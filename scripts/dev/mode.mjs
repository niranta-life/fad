import { UserMessage } from './user-message.mjs';

export function assertDevelopment(env) {
  const mode = env.NODE_ENV ?? '';
  if (mode === '' || mode === 'development') return;
  throw new UserMessage('This command only runs for development. It did not change the server.');
}
