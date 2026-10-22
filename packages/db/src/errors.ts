const SQLSTATE = new Set([
  '40P01',
  '55P03',
  '57014',
  '57P01',
  '57P02',
  '57P03',
  '57P05',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '53300',
  '08P01',
]);

const NODE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

function textOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return '';
}

function codeOf(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

export function isDependencyError(err: unknown): boolean {
  const code = codeOf(err);
  if (code && (SQLSTATE.has(code) || NODE_CODES.has(code))) return true;
  if (/connection terminated|timeout exceeded|query read timeout|the database system is (starting up|shutting down)|cannot connect|Connection refused|ECONNREFUSED/i.test(textOf(err))) {
    return true;
  }
  if (typeof err === 'object' && err !== null && 'errors' in err && Array.isArray((err as { errors?: unknown }).errors)) {
    return (err as { errors: unknown[] }).errors.some((item) => isDependencyError(item));
  }
  return false;
}
