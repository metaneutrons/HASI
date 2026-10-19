import { digest, type ExecutionBinding } from '@hasi/plugin-sdk';
import { z } from 'zod';

/** Synthetic demo transport metadata; this header is not part of Anny's API. */
export const DEMO_EXECUTION_HEADER = 'x-hasi-demo-execution';
export const MAX_DEMO_EXECUTION_HEADER_BYTES = 4096;
export const MAX_DEMO_EXECUTION_ARGUMENT_BYTES = 8192;
export const MAX_DEMO_EXECUTION_EVIDENCE_BYTES = 8192;
export const MAX_DEMO_EXECUTION_EVIDENCE_RECORDS = 10_000;

const subjectSchema = z.string().min(1).max(256).refine((value) => !Array.from(value).some((character) => {
  const code = character.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}));
const installationIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const annyIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u);
const bookingToolArgumentsSchema = z.strictObject({
  resourceId: annyIdSchema,
  serviceId: annyIdSchema,
  startDate: z.iso.datetime({ offset: true }),
  endDate: z.iso.datetime({ offset: true })
});
const cancellationToolArgumentsSchema = z.strictObject({
  bookingId: annyIdSchema,
  resourceId: annyIdSchema,
  startDate: z.iso.datetime({ offset: true }),
  endDate: z.iso.datetime({ offset: true })
});
const bookingResultSchema = z.strictObject({ bookingId: annyIdSchema });
const cancellationResultSchema = z.strictObject({
  bookingId: annyIdSchema,
  status: z.literal('cancelled')
});

export const demoExecutionBindingSchema = z.strictObject({
  subject: subjectSchema,
  installationId: installationIdSchema,
  executionId: z.uuid(),
  tool: z.enum(['anny.execute_booking', 'anny.execute_cancellation']),
  argsHash: z.string().regex(/^[a-f0-9]{64}$/u),
  configurationRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
});

export const demoExecutionHeaderSchema = z.strictObject({
  schemaVersion: z.literal(1),
  binding: demoExecutionBindingSchema
});

const plainRecordSchema = z.record(z.string(), z.unknown());

export const demoExecutionEvidenceSchema = z.strictObject({
  binding: demoExecutionBindingSchema,
  customerId: z.string().min(1).max(256),
  arguments: plainRecordSchema,
  result: plainRecordSchema
}).superRefine((evidence, context) => {
  let argumentsValid = false;
  let resultValid = false;
  if (evidence.binding.tool === 'anny.execute_booking') {
    argumentsValid = bookingToolArgumentsSchema.safeParse(evidence.arguments).success;
    resultValid = bookingResultSchema.safeParse(evidence.result).success;
  } else {
    const parsedArguments = cancellationToolArgumentsSchema.safeParse(evidence.arguments);
    const parsedResult = cancellationResultSchema.safeParse(evidence.result);
    argumentsValid = parsedArguments.success;
    resultValid = parsedResult.success
      && parsedArguments.success
      && parsedResult.data.bookingId === parsedArguments.data.bookingId;
  }
  if (!argumentsValid || !resultValid || digest(evidence.arguments) !== evidence.binding.argsHash) {
    context.addIssue({ code: 'custom', message: 'Execution evidence does not match its binding.' });
  }
});

export const demoExecutionStatusRequestSchema = z.strictObject({ binding: demoExecutionBindingSchema });
export const demoExecutionStatusSchema = z.strictObject({
  schemaVersion: z.literal(1),
  receipts: z.array(demoExecutionEvidenceSchema).max(2)
});

export type DemoExecutionBinding = z.infer<typeof demoExecutionBindingSchema>;
export type DemoExecutionEvidence = z.infer<typeof demoExecutionEvidenceSchema>;
export type DemoExecutionEvidenceMap = Record<string, DemoExecutionEvidence>;
export type DemoExecutionToolArguments = z.infer<typeof bookingToolArgumentsSchema>
  | z.infer<typeof cancellationToolArgumentsSchema>;

export type DecodedDemoExecutionHeader =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'valid'; binding: DemoExecutionBinding };

export function decodeDemoExecutionHeader(value: string | string[] | undefined): DecodedDemoExecutionHeader {
  if (value === undefined) return { kind: 'missing' };
  if (typeof value !== 'string'
    || value.length === 0
    || Buffer.byteLength(value, 'utf8') > MAX_DEMO_EXECUTION_HEADER_BYTES
    || !/^[A-Za-z0-9_-]+$/u.test(value)) return { kind: 'invalid' };

  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.length === 0 || decoded.toString('base64url') !== value) return { kind: 'invalid' };
    const json = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
    const parsed = demoExecutionHeaderSchema.safeParse(JSON.parse(json) as unknown);
    return parsed.success ? { kind: 'valid', binding: parsed.data.binding } : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

