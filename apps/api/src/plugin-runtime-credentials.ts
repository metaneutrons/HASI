import { createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { digest } from '@hasi/plugin-sdk';
import type { JsonStore } from '@hasi/state';
import type { LogicalSecretAssignment } from './plugin-artifacts.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const schema = z.strictObject({
  installationId: id, operationId: id, releaseDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  assignments: z.array(z.strictObject({ name: id, secretRef: id })).max(32),
  credentialDigest: z.string().regex(/^[a-f0-9]{64}$/u),
});
type Binding = z.infer<typeof schema>;
export interface RuntimeCredentialStatus { configured: boolean; revision: string | null }

/** Records public custody revisions before container I/O. No credential value
 * or digest derived from a credential is ever stored. Late/unknown container
 * creation retains its original grant; recovery cannot bless new revisions.
 */
export class PluginRuntimeCredentials {
  private readonly prefix: string;
  private readonly publicKey: KeyObject;
  constructor(private readonly options: {
    store: JsonStore; privateKey: KeyObject; scope: string;
    status: (installationId: string, assignments: readonly LogicalSecretAssignment[], releaseDigest: string) => Promise<{ transport: RuntimeCredentialStatus; secrets: RuntimeCredentialStatus[] }>;
  }) {
    this.prefix = `plugin-runtime-credentials:v1:${digest(options.scope)}:`;
    this.publicKey = createPublicKey(options.privateKey);
  }
  private key(installationId: string, operationId: string) { id.parse(installationId); id.parse(operationId); return `${this.prefix}${digest([installationId, operationId])}`; }
  private async credentialDigest(installationId: string, assignments: readonly LogicalSecretAssignment[], releaseDigest: string) {
    const status = await this.options.status(installationId, assignments, releaseDigest);
    if (status.secrets.length !== assignments.length || [status.transport, ...status.secrets].some(item => !item.configured || !item.revision)) throw new Error('Runtime credential grant unavailable');
    return digest({ assignments, status });
  }
  async capture(input: { installationId: string; operationId: string; releaseDigest: string; assignments: readonly LogicalSecretAssignment[] }) {
    const assignments = [...input.assignments].sort((a, b) => a.name.localeCompare(b.name));
    const value = schema.parse({ ...input, assignments, credentialDigest: await this.credentialDigest(input.installationId, assignments, input.releaseDigest) });
    const signature = sign(null, Buffer.from(`${this.prefix}${digest(value)}`), this.options.privateKey).toString('base64url');
    if (!await this.options.store.compareAndSet(this.key(value.installationId, value.operationId), null, { value, signature })) throw new Error('Runtime credential capture already exists');
  }
  async assertCurrent(input: { installationId: string; operationId: string; releaseDigest: string }) {
    const record = await this.options.store.read(this.key(input.installationId, input.operationId));
    if (!record) throw new Error('Runtime credential grant unavailable');
    const envelope = z.strictObject({ value: schema, signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/u) }).parse(record.value);
    const value: Binding = envelope.value;
    if (value.installationId !== input.installationId || value.operationId !== input.operationId || value.releaseDigest !== input.releaseDigest
      || !verify(null, Buffer.from(`${this.prefix}${digest(value)}`), this.publicKey, Buffer.from(envelope.signature, 'base64url'))
      || value.credentialDigest !== await this.credentialDigest(input.installationId, value.assignments, input.releaseDigest)) throw new Error('Runtime credentials changed');
  }
}
