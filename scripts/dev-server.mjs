#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireColimaHost } from './dev/colima.mjs';
import { envFile, readText } from './dev/files.mjs';
import { assertDevelopment } from './dev/mode.mjs';
import { projectName } from './dev/project.mjs';
import { bodyIsReady, getReady, waitReady } from './dev/ready.mjs';
import { publishPort, startProblem } from './dev/settings.mjs';
import { capture } from './dev/spawn.mjs';
import { runCli, UserMessage } from './dev/user-message.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

function dockerEnv(env, dockerHost) {
  const home = env.HOME && env.HOME.trim() !== '' ? env.HOME : homedir();
  return { PATH: env.PATH ?? '', HOME: home, DOCKER_HOST: dockerHost };
}

function composeArgs(env, file, args) {
  return [
    'compose',
    '--project-name', projectName(env),
    '--env-file', file,
    '-f', join(root, 'deploy/docker/compose.yaml'),
    ...args,
  ];
}

async function pepperCheck() {
  try {
    const auth = await import('@fad/auth-core');
    return auth.assertPepper;
  } catch {
    throw new UserMessage('The project packages are not ready. Run the setup command, then try again.');
  }
}

async function compose(env, dockerHost, file, args) {
  const result = await capture('docker', composeArgs(env, file, args), dockerEnv(env, dockerHost), root);
  if (result.error && result.error.code === 'ENOENT') {
    throw new UserMessage('Docker is not available. Start Colima, which provides Docker, and try again.');
  }
  return result;
}

async function runningServices(env, dockerHost, file) {
  const result = await compose(env, dockerHost, file, ['ps', '--status', 'running', '--services']);
  if (result.code !== 0) {
    throw new UserMessage('The server status could not be checked. Start Colima and try again.');
  }
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

async function main() {
  const action = process.argv[2];
  if (action !== 'start' && action !== 'stop' && action !== 'restart' && action !== 'status') {
    throw new UserMessage('Use start, stop, restart, or status.');
  }
  assertDevelopment(process.env);
  const dockerHost = await requireColimaHost(process.env);
  const file = envFile(root, process.env);
  const text = readText(file);

  if (action === 'status') {
    if (text.trim() === '') {
      process.stdout.write('The server is down.\n');
      return;
    }
    const services = await runningServices(process.env, dockerHost, file);
    if (!services.includes('api')) {
      process.stdout.write('The server is down.\n');
      return;
    }
    const ready = await getReady(publishPort(text));
    process.stdout.write(ready && ready.status === 200 && bodyIsReady(ready.body)
      ? 'The server is up.\n'
      : 'The server is not ready yet.\n');
    return;
  }

  if (action === 'stop') {
    if (text.trim() === '') {
      process.stdout.write('The server is down.\n');
      return;
    }
    const result = await compose(process.env, dockerHost, file, ['stop']);
    if (result.code !== 0) {
      throw new UserMessage('The server did not stop. Start Colima and try again.');
    }
    const ready = await getReady(publishPort(text));
    if (ready && ready.status === 200 && bodyIsReady(ready.body)) {
      throw new UserMessage('The server did not stop. Start Colima and try again.');
    }
    process.stdout.write('The server is down.\n');
    return;
  }

  const problem = startProblem(text, await pepperCheck());
  if (problem) throw new UserMessage(problem);
  const port = publishPort(text);

  if (action === 'restart') {
    const services = await runningServices(process.env, dockerHost, file);
    if (!services.includes('api')) {
      throw new UserMessage('The server is down. Start it, then try again.');
    }
    const result = await compose(process.env, dockerHost, file, ['restart', 'postgres', 'api']);
    if (result.code !== 0) {
      throw new UserMessage('The server did not restart. Start Colima and try again.');
    }
    if (!(await waitReady(port))) {
      throw new UserMessage('The server did not become ready. Check that Colima is running and the settings are complete, then try again.');
    }
    process.stdout.write('The server is up.\n');
    return;
  }

  process.stdout.write('Starting the server. The first start can take a few minutes.\n');
  const started = await compose(process.env, dockerHost, file, ['up', '-d', '--build']);
  if (started.code !== 0) {
    throw new UserMessage('The server did not start. Check that Colima is running and the settings are complete, then try again.');
  }
  if (!(await waitReady(port))) {
    throw new UserMessage('The server did not become ready. Check that Colima is running and the settings are complete, then try again.');
  }
  process.stdout.write('The server is up.\n');
}

runCli(main);
