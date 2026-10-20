import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { expect, it } from 'vitest';
import { sendReferenceCommand, spawnJourneyChild, stopJourneyChild } from '../scripts/serve-plugin-journey.js';

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
