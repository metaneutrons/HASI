import { z } from 'zod';
import { digest, type ActorContext, type ExecutionBinding } from '@hasi/plugin-sdk';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u);
const interval = z.strictObject({ resourceId: id, serviceId: id, startDate: z.iso.datetime({ offset: true }), endDate: z.iso.datetime({ offset: true }) });
const cancellation = interval.omit({ serviceId: true }).extend({ bookingId: id });
const evidenceSchema = z.strictObject({
  binding: z.strictObject({ subject: z.string().min(1).max(256), installationId: z.string().min(1).max(128),
    executionId: z.uuid(), tool: z.enum(['anny.execute_booking', 'anny.execute_cancellation']),
    argsHash: z.string().regex(/^[a-f0-9]{64}$/u), configurationRevision: z.number().int().nonnegative() }),
  customerId: id, arguments: z.record(z.string(), z.unknown()), result: z.record(z.string(), z.unknown()),
});

/** An approved source adapter must correlate the original execution, not infer it from room/time. */
export type AnnyExecutionEvidenceReader = (binding: Readonly<ExecutionBinding>, actor: ActorContext) => Promise<unknown>;
interface OwnedBooking { resourceId: string; startDate: string; endDate: string; status?: string }

export function createAnnySourceReconciler(options: {
  readEvidence: AnnyExecutionEvidenceReader;
  customerId: (actor: ActorContext) => string;
  authorizeResource: (resourceId: string, serviceId: string | undefined, actor: ActorContext) => void;
  ownedBooking: (bookingId: string, actor: ActorContext) => Promise<OwnedBooking>;
}) {
  return async (binding: Readonly<ExecutionBinding>, actor: ActorContext): Promise<Record<string, unknown> | undefined> => {
    if (!['anny.execute_booking', 'anny.execute_cancellation'].includes(binding.tool) || actor.subject !== binding.subject) return undefined;
    const customerId = options.customerId(actor);
    const parsed = z.array(evidenceSchema).max(2).safeParse(await options.readEvidence(binding, actor));
    if (!parsed.success || parsed.data.length !== 1) return undefined;
    const evidence = parsed.data[0];
    if (!evidence || digest(evidence.binding) !== digest(binding) || evidence.customerId !== customerId
      || digest(evidence.arguments) !== binding.argsHash) return undefined;

    const args = binding.tool === 'anny.execute_booking'
      ? interval.safeParse(evidence.arguments) : cancellation.safeParse(evidence.arguments);
    if (!args.success) return undefined;
    const serviceId = 'serviceId' in args.data ? args.data.serviceId : undefined;
    options.authorizeResource(args.data.resourceId, serviceId, actor);
    const result = (binding.tool === 'anny.execute_booking'
      ? z.strictObject({ bookingId: id })
      : z.strictObject({ bookingId: id, status: z.literal('cancelled') })).safeParse(evidence.result);
    if (!result.success || ('bookingId' in args.data && args.data.bookingId !== result.data.bookingId)) return undefined;
    const current = await options.ownedBooking(result.data.bookingId, actor);
    if (current.resourceId !== args.data.resourceId || Date.parse(current.startDate) !== Date.parse(args.data.startDate)
      || Date.parse(current.endDate) !== Date.parse(args.data.endDate)) return undefined;
    const allowedStatuses = binding.tool === 'anny.execute_booking'
      ? ['accepted', 'confirmed', 'requested', 'reserved'] : ['canceled', 'cancelled'];
    if (!allowedStatuses.includes(current.status ?? '')) return undefined;
    return result.data;
  };
}
