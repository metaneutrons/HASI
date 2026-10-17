import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { AnnyClient, type BookingSummary } from '@hasi/anny-client';
import { createAnnyPlugin, annyManifest, type Presentation } from '@hasi/anny-plugin';
import { digest } from '@hasi/plugin-sdk';
import { PluginRegistry } from '../apps/api/src/index.js';

const bookingId = 'synthetic-booking-123';
const ownerId = 'synthetic-customer-owner';
const otherCustomerId = 'synthetic-customer-other';
const resourceA = 'synthetic-room-a';
const resourceB = 'synthetic-room-b';
const startDate = '2099-03-10T09:00:00.000Z';
const endDate = '2099-03-10T10:00:00.000Z';
const serviceId = 'synthetic-service';
const serviceToken = 'synthetic-cancellation-plugin-token';
const actor = {
  subject: 'synthetic-subject-owner',
  customerId: ownerId,
  resourceIds: [resourceA, resourceB],
  permissions: ['rooms:read', 'rooms:prepare', 'rooms:execute'],
};
const presentation: Record<string, Presentation> = {
  [resourceA]: { capacity: 4, location: 'Synthetic campus', features: [], serviceId },
  [resourceB]: { capacity: 4, location: 'Synthetic campus', features: [], serviceId },
};

interface SyntheticBooking extends BookingSummary {
  bookingId: string;
  resourceId: string;
  startDate: string;
  endDate: string;
  status: string;
}

interface CancellationArguments extends Record<string, unknown> {
  bookingId: string;
  resourceId: string;
  startDate: string;
  endDate: string;
}

interface CancellationDraft {
  executionTool: string;
  arguments: CancellationArguments;
  resourceName: string;
}

class SyntheticAnnyClient {
  readonly bookingQueries: string[] = [];
  readonly cancellationCalls: string[] = [];
  private readonly bookings = new Map<string, SyntheticBooking[]>();

  constructor(booking: SyntheticBooking, private readonly establishCancellation = true) {
    this.bookings.set(ownerId, [{ ...booking }]);
  }

  listResources() {
    return Promise.resolve([]);
  }

  listBookings(customerId: string): Promise<BookingSummary[]> {
    this.bookingQueries.push(customerId);
    return Promise.resolve((this.bookings.get(customerId) ?? []).map((booking) => ({ ...booking })));
  }

  cancelBooking(id: string): Promise<void> {
    this.cancellationCalls.push(id);
    if (this.establishCancellation) this.updateBooking(ownerId, { status: 'cancelled' });
    return Promise.resolve();
  }

  updateBooking(customerId: string, patch: Partial<SyntheticBooking>): void {
    const customerBookings = this.bookings.get(customerId) ?? [];
    this.bookings.set(customerId, customerBookings.map((booking) => ({ ...booking, ...patch })));
  }
}

type TestPlugin = ReturnType<typeof createAnnyPlugin>;
const activePlugins: TestPlugin[] = [];

afterEach(async () => {
  await Promise.all(activePlugins.splice(0).map((plugin) => plugin.close()));
});

