import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { digest } from '@hasi/plugin-sdk';
import { MemoryJsonStore } from '@hasi/state';
import {
  DEMO_EXECUTION_HEADER,
  createAnnyMock,
  MOCK_IDS,
  type DemoExecutionBinding
} from '../src/index.js';

const TOKEN = 'execution-evidence-test-token';
const STATUS_URL = '/api/v1/_hasi-demo/execution-status';
const DAY_MS = 24 * 60 * 60 * 1000;

function futureSlot(): { startDate: string; endDate: string } {
  const start = new Date(Date.now() + 30 * DAY_MS);
  start.setUTCHours(9, 0, 0, 0);
  return {
    startDate: start.toISOString(),
    endDate: new Date(start.getTime() + 60 * 60 * 1000).toISOString()
  };
}

function bookingArguments(slot: { startDate: string; endDate: string }) {
  return {
    resourceId: MOCK_IDS.resources.seminarRoom,
    serviceId: MOCK_IDS.services.students2,
    startDate: slot.startDate,
    endDate: slot.endDate
  };
}

function bindingFor(
  subject: string,
  tool: DemoExecutionBinding['tool'],
  args: Record<string, unknown>,
  overrides: Partial<DemoExecutionBinding> = {}
): DemoExecutionBinding {
  return {
    subject,
    installationId: 'de.hsh.hasi.anny',
    executionId: randomUUID(),
    tool,
    argsHash: digest(args),
    configurationRevision: 0,
    ...overrides
  };
}

function executionHeader(binding: DemoExecutionBinding): string {
  return Buffer.from(JSON.stringify({ schemaVersion: 1, binding }), 'utf8').toString('base64url');
}

function headers(binding?: DemoExecutionBinding, workspaceId?: string) {
  return {
    authorization: `Bearer ${TOKEN}`,
    ...(workspaceId ? { 'x-hasi-demo-workspace': workspaceId } : {}),
    ...(binding ? { [DEMO_EXECUTION_HEADER]: executionHeader(binding) } : {})
  };
}

function createBooking(
  app: ReturnType<typeof createAnnyMock>,
  slot: { startDate: string; endDate: string },
  binding?: DemoExecutionBinding,
  workspaceId?: string
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/orders/from-config?o=${MOCK_IDS.organization}`,
    headers: { ...headers(binding, workspaceId), 'content-type': 'application/json' },
    payload: {
      order_customer_id: MOCK_IDS.customers.student,
      bookings: [{
        resource_id: MOCK_IDS.resources.seminarRoom,
        service_id: { [MOCK_IDS.services.students2]: 1 },
        start_date: slot.startDate,
        end_date: slot.endDate,
        customer_id: MOCK_IDS.customers.student
      }]
    }
  });
}

function readStatus(app: ReturnType<typeof createAnnyMock>, binding: DemoExecutionBinding, workspaceId?: string) {
  return app.inject({
    method: 'POST',
    url: STATUS_URL,
    headers: { ...headers(undefined, workspaceId), 'content-type': 'application/json' },
    payload: { binding }
  });
}

function customerBookings(app: ReturnType<typeof createAnnyMock>) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/customers/${MOCK_IDS.customers.student}/bookings?o=${MOCK_IDS.organization}&page%5Bsize%5D=50`,
    headers: { authorization: `Bearer ${TOKEN}` }
  });
}

