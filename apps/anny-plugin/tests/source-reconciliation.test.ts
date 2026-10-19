import { describe, expect, it, vi } from 'vitest';
import { digest, type ActorContext, type ExecutionBinding } from '@hasi/plugin-sdk';
import { createAnnySourceReconciler } from '../src/source-reconciliation.js';

const actor: ActorContext = { subject: 'subject-1', permissions: ['rooms:execute'] };
const args = { resourceId: 'resource-1', serviceId: 'service-1', startDate: '2030-01-02T08:00:00Z', endDate: '2030-01-02T16:00:00Z' };
const binding: ExecutionBinding = { subject: actor.subject, installationId: 'de.hsh.hasi.anny',
  executionId: '00000000-0000-4000-8000-000000000001', tool: 'anny.execute_booking', argsHash: digest(args), configurationRevision: 1 };
const evidence = { binding, customerId: 'customer-1', arguments: args, result: { bookingId: 'booking-1' } };
const booking = { resourceId: args.resourceId, startDate: args.startDate, endDate: args.endDate, status: 'accepted' };

function harness(records: unknown = [evidence], current = booking) {
  const readEvidence = vi.fn().mockResolvedValue(records);
  const authorizeResource = vi.fn();
  const ownedBooking = vi.fn().mockResolvedValue(current);
  return { reconcile: createAnnySourceReconciler({ readEvidence, authorizeResource, ownedBooking, customerId: () => 'customer-1' }),
    readEvidence, authorizeResource, ownedBooking };
}

describe('Anny source receipt validation', () => {
  it('confirms only one exact receipt and a currently owned matching booking', async () => {
    const fixture = harness();
    expect(await fixture.reconcile(binding, actor)).toEqual({ bookingId: 'booking-1' });
    expect(fixture.authorizeResource).toHaveBeenCalledWith(args.resourceId, args.serviceId, actor);
    expect(fixture.ownedBooking).toHaveBeenCalledWith('booking-1', actor);
  });

  it.each([
    ['missing', []],
    ['ambiguous', [evidence, evidence]],
    ['foreign customer', [{ ...evidence, customerId: 'customer-2' }]],
    ['different arguments', [{ ...evidence, arguments: { ...args, resourceId: 'resource-2' } }]],
    ['different execution', [{ ...evidence, binding: { ...binding, executionId: '00000000-0000-4000-8000-000000000002' } }]],
    ['different configuration', [{ ...evidence, binding: { ...binding, configurationRevision: 2 } }]],
    ['malformed result', [{ ...evidence, result: { bookingId: 'booking-1', untrusted: true } }]],
  ])('keeps %s evidence unresolved', async (_name, records) => {
    expect(await harness(records).reconcile(binding, actor)).toBeUndefined();
  });

  it('does not even query the source for another subject', async () => {
    const fixture = harness();
    expect(await fixture.reconcile(binding, { ...actor, subject: 'subject-2' })).toBeUndefined();
    expect(fixture.readEvidence).not.toHaveBeenCalled();
  });

  it.each([
    ['other resource', { ...booking, resourceId: 'resource-2' }],
    ['other interval', { ...booking, endDate: '2030-01-02T17:00:00Z' }],
    ['already cancelled', { ...booking, status: 'cancelled' }],
  ])('does not infer success from a booking with %s', async (_name, current) => {
    expect(await harness([evidence], current).reconcile(binding, actor)).toBeUndefined();
  });

  it('rechecks current rights before accepting historical evidence', async () => {
    const fixture = harness();
    fixture.authorizeResource.mockImplementation(() => { throw new Error('Resource access denied'); });
    await expect(fixture.reconcile(binding, actor)).rejects.toThrow('Resource access denied');
    expect(fixture.ownedBooking).not.toHaveBeenCalled();
  });

  it('accepts cancellation only for the original booking and its current cancelled state', async () => {
    const cancellationArgs = { resourceId: args.resourceId, startDate: args.startDate, endDate: args.endDate, bookingId: 'booking-1' };
    const cancellationBinding = { ...binding, tool: 'anny.execute_cancellation', argsHash: digest(cancellationArgs) };
    const cancelled = { binding: cancellationBinding, customerId: 'customer-1', arguments: cancellationArgs,
      result: { bookingId: 'booking-1', status: 'cancelled' } };
    expect(await harness([cancelled], { ...booking, status: 'cancelled' }).reconcile(cancellationBinding, actor))
      .toEqual(cancelled.result);
    expect(await harness([cancelled]).reconcile(cancellationBinding, actor)).toBeUndefined();
    expect(await harness([{ ...cancelled, result: { bookingId: 'booking-2', status: 'cancelled' } }], { ...booking, status: 'cancelled' })
      .reconcile(cancellationBinding, actor)).toBeUndefined();
  });
});
