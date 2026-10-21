import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UserMessage } from './user-message.mjs';

export function envFile(root, env) {
  const override = env.FAD_DEV_ENV_FILE;
  if (override && override.trim() !== '') return override;
  return join(root, '.env.development');
}

export function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return '';
    throw new UserMessage('The settings file could not be read. Check that you can open it, then try again.');
  }
}

export function writeText(path, text) {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, text, { mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file was already removed.
    }
    throw new UserMessage('The settings could not be saved. Check that you can write in this folder, then try again.');
  }
}
