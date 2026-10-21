import { appendFileSync } from 'node:fs';
import dns from 'node:dns';
import net from 'node:net';

const log = process.env.FAD_NET_GUARD_LOG;

function note(host) {
  if (!log || host === undefined || host === null) return;
  const name = String(host).toLowerCase();
  if (name === '' || name === '127.0.0.1' || name === '::1' || name === 'localhost') return;
  appendFileSync(log, `${name}\n`);
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connectGuarded(...args) {
  const first = args[0];
  if (first && typeof first === 'object') note(first.host ?? first.hostname);
  if (typeof args[1] === 'string') note(args[1]);
  return connect.apply(this, args);
};

const lookup = dns.lookup;
dns.lookup = function lookupGuarded(hostname, ...rest) {
  note(hostname);
  return lookup.call(dns, hostname, ...rest);
};

const promisesLookup = dns.promises.lookup.bind(dns.promises);
dns.promises.lookup = async function lookupPromiseGuarded(hostname, options) {
  note(hostname);
  return promisesLookup(hostname, options);
};
