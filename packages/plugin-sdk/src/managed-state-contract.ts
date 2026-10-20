import { z } from 'zod';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { canonicalJson, digest } from './canonical-json.js';

/** Explicit bidirectional profile; it does not change other plugins' negotiation. */
export const MANAGED_STATE_MCP_VERSION = '2025-11-25' as const;
export const MANAGED_STATE_METHODS = Object.freeze({
  read: 'hasi/state/read',
  compareAndSet: 'hasi/state/compareAndSet',
  consumeInvocation: 'hasi/state/consumeInvocation',
  actionStatus: 'hasi/action-status',
});

/** Operator-approved stable account identifier, never an e-mail/display-name heuristic. */
export interface ManagedStateDeclaration {
  schemaVersion: number;
  accountIdentity: { kind: 'subject' } | { kind: 'customerId' } | { kind: 'claim'; name: string };
  applicationSchema: Record<string, unknown>;
}

const logicalKey = z.string().min(1).max(192).regex(/^[A-Za-z0-9][A-Za-z0-9:._~-]*$/u)
  .refine(value => !['constructor', 'prototype'].includes(value));
const invocation = { invocationId: z.uuid() };
const address = { ...invocation, area: z.enum(['application', 'journal']), key: logicalKey };
export const managedStateReadParams = z.strictObject(address);
export const managedStateCasParams = z.strictObject({ ...address, revision: z.uuid().nullable(), value: z.unknown() });
export const managedStateConsumeParams = z.strictObject(invocation);
export const managedStateEntry = z.strictObject({ revision: z.uuid(), value: z.unknown() });
export const managedStateReadResult = z.strictObject({ entry: managedStateEntry.nullable() });
export const managedStateCasResult = z.strictObject({ updated: z.boolean() });
export const managedStateConsumeResult = z.strictObject({ consumed: z.boolean() });
export const managedStateActionStatusParams = z.strictObject({ executionId: z.uuid(), tool: z.string().min(1).max(256), argsHash: z.string().regex(/^[a-f0-9]{64}$/u) });
export const managedStateActionStatusResult = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('confirmed'), result: z.record(z.string(), z.unknown()) }),
  z.strictObject({ status: z.literal('outcome_unknown') }),
]);

const validators = new Map<string, (value: unknown) => boolean>();
/** Compile the approved schema at admission as well as before state access. */
export function managedStateValidator(schema: Record<string, unknown>): (value: unknown) => boolean {
  const snapshot = JSON.parse(canonicalJson(schema)) as Record<string, unknown>;
  const key = digest(snapshot);
  const cached = validators.get(key);
  if (cached) return cached;
  const ajv = new Ajv2020({ strict: true });
  addFormats.default(ajv);
  const compiled = ajv.compile(snapshot);
  const validate = (value: unknown) => compiled(value);
  if (validators.size >= 64) {
    const oldest = validators.keys().next().value;
    if (oldest !== undefined) validators.delete(oldest);
  }
  validators.set(key, validate);
  return validate;
}
