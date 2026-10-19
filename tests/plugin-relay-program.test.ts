import { networkInterfaces } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import net, { type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { PLUGIN_RELAY_LIMITS, PLUGIN_RELAY_PROGRAM } from '../apps/api/src/plugin-relay-program.js';

const privateTargetAddress = Object.values(networkInterfaces())
  .flatMap(interfaces => interfaces ?? [])
  .filter(address => address.family === 'IPv4' && !address.internal && isPrivateIPv4(address.address))
  .map(address => address.address)
  .sort((left, right) => compareIPv4(left, right))[0];

// Test-only scheduling: emit SIGTERM synchronously after listen() begins and
// before Node delivers the relay server's `listening` event.
const signalBeforeListeningPreload = [
  "import net from 'node:net';",
  'const originalListen = net.Server.prototype.listen;',
  'net.Server.prototype.listen = function (...args) {',
  '  const result = originalListen.apply(this, args);',
  "  if (args[0] && typeof args[0] === 'object' && args[0].host === '0.0.0.0') process.emit('SIGTERM');",
  '  return result;',
  '};',
].join('\n');

function holdFirstTargetConnectPreload(address: string, port: number): string {
  return [
    "import net from 'node:net';",
    'const originalCreateConnection = net.createConnection;',
    'let holdFirstTargetConnect = true;',
    'net.createConnection = function (...args) {',
    '  const options = args[0];',
    `  if (holdFirstTargetConnect && options && typeof options === 'object' && options.host === ${JSON.stringify(address)} && options.port === ${String(port)}) {`,
    '    holdFirstTargetConnect = false;',
    '    return new net.Socket();',
    '  }',
    '  return originalCreateConnection.apply(this, args);',
    '};',
  ].join('\n');
}

const children: ChildProcess[] = [];
const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  let cleanupFailure: Error | undefined;
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    child.kill('SIGTERM');
    const exitCode = await waitForExit(child, 1_000);
    if (exitCode === undefined) {
      child.kill('SIGKILL');
      await waitForExit(child, 1_000);
      cleanupFailure = new Error('A relay child required SIGKILL after SIGTERM.');
    } else if (exitCode !== 0) {
      cleanupFailure = new Error(`A relay child exited unexpectedly during cleanup (${String(exitCode)}).`);
    }
  }
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map(server => closeServer(server)));
  if (cleanupFailure) throw cleanupFailure;
});

