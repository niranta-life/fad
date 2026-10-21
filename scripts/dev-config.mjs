#!/usr/bin/env node
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envFile, readText, writeText } from './dev/files.mjs';
import { assertDevelopment } from './dev/mode.mjs';
import { applyChange, reviewText } from './dev/settings.mjs';
import { runCli, UserMessage } from './dev/user-message.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

async function pepperCheck() {
  try {
    const auth = await import('@fad/auth-core');
    return auth.assertPepper;
  } catch {
    throw new UserMessage('The project packages are not ready. Run the setup command, then try again.');
  }
}

async function main() {
  assertDevelopment(process.env);
  const action = process.argv[2];
  const file = envFile(root, process.env);
  if (action === 'review') {
    process.stdout.write(reviewText(readText(file)));
    return;
  }
  if (action !== 'set') {
    throw new UserMessage('Use review, or set a setting and a value.');
  }
  const name = process.argv[3] ?? '';
  const value = process.argv[4] ?? '';
  const next = applyChange(readText(file), name, value, await pepperCheck());
  writeText(file, next);
  process.stdout.write('Saved.\n');
}

runCli(main);
