import { describe, expect, it } from 'vitest';
import { MemoryJsonStore, type JsonStore } from '@hasi/state';
import { createAnnyMock, MOCK_IDS } from '../src/index.js';

const TOKEN = 'durable-mock-test-token';
const DAY_MS = 24 * 60 * 60 * 1000;

function futureSlot(daysAhead = 21): { start: string; end: string; dayStart: string } {
  const start = new Date(Date.now() + daysAhead * DAY_MS);
  start.setUTCHours(9, 0, 0, 0);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const dayStart = new Date(start);
  dayStart.setUTCHours(0, 0, 0, 0);
  return { start: start.toISOString(), end: end.toISOString(), dayStart: dayStart.toISOString() };
}

function orderPayload(customerId: string, start: string, end: string) {
  return {
    order_customer_id: customerId,
    bookings: [{
      resource_id: MOCK_IDS.resources.seminarRoom,
      service_id: { [MOCK_IDS.services.students2]: 1 },
      start_date: start,
      end_date: end
    }]
  };
}

function postOrder(app: ReturnType<typeof createAnnyMock>, customerId: string, start: string, end: string) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/orders/from-config?o=${MOCK_IDS.organization}`,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    payload: orderPayload(customerId, start, end)
  });
}

function customerBookings(app: ReturnType<typeof createAnnyMock>, customerId: string) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/customers/${customerId}/bookings?o=${MOCK_IDS.organization}&page%5Bsize%5D=100`,
    headers: { authorization: `Bearer ${TOKEN}` }
  });
}

class PausingJsonStore implements JsonStore {
  private nextGate: {
    started: () => void;
    wait: Promise<void>;
  } | undefined;

  constructor(private readonly inner: JsonStore) {}

  read(key: string): Promise<{ revision: string; value: unknown } | undefined> {
    return this.inner.read(key);
  }

  async compareAndSet(key: string, expectedRevision: string | null, value: unknown, expiresAt?: number): Promise<boolean> {
    const gate = this.nextGate;
    if (gate) {
      this.nextGate = undefined;
      gate.started();
      await gate.wait;
    }
    return this.inner.compareAndSet(key, expectedRevision, value, expiresAt);
  }

  delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }

  pauseNextCompareAndSet(): { started: Promise<void>; release: () => void } {
    let signalStarted!: () => void;
    let resume!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const wait = new Promise<void>((resolve) => { resume = resolve; });
    this.nextGate = { started: signalStarted, wait };
    return { started, release: resume };
  }
}

describe('durable Anny mock state', () => {
  it('shares committed orders across mock instances and uses them for availability', async () => {
    const store = new MemoryJsonStore('durable-shared-test');
    const first = createAnnyMock({ token: TOKEN, store, scope: 'shared' });
    const second = createAnnyMock({ token: TOKEN, store, scope: 'shared' });
    const slot = futureSlot();
    try {
      await Promise.all([first.ready(), second.ready()]);
      const created = await postOrder(first, MOCK_IDS.customers.student, slot.start, slot.end);
      expect(created.statusCode).toBe(200);
      const createdBody = created.json<{ data: { id: string }; included: { id: string }[] }>();

      const bookings = await customerBookings(second, MOCK_IDS.customers.student);
      expect(bookings.statusCode).toBe(200);
      const bookingBody = bookings.json<{ data: { id: string }[]; included: { id: string }[] }>();
      expect(bookingBody.data.map(({ id }) => id)).toContain(createdBody.data.id);
      expect(bookingBody.included.map(({ id }) => id)).toContain(createdBody.included[0]?.id);

      const availability = await second.inject({
        method: 'GET',
        url: `/api/v1/availability/upcoming-intervals?service_id=${MOCK_IDS.services.students2}&resource_id=${MOCK_IDS.resources.seminarRoom}&start_date=${encodeURIComponent(slot.dayStart)}&duration=60`
      });
      expect(availability.statusCode).toBe(200);
      const intervals = availability.json<{ data: { start_date: string; available: boolean; resource_ids: string[] }[] }>().data;
      expect(intervals.find(({ start_date }) => start_date === slot.start)).toMatchObject({ available: false, resource_ids: [] });
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it('atomically rejects overlapping bookings across customers', async () => {
    const store = new MemoryJsonStore('durable-conflict-test');
    const first = createAnnyMock({ token: TOKEN, store, scope: 'shared' });
    const second = createAnnyMock({ token: TOKEN, store, scope: 'shared' });
    const slot = futureSlot();
    try {
      await Promise.all([first.ready(), second.ready()]);
      const replies = await Promise.all([
        postOrder(first, MOCK_IDS.customers.student, slot.start, slot.end),
        postOrder(second, MOCK_IDS.customers.employee, slot.start, slot.end)
      ]);
      expect(replies.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);

      const [student, employee] = await Promise.all([
        customerBookings(first, MOCK_IDS.customers.student),
        customerBookings(second, MOCK_IDS.customers.employee)
      ]);
      const newOrderCount = student.json<{ data: { id: string }[] }>().data.length - 2
        + employee.json<{ data: { id: string }[] }>().data.length - 1;
      expect(newOrderCount).toBe(1);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it('isolates state by server-owned scope', async () => {
    const store = new MemoryJsonStore('durable-scope-test');
    const first = createAnnyMock({ token: TOKEN, store, scope: 'first-scope' });
    const second = createAnnyMock({ token: TOKEN, store, scope: 'second-scope' });
    const slot = futureSlot();
    try {
      await Promise.all([first.ready(), second.ready()]);
      expect((await postOrder(first, MOCK_IDS.customers.student, slot.start, slot.end)).statusCode).toBe(200);

      const beforeSecondWrite = await customerBookings(second, MOCK_IDS.customers.student);
      expect(beforeSecondWrite.json<{ data: { id: string }[] }>().data).toHaveLength(2);
      expect((await postOrder(second, MOCK_IDS.customers.student, slot.start, slot.end)).statusCode).toBe(200);
      expect((await customerBookings(first, MOCK_IDS.customers.student)).json<{ data: { id: string }[] }>().data).toHaveLength(3);
      expect((await customerBookings(second, MOCK_IDS.customers.student)).json<{ data: { id: string }[] }>().data).toHaveLength(3);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it('does not expose a booking while its commit is pending', async () => {
    const store = new PausingJsonStore(new MemoryJsonStore('durable-pending-test'));
    const first = createAnnyMock({ token: TOKEN, store, scope: 'shared' });
    const second = createAnnyMock({ token: TOKEN, store, scope: 'shared' });
    const slot = futureSlot();
    try {
      await Promise.all([first.ready(), second.ready()]);
      await customerBookings(first, MOCK_IDS.customers.student);
      const gate = store.pauseNextCompareAndSet();
      const pendingCreate = postOrder(first, MOCK_IDS.customers.student, slot.start, slot.end);
      await gate.started;

      const beforeCommit = await customerBookings(second, MOCK_IDS.customers.student);
      expect(beforeCommit.json<{ data: { id: string }[] }>().data).toHaveLength(2);

      gate.release();
      expect((await pendingCreate).statusCode).toBe(200);
      const afterCommit = await customerBookings(second, MOCK_IDS.customers.student);
      expect(afterCommit.json<{ data: { id: string }[] }>().data).toHaveLength(3);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });
});