describe('standalone plugin TCP relay program', () => {
  it.each([
    ['loopback', '127.0.0.1'],
    ['public IPv4', '8.8.8.8'],
    ['DNS name', 'plugin.internal'],
    ['malformed IPv4', '10.0.0.999'],
  ])('rejects a %s target without echoing configuration', async (_label, address) => {
    const result = await runInvalidConfig(address);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('closes the listener when SIGTERM arrives before the listening event', async () => {
    const relayPort = await freeLoopbackPort();
    const relay = startRelay('10.0.0.1', 1234, relayPort, signalBeforeListeningPreload);
    await expect(waitForExit(relay)).resolves.toBe(0);
    await expect(connect(relayPort)).rejects.toThrow();
  });

  it('closes an unconnected target after the connect timeout, releases its slot, and forwards a later connection', async context => {
    if (!privateTargetAddress) return context.skip();
    const targetSockets: Socket[] = [];
    const target = createEchoTarget(targetSockets);
    servers.push(target);
    const targetPort = await listen(target, privateTargetAddress);
    const relayPort = await freeLoopbackPort();
    const relay = startRelay(privateTargetAddress, targetPort, relayPort, holdFirstTargetConnectPreload(privateTargetAddress, targetPort));

    const pendingClient = await connectWhenAvailable(relay, relayPort);
    const pendingClosed = waitForClose(pendingClient, PLUGIN_RELAY_LIMITS.connectTimeoutMs + 5_000);
    const holderClients = await Promise.all(Array.from({ length: PLUGIN_RELAY_LIMITS.maxConnections - 1 }, () => connect(relayPort)));
    await waitUntil(async () => await getConnectionCount(target) === PLUGIN_RELAY_LIMITS.maxConnections - 1);

    const overflow = await connect(relayPort);
    await expect(waitForClose(overflow)).resolves.toBeUndefined();
    await expect(pendingClosed).resolves.toBeUndefined();
    expect(await getConnectionCount(target)).toBe(PLUGIN_RELAY_LIMITS.maxConnections - 1);

    const payload = Buffer.from('recovered-after-connect-timeout');
    await expect(exchangeUntilEcho(relayPort, payload)).resolves.toEqual(payload);
    expect(targetSockets).toHaveLength(PLUGIN_RELAY_LIMITS.maxConnections);
    for (const client of holderClients) client.destroy();
  }, PLUGIN_RELAY_LIMITS.connectTimeoutMs + 10_000);

  it.each([
    ['target', '0', '1234'],
    ['target', '65536', '1234'],
    ['listen', '1234', '0'],
    ['listen', '1234', '65536'],
  ])('rejects an invalid %s port without starting', async (_label, targetPort, listenPort) => {
    const result = await runInvalidConfig('10.0.0.1', targetPort, listenPort);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('forwards raw CONNECT bytes only to the configured RFC1918 target', async context => {
    if (!privateTargetAddress) return context.skip();
    const received: Buffer[] = [];
    const target = net.createServer(socket => {
      sockets.push(socket);
      socket.on('data', chunk => {
        received.push(Buffer.from(chunk));
        socket.write(chunk);
      });
      socket.on('end', () => socket.end());
    });
    servers.push(target);
    const targetPort = await listen(target, privateTargetAddress);
    const relayPort = await freeLoopbackPort();
    const relay = startRelay(privateTargetAddress, targetPort, relayPort);
    await waitForRelay(relay, relayPort);

    const payload = Buffer.from('CONNECT 198.51.100.20:443 HTTP/1.1\r\nHost: 198.51.100.20\r\n\r\nfixed-target-proof');
    const response = await exchange(relayPort, payload);
    expect(Buffer.concat(received)).toEqual(payload);
    expect(response).toEqual(payload);
  });

  it('enforces the per-direction byte cap and closes the connection pair', async context => {
    if (!privateTargetAddress) return context.skip();
    let targetBytes = 0;
    const target = net.createServer(socket => {
      sockets.push(socket);
      socket.on('data', chunk => { targetBytes += chunk.length; });
    });
    servers.push(target);
    const targetPort = await listen(target, privateTargetAddress);
    const relayPort = await freeLoopbackPort();
    const relay = startRelay(privateTargetAddress, targetPort, relayPort);
    await waitForRelay(relay, relayPort);

    const client = await connect(relayPort);
    sockets.push(client);
    const closed = waitForClose(client);
    client.write(Buffer.alloc(PLUGIN_RELAY_LIMITS.maxBytesPerDirection + 1, 0x61));
    await expect(closed).resolves.toBeUndefined();
    expect(targetBytes).toBeLessThanOrEqual(PLUGIN_RELAY_LIMITS.maxBytesPerDirection);
    expect(relay.exitCode).toBeNull();
  });

  it('limits each relay process to sixteen simultaneous connections', async context => {
    if (!privateTargetAddress) return context.skip();
    const targetSockets: Socket[] = [];
    const target = net.createServer(socket => {
      targetSockets.push(socket);
      sockets.push(socket);
    });
    servers.push(target);
    const targetPort = await listen(target, privateTargetAddress);
    const relayPort = await freeLoopbackPort();
    const relay = startRelay(privateTargetAddress, targetPort, relayPort);
    await waitForRelay(relay, relayPort);
    await waitUntil(() => targetSockets.length > 0);
    await waitUntil(async () => await getConnectionCount(target) === 0);

    const clients = await Promise.all(Array.from({ length: PLUGIN_RELAY_LIMITS.maxConnections }, () => connect(relayPort)));
    await waitUntil(async () => await getConnectionCount(target) === PLUGIN_RELAY_LIMITS.maxConnections);
    const overflow = await connect(relayPort);
    const overflowClosed = waitForClose(overflow);
    await expect(overflowClosed).resolves.toBeUndefined();
    expect(await getConnectionCount(target)).toBe(PLUGIN_RELAY_LIMITS.maxConnections);
    for (const client of clients) client.destroy();
  });

  it('expires idle pairs after ten seconds, closes both ends, frees a full slot set, and accepts a new connection', async context => {
    if (!privateTargetAddress) return context.skip();
    const targetSockets: Socket[] = [];
    const target = createEchoTarget(targetSockets);
    servers.push(target);
    const targetPort = await listen(target, privateTargetAddress);
    const relayPort = await freeLoopbackPort();
    const relay = startRelay(privateTargetAddress, targetPort, relayPort);
    await waitForRelay(relay, relayPort);
    await waitUntil(() => targetSockets.length > 0);
    await waitUntil(async () => await getConnectionCount(target) === 0);
    const readinessConnections = targetSockets.length;

    const idleTargetIndex = targetSockets.length;
    const idleClient = await connect(relayPort);
    await waitUntil(async () => await getConnectionCount(target) === 1);
    const idleTarget = targetSockets[idleTargetIndex]!;
    const idleClientClosed = waitForClose(idleClient, PLUGIN_RELAY_LIMITS.idleTimeoutMs + 5_000);
    const idleTargetClosed = waitForClose(idleTarget, PLUGIN_RELAY_LIMITS.idleTimeoutMs + 5_000);
    const keepAliveClients = await Promise.all(Array.from({ length: PLUGIN_RELAY_LIMITS.maxConnections - 1 }, () => connect(relayPort)));
    await waitUntil(async () => await getConnectionCount(target) === PLUGIN_RELAY_LIMITS.maxConnections);

    const keepAlive = () => {
      for (const client of keepAliveClients) {
        if (!client.destroyed) client.write('keep');
      }
    };
    keepAlive();
    const keepAliveTimer = setInterval(keepAlive, 2_000);
    try {
      await Promise.all([idleClientClosed, idleTargetClosed]);
      expect(await getConnectionCount(target)).toBe(PLUGIN_RELAY_LIMITS.maxConnections - 1);
      const payload = Buffer.from('reused-after-idle-timeout');
      await expect(exchangeUntilEcho(relayPort, payload)).resolves.toEqual(payload);
      expect(targetSockets).toHaveLength(readinessConnections + PLUGIN_RELAY_LIMITS.maxConnections + 1);
    } finally {
      clearInterval(keepAliveTimer);
      for (const client of keepAliveClients) client.destroy();
    }
  }, PLUGIN_RELAY_LIMITS.idleTimeoutMs + 8_000);

  it('expires an active pair at thirty seconds despite periodic traffic, closes both ends, and accepts a new connection', async context => {
    if (!privateTargetAddress) return context.skip();
    const targetSockets: Socket[] = [];
    let targetBytes = 0;
    const target = createEchoTarget(targetSockets, chunk => { targetBytes += chunk.length; });
    servers.push(target);
    const targetPort = await listen(target, privateTargetAddress);
    const relayPort = await freeLoopbackPort();
    const relay = startRelay(privateTargetAddress, targetPort, relayPort);
    await waitForRelay(relay, relayPort);
    await waitUntil(() => targetSockets.length > 0);
    await waitUntil(async () => await getConnectionCount(target) === 0);

    const targetPeerIndex = targetSockets.length;
    const client = await connect(relayPort);
    await waitUntil(async () => await getConnectionCount(target) === 1);
    const targetPeer = targetSockets[targetPeerIndex]!;
    let clientBytes = 0;
    client.on('data', chunk => { clientBytes += chunk.length; });
    const clientClosed = waitForClose(client, PLUGIN_RELAY_LIMITS.lifetimeMs + 5_000);
    const targetClosed = waitForClose(targetPeer, PLUGIN_RELAY_LIMITS.lifetimeMs + 5_000);
    const sendHeartbeat = () => { if (!client.destroyed) client.write('tick'); };
    sendHeartbeat();
    const heartbeatTimer = setInterval(sendHeartbeat, 4_000);
    try {
      await Promise.all([clientClosed, targetClosed]);
      expect(targetBytes).toBeGreaterThanOrEqual(20);
      expect(clientBytes).toBeGreaterThanOrEqual(20);
      const payload = Buffer.from('reused-after-lifetime-timeout');
      await expect(exchangeUntilEcho(relayPort, payload)).resolves.toEqual(payload);
    } finally {
      clearInterval(heartbeatTimer);
    }
  }, PLUGIN_RELAY_LIMITS.lifetimeMs + 8_000);

  it('closes the listener and destroys active pairs on SIGTERM', async context => {
    if (!privateTargetAddress) return context.skip();
    const target = net.createServer(socket => sockets.push(socket));
    servers.push(target);
    const targetPort = await listen(target, privateTargetAddress);
    const relayPort = await freeLoopbackPort();
    const relay = startRelay(privateTargetAddress, targetPort, relayPort);
    await waitForRelay(relay, relayPort);

    const client = await connect(relayPort);
    sockets.push(client);
    await waitUntil(async () => await getConnectionCount(target) > 0);
    const clientClosed = waitForClose(client);
    relay.kill('SIGTERM');
    await expect(waitForExit(relay)).resolves.toBe(0);
    await expect(clientClosed).resolves.toBeUndefined();
    await expect(connect(relayPort)).rejects.toThrow();
  });
});

function isPrivateIPv4(value: string): boolean {
  const octets = value.split('.').map(Number);
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  return octets[0] === 10
    || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function compareIPv4(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 4; index++) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

async function runInvalidConfig(address: string, targetPort = '1234', listenPort?: string): Promise<{ code: number | null | undefined; stdout: string; stderr: string }> {
  const fallbackListenPort = await freeLoopbackPort();
  const child = spawn(process.execPath, ['--input-type=module', '-e', PLUGIN_RELAY_PROGRAM], {
    env: { HASI_RELAY_TARGET_ADDRESS: address, HASI_RELAY_TARGET_PORT: targetPort, HASI_RELAY_LISTEN_PORT: listenPort ?? String(fallbackListenPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  const code = await waitForExit(child);
  if (code === undefined) {
    child.kill('SIGKILL');
    await waitForExit(child, 1_000);
  }
  return { code, stdout: await stdout, stderr: await stderr };
}

function startRelay(address: string, targetPort: number, listenPort: number, preload?: string): ChildProcess {
  const argumentsForNode = preload
    ? ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, '--input-type=module', '-e', PLUGIN_RELAY_PROGRAM]
    : ['--input-type=module', '-e', PLUGIN_RELAY_PROGRAM];
  const child = spawn(process.execPath, argumentsForNode, {
    env: {
      HASI_RELAY_TARGET_ADDRESS: address,
      HASI_RELAY_TARGET_PORT: String(targetPort),
      HASI_RELAY_LISTEN_PORT: String(listenPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  return child;
}

async function listen(server: Server, host: string): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host, port: 0 }, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address) throw new Error('Fixture TCP server did not bind.');
  if (typeof address === 'string') throw new Error('Fixture TCP server bound to a non-TCP address.');
  return address.port;
}

async function freeLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await listen(server, '127.0.0.1');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback fixture did not bind to TCP.');
  await closeServer(server);
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('Fixture TCP server did not close in time.')); }, 3_000);
    server.close(error => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
  });
}

async function getConnectionCount(server: Server): Promise<number> {
  return await new Promise((resolve, reject) => {
    server.getConnections((error, count) => {
      if (error) reject(error);
      else resolve(count);
    });
  });
}

async function waitForRelay(child: ChildProcess, port: number): Promise<void> {
  await waitUntil(async () => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Relay exited before listening (code ${String(child.exitCode)}).`);
    try {
      const probe = await connect(port, 150);
      probe.destroy();
      return true;
    } catch {
      return false;
    }
  });
}

async function connectWhenAvailable(child: ChildProcess, port: number): Promise<Socket> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Relay exited before accepting a connection (code ${String(child.exitCode)}).`);
    try {
      return await connect(port, 150);
    } catch {
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  }
  throw new Error('Relay did not begin accepting connections in time.');
}

async function connect(port: number, timeoutMs = 1_000): Promise<Socket> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Timed out connecting to relay.'));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      sockets.push(socket);
      resolve(socket);
    });
    socket.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function exchange(port: number, payload: Buffer, timeoutMs = 3_000): Promise<Buffer> {
  const socket = await connect(port);
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('TCP exchange did not close in time.'));
    }, timeoutMs);
    socket.on('data', chunk => { chunks.push(Buffer.from(chunk)); });
    socket.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once('close', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    socket.end(payload);
  });
}

