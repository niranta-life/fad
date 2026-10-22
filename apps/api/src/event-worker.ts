import { randomUUID } from 'node:crypto';
import { createPool, isDependencyError } from '@fad/db';
import {
  acknowledgeDelivery,
  claimDelivery,
  claimVerification,
  eventCaptureBlocksReady,
  eventsCaptureEnabled,
  fanoutOrganization,
  finishVerification,
  pendingOrganizations,
  postSignedWebhook,
} from '@fad/db';
import { ConfigError, loadConfig } from './config.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One pass of verification, fanout, and delivery. Tests call this directly. */
export async function runEventWorkerTick(pool: Parameters<typeof pendingOrganizations>[0]): Promise<void> {
  const organizations = await pendingOrganizations(pool);
  for (const organizationId of organizations) {
    await verifyOrganization(pool, organizationId);
    await fanoutOrganization(pool, organizationId);
    for (let sent = 0; sent < 20; sent += 1) {
      const claim = await claimDelivery(pool, organizationId);
      if (!claim) break;
      await deliverOne(pool, claim);
    }
  }
}

async function verifyOrganization(pool: Parameters<typeof pendingOrganizations>[0], organizationId: string): Promise<void> {
  for (let count = 0; count < 20; count += 1) {
    const claim = await claimVerification(pool, organizationId);
    if (!claim) return;
    const body = Buffer.from(JSON.stringify({
      type: 'fad.webhook.challenge.v1',
      challenge: claim.challenge,
      subscription_id: claim.subscriptionId,
    }));
    try {
      const sent = await postSignedWebhook({
        url: claim.url,
        secret: claim.secret,
        keyId: claim.keyId,
        eventId: claim.subscriptionId,
        deliveryId: randomUUID(),
        body,
      });
      await finishVerification(pool, organizationId, claim.subscriptionId, sent.status, sent.body);
    } catch {
      await finishVerification(pool, organizationId, claim.subscriptionId, 0, Buffer.alloc(0));
    }
  }
}

async function deliverOne(
  pool: Parameters<typeof pendingOrganizations>[0],
  claim: Awaited<ReturnType<typeof claimDelivery>>,
): Promise<void> {
  if (!claim) return;
  const startedAt = new Date();
  try {
    const sent = await postSignedWebhook(claim);
    const retry = sent.status === 408 || sent.status === 429 || sent.status >= 500;
    const success = sent.status >= 200 && sent.status < 300;
    await acknowledgeDelivery(pool, claim, {
      kind: success ? 'success' : retry ? 'retry' : 'dead',
      httpStatus: sent.status,
      retryAfterSeconds: sent.retryAfterSeconds,
      startedAt,
    });
  } catch {
    await acknowledgeDelivery(pool, claim, {
      kind: 'retry',
      httpStatus: null,
      retryAfterSeconds: null,
      startedAt,
    });
  }
}

export async function startEventWorker(): Promise<void> {
  if (!eventsCaptureEnabled()) {
    process.exit(0);
  }
  const config = loadConfig();
  const pool = createPool({
    connectionString: config.databaseUrl,
    max: config.poolMax,
    statementTimeoutMs: config.requestTimeoutMs,
    applicationName: `fad-events-${process.pid}`,
    ssl: config.ssl,
  });
  pool.on('error', () => undefined);
  let stop = false;
  const shutdown = (): void => {
    stop = true;
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  try {
    if (await eventCaptureBlocksReady(pool)) {
      throw new ConfigError('event capture is not ready');
    }
    while (!stop) {
      await runEventWorkerTick(pool);
      if (stop) break;
      await sleep(250);
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('event-worker.js')) {
  startEventWorker().catch((err: unknown) => {
    const message = err instanceof ConfigError
      ? err.message
      : isDependencyError(err)
        ? 'Database is unavailable'
        : 'Event worker failed';
    console.error(JSON.stringify({ error: { code: 'STARTUP', message } }));
    process.exit(1);
  });
}
