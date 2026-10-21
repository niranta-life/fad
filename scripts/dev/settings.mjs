import { UserMessage } from './user-message.mjs';

const ORDER = [
  'FAD_DEV_POSTGRES_PASSWORD',
  'FAD_APP_DB_PASSWORD',
  'FAD_API_KEY_PEPPER_V1',
  'FAD_PUBLISH_PORT',
  'FAD_PUBLISH_ADDRESS',
  'FAD_TAGS_ENABLED',
  'FAD_SLICE3_ENABLED',
  'FAD_MCP_ENABLED',
  'FAD_MCP_AUTH_ISSUERS',
  'FAD_MCP_RESOURCE_URI',
  'FAD_MCP_EXPECTED_AUDIENCE',
  'FAD_HTTP_ALLOWED_HOSTS',
];

const NAMES = {
  'postgres-password': 'FAD_DEV_POSTGRES_PASSWORD',
  'app-password': 'FAD_APP_DB_PASSWORD',
  pepper: 'FAD_API_KEY_PEPPER_V1',
  port: 'FAD_PUBLISH_PORT',
  'publish-address': 'FAD_PUBLISH_ADDRESS',
  tags: 'FAD_TAGS_ENABLED',
  slice3: 'FAD_SLICE3_ENABLED',
  mcp: 'FAD_MCP_ENABLED',
  'mcp-issuer': 'FAD_MCP_AUTH_ISSUERS',
  'mcp-resource': 'FAD_MCP_RESOURCE_URI',
  'mcp-audience': 'FAD_MCP_EXPECTED_AUDIENCE',
  'allowed-hosts': 'FAD_HTTP_ALLOWED_HOSTS',
};

const LABELS = {
  FAD_DEV_POSTGRES_PASSWORD: 'Database password',
  FAD_APP_DB_PASSWORD: 'App database password',
  FAD_API_KEY_PEPPER_V1: 'API pepper',
  FAD_PUBLISH_PORT: 'Port',
  FAD_PUBLISH_ADDRESS: 'Publish address',
  FAD_TAGS_ENABLED: 'Tags',
  FAD_SLICE3_ENABLED: 'Slice 3',
  FAD_MCP_ENABLED: 'MCP',
  FAD_MCP_AUTH_ISSUERS: 'MCP issuer',
  FAD_MCP_RESOURCE_URI: 'MCP resource',
  FAD_MCP_EXPECTED_AUDIENCE: 'MCP audience',
  FAD_HTTP_ALLOWED_HOSTS: 'Allowed hosts',
};

const SECRET_KEYS = new Set([
  'FAD_DEV_POSTGRES_PASSWORD',
  'FAD_APP_DB_PASSWORD',
  'FAD_API_KEY_PEPPER_V1',
]);

const SWITCH_KEYS = new Set(['FAD_TAGS_ENABLED', 'FAD_SLICE3_ENABLED', 'FAD_MCP_ENABLED']);

export function parseEnv(text) {
  const map = new Map();
  const extras = [];
  for (const line of String(text ?? '').split('\n')) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    if (ORDER.includes(key)) map.set(key, value);
    else extras.push([key, value]);
  }
  return { map, extras };
}

export function serializeEnv(map, extras = []) {
  const lines = ['# Local development settings. Do not commit this file.'];
  for (const key of ORDER) {
    if (map.has(key)) lines.push(`${key}=${map.get(key)}`);
  }
  for (const [key, value] of extras) lines.push(`${key}=${value}`);
  return `${lines.join('\n')}\n`;
}

function trimmed(value) {
  return String(value ?? '').trim();
}

function oneLine(value) {
  if (/[\r\n\0]/.test(value)) {
    throw new UserMessage('That value cannot include a line break. Enter it on one line and try again.');
  }
}

function asSwitch(value) {
  const text = trimmed(value).toLowerCase();
  if (text === 'on' || text === 'true' || text === 'yes') return 'true';
  if (text === 'off' || text === 'false' || text === 'no') return 'false';
  throw new UserMessage('Use on or off for that setting.');
}

function asPort(value) {
  const text = trimmed(value);
  if (!/^[1-9]\d*$/.test(text)) throw new UserMessage('That port is not valid. Use a whole number from 1 to 65535.');
  const port = Number(text);
  if (port < 1 || port > 65535) throw new UserMessage('That port is not valid. Use a whole number from 1 to 65535.');
  return String(port);
}

