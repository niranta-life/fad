import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { redactValue } from '@fad/auth-core';

export interface AuditInput {
  organizationId: string;
  actorPrincipalId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  outcome: 'success' | 'denied' | 'failed';
  details: Record<string, unknown>;
}

export async function insertAudit(client: PoolClient, input: AuditInput): Promise<void> {
  const details = redactValue(input.details);
  await client.query(
    `INSERT INTO audit_events (
       organization_id, id, actor_principal_id, action, target_type, target_id, outcome, request_id, details
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8::jsonb)`,
    [
      input.organizationId,
      randomUUID(),
      input.actorPrincipalId,
      input.action,
      input.targetType,
      input.targetId,
      input.outcome,
      JSON.stringify(details),
    ],
  );
}

export async function auditedMutation(
  client: PoolClient,
  input: AuditInput & { mutate: (client: PoolClient) => Promise<void> },
): Promise<void> {
  await input.mutate(client);
  await insertAudit(client, input);
}
