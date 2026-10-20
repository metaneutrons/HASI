import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { expect, it } from 'vitest';
import type { PluginAccountAdapter } from '../apps/api/src/plugin-accounts.js';
import { JourneyReferenceAccountAdapter, revokeReferenceProvider, sendReferenceCommand, spawnJourneyChild, stopJourneyChild } from '../scripts/serve-plugin-journey.js';

it('handles a failed spawn and still stops an earlier owned process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hasi-journey-spawn-'));
  const children: ChildProcess[] = [];
  let unexpectedExits = 0;
  try {
    const running = spawnJourneyChild({ executable: process.execPath, arguments: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: directory, environment: {}, ipc: false, children, onUnexpectedExit: () => { unexpectedExits++; } });
    expect(running.pid).toBeGreaterThan(0);
    expect(() => spawnJourneyChild({ executable: join(directory, 'missing-executable'), arguments: [],
      cwd: directory, environment: {}, ipc: false, children, onUnexpectedExit: () => { unexpectedExits++; } })).toThrow('could not start');
    expect(children).toHaveLength(2);
    const failed = children[1];
    if (!failed) throw new Error('Failed child was not registered for cleanup');
    // close follows the handled error, whereas failed spawn never emits exit.
    await new Promise<void>(resolve => { failed.once('close', () => { resolve(); }); });
    expect(unexpectedExits).toBe(1);
    expect(failed.pid).toBeUndefined();
    await expect(stopJourneyChild(failed)).resolves.toBeUndefined();
    const stopped = once(running, 'exit');
    await stopJourneyChild(running);
    await stopped;
    expect(running.signalCode).toBe('SIGTERM');
    await expect(stopJourneyChild(running)).resolves.toBeUndefined();
  } finally {
    await Promise.all(children.map(stopJourneyChild));
    await rm(directory, { recursive: true, force: true });
  }
});


it('accepts only the matching owned IPC acknowledgement and rejects a lost process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hasi-journey-ipc-'));
  const children: ChildProcess[] = [];
  try {
    const child = spawnJourneyChild({ executable: process.execPath, arguments: ['-e', `
      process.on('message', message => {
        if (message.command === 'source-unavailable') { process.disconnect(); process.exitCode = 0; return; }
        process.send({ event: 'reference-command-applied', commandId: 'foreign', command: message.command, stats: { marks: 999 } });
        process.send({ event: 'reference-command-applied', commandId: message.commandId, command: message.command,
          ...(message.command === 'stats' ? { stats: { marks: 1, journalRows: 1, sourceRows: 1, invocationRows: 2 } } : {}) });
      });
      process.on('SIGTERM', () => { if (process.connected) process.disconnect(); process.exitCode = 0; });
    `], cwd: directory, environment: {}, ipc: true, children, onUnexpectedExit: () => { /* This probe deliberately disconnects its owned child. */ } });
    expect(await sendReferenceCommand(child, 'stats')).toEqual({ marks: 1, journalRows: 1, sourceRows: 1, invocationRows: 2 });
    expect(await sendReferenceCommand(child, 'lose-next-execution-ack')).toBeUndefined();
    await expect(sendReferenceCommand(child, 'source-unavailable')).rejects.toThrow('lost its process');
    await expect(sendReferenceCommand(child, 'stats')).rejects.toThrow('not available');
  } finally {
    await Promise.all(children.map(stopJourneyChild));
    await rm(directory, { recursive: true, force: true });
  }
});

it('models external reference revocation at the provider seam without calling host revocation', async () => {
  let delegateRevocations = 0;
  const delegate: PluginAccountAdapter = {
    trustLevel: 'demo-only',
    begin: () => Promise.resolve({ authorizationUrl: '/consent' }),
    complete: () => Promise.resolve({ expiresAt: null, authorityRevision: 2 }),
    inspect: () => Promise.resolve({ status: 'active', authorityRevision: 4, expiresAt: null,
      projection: { permissions: ['reference:read'], claims: { 'reference.account': 'synthetic-student' } } }),
    revoke: () => { delegateRevocations++; return Promise.resolve(); },
  };
  const adapter = new JourneyReferenceAccountAdapter(delegate);
  const adminSubject = 'stable-oidc-admin-subject';
  const adminContext = { subject: adminSubject, installationId: 'hasi.reference', signal: AbortSignal.timeout(1000) };
  const studentContext = { ...adminContext, subject: 'stable-oidc-student-subject' };

  await expect(adapter.inspect(adminContext)).resolves.toMatchObject({ status: 'active', authorityRevision: 4 });
  adapter.revokeAtProvider(adminSubject);
  await expect(adapter.inspect(adminContext)).resolves.toMatchObject({ status: 'revoked', authorityRevision: 5, projection: undefined });
  adapter.revokeAtProvider(adminSubject);
  await expect(adapter.inspect(adminContext)).resolves.toMatchObject({ status: 'revoked', authorityRevision: 5, projection: undefined });
  await expect(adapter.inspect(studentContext)).resolves.toMatchObject({ status: 'active', authorityRevision: 4 });
  expect(delegateRevocations).toBe(0);
});

