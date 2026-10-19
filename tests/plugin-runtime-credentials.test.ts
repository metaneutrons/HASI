import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { digest } from '@hasi/plugin-sdk';
import { MemoryJsonStore, type JsonStore } from '@hasi/state';
import type { LogicalSecretAssignment } from '../apps/api/src/plugin-artifacts.js';
import { PluginRuntimeCredentials, type RuntimeCredentialStatus } from '../apps/api/src/plugin-runtime-credentials.js';

const INSTALLATION = 'com.example.calendar';
const OPERATION = 'stage-operation-1';
const RELEASE = 'a'.repeat(64);
const ASSIGNMENTS: LogicalSecretAssignment[] = [{ name: 'OPTIONAL_TOKEN', secretRef: 'optional-token' }];

interface StatusState {
  transport: RuntimeCredentialStatus;
  secrets: Map<string, RuntimeCredentialStatus>;
}

class RecordingStore implements JsonStore {
  readonly committedWrites: { key: string; value: unknown }[] = [];

  constructor(private readonly inner: JsonStore) {}

  read(key: string) { return this.inner.read(key); }

  async compareAndSet(key: string, expectedRevision: string | null, value: unknown, expiresAt?: number) {
    const committed = await this.inner.compareAndSet(key, expectedRevision, value, expiresAt);
    if (committed) this.committedWrites.push({ key, value: structuredClone(value) });
    return committed;
  }

  delete(key: string) { return this.inner.delete(key); }
}

function fixture(scope = 'institution:one') {
  const { privateKey } = generateKeyPairSync('ed25519');
  const backing = new MemoryJsonStore(`plugin-runtime-credentials-${randomUUID()}`);
  const store = new RecordingStore(backing);
  const statusState: StatusState = {
    transport: { configured: true, revision: 'transport-r1' },
    secrets: new Map([['optional-token', { configured: true, revision: 'secret-r1' }]]),
  };
  const makeCredentials = (requestedScope = scope) => new PluginRuntimeCredentials({
    store,
    privateKey,
    scope: requestedScope,
    status: (_installationId, assignments) => Promise.resolve({
      transport: { ...statusState.transport },
      secrets: assignments.map(assignment => ({
        ...(statusState.secrets.get(assignment.secretRef) ?? { configured: false, revision: null }),
      })),
    }),
  });

  return { backing, store, statusState, makeCredentials, credentials: makeCredentials() };
}

function recordKey(scope: string, installationId: string, operationId: string) {
  return `plugin-runtime-credentials:v1:${digest(scope)}:${digest([installationId, operationId])}`;
}

const captureInput = {
  installationId: INSTALLATION,
  operationId: OPERATION,
  releaseDigest: RELEASE,
  assignments: ASSIGNMENTS,
};

