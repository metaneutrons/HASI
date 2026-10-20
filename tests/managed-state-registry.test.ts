import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { fixture, closeManagedStateFixtures } from './helpers/managed-state-registry.js';
afterEach(closeManagedStateFixtures);

describe('actual registry, streaming gateway and SDK durable state callbacks', () => {
  it('retains application state and receipts through compatible update, rollback and host reconstruction', async () => {
    const f = await fixture();
    expect(await f.read()).toMatchObject({ actionCount: 0, version: '1.0.0' });
    const executionId = randomUUID();
    expect(await f.execute(executionId)).toMatchObject({ actionCount: 1, account: 'account-a' });
    await f.update();
    expect(await f.read()).toMatchObject({ actionCount: 1, version: '1.1.0' });
    expect(await f.execute(executionId)).toMatchObject({ actionCount: 1 });
    expect(f.executions()).toBe(1);
    await f.rollback();
    const restarted = f.construct(); await restarted.restoreConnections();
    expect(await f.read(restarted)).toMatchObject({ actionCount: 1, version: '1.0.0' });
    expect(await f.status(executionId, restarted)).toMatchObject({ status: 'confirmed', result: { actionCount: 1 } });
    await f.switchAccount();
    expect(await f.read()).toMatchObject({ actionCount: 0, account: 'account-b' });
    expect(await f.status(executionId)).toEqual({ status: 'outcome_unknown' });
  });

  it('binds an explicitly approved customerId through the actual actor projection and token', async () => {
    const f = await fixture(undefined, 'customerId');
    expect(await f.execute()).toMatchObject({ actionCount: 1, account: 'account-a' });
    await f.switchAccount();
    expect(await f.read()).toMatchObject({ actionCount: 0, account: 'account-b' });
  });

  it('reconciles a committed source write after lost acknowledgment without invoking it again', async () => {
    const f = await fixture(); const executionId = randomUUID(); f.loseAck();
    await expect(f.execute(executionId)).rejects.toThrow();
    expect(f.executions()).toBe(1);
    const restarted = f.construct(); await restarted.restoreConnections();
    expect(await f.status(executionId, restarted)).toMatchObject({ status: 'confirmed', result: { actionCount: 1 } });
    expect(await f.execute(executionId, restarted)).toMatchObject({ actionCount: 1 });
    expect(f.executions()).toBe(1);
  });

  it('denies a state mutation after the host withdraws the personal account mid-handler', async () => {
    const f = await fixture();
    f.beforeWrite(async () => { const account = await f.accounts.resolveAuthority(f.subject); await f.accounts.disconnect(f.subject, account.authorityRevision); });
    await expect(f.execute()).rejects.toThrow();
    expect(f.executions()).toBe(0);
    expect(await f.accounts.status(f.subject)).toMatchObject({ status: 'disconnected' });
    await expect(f.read()).rejects.toThrow();
  });
});
