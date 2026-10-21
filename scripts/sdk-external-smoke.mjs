import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function keyFrom(fileEnv, valueEnv) {
  if (process.env[fileEnv]) {
    const parsed = JSON.parse(readFileSync(process.env[fileEnv], 'utf8'));
    return parsed.api_key;
  }
  return process.env[valueEnv] || '';
}
process.env.FAD_TEST_A_KEY = keyFrom('FAD_TEST_A_KEY_FILE', 'FAD_TEST_A_KEY');
process.env.FAD_TEST_NOSCOPE_KEY = keyFrom('FAD_TEST_NOSCOPE_KEY_FILE', 'FAD_TEST_NOSCOPE_KEY');
process.env.FAD_TEST_REVOKED_KEY = keyFrom('FAD_TEST_REVOKED_KEY_FILE', 'FAD_TEST_REVOKED_KEY');

const root = new URL('..', import.meta.url).pathname;
const pack = spawnSync('npm', ['pack', '-w', '@fad/sdk', '--pack-destination', process.env.FAD_PACK_DIR || tmpdir()], {
  cwd: root,
  encoding: 'utf8',
});
if (pack.status !== 0) {
  console.error(pack.stdout);
  console.error(pack.stderr);
  process.exit(pack.status ?? 1);
}
const tarballName = pack.stdout.trim().split('\n').at(-1);
const packDir = process.env.FAD_PACK_DIR || tmpdir();
const tarball = join(packDir, tarballName);
const consumer = mkdtempSync(join(process.env.FAD_PACK_DIR || tmpdir(), 'fad-sdk-consumer-'));
writeFileSync(join(consumer, 'package.json'), JSON.stringify({
  name: 'fad-sdk-consumer',
  private: true,
  type: 'module',
}));
const installed = spawnSync('npm', ['install', '--no-audit', '--no-fund', tarball], { cwd: consumer, encoding: 'utf8' });
if (installed.status !== 0) {
  console.error(installed.stderr);
  process.exit(installed.status ?? 1);
}
const listing = readFileSync(join(consumer, 'node_modules/@fad/sdk/package.json'), 'utf8');
if (listing.includes('@fad/api') || listing.includes('@fad/db')) {
  console.error('packed sdk depends on server packages');
  process.exit(1);
}
console.log('PASS S0-K01');
writeFileSync(join(consumer, 'smoke.mjs'), String.raw`
import { createServer } from 'node:http';
import { FadApiError, FadClient } from '@fad/sdk';

const baseUrl = process.env.FAD_BASE_URL;
const key = process.env.FAD_TEST_A_KEY;
const orgId = process.env.FAD_TEST_A_ORG_ID;
const noScope = process.env.FAD_TEST_NOSCOPE_KEY;
const revoked = process.env.FAD_TEST_REVOKED_KEY;
function fail(message) { console.error('FAIL ' + message); process.exit(1); }
const client = new FadClient({ baseUrl, apiKey: key, allowInsecureHttp: true, maxGetRetries: 0, timeoutMs: 5000 });
const current = await client.organizations.current();
if (current.data.id !== orgId || current.meta.api_version !== 'v1') fail('current org');
console.log('PASS K02 ' + current.data.id + ' ' + current.meta.api_version + ' request ' + current.meta.request_id);
const live = await client.health.live();
const ready = await client.health.ready();
if (live.status !== 'ok' || ready.status !== 'ready') fail('health');
console.log('PASS health ' + live.status + ' ' + ready.status);
let forbidden = null;
try { await new FadClient({ baseUrl, apiKey: noScope, allowInsecureHttp: true, maxGetRetries: 0 }).organizations.current(); }
catch (err) { forbidden = err; }
if (!(forbidden instanceof FadApiError) || forbidden.status !== 403 || !forbidden.requestId) fail('403');
console.log('PASS 403 ' + forbidden.code + ' ' + forbidden.requestId);
let unauthorized = null;
try { await new FadClient({ baseUrl, apiKey: revoked, allowInsecureHttp: true, maxGetRetries: 1 }).organizations.current(); }
catch (err) { unauthorized = err; }
if (!(unauthorized instanceof FadApiError) || unauthorized.status !== 401 || !unauthorized.requestId) fail('401');
console.log('PASS 401 ' + unauthorized.code + ' ' + unauthorized.requestId);
let limited = null;
const limiter = new FadClient({ baseUrl, apiKey: key, allowInsecureHttp: true, maxGetRetries: 0, timeoutMs: 5000 });
for (let i = 0; i < 80; i += 1) {
  try { await limiter.organizations.current(); }
  catch (err) { limited = err; break; }
}
if (!(limited instanceof FadApiError) || limited.status !== 429) fail('429 status ' + (limited && limited.status));
console.log('PASS 429 ' + limited.code + ' retryAfter ' + limited.retryAfterSeconds + ' request ' + limited.requestId);
const sink = createServer((req, res) => { res.writeHead(200); res.end(req.headers['x-fad-api-key'] ? 'saw-key' : 'no'); });
await new Promise((resolve) => sink.listen(0, '127.0.0.1', resolve));
const sinkPort = sink.address().port;
let forwarded = 0;
sink.removeAllListeners('request');
sink.on('request', (req, res) => { if (req.headers['x-fad-api-key']) forwarded += 1; res.end(); });
const redirector = createServer((_req, res) => { res.writeHead(302, { location: 'http://127.0.0.1:' + sinkPort + '/x' }); res.end(); });
await new Promise((resolve) => redirector.listen(0, '127.0.0.1', resolve));
let redirectError = null;
try {
  await new FadClient({ baseUrl: 'http://127.0.0.1:' + redirector.address().port, apiKey: 'redirect-secret-key-value', allowInsecureHttp: true, maxGetRetries: 0 }).organizations.current();
} catch (err) { redirectError = err; }
if (!redirectError || redirectError.name !== 'FadRedirectError' || forwarded !== 0) fail('redirect');
console.log('PASS redirect');
redirector.close(); sink.close();
const hanging = createServer(() => {});
await new Promise((resolve) => hanging.listen(0, '127.0.0.1', resolve));
const controller = new AbortController();
const pending = new FadClient({ baseUrl: 'http://127.0.0.1:' + hanging.address().port, apiKey: 'abort-secret-key-value', allowInsecureHttp: true, timeoutMs: 5000 }).health.live({ signal: controller.signal });
controller.abort();
let aborted = null;
try { await pending; } catch (err) { aborted = err; }
if (!aborted || aborted.name !== 'AbortError') fail('abort ' + (aborted && aborted.name));
console.log('PASS abort');
hanging.close();
try { await import('@fad/api'); fail('imported server'); } catch { console.log('PASS no server import'); }
if (typeof client.agents !== 'undefined') fail('agents method');
console.log('PASS no agents method');
console.log('node ' + process.version);
`);
const run = spawnSync(process.execPath, ['smoke.mjs'], {
  cwd: consumer,
  encoding: 'utf8',
  env: process.env,
});
const secret = process.env.FAD_TEST_A_KEY || '';
const text = (run.stdout + run.stderr).split(secret).join('<redacted>').split(process.env.FAD_TEST_NOSCOPE_KEY || '___').join('<redacted>').split(process.env.FAD_TEST_REVOKED_KEY || '___').join('<redacted>');
process.stdout.write(text);
console.log('consumer ' + consumer);
console.log('tarball ' + tarballName);
process.exit(run.status ?? 1);