export function digestDemoExecutionBinding(binding: ExecutionBinding | DemoExecutionBinding): string {
  return digest(binding);
}

export function demoExecutionArgumentsMatch(binding: DemoExecutionBinding, toolArguments: Record<string, unknown>): boolean {
  return digest(toolArguments) === binding.argsHash;
}

export function parseDemoExecutionEvidenceMap(value: unknown): DemoExecutionEvidenceMap {
  const parsed = z.record(z.string().regex(/^[a-f0-9]{64}$/u), demoExecutionEvidenceSchema).parse(value);
  for (const [key, evidence] of Object.entries(parsed)) {
    if (key !== digestDemoExecutionBinding(evidence.binding)) {
      throw new TypeError('Invalid synthetic execution evidence key.');
    }
  }
  return parsed;
}

export function isDemoExecutionSubjectInScope(subject: string, scope: string): boolean {
  if (!subject.startsWith('demo:')) return !z.uuid().safeParse(scope).success;
  const match = /^demo:([0-9a-f-]{36}):(student|employee|admin)$/u.exec(subject);
  return match?.[1] === scope;
}

export function isDemoExecutionCustomerForSubject(subject: string, customerId: string): boolean {
  if (!subject.startsWith('demo:')) return true;
  const match = /^demo:([0-9a-f-]{36}):(student|employee|admin)$/u.exec(subject);
  if (!match) return false;
  const expectedCustomers: Record<string, string> = {
    student: '00000000-0000-4000-8000-000000000301',
    employee: '00000000-0000-4000-8000-000000000302',
    admin: '00000000-0000-4000-8000-000000000303'
  };
  return expectedCustomers[match[2] ?? ''] === customerId;
}

export function hasDemoExecutionIdentityConflict(
  records: DemoExecutionEvidenceMap,
  binding: DemoExecutionBinding
): boolean {
  const key = digestDemoExecutionBinding(binding);
  return Object.entries(records).some(([recordKey, evidence]) => (
    recordKey !== key
    && evidence.binding.subject === binding.subject
    && evidence.binding.installationId === binding.installationId
    && evidence.binding.executionId === binding.executionId
  ));
}

export type PreparedDemoExecutionEvidence =
  | { kind: 'new'; key: string; evidence: DemoExecutionEvidence; records: DemoExecutionEvidenceMap }
  | { kind: 'duplicate'; evidence: DemoExecutionEvidence }
  | { kind: 'conflict' }
  | { kind: 'limit' };

export function prepareDemoExecutionEvidence(
  records: DemoExecutionEvidenceMap,
  binding: DemoExecutionBinding,
  customerId: string,
  toolArguments: Record<string, unknown>,
  result: Record<string, unknown>
): PreparedDemoExecutionEvidence {
  if (!demoExecutionArgumentsMatch(binding, toolArguments)) return { kind: 'conflict' };
  const key = digestDemoExecutionBinding(binding);
  const prior = records[key];
  if (prior) {
    return demoExecutionEvidenceMatches(prior, binding, customerId, toolArguments)
      ? { kind: 'duplicate', evidence: prior }
      : { kind: 'conflict' };
  }
  if (hasDemoExecutionIdentityConflict(records, binding)) return { kind: 'conflict' };
  if (Object.keys(records).length >= MAX_DEMO_EXECUTION_EVIDENCE_RECORDS) return { kind: 'limit' };

  const parsed = demoExecutionEvidenceSchema.safeParse({ binding, customerId, arguments: toolArguments, result });
  if (!parsed.success) return { kind: 'conflict' };
  if (Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') > MAX_DEMO_EXECUTION_EVIDENCE_BYTES) {
    return { kind: 'limit' };
  }
  return { kind: 'new', key, evidence: parsed.data, records: { ...records, [key]: parsed.data } };
}

export function demoExecutionEvidenceMatches(
  evidence: DemoExecutionEvidence,
  binding: DemoExecutionBinding,
  customerId: string,
  toolArguments: Record<string, unknown>
): boolean {
  return digestDemoExecutionBinding(evidence.binding) === digestDemoExecutionBinding(binding)
    && evidence.customerId === customerId
    && digest(evidence.arguments) === digest(toolArguments);
}

