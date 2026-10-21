import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..');
const postgres = 'postgres-secret-value';
const app = 'app-secret-value';
const pepper = 'local-dev-pepper-9f3c1a7e5b2d4860';
const weakPepper = 'a'.repeat(40);

function validEnv() {
  return [
    `FAD_DEV_POSTGRES_PASSWORD=${postgres}`,
    `FAD_APP_DB_PASSWORD=${app}`,
    `FAD_API_KEY_PEPPER_V1=${pepper}`,
    'FAD_PUBLISH_PORT=8080',
    'FAD_TAGS_ENABLED=false',
    'FAD_SLICE3_ENABLED=false',
    'FAD_MCP_ENABLED=false',
    '',
  ].join('\n');
}

function run(script, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, 'scripts', script), ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = [];
    const err = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', (error) => {
      resolve({ code: 127, stdout: Buffer.concat(out).toString('utf8'), stderr: `${Buffer.concat(err).toString('utf8')}${error.message}` });
    });
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

function assertPlain(text) {
  assert.equal(text.includes(postgres), false);
  assert.equal(text.includes(app), false);
  assert.equal(text.includes(pepper), false);
  assert.equal(text.includes(weakPepper), false);
  assert.equal(/postgres:\/\//i.test(text), false);
  assert.equal(text.includes('node:internal'), false);
  assert.equal(/^\s*at .+\(/m.test(text), false);
  assert.equal(text.includes('Error:'), false);
}

function freshFile(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'fad-dev-script-'));
  const file = join(dir, 'settings.env');
  if (contents !== undefined) writeFileSync(file, contents, { mode: 0o600 });
  return {
    dir,
    file,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('config rejects a weak pepper, an empty password, an unknown name, and MCP without issuer settings', async () => {
  const fixture = freshFile(validEnv());
  try {
    const cases = [
      ['pepper', weakPepper, 'The API pepper is not strong enough.'],
      ['postgres-password', '', 'The database password is empty.'],
      ['not-a-setting', 'value', 'That setting is not used here.'],
      ['mcp', 'on', 'MCP is on, but the issuer settings are missing.'],
      ['port', '70000', 'That port is not valid.'],
      ['publish-address', '0.0.0.0', 'That address is not this computer.'],
    ];
    for (const [name, value, sentence] of cases) {
      const before = readFileSync(fixture.file);
      const stamp = statSync(fixture.file).mtimeMs;
      const result = await run('dev-config.mjs', ['set', name, value], {
        NODE_ENV: 'development',
        FAD_DEV_ENV_FILE: fixture.file,
      });
      assert.equal(result.code, 1, result.stderr);
      assert.equal(result.stderr.includes(sentence), true, result.stderr);
      assertPlain(`${result.stdout}${result.stderr}`);
      assert.equal(readFileSync(fixture.file).equals(before), true);
      assert.equal(statSync(fixture.file).mtimeMs, stamp);
    }
  } finally {
    fixture.cleanup();
  }
});

test('a refused pepper does not create a settings file', async () => {
  const fixture = freshFile();
  try {
    const result = await run('dev-config.mjs', ['set', 'pepper', 'changeme'], {
      NODE_ENV: 'development',
      FAD_DEV_ENV_FILE: fixture.file,
    });
    assert.equal(result.code, 1);
    assert.equal(result.stderr.includes('The API pepper is not strong enough.'), true);
    assertPlain(`${result.stdout}${result.stderr}`);
    assert.equal(existsSync(fixture.file), false);
  } finally {
    fixture.cleanup();
  }
});

test('review of a valid file shows the port and hides secret values', async () => {
  const fixture = freshFile(validEnv());
  try {
    const result = await run('dev-config.mjs', ['review'], {
      NODE_ENV: 'development',
      FAD_DEV_ENV_FILE: fixture.file,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.includes('Port: 8080'), true);
    assert.equal(result.stdout.includes('Database password: set'), true);
    assert.equal(result.stdout.includes('App database password: set'), true);
    assert.equal(result.stdout.includes('API pepper: set'), true);
    assert.equal(result.stdout.includes('MCP: off'), true);
    assertPlain(`${result.stdout}${result.stderr}`);
  } finally {
    fixture.cleanup();
  }
});

test('a valid port change is saved without printing secrets', async () => {
  const fixture = freshFile(validEnv());
  try {
    const saved = await run('dev-config.mjs', ['set', 'port', '18080'], {
      NODE_ENV: 'development',
      FAD_DEV_ENV_FILE: fixture.file,
    });
    assert.equal(saved.code, 0, saved.stderr);
    assert.equal(saved.stdout, 'Saved.\n');
    assert.equal(statSync(fixture.file).mode & 0o777, 0o600);
    assert.equal(readFileSync(fixture.file, 'utf8').includes('FAD_PUBLISH_PORT=18080'), true);
    const review = await run('dev-config.mjs', ['review'], {
      NODE_ENV: 'development',
      FAD_DEV_ENV_FILE: fixture.file,
    });
    assert.equal(review.code, 0, review.stderr);
    assert.equal(review.stdout.includes('Port: 18080'), true);
    assertPlain(`${saved.stdout}${saved.stderr}${review.stdout}${review.stderr}`);
  } finally {
    fixture.cleanup();
  }
});

test('MCP can be turned on only after the issuer settings are present', async () => {
  const fixture = freshFile(validEnv());
  try {
    const steps = [
      ['mcp-issuer', 'https://issuer.example'],
      ['mcp-resource', 'http://127.0.0.1:8080/mcp'],
      ['mcp-audience', 'http://127.0.0.1:8080/mcp'],
      ['allowed-hosts', '127.0.0.1:8080'],
      ['mcp', 'on'],
    ];
    for (const [name, value] of steps) {
      const result = await run('dev-config.mjs', ['set', name, value], {
        NODE_ENV: 'development',
        FAD_DEV_ENV_FILE: fixture.file,
      });
      assert.equal(result.code, 0, `${name}: ${result.stderr}`);
      assertPlain(`${result.stdout}${result.stderr}`);
    }
    const text = readFileSync(fixture.file, 'utf8');
    assert.equal(text.includes('FAD_MCP_ENABLED=true'), true);
    const review = await run('dev-config.mjs', ['review'], {
      NODE_ENV: 'development',
      FAD_DEV_ENV_FILE: fixture.file,
    });
    assert.equal(review.stdout.includes('MCP: on'), true);
    assertPlain(`${review.stdout}${review.stderr}`);
  } finally {
    fixture.cleanup();
  }
});

test('resource and audience can be changed one at a time while MCP is off', async () => {
  const oldUrl = 'http://127.0.0.1:8080/mcp';
  const nextUrl = 'http://127.0.0.1:18080/mcp';
  const fixture = freshFile([
    `FAD_DEV_POSTGRES_PASSWORD=${postgres}`,
    `FAD_APP_DB_PASSWORD=${app}`,
    `FAD_API_KEY_PEPPER_V1=${pepper}`,
    'FAD_PUBLISH_PORT=8080',
    'FAD_TAGS_ENABLED=false',
    'FAD_SLICE3_ENABLED=false',
    'FAD_MCP_ENABLED=false',
    'FAD_MCP_AUTH_ISSUERS=https://issuer.example',
    `FAD_MCP_RESOURCE_URI=${oldUrl}`,
    `FAD_MCP_EXPECTED_AUDIENCE=${oldUrl}`,
    'FAD_HTTP_ALLOWED_HOSTS=127.0.0.1:8080',
    '',
  ].join('\n'));
  const env = { NODE_ENV: 'development', FAD_DEV_ENV_FILE: fixture.file };
  try {
    const resource = await run('dev-config.mjs', ['set', 'mcp-resource', nextUrl], env);
    assert.equal(resource.code, 0, resource.stderr);
    let text = readFileSync(fixture.file, 'utf8');
    assert.equal(text.includes(`FAD_MCP_RESOURCE_URI=${nextUrl}`), true);
    assert.equal(text.includes(`FAD_MCP_EXPECTED_AUDIENCE=${oldUrl}`), true);

    const audience = await run('dev-config.mjs', ['set', 'mcp-audience', nextUrl], env);
    assert.equal(audience.code, 0, audience.stderr);
    text = readFileSync(fixture.file, 'utf8');
    assert.equal(text.includes(`FAD_MCP_RESOURCE_URI=${nextUrl}`), true);
    assert.equal(text.includes(`FAD_MCP_EXPECTED_AUDIENCE=${nextUrl}`), true);
    assertPlain(`${resource.stdout}${resource.stderr}${audience.stdout}${audience.stderr}`);

    const turnedOn = await run('dev-config.mjs', ['set', 'mcp', 'on'], env);
    assert.equal(turnedOn.code, 0, turnedOn.stderr);
    const before = readFileSync(fixture.file);
    const blocked = await run('dev-config.mjs', ['set', 'mcp-resource', oldUrl], env);
    assert.equal(blocked.code, 1);
    assert.equal(blocked.stderr.includes('The audience must be the same address as the resource.'), true, blocked.stderr);
    assert.equal(blocked.stderr.includes('issuer settings are missing'), false);
    assertPlain(`${blocked.stdout}${blocked.stderr}`);
    assert.equal(readFileSync(fixture.file).equals(before), true);

    const turnedOff = await run('dev-config.mjs', ['set', 'mcp', 'off'], env);
    assert.equal(turnedOff.code, 0, turnedOff.stderr);
    const audienceFirst = await run('dev-config.mjs', ['set', 'mcp-audience', oldUrl], env);
    assert.equal(audienceFirst.code, 0, audienceFirst.stderr);
    const resourceSecond = await run('dev-config.mjs', ['set', 'mcp-resource', oldUrl], env);
    assert.equal(resourceSecond.code, 0, resourceSecond.stderr);
    text = readFileSync(fixture.file, 'utf8');
    assert.equal(text.includes(`FAD_MCP_RESOURCE_URI=${oldUrl}`), true);
    assert.equal(text.includes(`FAD_MCP_EXPECTED_AUDIENCE=${oldUrl}`), true);
    assert.equal(text.includes('FAD_MCP_ENABLED=false'), true);
  } finally {
    fixture.cleanup();
  }
});

test('server and setup refuse a non-development run before Docker is used', async () => {
  const fixture = freshFile(validEnv());
  const bin = mkdtempSync(join(tmpdir(), 'fad-dev-docker-'));
  const record = join(bin, 'record');
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(record)}\nexit 0\n`, { mode: 0o755 });
  chmodSync(join(bin, 'docker'), 0o755);
  try {
    const env = {
      NODE_ENV: 'production',
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      FAD_DEV_ENV_FILE: fixture.file,
      FAD_DEV_PROJECT: 'fad-dev-refuse',
    };
    const before = readFileSync(fixture.file);
    const start = await run('dev-server.mjs', ['start'], env);
    const setup = await run('dev-setup.mjs', [], env);
    const config = await run('dev-config.mjs', ['set', 'port', '18081'], env);
    for (const result of [start, setup, config]) {
      assert.equal(result.code, 1, result.stderr);
      assert.equal(result.stderr.includes('This command only runs for development.'), true, result.stderr);
      assertPlain(`${result.stdout}${result.stderr}`);
    }
    assert.equal(readFileSync(fixture.file).equals(before), true);
    assert.equal(existsSync(record), false);
  } finally {
    fixture.cleanup();
    rmSync(bin, { recursive: true, force: true });
  }
});

test('server start refuses an engine that is not Colima and does not call Docker', async () => {
  const fixture = freshFile(validEnv());
  const bin = mkdtempSync(join(tmpdir(), 'fad-dev-docker-'));
  const record = join(bin, 'record');
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(record)}\nexit 0\n`, { mode: 0o755 });
  chmodSync(join(bin, 'docker'), 0o755);
  try {
    const result = await run('dev-server.mjs', ['start'], {
      NODE_ENV: 'development',
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      FAD_DEV_ENV_FILE: fixture.file,
      FAD_DEV_PROJECT: 'fad-dev-not-colima',
      FAD_DEV_DOCKER_HOST: 'unix:///tmp/not-colima/docker.sock',
    });
    assert.notEqual(result.code, 0);
    assert.equal(result.stderr.includes('Docker is using a different engine.'), true, result.stderr);
    assert.equal(result.stderr.includes('It did not start or change containers.'), true, result.stderr);
    assertPlain(`${result.stdout}${result.stderr}`);
    assert.equal(existsSync(record), false);
  } finally {
    fixture.cleanup();
    rmSync(bin, { recursive: true, force: true });
  }
});

test('server start refuses a DOCKER_HOST that is not the Colima socket', async () => {
  const fixture = freshFile(validEnv());
  const bin = mkdtempSync(join(tmpdir(), 'fad-dev-docker-'));
  const record = join(bin, 'record');
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(record)}\nexit 0\n`, { mode: 0o755 });
  chmodSync(join(bin, 'docker'), 0o755);
  try {
    const result = await run('dev-server.mjs', ['status'], {
      NODE_ENV: 'development',
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      FAD_DEV_ENV_FILE: fixture.file,
      FAD_DEV_DOCKER_HOST: '',
      DOCKER_HOST: 'unix:///tmp/not-colima/docker.sock',
    });
    assert.notEqual(result.code, 0);
    assert.equal(result.stderr.includes('Docker is using a different engine.'), true, result.stderr);
    assertPlain(`${result.stdout}${result.stderr}`);
    assert.equal(existsSync(record), false);
  } finally {
    fixture.cleanup();
    rmSync(bin, { recursive: true, force: true });
  }
});
