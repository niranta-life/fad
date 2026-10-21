import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  const text = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.status !== 0) {
    console.error(text);
    throw new Error(`${command} ${args.join(' ')} failed`);
  }
  return text;
}

function fail(id, detail) {
  console.error(`FAIL ${id} ${detail}`);
  process.exit(1);
}

const inspected = run('docker', ['inspect', 'fad-s0-proof-api-1', 'fad-s0-proof-api-2']);
const containers = JSON.parse(inspected);
for (const container of containers) {
  const uid = run('docker', ['exec', container.Name.replace(/^\//, ''), 'id', '-u']).trim();
  if (uid === '0' || container.HostConfig.ReadonlyRootfs !== true) {
    fail('S0-O01', `${container.Name} uid=${uid} readonly=${container.HostConfig.ReadonlyRootfs}`);
  }
}
const health = run('curl', ['-sS', '-D', '-', 'http://127.0.0.1:18082/health/live']);
if (!health.includes('HTTP/1.1 200') || !health.includes('{"status":"ok"}')) fail('S0-O01', 'health');
console.log('PASS S0-O01');

const sql = `
SELECT
  (SELECT count(*) FROM organizations) AS orgs,
  (SELECT count(*) FROM principals) AS principals,
  (SELECT count(*) FROM api_credentials) AS credentials,
  (SELECT count(*) FROM audit_events) AS audits,
  (SELECT count(*) FROM schema_migrations) AS migrations,
  (SELECT count(*) FROM api_credentials WHERE status = 'revoked') AS revoked;
`;
const counts = run('docker', ['exec', 'fad-s0-restore', 'psql', '-U', 'postgres', '-d', 'fad', '-c', sql]);
console.log(counts.trim());
if (!/\b2\s+\|\s+2\s+\|\s+4\s+\|\s+9\s+\|\s+2\s+\|\s+1\b/.test(counts.replace(/\n/g, ' '))) {
  fail('S0-O06', 'restored counts');
}
const sums = run('docker', ['exec', 'fad-s0-restore', 'psql', '-U', 'postgres', '-d', 'fad', '-c',
  "SELECT version, checksum_sha256 FROM schema_migrations ORDER BY version"]);
console.log(sums.trim());
if (!sums.includes('09fb08e50ca20f3c1f18a32e93c03260f476c52816a976e1754a8b34505dc463')) fail('S0-O06', '0001 checksum');
if (!sums.includes('2b8f86066af0b29968268db39ca3dd297677321339b947d46e46613f68811924')) fail('S0-O06', '0002 checksum');
console.log('RPO unmeasured');
console.log('RTO unmeasured');
console.log('PASS S0-O06');

const auditRun = spawnSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8' });
const audit = JSON.parse(auditRun.stdout || '{}');
const vulns = audit.metadata?.vulnerabilities || audit.vulnerabilities;
console.log(JSON.stringify(vulns));
if (!vulns || vulns.critical !== 0 || vulns.high !== 0) fail('S0-O07', 'npm audit');
const pepper = process.env.FAD_API_KEY_PEPPER_V1 || '';
if (pepper.length < 32) fail('S0-O07', 'pepper env missing');
const image = spawnSync('docker', ['run', '--rm', '--entrypoint', 'grep', 'fad-api:local', '-R', '-l', '-F', pepper, '/srv/fad'], { encoding: 'utf8' });
if (image.status === 0) fail('S0-O07', 'pepper present in image');
if (image.status !== 1) {
  console.error(image.stderr);
  fail('S0-O07', 'image scan failed');
}
console.log('pepper value absent from image');
console.log('PASS S0-O07');
