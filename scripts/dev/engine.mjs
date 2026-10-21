import { join } from 'node:path';
import { UserMessage } from './user-message.mjs';

export function colimaSocketFromStatus(text) {
  const match = /docker socket:\s*unix:\/\/([^\s"]+)/.exec(text ?? '');
  return match ? match[1] : null;
}

export function colimaIsRunning(text) {
  return /colima is running/i.test(text ?? '');
}

export function reportedSocket(statusText, home) {
  return colimaSocketFromStatus(statusText) ?? join(home, '.colima', 'default', 'docker.sock');
}

function unixPath(host) {
  if (!host) return '';
  return host.startsWith('unix://') ? host.slice('unix://'.length) : host;
}

function clean(path) {
  if (!path) return '';
  const parts = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

/** The selected Docker socket must be the socket Colima reported, under the Colima directory. */
export function selectColimaHost({ statusText, dockerHost, home, socketExists }) {
  if (!colimaIsRunning(statusText)) {
    throw new UserMessage('Colima is not running. Start Colima, and run this command again. Nothing was changed.');
  }
  const reported = reportedSocket(statusText, home);
  const colimaRoot = clean(join(home, '.colima'));
  const reportedPath = clean(unixPath(reported));
  if (!reportedPath.startsWith(`${colimaRoot}/`) || !socketExists) {
    throw new UserMessage('Colima is not running. Start Colima, and run this command again. Nothing was changed.');
  }
  const selected = dockerHost ? clean(unixPath(dockerHost)) : reportedPath;
  if (selected !== reportedPath || !selected.startsWith(`${colimaRoot}/`)) {
    throw new UserMessage('Docker is using a different engine. This command only uses Colima. It did not start or change containers.');
  }
  return `unix://${reportedPath}`;
}

export function nodeMeets(version, range) {
  const need = /^>=(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(String(range ?? '').trim());
  const got = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? '').trim());
  if (!need || !got) return false;
  const required = [Number(need[1]), Number(need[2] ?? 0), Number(need[3] ?? 0)];
  const current = [Number(got[1]), Number(got[2]), Number(got[3])];
  for (let index = 0; index < 3; index += 1) {
    if (current[index] > required[index]) return true;
    if (current[index] < required[index]) return false;
  }
  return true;
}

export function nodeProblem(version, range) {
  if (!range) return 'This project does not say which Node.js version it needs.';
  if (!nodeMeets(version, range)) {
    return `This project needs Node.js ${range}. This computer has ${version}. Install a newer Node.js and run setup again.`;
  }
  return null;
}
