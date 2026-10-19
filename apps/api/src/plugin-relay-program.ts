export const PLUGIN_RELAY_LIMITS = Object.freeze({
  maxConnections: 16,
  connectTimeoutMs: 2_000,
  idleTimeoutMs: 10_000,
  lifetimeMs: 30_000,
  maxBytesPerDirection: 2 * 1024 * 1024,
});

/**
 * Standalone source for the trusted platform TCP relay. It is passed directly
 * to `node --input-type=module -e`, so it must not depend on this module at run
 * time.
 */
export const PLUGIN_RELAY_PROGRAM = String.raw`
import net from 'node:net';

const MAX_CONNECTIONS = ${PLUGIN_RELAY_LIMITS.maxConnections};
const CONNECT_TIMEOUT_MS = ${PLUGIN_RELAY_LIMITS.connectTimeoutMs};
const IDLE_TIMEOUT_MS = ${PLUGIN_RELAY_LIMITS.idleTimeoutMs};
const LIFETIME_MS = ${PLUGIN_RELAY_LIMITS.lifetimeMs};
const MAX_BYTES_PER_DIRECTION = ${PLUGIN_RELAY_LIMITS.maxBytesPerDirection};

function isPrivateIPv4(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some(part => !/^(?:0|[1-9][0-9]{0,2})$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some(octet => octet > 255)) return false;
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function parsePort(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,4}$/.test(value)) return undefined;
  const port = Number(value);
  return port <= 65535 ? port : undefined;
}

const targetAddress = process.env.HASI_RELAY_TARGET_ADDRESS;
const targetPort = parsePort(process.env.HASI_RELAY_TARGET_PORT);
const listenPort = parsePort(process.env.HASI_RELAY_LISTEN_PORT);

if (!isPrivateIPv4(targetAddress) || targetPort === undefined || listenPort === undefined) {
  process.exitCode = 1;
} else {
  const active = new Set();
  const server = net.createServer({ allowHalfOpen: true });
  let shuttingDown = false;
  let listening = false;

  function clearTimers(pair) {
    clearTimeout(pair.connectTimer);
    clearTimeout(pair.idleTimer);
    clearTimeout(pair.lifetimeTimer);
  }

  function finishPair(pair) {
    if (pair.closed) return;
    pair.closed = true;
    clearTimers(pair);
    active.delete(pair);
  }

  function destroyPair(pair) {
    if (pair.closing || pair.closed) return;
    pair.closing = true;
    clearTimers(pair);
    pair.client.destroy();
    pair.target.destroy();
  }

  function resetIdleTimer(pair) {
    clearTimeout(pair.idleTimer);
    pair.idleTimer = setTimeout(() => destroyPair(pair), IDLE_TIMEOUT_MS);
  }

  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const pair of active) destroyPair(pair);
    if (listening) server.close(() => {});
  }

  function connectClient(client) {
    if (shuttingDown || active.size >= MAX_CONNECTIONS) {
      client.destroy();
      return;
    }

    client.pause();
    const target = net.createConnection({ host: targetAddress, port: targetPort, family: 4 });
    target.pause();

    const pair = {
      client,
      target,
      clientBytes: 0,
      targetBytes: 0,
      connected: false,
      closing: false,
      closed: false,
      clientEnded: false,
      targetEnded: false,
      connectTimer: undefined,
      idleTimer: undefined,
      lifetimeTimer: undefined,
    };
    active.add(pair);

    function forward(source, destination, direction) {
      source.on('data', chunk => {
        if (pair.closing) return;
        const nextBytes = pair[direction] + chunk.length;
        if (nextBytes > MAX_BYTES_PER_DIRECTION) {
          destroyPair(pair);
          return;
        }
        pair[direction] = nextBytes;
        resetIdleTimer(pair);
        if (!destination.write(chunk)) source.pause();
      });
      destination.on('drain', () => {
        if (pair.connected && !pair.closing) source.resume();
      });
      source.on('end', () => {
        if (direction === 'clientBytes') pair.clientEnded = true;
        else pair.targetEnded = true;
        if (!pair.closing && !destination.destroyed) destination.end();
      });
    }

    client.on('error', () => destroyPair(pair));
    target.on('error', () => destroyPair(pair));
    forward(client, target, 'clientBytes');
    forward(target, client, 'targetBytes');

    client.on('close', hadError => {
      if (pair.closing) {
        if (client.destroyed && target.destroyed) finishPair(pair);
        return;
      }
      if (hadError) destroyPair(pair);
      else if (target.destroyed) finishPair(pair);
      else if (!pair.clientEnded) destroyPair(pair);
    });
    target.on('close', hadError => {
      if (pair.closing) {
        if (client.destroyed && target.destroyed) finishPair(pair);
        return;
      }
      if (hadError) destroyPair(pair);
      else if (client.destroyed) finishPair(pair);
      else if (!pair.targetEnded) destroyPair(pair);
    });

    pair.connectTimer = setTimeout(() => destroyPair(pair), CONNECT_TIMEOUT_MS);
    pair.idleTimer = setTimeout(() => destroyPair(pair), IDLE_TIMEOUT_MS);
    pair.lifetimeTimer = setTimeout(() => destroyPair(pair), LIFETIME_MS);

    target.once('connect', () => {
      if (pair.closing) return;
      pair.connected = true;
      clearTimeout(pair.connectTimer);
      client.resume();
      target.resume();
    });
  }

  server.on('connection', connectClient);
  server.on('listening', () => {
    listening = true;
    if (shuttingDown) server.close(() => {});
  });
  server.on('error', () => {
    process.exitCode = 1;
    shutdown();
  });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  server.listen({ host: '0.0.0.0', port: listenPort });
}
`;