function asLoopback(value) {
  const text = trimmed(value).toLowerCase();
  if (text === '127.0.0.1' || text === 'localhost' || text === '::1') return text === 'localhost' ? 'localhost' : text;
  throw new UserMessage('That address is not this computer. Use 127.0.0.1 so the server stays on this computer only.');
}

function asPassword(value, label) {
  const text = trimmed(value);
  oneLine(text);
  if (text === '') throw new UserMessage(`The ${label} is empty. Choose a password and try again.`);
  return text;
}

function httpsIssuer(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new UserMessage('That issuer address is not valid. Use an https address with no path, then try again.');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new UserMessage('That issuer address is not valid. Use an https address with no path, then try again.');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new UserMessage('That issuer address is not valid. Use an https address with no path, then try again.');
  }
  return value;
}

function resourceUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new UserMessage('That resource address is not valid. Use the server address on this computer, then try again.');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new UserMessage('That resource address is not valid. Use the server address on this computer, then try again.');
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  if (url.protocol === 'http:' && !loopback) {
    throw new UserMessage('That resource address is not this computer. Use 127.0.0.1 for a development server.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UserMessage('That resource address is not valid. Use an http or https address, then try again.');
  }
  return value;
}

function issuerList(value) {
  const text = trimmed(value);
  oneLine(text);
  if (text === '') throw new UserMessage('The issuer address is empty. Enter an https address and try again.');
  const items = text.split(',').map((item) => item.trim()).filter(Boolean);
  const seen = new Set();
  for (const issuer of items) {
    httpsIssuer(issuer);
    if (seen.has(issuer)) throw new UserMessage('That issuer is listed twice. List each issuer once and try again.');
    seen.add(issuer);
  }
  return text;
}

function mcpReady(map) {
  const resource = trimmed(map.get('FAD_MCP_RESOURCE_URI'));
  const audience = trimmed(map.get('FAD_MCP_EXPECTED_AUDIENCE'));
  const issuers = trimmed(map.get('FAD_MCP_AUTH_ISSUERS'));
  const hosts = trimmed(map.get('FAD_HTTP_ALLOWED_HOSTS'));
  if (resource === '' || audience === '' || issuers === '' || hosts === '') return false;
  if (audience !== resource) return false;
  try {
    resourceUrl(resource);
    issuerList(issuers);
  } catch {
    return false;
  }
  return true;
}

function assertMcpCoherent(map) {
  if (map.get('FAD_MCP_ENABLED') !== 'true') return;
  const resource = trimmed(map.get('FAD_MCP_RESOURCE_URI'));
  const audience = trimmed(map.get('FAD_MCP_EXPECTED_AUDIENCE'));
  if (resource !== '' && audience !== '' && resource !== audience) {
    throw new UserMessage('The audience must be the same address as the resource. Turn MCP off, change both addresses, then turn MCP on.');
  }
  if (!mcpReady(map)) {
    throw new UserMessage('MCP is on, but the issuer settings are missing. Add the issuer, the resource address, the audience, and the allowed host. Then turn MCP on.');
  }
}

function checkPepper(value, assertPepper) {
  const text = trimmed(value);
  oneLine(text);
  try {
    assertPepper(text);
  } catch (error) {
    if (error && error.reason === 'missing') {
      throw new UserMessage('The API pepper is empty. Use a long random value and try again.');
    }
    throw new UserMessage('The API pepper is not strong enough. Use a long random value with many different characters, and try again.');
  }
  return text;
}

