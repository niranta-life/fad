#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireColimaHost } from './dev/colima.mjs';
import { nodeProblem } from './dev/engine.mjs';
import { assertDevelopment } from './dev/mode.mjs';
import { installedLockMatches } from './dev/packages.mjs';
import { capture } from './dev/spawn.mjs';
import { runCli, UserMessage } from './dev/user-message.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

function readProject(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return '';
    throw new UserMessage('A project file could not be read. Run this command from the project folder.');
  }
}

function childEnv(env, extra = {}) {
  const home = env.HOME && env.HOME.trim() !== '' ? env.HOME : homedir();
  const next = { PATH: env.PATH ?? '', HOME: home, ...extra };
  if (env.TMPDIR) next.TMPDIR = env.TMPDIR;
  return next;
}

async function main() {
  assertDevelopment(process.env);
  let range = '';
  try {
    range = JSON.parse(readProject(join(root, 'package.json'))).engines?.node ?? '';
  } catch {
    throw new UserMessage('The project file could not be read. Run this command from the project folder.');
  }
  const problem = nodeProblem(process.version, range);
  if (problem) throw new UserMessage(problem);

  const dockerHost = await requireColimaHost(process.env);
  const info = await capture('docker', ['info'], childEnv(process.env, { DOCKER_HOST: dockerHost }), root);
  if (info.error && info.error.code === 'ENOENT') {
    throw new UserMessage('Docker is not available. Start Colima, which provides Docker, and run setup again.');
  }
  if (info.code !== 0) {
    throw new UserMessage("Colima's Docker engine did not answer. Start Colima and run setup again.");
  }

  const lockText = () => readProject(join(root, 'package-lock.json'));
  const installedText = () => readProject(join(root, 'node_modules', '.package-lock.json'));
  if (!installedLockMatches(lockText(), installedText())) {
    const install = await capture('npm', ['ci', '--no-audit', '--no-fund'], childEnv(process.env), root);
    if (install.error && install.error.code === 'ENOENT') {
      throw new UserMessage("Node's package tool is not available. Install Node.js, which includes npm, and run setup again.");
    }
    if (install.code !== 0 || !installedLockMatches(lockText(), installedText())) {
      throw new UserMessage('The project packages could not be installed. Run setup again. If it still fails, ask the person who gave you this project.');
    }
  }

  process.stdout.write('Colima is the engine.\nNode.js meets the requirement.\nPackages are installed.\n');
}

runCli(main);
