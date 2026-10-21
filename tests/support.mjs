import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { redactText } from '@fad/auth-core';

const scratchDir = process.env.FAD_SCRATCH || `${tmpdir()}/fad-test`;
mkdirSync(scratchDir, { recursive: true });
export const scratch = scratchDir;

const liveApiChildren = new Set();

export function check(id, condition, detail = '') {
  if (!condition) {
    const message = `FAIL ${id} ${detail}`;
    console.error(message);
    throw new Error(message);
  }
  console.log(`${new Date().toISOString()} PASS ${id}`);
}

export function run(command, args, env = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

export function admin(args, env = {}) {
  return run(process.execPath, ['apps/admin/dist/main.js', ...args], env);
}

export function parseJson(text) {
  return JSON.parse(text);
}

export function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolvePromise(port));
    });
  });
}

export async function startApi(env) {
  const port = env.PORT || String(await freePort());
  let logs = '';
  const child = spawn(process.execPath, ['apps/api/dist/server.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'development',
      FAD_BIND_HOST: '127.0.0.1',
      FAD_INGRESS_TLS: 'cleartext',
      FAD_TRUST_PROXY: 'false',
      FAD_RATE_LIMIT_BACKEND: 'postgres',
      FAD_RATE_LIMIT_MAX: '1000',
      FAD_RATE_LIMIT_WINDOW_SECONDS: '60',
      FAD_DB_POOL_MAX: '4',
      FAD_HTTP_REQUEST_TIMEOUT_MS: '5000',
      FAD_SHUTDOWN_GRACE_MS: '5000',
      ...env,
      PORT: String(port),
    },
  });
  liveApiChildren.add(child);
  child.stdout.on('data', (chunk) => {
    logs += chunk;
  });
  child.stderr.on('data', (chunk) => {
    logs += chunk;
  });
  const base = `http://127.0.0.1:${port}`;
  const started = Date.now();
  let ready = false;
  while (Date.now() - started < 8000) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${base}/health/live`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* process still binding */
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  async function stop() {
    liveApiChildren.delete(child);
    if (child.exitCode !== null) return child.exitCode;
    child.kill('SIGTERM');
    const exit = await new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolvePromise(1);
      }, 6000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolvePromise(code ?? 1);
      });
    });
    return exit;
  }
  return { port: Number(port), base, ready, stop, logs: () => logs, child };
}

export async function stopApis() {
  const children = [...liveApiChildren];
  liveApiChildren.clear();
  await Promise.all(children.map((child) => new Promise((resolvePromise) => {
    if (child.exitCode !== null) {
      resolvePromise(child.exitCode);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolvePromise(1);
    }, 6000);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolvePromise(code ?? 1);
    });
    child.kill('SIGTERM');
  })));
}

export async function request(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  const headers = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: response.status, headers, text, json };
}

export function writeEvidence(name, content, secrets = []) {
  const dir = process.env.FAD_EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${name}`, redactText(content, secrets));
}

export function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}