export function applyChange(original, name, rawValue, assertPepper) {
  const key = NAMES[name];
  if (!key) {
    throw new UserMessage('That setting is not used here. Run the review command to see the settings you can change.');
  }
  const { map, extras } = parseEnv(original);
  const next = new Map(map);
  if (key === 'FAD_DEV_POSTGRES_PASSWORD') next.set(key, asPassword(rawValue, 'database password'));
  else if (key === 'FAD_APP_DB_PASSWORD') next.set(key, asPassword(rawValue, 'app database password'));
  else if (key === 'FAD_API_KEY_PEPPER_V1') next.set(key, checkPepper(rawValue, assertPepper));
  else if (key === 'FAD_PUBLISH_PORT') next.set(key, asPort(rawValue));
  else if (key === 'FAD_PUBLISH_ADDRESS') next.set(key, asLoopback(rawValue));
  else if (key === 'FAD_TAGS_ENABLED' || key === 'FAD_SLICE3_ENABLED' || key === 'FAD_MCP_ENABLED') {
    const stored = asSwitch(rawValue);
    next.set(key, stored);
  } else if (key === 'FAD_MCP_AUTH_ISSUERS') {
    next.set(key, issuerList(rawValue));
  } else if (key === 'FAD_MCP_RESOURCE_URI') {
    const text = resourceUrl(trimmed(rawValue));
    oneLine(text);
    next.set(key, text);
  } else if (key === 'FAD_MCP_EXPECTED_AUDIENCE') {
    const text = trimmed(rawValue);
    oneLine(text);
    if (text === '') throw new UserMessage('The audience is empty. Use the same address as the resource and try again.');
    next.set(key, text);
  } else if (key === 'FAD_HTTP_ALLOWED_HOSTS') {
    const text = trimmed(rawValue);
    oneLine(text);
    if (text === '') throw new UserMessage('The allowed host is empty. Enter the host for this computer and try again.');
    next.set(key, text);
  }
  assertMcpCoherent(next);
  return serializeEnv(next, extras);
}

function shown(key, value) {
  if (value === undefined || trimmed(value) === '') return 'missing';
  if (SECRET_KEYS.has(key)) return 'set';
  if (SWITCH_KEYS.has(key)) return value === 'true' ? 'on' : value === 'false' ? 'off' : 'not valid';
  return value;
}

export function reviewText(original) {
  const { map } = parseEnv(original);
  const lines = ORDER.map((key) => `${LABELS[key]}: ${shown(key, map.get(key))}`);
  return `${lines.join('\n')}\n`;
}

export function startProblem(original, assertPepper) {
  const { map } = parseEnv(original);
  for (const [key, label] of [
    ['FAD_DEV_POSTGRES_PASSWORD', 'database password'],
    ['FAD_APP_DB_PASSWORD', 'app database password'],
  ]) {
    if (trimmed(map.get(key)) === '') {
      return `The ${label} is missing. Set it with the configuration command, then start the server again.`;
    }
  }
  const pepper = map.get('FAD_API_KEY_PEPPER_V1');
  if (trimmed(pepper) === '') return 'The API pepper is missing. Set a long random pepper, then start the server again.';
  try {
    assertPepper(trimmed(pepper));
  } catch {
    return 'The API pepper is not strong enough. Set a long random pepper, then start the server again.';
  }
  const port = map.get('FAD_PUBLISH_PORT');
  if (trimmed(port) === '') return 'The port is missing. Set a port from 1 to 65535, then start the server again.';
  try {
    asPort(port);
  } catch {
    return 'That port is not valid. Use a whole number from 1 to 65535.';
  }
  const address = map.get('FAD_PUBLISH_ADDRESS');
  if (address !== undefined && trimmed(address) !== '') {
    try {
      asLoopback(address);
    } catch {
      return 'That address is not this computer. Use 127.0.0.1 so the server stays on this computer only.';
    }
  }
  for (const key of SWITCH_KEYS) {
    const value = map.get(key);
    if (value === undefined || trimmed(value) === '') continue;
    if (value !== 'true' && value !== 'false') return 'A feature switch is not on or off. Fix it with the configuration command and try again.';
  }
  if (map.get('FAD_MCP_ENABLED') === 'true') {
    const resource = trimmed(map.get('FAD_MCP_RESOURCE_URI'));
    const audience = trimmed(map.get('FAD_MCP_EXPECTED_AUDIENCE'));
    if (resource !== '' && audience !== '' && resource !== audience) {
      return 'The audience must be the same address as the resource. Turn MCP off, change both addresses, then turn MCP on.';
    }
    if (!mcpReady(map)) {
      return 'MCP is on, but the issuer settings are missing. Add the issuer, the resource address, the audience, and the allowed host. Then start the server again.';
    }
  }
  return null;
}

export function publishPort(original) {
  const port = trimmed(parseEnv(original).map.get('FAD_PUBLISH_PORT'));
  return port === '' ? 8080 : Number(port);
}

export function secretValues(original) {
  const { map } = parseEnv(original);
  return [...SECRET_KEYS].map((key) => trimmed(map.get(key))).filter((value) => value.length >= 4);
}