it('waits for provider revocation state acknowledgements from both API replicas', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hasi-journey-reference-revoke-'));
  const children: ChildProcess[] = [];
  try {
    const spawnReplica = (holdValidAck: boolean) => spawnJourneyChild({ executable: process.execPath, arguments: ['-e', `
      const providerRevokedPersonas = new Set();
      let pendingCommandId;
      process.on('message', message => {
        if (message.command === 'revoke-reference-provider') {
          if (${String(holdValidAck)}) {
            pendingCommandId = message.commandId;
            process.send({ event: 'reference-provider-state-applied', commandId: message.commandId,
              installationId: 'hasi.reference', persona: 'student', status: 'revoked' });
            process.send({ event: 'forged-provider-ack-emitted', commandId: message.commandId });
          } else {
            providerRevokedPersonas.add('admin');
            process.send({ event: 'reference-provider-state-applied', commandId: message.commandId,
              installationId: 'hasi.reference', persona: 'admin', status: 'revoked' });
          }
        } else if (message.command === 'release-provider-revocation' && pendingCommandId) {
          providerRevokedPersonas.add('admin');
          process.send({ event: 'reference-provider-state-applied', commandId: pendingCommandId,
            installationId: 'hasi.reference', persona: 'admin', status: 'revoked' });
          pendingCommandId = undefined;
        } else if (message.command === 'read-provider-state' && ['admin', 'student'].includes(message.persona)) {
          process.send({ event: 'provider-state', commandId: message.commandId, persona: message.persona,
            status: providerRevokedPersonas.has(message.persona) ? 'revoked' : 'active' });
        }
      });
      process.on('SIGTERM', () => { if (process.connected) process.disconnect(); process.exitCode = 0; });
    `], cwd: directory, environment: {}, ipc: true, children, onUnexpectedExit: () => { /* Deliberate test child lifecycle. */ } });
    const apis = [spawnReplica(false), spawnReplica(true)];
    const heldReplica = apis[1];
    if (!heldReplica) throw new Error('Held API replica was not started.');

    let revocationSettled = false;
    let revocationFailure: unknown;
    const revocation = revokeReferenceProvider(apis).then(() => { revocationSettled = true; }, (error: unknown) => {
      revocationSettled = true;
      revocationFailure = error;
    });
    const forgedAckBarrier = new Promise<void>(resolve => {
      const onMessage = (message: unknown) => {
        if (typeof message !== 'object' || message === null || !('event' in message) || message.event !== 'forged-provider-ack-emitted') return;
        heldReplica.off('message', onMessage);
        resolve();
      };
      heldReplica.on('message', onMessage);
    });
    await forgedAckBarrier;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(revocationSettled).toBe(false);
    heldReplica.send({ command: 'release-provider-revocation' });
    await revocation;
    expect(revocationFailure).toBeUndefined();

    const readProviderState = (api: ChildProcess, persona: 'admin' | 'student') => new Promise<string>((resolve, reject) => {
      const commandId = crypto.randomUUID();
      const onMessage = (message: unknown) => {
        if (typeof message !== 'object' || message === null || !('event' in message) || message.event !== 'provider-state'
          || !('commandId' in message) || message.commandId !== commandId || !('persona' in message) || message.persona !== persona
          || !('status' in message) || typeof message.status !== 'string') return;
        api.off('message', onMessage);
        resolve(message.status);
      };
      api.on('message', onMessage);
      api.send({ command: 'read-provider-state', commandId, persona }, error => {
        if (error) { api.off('message', onMessage); reject(error); }
      });
    });
    const states = await Promise.all(apis.map(async api => [await readProviderState(api, 'admin'), await readProviderState(api, 'student')]));
    expect(states).toEqual([['revoked', 'active'], ['revoked', 'active']]);
  } finally {
    await Promise.all(children.map(stopJourneyChild));
    await rm(directory, { recursive: true, force: true });
  }
});
