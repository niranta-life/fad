export class UserMessage extends Error {
  constructor(text) {
    super(text);
    this.name = 'UserMessage';
  }
}

export async function runCli(fn) {
  try {
    await fn();
  } catch (error) {
    const text = error instanceof UserMessage
      ? error.message
      : 'Something went wrong. No secret details were printed. Check that Colima is running and try again.';
    process.stderr.write(`${text}\n`);
    process.exit(1);
  }
}
