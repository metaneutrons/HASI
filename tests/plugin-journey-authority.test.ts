import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { expect, it } from 'vitest';
import { setJourneyHistoryAuthorityAvailability, spawnJourneyChild, stopJourneyChild, journeyHistoryAuthorityFaultResponse } from '../scripts/serve-plugin-journey.js';

const unavailableCommand = 'unavailable-history-authority';
const availableCommand = 'available-history-authority';

function spawnAuthorityReplica(directory: string, children: ChildProcess[], options: { holdValidAck?: boolean; exitOnCommand?: boolean } = {}): ChildProcess {
  return spawnJourneyChild({ executable: process.execPath, arguments: ['-e', `
    let availability = 'available';
    let pending;
    let holdValidAck = ${String(options.holdValidAck ?? false)};
    process.on('message', message => {
      if (message.command === '${unavailableCommand}' || message.command === '${availableCommand}') {
        availability = message.command === '${unavailableCommand}' ? 'unavailable' : 'available';
        if (${String(options.exitOnCommand ?? false)}) { process.disconnect(); process.exitCode = 0; return; }
        if (holdValidAck) {
          pending = message;
          process.send({ event: 'history-authority-state-applied', commandId: message.commandId, command: message.command,
            route: '/api/history/elsewhere', availability });
          process.send({ event: 'history-authority-state-applied', commandId: 'c097d209-6b5c-43be-8199-3e87711aec42', command: message.command,
            route: '/api/history/authority', availability });
          process.send({ event: 'history-authority-state-applied', commandId: message.commandId,
            command: message.command === '${unavailableCommand}' ? '${availableCommand}' : '${unavailableCommand}',
            route: '/api/history/authority', availability: availability === 'available' ? 'unavailable' : 'available' });
          process.send({ event: 'history-authority-state-applied', commandId: message.commandId, command: message.command,
            route: '/api/history/authority', availability: availability === 'available' ? 'unavailable' : 'available' });
          process.send({ event: 'invalid-history-ack-emitted' });
        } else {
          process.send({ event: 'history-authority-state-applied', commandId: message.commandId, command: message.command,
            route: '/api/history/authority', availability });
        }
      } else if (message.command === 'release-valid-history-ack' && pending) {
        process.send({ event: 'history-authority-state-applied', commandId: pending.commandId, command: pending.command,
          route: '/api/history/authority', availability });
        pending = undefined;
        holdValidAck = false;
      } else if (message.command === 'read-history-state') {
        process.send({ event: 'history-state-read', commandId: message.commandId, availability });
      }
    });
    process.on('SIGTERM', () => { if (process.connected) process.disconnect(); process.exitCode = 0; });
  `], cwd: directory, environment: {}, ipc: true, children, onUnexpectedExit: () => undefined });
}

function readAvailability(api: ChildProcess): Promise<string> {
  const commandId = randomUUID();
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, availability?: string) => {
      clearTimeout(timer);
      api.off('message', onMessage);
      if (error) reject(error); else if (availability) resolve(availability);
      else reject(new Error('The synthetic API replica returned no history authority state.'));
    };
    const onMessage = (message: unknown) => {
      if (typeof message !== 'object' || message === null || !('event' in message) || message.event !== 'history-state-read'
        || !('commandId' in message) || message.commandId !== commandId || !('availability' in message) || typeof message.availability !== 'string') return;
      finish(undefined, message.availability);
    };
    api.on('message', onMessage);
    const timer = setTimeout(() => { finish(new Error('A synthetic API replica did not return its history authority state.')); }, 2000);
    api.send({ command: 'read-history-state', commandId }, error => {
      if (error) finish(error);
    });
  });
}

