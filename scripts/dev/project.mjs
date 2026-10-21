import { UserMessage } from './user-message.mjs';

export function projectName(env) {
  const name = env.FAD_DEV_PROJECT && env.FAD_DEV_PROJECT.trim() !== '' ? env.FAD_DEV_PROJECT.trim() : 'fad-dev';
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) {
    throw new UserMessage('That project name is not valid. Use short lowercase letters, numbers, and dashes, then try again.');
  }
  return name;
}
