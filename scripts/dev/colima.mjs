import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { reportedSocket, selectColimaHost } from './engine.mjs';
import { capture } from './spawn.mjs';
import { UserMessage } from './user-message.mjs';

function requestedHost(env) {
  for (const value of [env.FAD_DEV_DOCKER_HOST, env.DOCKER_HOST]) {
    if (value && value.trim() !== '') return value;
  }
  return undefined;
}

export async function requireColimaHost(env) {
  const home = env.HOME && env.HOME.trim() !== '' ? env.HOME : homedir();
  const status = await capture('colima', ['status'], { PATH: env.PATH ?? '', HOME: home });
  if (status.error && status.error.code === 'ENOENT') {
    throw new UserMessage('Colima is not installed or not available. Install Colima, start it, and run this command again.');
  }
  const statusText = `${status.stdout}\n${status.stderr}`;
  const socketPath = reportedSocket(statusText, home);
  return selectColimaHost({
    statusText,
    dockerHost: requestedHost(env),
    home,
    socketExists: existsSync(socketPath),
  });
}