it('faults only GET /api/history/authority and returns a generic 503 during the outage', () => {
  const outage = journeyHistoryAuthorityFaultResponse('GET', '/api/history/authority', 'unavailable');
  expect(outage).toEqual({ statusCode: 503, body: { error: 'Service unavailable.' } });
  expect(JSON.stringify(outage)).not.toContain('authorityDigest');
  expect(journeyHistoryAuthorityFaultResponse('GET', '/api/history/authority?view=current', 'unavailable')).toEqual(outage);
  expect(journeyHistoryAuthorityFaultResponse('GET', '/api/history/authority', 'available')).toBeUndefined();
  expect(journeyHistoryAuthorityFaultResponse('GET', '/api/history/other', 'unavailable')).toBeUndefined();
  expect(journeyHistoryAuthorityFaultResponse('POST', '/api/history/authority', 'unavailable')).toBeUndefined();
});

it('applies only matching authority acknowledgements and waits for both replicas', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hasi-journey-history-authority-'));
  const children: ChildProcess[] = [];
  try {
    const apis = [spawnAuthorityReplica(directory, children), spawnAuthorityReplica(directory, children, { holdValidAck: true })];
    const heldReplica = apis[1];
    if (!heldReplica) throw new Error('Held API replica was not started.');
    let commandSettled = false;
    const transition = setJourneyHistoryAuthorityAvailability(apis, unavailableCommand).then(() => { commandSettled = true; });
    const invalidAckBarrier = new Promise<void>(resolve => {
      const onMessage = (message: unknown) => {
        if (typeof message !== 'object' || message === null || !('event' in message) || message.event !== 'invalid-history-ack-emitted') return;
        heldReplica.off('message', onMessage);
        resolve();
      };
      heldReplica.on('message', onMessage);
    });
    await invalidAckBarrier;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(commandSettled).toBe(false);
    heldReplica.send({ command: 'release-valid-history-ack' });
    await transition;
    expect(await Promise.all(apis.map(readAvailability))).toEqual(['unavailable', 'unavailable']);

    await setJourneyHistoryAuthorityAvailability(apis, availableCommand);
    expect(await Promise.all(apis.map(readAvailability))).toEqual(['available', 'available']);
  } finally {
    await Promise.all(children.map(stopJourneyChild));
    await rm(directory, { recursive: true, force: true });
  }
});

it('rejects a missing replica, an exited replica, and a missing acknowledgement with listener cleanup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hasi-journey-history-authority-failure-'));
  const children: ChildProcess[] = [];
  try {
    const healthy = spawnAuthorityReplica(directory, children);
    await expect(setJourneyHistoryAuthorityAvailability([healthy], unavailableCommand)).rejects.toThrow('both distinct synthetic API replicas');
    expect(healthy.listenerCount('message')).toBe(0);
    await expect(setJourneyHistoryAuthorityAvailability([healthy, healthy], unavailableCommand)).rejects.toThrow('both distinct synthetic API replicas');

    const exiting = spawnAuthorityReplica(directory, children, { exitOnCommand: true });
    const exitingClosed = once(exiting, 'close');
    await expect(setJourneyHistoryAuthorityAvailability([healthy, exiting], unavailableCommand)).rejects.toThrow('stopped before acknowledging');
    expect(healthy.listenerCount('message')).toBe(0);
    expect(exiting.listenerCount('message')).toBe(0);
    await exitingClosed;

    const silent = spawnJourneyChild({ executable: process.execPath, arguments: ['-e', `
      process.on('message', message => {
        if (message.command === '${unavailableCommand}') process.send({ event: 'history-authority-state-applied',
          commandId: 'c097d209-6b5c-43be-8199-3e87711aec42', command: '${unavailableCommand}', route: '/api/history/authority', availability: 'unavailable' });
      });
      process.on('SIGTERM', () => { if (process.connected) process.disconnect(); process.exitCode = 0; });
    `], cwd: directory, environment: {}, ipc: true, children, onUnexpectedExit: () => undefined });
    await expect(setJourneyHistoryAuthorityAvailability([healthy, silent], unavailableCommand)).rejects.toThrow('did not acknowledge');
    expect(healthy.listenerCount('message')).toBe(0);
    expect(silent.listenerCount('message')).toBe(0);
  } finally {
    await Promise.all(children.map(stopJourneyChild));
    await rm(directory, { recursive: true, force: true });
  }
}, 12_000);