async function exchangeUntilEcho(port: number, payload: Buffer, timeoutMs = 3_000): Promise<Buffer> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await exchange(port, payload, Math.min(500, deadline - Date.now()));
      if (response.equals(payload)) return response;
    } catch {
      // A just-expired pair may still be delivering its final close event.
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Relay did not forward a new connection after the previous pair expired.');
}

function createEchoTarget(targetSockets: Socket[], onData?: (chunk: Buffer) => void): Server {
  return net.createServer(socket => {
    targetSockets.push(socket);
    socket.on('data', chunk => {
      onData?.(chunk);
      socket.write(chunk);
    });
    socket.on('end', () => socket.end());
  });
}

function waitForClose(socket: Socket, timeoutMs = 3_000): Promise<void> {
  if (socket.closed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeListener('close', onClose);
      reject(new Error('TCP socket did not close in time.'));
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.once('close', onClose);
  });
}

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('Condition was not met before the timeout.');
}

function waitForExit(child: ChildProcess, timeoutMs = 3_000): Promise<number | null | undefined> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  if (child.signalCode !== null) return Promise.resolve(null);
  return new Promise(resolve => {
    const finish = (code: number | null | undefined) => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(code);
    };
    const onExit = (code: number | null) => { finish(code); };
    const timer = setTimeout(() => { finish(undefined); }, timeoutMs);
    child.once('exit', onExit);
  });
}

function collect(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise(resolve => {
    let value = '';
    stream.setEncoding('utf8');
    stream.on('data', chunk => { value += String(chunk); });
    stream.on('end', () => { resolve(value); });
  });
}
