import { isDependencyError } from '@fad/db';
import { ConfigError } from './config.js';
import { start } from './main.js';

start().catch((err: unknown) => {
  const message = err instanceof ConfigError
    ? err.message
    : isDependencyError(err)
      ? 'Database is unavailable'
      : 'Startup failed';
  console.error(JSON.stringify({ error: { code: 'STARTUP', message } }));
  process.exit(1);
});