describe('Anny cancellation safety through the signed plugin registry', () => {
  it('prepares an owned active booking from its canonical snapshot without cancelling it', async () => {
    const { client, registry } = await setup();

    const draft = await proposeCancellation(registry, actor);

    expect(draft).toEqual({
      executionTool: 'anny.execute_cancellation',
      arguments: { bookingId, resourceId: resourceA, startDate, endDate },
      resourceName: 'Raum',
    });
    expect(client.bookingQueries).toEqual([ownerId]);
    expect(client.cancellationCalls).toEqual([]);
  });

  it('does not find a booking through another customer’s booking list', async () => {
    const { client, registry } = await setup();

    await expect(proposeCancellation(registry, { ...actor, customerId: otherCustomerId }))
      .rejects.toThrow();

    expect(client.bookingQueries).toEqual([otherCustomerId]);
    expect(client.cancellationCalls).toEqual([]);
  });

  it('rechecks resource rights at execution after the actor loses access', async () => {
    const { client, registry } = await setup();
    const draft = await proposeCancellation(registry, actor);

    await expect(registry.invoke(
      annyManifest.id,
      draft.executionTool,
      draft.arguments,
      { ...actor, resourceIds: [] },
      true,
    )).rejects.toThrow();

    expect(client.cancellationCalls).toEqual([]);
  });

  it.each([
    { field: 'startDate', value: '2099-03-11T09:00:00.000Z' },
    { field: 'resourceId', value: 'synthetic-room-b' },
  ] as const)('rejects execution after the booking $field changes', async ({ field, value }) => {
    const { client, registry } = await setup();
    const draft = await proposeCancellation(registry, actor);
    client.updateBooking(ownerId, { [field]: value });

    await expect(registry.invoke(
      annyManifest.id,
      draft.executionTool,
      draft.arguments,
      actor,
      true,
    )).rejects.toThrow();

    expect(client.cancellationCalls).toEqual([]);
  });

  it.each([
    { label: 'past', booking: { startDate: '2000-03-10T09:00:00.000Z', endDate: '2000-03-10T10:00:00.000Z' } },
    { label: 'terminal', booking: { status: 'declined' } },
  ])('refuses to prepare a $label booking', async ({ booking }) => {
    const { client, registry } = await setup(booking);

    await expect(proposeCancellation(registry, actor)).rejects.toThrow();

    expect(client.cancellationCalls).toEqual([]);
  });

  it('rejects an execute tool call unless the host marks it as execution', async () => {
    const { client, registry } = await setup();
    const draft = await proposeCancellation(registry, actor);

    await expect(registry.invoke(
      annyManifest.id,
      draft.executionTool,
      draft.arguments,
      actor,
    )).rejects.toMatchObject({ status: 403 });

    expect(client.cancellationCalls).toEqual([]);
  });

  it('leaves a missing cancellation outcome unconfirmed after one vendor call', async () => {
    const { client, registry } = await setup({}, false);
    const draft = await proposeCancellation(registry, actor);

    await expect(registry.invoke(
      annyManifest.id,
      draft.executionTool,
      draft.arguments,
      actor,
      true,
    )).rejects.toThrow();

    expect(client.cancellationCalls).toEqual([bookingId]);
  });

  it.each(['canceled', 'cancelled'])('treats an already %s booking as idempotently cancelled', async (status) => {
    const { client, registry } = await setup({ status });

    await expect(registry.invoke(
      annyManifest.id,
      'anny.execute_cancellation',
      { bookingId, resourceId: resourceA, startDate, endDate },
      actor,
      true,
    )).resolves.toMatchObject({ bookingId, status: 'cancelled' });

    expect(client.cancellationCalls).toEqual([]);
  });
});

async function setup(
  bookingPatch: Partial<SyntheticBooking> = {},
  establishCancellation = true,
): Promise<{ client: SyntheticAnnyClient; registry: PluginRegistry }> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const client = new SyntheticAnnyClient({
    bookingId,
    resourceId: resourceA,
    startDate,
    endDate,
    status: 'confirmed',
    ...bookingPatch,
  }, establishCancellation);
  const plugin = createAnnyPlugin({
    client: client as unknown as AnnyClient,
    publicKey,
    serviceToken,
    presentation,
  });
  plugin.server.keepAliveTimeout = 1;
  activePlugins.push(plugin);
  await plugin.listen({ host: '127.0.0.1', port: 0 });
  const address = plugin.server.address();
  if (!address || typeof address === 'string') throw new Error('Anny plugin did not bind a TCP port');

  const registry = new PluginRegistry(privateKey);
  await registry.install({
    endpoint: `http://127.0.0.1:${String(address.port)}/mcp`,
    serviceToken,
    expectedManifestDigest: digest(annyManifest),
    allowLoopback: true,
  });
  return { client, registry };
}

async function proposeCancellation(registry: PluginRegistry, actingAs: typeof actor): Promise<CancellationDraft> {
  const result = await registry.invoke(
    annyManifest.id,
    'anny.propose_cancellation',
    { bookingId },
    actingAs,
  );
  return result.draft as CancellationDraft;
}