describe('synthetic Anny execution evidence', () => {
  it('commits exact booking and cancellation evidence with their mutations across reconstructed mocks', async () => {
    const store = new MemoryJsonStore('anny-execution-evidence-roundtrip');
    const scope = randomUUID();
    const subject = `demo:${scope}:student`;
    const slot = futureSlot();
    const bookingArgs = bookingArguments(slot);
    const bookingBinding = bindingFor(subject, 'anny.execute_booking', bookingArgs);
    const first = createAnnyMock({ token: TOKEN, store, scope });
    let second: ReturnType<typeof createAnnyMock> | undefined;
    let third: ReturnType<typeof createAnnyMock> | undefined;
    try {
      await first.ready();
      const created = await createBooking(first, slot, bookingBinding);
      expect(created.statusCode).toBe(200);
      const createdBody = created.json<{ included: { id: string }[] }>();
      const bookingId = createdBody.included[0]?.id;
      if (!bookingId) throw new Error('Expected the correlated order to contain a booking.');

      const bookingReceipt = await readStatus(first, bookingBinding);
      expect(bookingReceipt.statusCode).toBe(200);
      expect(bookingReceipt.json()).toMatchObject({
        schemaVersion: 1,
        receipts: [{
          binding: bookingBinding,
          customerId: MOCK_IDS.customers.student,
          arguments: bookingArgs,
          result: { bookingId }
        }]
      });
      const bookingCount = (await customerBookings(first)).json<{ data: unknown[] }>().data.length;

      const cancellationArgs = {
        bookingId,
        resourceId: bookingArgs.resourceId,
        startDate: bookingArgs.startDate,
        endDate: bookingArgs.endDate
      };
      const cancellationBinding = bindingFor(subject, 'anny.execute_cancellation', cancellationArgs);
      second = createAnnyMock({ token: TOKEN, store, scope });
      await second.ready();

      const cancelUrl = `/api/v1/bookings/${bookingId}/cancel?o=${MOCK_IDS.organization}`;
      const canceled = await second.inject({
        method: 'GET',
        url: cancelUrl,
        headers: headers(cancellationBinding)
      });
      expect(canceled.statusCode).toBe(200);
      const canceledBody = canceled.json<{ data: { attributes: { status: string; canceled_at: string } } }>();
      expect(canceledBody.data.attributes.status).toBe('canceled');

      const replay = await second.inject({ method: 'GET', url: cancelUrl, headers: headers(cancellationBinding) });
      expect(replay.statusCode).toBe(200);
      expect(replay.json<{ data: { attributes: { canceled_at: string } } }>().data.attributes.canceled_at)
        .toBe(canceledBody.data.attributes.canceled_at);
      expect((await customerBookings(second)).json<{ data: unknown[] }>().data).toHaveLength(bookingCount);

      third = createAnnyMock({ token: TOKEN, store, scope });
      await third.ready();
      expect((await readStatus(third, bookingBinding)).json<{ receipts: unknown[] }>().receipts).toHaveLength(1);
      expect((await readStatus(third, cancellationBinding)).json<{ receipts: unknown[] }>().receipts).toMatchObject([{
        binding: cancellationBinding,
        customerId: MOCK_IDS.customers.student,
        arguments: cancellationArgs,
        result: { bookingId, status: 'cancelled' }
      }]);
    } finally {
      const apps = [first, second, third].filter((app): app is ReturnType<typeof createAnnyMock> => app !== undefined);
      await Promise.all(apps.map((app) => app.close()));
    }
  });

  it('rejects argument hash and full binding mismatches without creating evidence', async () => {
    const store = new MemoryJsonStore('anny-execution-evidence-mismatch');
    const scope = randomUUID();
    const subject = `demo:${scope}:student`;
    const slot = futureSlot();
    const args = bookingArguments(slot);
    const wrongHashBinding = bindingFor(subject, 'anny.execute_booking', args, {
      argsHash: digest({ ...args, endDate: '2031-02-03T11:00:00.000Z' })
    });
    const app = createAnnyMock({ token: TOKEN, store, scope });
    try {
      await app.ready();
      const before = (await customerBookings(app)).json<{ data: unknown[] }>().data.length;
      const rejected = await createBooking(app, slot, wrongHashBinding);
      expect(rejected.statusCode).toBe(409);
      expect((await customerBookings(app)).json<{ data: unknown[] }>().data).toHaveLength(before);
      expect((await readStatus(app, wrongHashBinding)).json<{ receipts: unknown[] }>().receipts).toEqual([]);

      const successfulBinding = bindingFor(subject, 'anny.execute_booking', args);
      expect((await createBooking(app, slot, successfulBinding)).statusCode).toBe(200);
      const afterSuccess = (await customerBookings(app)).json<{ data: unknown[] }>().data.length;
      const conflictingFullBinding = {
        ...successfulBinding,
        configurationRevision: successfulBinding.configurationRevision + 1
      };
      expect((await createBooking(app, slot, conflictingFullBinding)).statusCode).toBe(409);
      expect((await customerBookings(app)).json<{ data: unknown[] }>().data).toHaveLength(afterSuccess);
      expect((await readStatus(app, conflictingFullBinding)).json<{ receipts: unknown[] }>().receipts).toEqual([]);
      const alteredBindings = [
        conflictingFullBinding,
        { ...successfulBinding, installationId: 'de.hsh.hasi.other' },
        { ...successfulBinding, subject: `demo:${randomUUID()}:student` }
      ];
      for (const altered of alteredBindings) {
        expect((await readStatus(app, altered)).json<{ receipts: unknown[] }>().receipts).toEqual([]);
      }
    } finally {
      await app.close();
    }
  });

  it('keeps demo subjects inside their workspace and prevents a subject from claiming another customer', async () => {
    const store = new MemoryJsonStore('anny-execution-evidence-owner');
    const scope = randomUUID();
    const slot = futureSlot();
    const args = bookingArguments(slot);
    const foreignWorkspace = bindingFor(`demo:${randomUUID()}:student`, 'anny.execute_booking', args);
    const matchingWorkspace = bindingFor(`demo:${scope}:student`, 'anny.execute_booking', args);
    const unscopedSubject = bindingFor('test:unscoped-subject', 'anny.execute_booking', args);
    const app = createAnnyMock({ token: TOKEN, store, scope });
    try {
      await app.ready();
      const before = (await customerBookings(app)).json<{ data: unknown[] }>().data.length;
      expect((await createBooking(app, slot, foreignWorkspace)).statusCode).toBe(403);
      expect((await createBooking(app, slot, unscopedSubject)).statusCode).toBe(403);

      const foreignCustomerBody = {
        order_customer_id: MOCK_IDS.customers.student,
        bookings: [{
          resource_id: args.resourceId,
          service_id: { [args.serviceId]: 1 },
          start_date: args.startDate,
          end_date: args.endDate,
          customer_id: MOCK_IDS.customers.employee
        }]
      };
      const foreignCustomer = await app.inject({
        method: 'POST',
        url: `/api/v1/orders/from-config?o=${MOCK_IDS.organization}`,
        headers: { ...headers(matchingWorkspace), 'content-type': 'application/json' },
        payload: foreignCustomerBody
      });
      expect(foreignCustomer.statusCode).toBe(403);
      expect((await customerBookings(app)).json<{ data: unknown[] }>().data).toHaveLength(before);
      expect((await readStatus(app, foreignWorkspace)).json<{ receipts: unknown[] }>().receipts).toEqual([]);
      expect((await readStatus(app, matchingWorkspace)).json<{ receipts: unknown[] }>().receipts).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('uses the configured workspace UUID even when a privileged request header claims another workspace', async () => {
    const store = new MemoryJsonStore('anny-execution-evidence-configured-workspace');
    const workspaceA = randomUUID();
    const workspaceB = randomUUID();
    const scope = 'anny';
    const slot = futureSlot();
    const args = bookingArguments(slot);
    const foreignBinding = bindingFor(`demo:${workspaceB}:student`, 'anny.execute_booking', args);
    const localBinding = bindingFor(`demo:${workspaceA}:student`, 'anny.execute_booking', args);
    const app = createAnnyMock({ token: TOKEN, store, scope, workspaceId: workspaceA });
    try {
      await app.ready();
      expect((await createBooking(app, slot, foreignBinding, workspaceB)).statusCode).toBe(403);
      expect((await readStatus(app, foreignBinding, workspaceB)).json()).toEqual({ schemaVersion: 1, receipts: [] });

      const accepted = await createBooking(app, slot, localBinding, workspaceA);
      expect(accepted.statusCode).toBe(200);
      expect((await readStatus(app, localBinding, workspaceB)).json()).toMatchObject({
        schemaVersion: 1,
        receipts: [{ binding: localBinding }]
      });
    } finally {
      await app.close();
    }
    expect(() => createAnnyMock({ token: TOKEN, scope, workspaceId: 'workspace-A' }))
      .toThrow('Mock workspace ID must be a valid UUID.');
  });

  it('returns empty status for unknown bindings and preserves the legacy no-header mock behavior', async () => {
    const scope = randomUUID();
    const slot = futureSlot();
    const args = bookingArguments(slot);
    const unknownBinding = bindingFor(`demo:${scope}:student`, 'anny.execute_booking', args);
    const app = createAnnyMock({ token: TOKEN, scope });
    try {
      await app.ready();
      expect((await readStatus(app, unknownBinding)).json()).toEqual({ schemaVersion: 1, receipts: [] });

      const legacyCreate = await createBooking(app, slot);
      expect(legacyCreate.statusCode).toBe(200);
      expect((await readStatus(app, unknownBinding)).json()).toEqual({ schemaVersion: 1, receipts: [] });

      const legacyBookingId = legacyCreate.json<{ included: { id: string }[] }>().included[0]?.id;
      if (!legacyBookingId) throw new Error('Expected the legacy order to contain a booking.');
      const canceled = await app.inject({
        method: 'GET',
        url: `/api/v1/bookings/${legacyBookingId}/cancel?o=${MOCK_IDS.organization}`,
        headers: headers()
      });
      expect(canceled.statusCode).toBe(200);
      expect((await readStatus(app, unknownBinding)).json()).toEqual({ schemaVersion: 1, receipts: [] });
    } finally {
      await app.close();
    }
  });

  it('defaults only a missing evidence map and fails closed on invalid saved evidence', async () => {
    const legacyScope = `legacy-${randomUUID()}`;
    const legacyStore = new MemoryJsonStore('anny-execution-evidence-legacy');
    await legacyStore.compareAndSet(`orders-bookings:${legacyScope}`, null, { orders: [], bookings: [] });
    const legacyApp = createAnnyMock({ token: TOKEN, store: legacyStore, scope: legacyScope });
    const invalidScope = `invalid-${randomUUID()}`;
    const invalidStore = new MemoryJsonStore('anny-execution-evidence-invalid');
    await invalidStore.compareAndSet(`orders-bookings:${invalidScope}`, null, {
      orders: [], bookings: [], demoExecutionEvidence: []
    });
    const invalidApp = createAnnyMock({ token: TOKEN, store: invalidStore, scope: invalidScope });
    try {
      await Promise.all([legacyApp.ready(), invalidApp.ready()]);
      const slot = futureSlot();
      expect((await createBooking(legacyApp, slot)).statusCode).toBe(200);

      const binding = bindingFor('test:invalid-evidence', 'anny.execute_booking', bookingArguments(slot));
      const invalidStatus = await readStatus(invalidApp, binding);
      expect(invalidStatus.statusCode).toBe(500);
      const saved = await invalidStore.read(`orders-bookings:${invalidScope}`);
      expect((saved?.value as { demoExecutionEvidence: unknown[] }).demoExecutionEvidence).toEqual([]);
    } finally {
      await Promise.all([legacyApp.close(), invalidApp.close()]);
    }
  });
});