describe('PluginRuntimeCredentials', () => {
  it('rejects a configured slot after its operator revision rotates', async () => {
    const f = fixture();
    await f.credentials.capture(captureInput);
    await expect(f.credentials.assertCurrent(captureInput)).resolves.toBeUndefined();

    f.statusState.secrets.set('optional-token', { configured: true, revision: 'secret-r2' });
    await expect(f.credentials.assertCurrent(captureInput)).rejects.toThrow('Runtime credentials changed');
  });

  it('requires optional and undeclared assignments to remain configured', async () => {
    const f = fixture();
    const assignment = { name: 'OPTIONAL_EXTRA', secretRef: 'undeclared-optional' };
    const input = { ...captureInput, assignments: [assignment] };

    await expect(f.credentials.capture(input)).rejects.toThrow('Runtime credential grant unavailable');
    expect(f.store.committedWrites).toHaveLength(0);

    f.statusState.secrets.set('undeclared-optional', { configured: true, revision: 'optional-r1' });
    await f.credentials.capture(input);
    f.statusState.secrets.set('undeclared-optional', { configured: false, revision: null });
    await expect(f.credentials.assertCurrent(input)).rejects.toThrow('Runtime credential grant unavailable');
  });

  it('includes the transport credential revision in the active runtime binding', async () => {
    const f = fixture();
    await f.credentials.capture(captureInput);

    f.statusState.transport = { configured: true, revision: 'transport-r2' };
    await expect(f.credentials.assertCurrent(captureInput)).rejects.toThrow('Runtime credentials changed');
  });

  it('binds the signed record to its scope, installation, operation, and release', async () => {
    const f = fixture();
    await f.credentials.capture(captureInput);
    const stored = await f.backing.read(recordKey('institution:one', INSTALLATION, OPERATION));
    expect(stored).toBeDefined();

    const scopedCredentials = f.makeCredentials('institution:two');
    const scopeKey = recordKey('institution:two', INSTALLATION, OPERATION);
    expect(await f.backing.compareAndSet(scopeKey, null, stored!.value)).toBe(true);
    await expect(scopedCredentials.assertCurrent(captureInput)).rejects.toThrow('Runtime credentials changed');

    const otherInstallation = 'com.example.mail';
    const installationKey = recordKey('institution:one', otherInstallation, OPERATION);
    expect(await f.backing.compareAndSet(installationKey, null, stored!.value)).toBe(true);
    await expect(f.credentials.assertCurrent({ ...captureInput, installationId: otherInstallation })).rejects.toThrow('Runtime credentials changed');

    const otherOperation = 'stage-operation-2';
    const operationKey = recordKey('institution:one', INSTALLATION, otherOperation);
    expect(await f.backing.compareAndSet(operationKey, null, stored!.value)).toBe(true);
    await expect(f.credentials.assertCurrent({ ...captureInput, operationId: otherOperation })).rejects.toThrow('Runtime credentials changed');

    await expect(f.credentials.assertCurrent({ ...captureInput, releaseDigest: 'b'.repeat(64) })).rejects.toThrow('Runtime credentials changed');

    const envelope = stored!.value as { value: Record<string, unknown>; signature: string };
    const tampered = { ...envelope, value: { ...envelope.value, credentialDigest: 'c'.repeat(64) } };
    expect(await f.backing.compareAndSet(recordKey('institution:one', INSTALLATION, OPERATION), stored!.revision, tampered)).toBe(true);
    await expect(f.credentials.assertCurrent(captureInput)).rejects.toThrow('Runtime credentials changed');
  });

  it('revalidates the durable binding after a worker-style restart', async () => {
    const f = fixture();
    await f.credentials.capture(captureInput);

    const restarted = f.makeCredentials();
    await expect(restarted.assertCurrent(captureInput)).resolves.toBeUndefined();

    f.statusState.secrets.set('optional-token', { configured: true, revision: 'secret-r2' });
    await expect(restarted.assertCurrent(captureInput)).rejects.toThrow('Runtime credentials changed');
  });

  it('captures once before deployment I/O and never overwrites an uncertain operation', async () => {
    const f = fixture();
    const events: string[] = [];
    const driver = {
      stage: async () => {
        events.push('driver.stage');
        await f.credentials.assertCurrent(captureInput);
        throw new Error('simulated uncertain Docker result');
      },
    };
    const stage = async () => {
      await f.credentials.capture(captureInput);
      events.push('credential.capture');
      return driver.stage();
    };

    await expect(stage()).rejects.toThrow('simulated uncertain Docker result');
    expect(events).toEqual(['credential.capture', 'driver.stage']);
    expect(f.store.committedWrites).toHaveLength(1);
    expect(JSON.stringify(f.store.committedWrites)).not.toContain('secret-r1');

    f.statusState.secrets.set('optional-token', { configured: true, revision: 'secret-r2' });
    await expect(stage()).rejects.toThrow('Runtime credential capture already exists');
    expect(f.store.committedWrites).toHaveLength(1);
  });
});
