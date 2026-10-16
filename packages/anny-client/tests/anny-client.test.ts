import { afterEach, describe, expect, it } from 'vitest';
import {
  AnnyClient,
  AnnyOutcomeUnknownError,
  AnnyResponseValidationError,
  AnnyResponseShapeError,
  AnnyUnsupportedOperationError,
  type CreateBookingInput
} from '../src/index.js';
import { createAnnyMock, MOCK_IDS, type AnnyMockCatalog } from '../../../apps/anny-mock/src/index.js';

const token = 'client-contract-token';
const organizationId = MOCK_IDS.organization;
const baseInput: CreateBookingInput = {
  customerId: MOCK_IDS.customers.student,
  resourceId: MOCK_IDS.resources.seminarRoom,
  serviceId: MOCK_IDS.services.students2,
  startDate: '2026-11-02T10:00:00Z',
  endDate: '2026-11-02T11:00:00Z'
};

describe('AnnyClient', () => {
  const apps: ReturnType<typeof createAnnyMock>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function clientFor(options: {
    allowWrites?: boolean;
    pageSize?: number;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    catalog?: AnnyMockCatalog;
  } = {}) {
    const app = createAnnyMock({ token, ...(options.catalog ? { catalog: options.catalog } : {}) });
    apps.push(app);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    return new AnnyClient({
      baseUrl: address,
      organizationId,
      token,
      allowLoopback: true,
      ...options
    });
  }

  it('paginates resources and services, retaining documented resource-service relationships', async () => {
    const client = await clientFor({ pageSize: 2 });
    const resources = await client.listResources();
    const services = await client.listServices();

    expect(resources).toHaveLength(4);
    expect(services).toHaveLength(3);
    expect(resources.find((resource) => resource.id === MOCK_IDS.resources.projectRoom)?.relationships?.services?.data)
      .toEqual([
        { type: 'services', id: MOCK_IDS.services.students2 },
        { type: 'services', id: MOCK_IDS.services.hybridMeeting }
      ]);
  });

  it('uses the vendor page size limit and preserves numeric-string resource IDs across pages', async () => {
    const catalog: AnnyMockCatalog = {
      resources: Array.from({ length: 51 }, (_, index) => ({
        id: String(index + 1000),
        name: `Room ${String(index + 1)}`,
        description: 'Catalog room',
        capacity: index === 0 ? null : 4,
        location: 'Campus',
        features: [],
        serviceId: '82001'
      })),
      services: [{ id: '82001', name: 'Room booking' }]
    };
    const requestedPageSizes: string[] = [];
    const fetchImpl: typeof fetch = (input, init) => {
      const requestUrl = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      requestedPageSizes.push(requestUrl.searchParams.get('page[size]') ?? '');
      return fetch(input, init);
    };
    const client = await clientFor({ catalog, fetchImpl });
    const resources = await client.listResources();

    expect(requestedPageSizes).toEqual(['50', '50']);
    expect(resources).toHaveLength(51);
    expect(resources[0]?.id).toBe('1000');
    expect(resources[50]?.id).toBe('1050');
    await expect(clientFor({ pageSize: 51 })).rejects.toThrow('pageSize must be an integer between 1 and 50.');
  });

  it('accepts only boolean or integer 0/1 service protection values', async () => {
    const readProtection = async (value: unknown) => {
      const client = new AnnyClient({
        baseUrl: 'http://localhost:4102',
        organizationId,
        token,
        allowLoopback: true,
        fetchImpl: () => Promise.resolve(new Response(JSON.stringify({
          data: { id: '81002', type: 'services', attributes: { is_protected: value } }
        }), { status: 200, headers: { 'content-type': 'application/vnd.api+json' } }))
      });
      return client.listServices();
    };

    await expect(readProtection(0)).resolves.toMatchObject([{ attributes: { is_protected: false } }]);
    await expect(readProtection(1)).resolves.toMatchObject([{ attributes: { is_protected: true } }]);
    await expect(readProtection(false)).resolves.toMatchObject([{ attributes: { is_protected: false } }]);
    await expect(readProtection(true)).resolves.toMatchObject([{ attributes: { is_protected: true } }]);
    await expect(readProtection(2)).rejects.toBeInstanceOf(AnnyResponseValidationError);
    await expect(readProtection('1')).rejects.toBeInstanceOf(AnnyResponseValidationError);
  });

  it('reads public availability without applying the Admin Bearer identity', async () => {
    const authHeaders: (string | null)[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      authHeaders.push(headers.get('authorization'));
      return fetch(input, init);
    };
    const client = await clientFor({ fetchImpl });
    const response = await client.getAvailability({
      resourceId: MOCK_IDS.resources.seminarRoom,
      serviceId: MOCK_IDS.services.students2,
      startDate: '2026-11-02',
      duration: 60
    });

    expect(response.data).toHaveLength(2);
    expect(response.data[0]?.resource_ids).toEqual([MOCK_IDS.resources.seminarRoom]);
    expect(authHeaders).toEqual([null]);
  });

  it('translates documented customer order booking relationships into summaries', async () => {
    const client = await clientFor();
    const bookings = await client.listBookings(MOCK_IDS.customers.student);

    expect(bookings).toHaveLength(2);
    expect(bookings[0]).toMatchObject({
      bookingId: MOCK_IDS.bookings.studentA,
      resourceId: MOCK_IDS.resources.seminarRoom,
      serviceId: MOCK_IDS.services.students2,
      status: 'accepted'
    });
    expect(typeof bookings[0]?.startDate).toBe('string');
    expect(typeof bookings[0]?.endDate).toBe('string');
  });

  it('reports the OpenAPI customer-bookings order ambiguity when no bookings relationship is returned', async () => {
    const response: typeof fetch = () => Promise.resolve(new Response(JSON.stringify({
      data: { id: MOCK_IDS.orders.studentA, type: 'orders', attributes: {} }
    }), {
      status: 200,
      headers: { 'content-type': 'application/vnd.api+json' }
    }));
    const client = new AnnyClient({
      baseUrl: 'http://localhost:4102',
      organizationId,
      token,
      allowLoopback: true,
      fetchImpl: response
    });

    const error = await client.listBookings(MOCK_IDS.customers.student).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AnnyResponseShapeError);
    if (!(error instanceof AnnyResponseShapeError)) throw new Error('Expected a customer-bookings response-shape error.');
    expect(error.message).toContain('bookings relationship');
  });

  it('creates through orders/from-config and returns its related booking without sending notifications', async () => {
    let sentBody: Record<string, unknown> | undefined;
    const app = createAnnyMock({ token });
    apps.push(app);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const fetchImpl: typeof fetch = async (input, init) => {
      const parsed: unknown = await new Response(init?.body ?? null).json();
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        sentBody = parsed as Record<string, unknown>;
      }
      return fetch(input, init);
    };
    const client = new AnnyClient({
      baseUrl: address,
      organizationId,
      token,
      allowLoopback: true,
      allowWrites: true,
      fetchImpl
    });
    const result = await client.createBooking(baseInput);

    expect(result.bookingId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.orderId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result).toMatchObject({
      customerId: baseInput.customerId,
      resourceId: baseInput.resourceId,
      serviceId: baseInput.serviceId,
      startDate: baseInput.startDate,
      endDate: baseInput.endDate
    });
    expect(sentBody).toMatchObject({
      order_customer_id: baseInput.customerId,
      complete_order: true,
      check_availability: true,
      notify_customer: false,
      bookings: [{
        resource_id: baseInput.resourceId,
        service_id: { [baseInput.serviceId]: 1 },
        customer_id: baseInput.customerId
      }]
    });
  });

  it('blocks writes by default and surfaces cancellation as unsupported', async () => {
    const client = await clientFor();
    await expect(client.createBooking(baseInput)).rejects.toBeInstanceOf(AnnyUnsupportedOperationError);
    await expect(client.cancelBooking(MOCK_IDS.bookings.studentA)).rejects.toBeInstanceOf(AnnyUnsupportedOperationError);
  });

  it('reports a timed-out create as outcome unknown and sends it once', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = (_input, init) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('request aborted', 'AbortError'));
        }, { once: true });
      });
    };
    const client = new AnnyClient({
      baseUrl: 'http://localhost:4102',
      organizationId,
      token,
      allowLoopback: true,
      allowWrites: true,
      timeoutMs: 5,
      fetchImpl
    });

    const error = await client.createBooking(baseInput).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AnnyOutcomeUnknownError);
    expect(error).toMatchObject({ kind: 'outcome_unknown', reason: 'timeout' });
    expect(calls).toBe(1);
  });
});
