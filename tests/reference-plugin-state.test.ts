import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { digest, ExecutionJournal, type ActorContext, type ExecutionBinding, type ExecutionStore } from '@hasi/plugin-sdk';

interface MarkResult extends Record<string, unknown> { confirmed: boolean; actionCount: number; label: string; account: string }
interface ReferenceStateStats { marks: number; journalRows: number; sourceRows: number; invocationRows: number }
interface ReferenceState {
  executionStore: ExecutionStore;
  consumeInvocation(jti: string, expiresAt: number): Promise<boolean>;
  mark(binding: ExecutionBinding, args: Record<string, unknown>, actor: ActorContext): Promise<MarkResult>;
  resolve(binding: ExecutionBinding, actor: ActorContext): Promise<MarkResult | undefined>;
  count(installationId: string, actor: ActorContext): Promise<number>;
  stats(): ReferenceStateStats;
  close(): void;
};

async function createState(filename: string): Promise<ReferenceState> {
  const stateModule = await import(new URL('../examples/reference-plugin/src/state.js', import.meta.url).href) as unknown as {
    createReferenceState(path?: string): ReferenceState;
  };
  return stateModule.createReferenceState(filename);
}

const actor = (subject: string, account: string): ActorContext => ({
  subject,
  permissions: ['reference:execute'],
  claims: { 'reference.account': account },
});

function bindingFor(
  currentActor: ActorContext,
  args: Record<string, unknown>,
  options: Partial<ExecutionBinding> = {},
): ExecutionBinding {
  return {
    subject: currentActor.subject,
    installationId: 'hasi.reference.installation',
    executionId: randomUUID(),
    tool: 'execute_mark',
    argsHash: digest(args),
    configurationRevision: 1,
    ...options,
  };
}

