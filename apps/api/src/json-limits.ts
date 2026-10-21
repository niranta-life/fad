export class JsonLimitError extends Error {
  readonly statusCode = 400;
  readonly mcpCode: number;

  constructor(mcpCode: number, message: string) {
    super(message);
    this.name = 'JsonLimitError';
    this.mcpCode = mcpCode;
  }
}

/** Reject duplicate object keys and nesting deeper than maxDepth. Depth 1 is the top value. */
export function assertJsonLimits(text: string, maxDepth: number): void {
  let index = 0;
  const length = text.length;

  function fail(mcpCode: number, message: string): never {
    throw new JsonLimitError(mcpCode, message);
  }

  function skipSpace(): void {
    while (index < length) {
      const char = text[index];
      if (char !== ' ' && char !== '\n' && char !== '\r' && char !== '\t') return;
      index += 1;
    }
  }

  function parseString(): string {
    if (text[index] !== '"') fail(-32700, 'Parse error');
    index += 1;
    let value = '';
    while (index < length) {
      const char = text[index];
      if (char === undefined) break;
      if (char === '"') {
        index += 1;
        return value;
      }
      if (char === '\\') {
        index += 1;
        const escaped = text[index];
        if (escaped === undefined) fail(-32700, 'Parse error');
        index += 1;
        if (escaped === '"' || escaped === '\\' || escaped === '/') {
          value += escaped;
          continue;
        }
        if (escaped === 'b') {
          value += '\b';
          continue;
        }
        if (escaped === 'f') {
          value += '\f';
          continue;
        }
        if (escaped === 'n') {
          value += '\n';
          continue;
        }
        if (escaped === 'r') {
          value += '\r';
          continue;
        }
        if (escaped === 't') {
          value += '\t';
          continue;
        }
        if (escaped === 'u') {
          const hex = text.slice(index, index + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail(-32700, 'Parse error');
          value += String.fromCharCode(Number.parseInt(hex, 16));
          index += 4;
          continue;
        }
        fail(-32700, 'Parse error');
      }
      if (char < ' ') fail(-32700, 'Parse error');
      value += char;
      index += 1;
    }
    fail(-32700, 'Parse error');
  }

  function parseValue(depth: number): void {
    skipSpace();
    const char = text[index];
    if (char === '{') {
      parseObject(depth + 1);
      return;
    }
    if (char === '[') {
      parseArray(depth + 1);
      return;
    }
    if (char === '"') {
      parseString();
      return;
    }
    if (char === '-' || (char !== undefined && char >= '0' && char <= '9') || char === 't' || char === 'f' || char === 'n') {
      while (index < length) {
        const next = text[index];
        if (next === undefined || ' \n\r\t,]}'.includes(next)) return;
        index += 1;
      }
      return;
    }
    fail(-32700, 'Parse error');
  }

  function parseObject(depth: number): void {
    if (depth > maxDepth) fail(-32600, 'JSON depth exceeds the limit');
    index += 1;
    const keys = new Set<string>();
    skipSpace();
    if (text[index] === '}') {
      index += 1;
      return;
    }
    while (index < length) {
      skipSpace();
      const key = parseString();
      if (keys.has(key)) fail(-32600, 'Duplicate JSON key');
      keys.add(key);
      skipSpace();
      if (text[index] !== ':') fail(-32700, 'Parse error');
      index += 1;
      parseValue(depth);
      skipSpace();
      if (text[index] === ',') {
        index += 1;
        continue;
      }
      if (text[index] === '}') {
        index += 1;
        return;
      }
      fail(-32700, 'Parse error');
    }
    fail(-32700, 'Parse error');
  }

  function parseArray(depth: number): void {
    if (depth > maxDepth) fail(-32600, 'JSON depth exceeds the limit');
    index += 1;
    skipSpace();
    if (text[index] === ']') {
      index += 1;
      return;
    }
    while (index < length) {
      parseValue(depth);
      skipSpace();
      if (text[index] === ',') {
        index += 1;
        continue;
      }
      if (text[index] === ']') {
        index += 1;
        return;
      }
      fail(-32700, 'Parse error');
    }
    fail(-32700, 'Parse error');
  }

  parseValue(0);
  skipSpace();
  if (index !== length) fail(-32700, 'Parse error');
}