async function withStateFile<T>(run: (filename: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'hasi-reference-state-'));
  try {
    return await run(join(directory, 'state.sqlite'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('durable reference plugin state', () => {
  it('keeps its database private and rejects a symbolic-link path', async () => {
    await withStateFile(async (filename) => {
      const state = await createState(filename);
      state.close();
      expect((await lstat(filename)).mode & 0o777).toBe(0o600);
      const link = `${filename}.link`;
      const { symlink } = await import('node:fs/promises');
      await symlink(filename, link);
      await expect(createState(link)).rejects.toThrow('Reference state file is invalid');
    });
  });

  it('persists the source result and counter across reopen without repeating an effect', async () => {
    await withStateFile(async (filename) => {
      const currentActor = actor('person-1', 'account-a');
      const args = { label: 'Synthetic reading-room marker' };
      const binding = bindingFor(currentActor, args);
      const first = await createState(filename);
      const result = await first.mark(binding, args, currentActor);
      expect(result).toEqual({ confirmed: true, actionCount: 1, label: args.label, account: 'account-a' });
      first.close();

      const reopened = await createState(filename);
      expect(await reopened.resolve(binding, currentActor)).toEqual(result);
      expect(await reopened.mark(binding, args, currentActor)).toEqual(result);
      expect(await reopened.count(binding.installationId, currentActor)).toBe(1);
      expect(reopened.stats()).toEqual({ marks: 1, journalRows: 0, sourceRows: 1, invocationRows: 0 });
      reopened.close();
    });
  });

  it('reconciles a lost execution acknowledgement from the durable source after reopen', async () => {
    await withStateFile(async (filename) => {
      const currentActor = actor('person-2', 'account-a');
      const args = { label: 'Synthetic durable mark' };
      const binding = bindingFor(currentActor, args);
      const first = await createState(filename);
      const firstJournal = new ExecutionJournal(first.executionStore, 'local-reference-test');
      await expect(firstJournal.execute(binding, async () => {
        await first.mark(binding, args, currentActor);
        throw new Error('synthetic response loss');
      })).rejects.toThrow('Execution outcome requires reconciliation');
      expect(await firstJournal.status(binding)).toEqual({ status: 'outcome_unknown' });
      first.close();

      const reopened = await createState(filename);
      const reopenedJournal = new ExecutionJournal(reopened.executionStore, 'local-reference-test');
      expect(await reopenedJournal.status(binding)).toEqual({ status: 'outcome_unknown' });
      expect(await reopenedJournal.reconcile(binding, () => reopened.resolve(binding, currentActor))).toEqual({
        status: 'confirmed',
        result: { confirmed: true, actionCount: 1, label: args.label, account: 'account-a' },
      });
      const invokeAgain = () => Promise.reject(new Error('must not execute again'));
      expect(await reopenedJournal.execute(binding, invokeAgain)).toEqual({
        confirmed: true,
        actionCount: 1,
        label: args.label,
        account: 'account-a',
      });
      expect(await reopened.count(binding.installationId, currentActor)).toBe(1);
      expect(reopened.stats()).toEqual({ marks: 1, journalRows: 1, sourceRows: 1, invocationRows: 0 });
      reopened.close();
    });
  });

  it('uses atomic compare-and-set revisions for the SDK execution journal', async () => {
    await withStateFile(async (filename) => {
      const state = await createState(filename);
      const key = 'execution:v1:fixture';
      expect(await state.executionStore.compareAndSet(key, null, { status: 'executing' })).toBe(true);
      expect(await state.executionStore.compareAndSet(key, null, { status: 'executing' })).toBe(false);
      const first = await state.executionStore.read(key);
      expect(first?.value).toEqual({ status: 'executing' });
      expect(await state.executionStore.compareAndSet(key, 'stale-revision', { status: 'confirmed' })).toBe(false);
      expect(await state.executionStore.compareAndSet(key, first!.revision, { status: 'confirmed' })).toBe(true);
      expect((await state.executionStore.read(key))?.value).toEqual({ status: 'confirmed' });
      state.close();
    });
  });

  it('rejects a reused execution identity when its args, config, or account changes', async () => {
    await withStateFile(async (filename) => {
      const state = await createState(filename);
      const currentActor = actor('person-3', 'account-a');
      const args = { label: 'Original marker' };
      const binding = bindingFor(currentActor, args);
      const result = await state.mark(binding, args, currentActor);

      const changedArgs = { label: 'Changed marker' };
      await expect(state.mark({ ...binding, argsHash: digest(changedArgs) }, changedArgs, currentActor)).rejects.toThrow('Reference source binding changed');
      await expect(state.resolve({ ...binding, configurationRevision: 2 }, currentActor)).rejects.toThrow('Reference source binding changed');
      await expect(state.resolve(binding, actor('person-3', 'account-b'))).rejects.toThrow('Reference source binding changed');
      expect(await state.count(binding.installationId, currentActor)).toBe(result.actionCount);
      expect(state.stats().marks).toBe(1);
      state.close();
    });
  });

  it('scopes counters by installation, subject, and current account', async () => {
    await withStateFile(async (filename) => {
      const state = await createState(filename);
      const firstActor = actor('person-4', 'account-a');
      const samePersonOtherAccount = actor('person-4', 'account-b');
      const sameAccountOtherPerson = actor('person-5', 'account-a');
      const args = { label: 'Scoped marker' };

      const first = bindingFor(firstActor, args);
      const second = bindingFor(samePersonOtherAccount, args);
      const third = bindingFor(sameAccountOtherPerson, args);
      const otherInstallation = bindingFor(firstActor, args, { installationId: 'hasi.reference.other' });
      expect((await state.mark(first, args, firstActor)).actionCount).toBe(1);
      expect((await state.mark(second, args, samePersonOtherAccount)).actionCount).toBe(1);
      expect((await state.mark(third, args, sameAccountOtherPerson)).actionCount).toBe(1);
      expect((await state.mark(otherInstallation, args, firstActor)).actionCount).toBe(1);
      expect(await state.count(first.installationId, firstActor)).toBe(1);
      expect(await state.count(second.installationId, samePersonOtherAccount)).toBe(1);
      expect(await state.count(third.installationId, sameAccountOtherPerson)).toBe(1);
      expect(await state.count(otherInstallation.installationId, firstActor)).toBe(1);
      expect(state.stats().marks).toBe(4);
      state.close();
    });
  });

  it('persists invocation replay consumption across reopen', async () => {
    await withStateFile(async (filename) => {
      const jti = randomUUID();
      const expiresAt = Math.floor(Date.now() / 1_000) + 60;
      const first = await createState(filename);
      expect(await first.consumeInvocation(jti, expiresAt)).toBe(true);
      expect(await first.consumeInvocation(jti, expiresAt)).toBe(false);
      first.close();

      const reopened = await createState(filename);
      expect(await reopened.consumeInvocation(jti, expiresAt)).toBe(false);
      expect(reopened.stats().invocationRows).toBe(1);
      expect(await reopened.consumeInvocation(randomUUID(), Math.floor(Date.now() / 1_000) - 1)).toBe(false);
      reopened.close();
    });
  });
});
