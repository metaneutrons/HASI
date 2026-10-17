import { readFile } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAnnyMock, MOCK_IDS, MOCK_RESOURCE_VIEWS, type AnnyMockCatalog } from '../src/index.js';

interface OpenApiSnapshot {
  components: { schemas: Record<string, unknown> };
}

const adminOpenApi = JSON.parse(await readFile(
  new URL('../../../docs/research/anny/current/admin.openapi.json', import.meta.url),
  'utf8'
)) as OpenApiSnapshot;
const customerOpenApi = JSON.parse(await readFile(
  new URL('../../../docs/research/anny/current/customer.openapi.json', import.meta.url),
  'utf8'
)) as OpenApiSnapshot;

function validatorFor(spec: OpenApiSnapshot, filename: string, schemaName: string) {
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const schemaId = `https://contracts.local/${filename}`;
  ajv.addSchema({
    $id: schemaId,
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    components: spec.components
  });
  const validate = ajv.getSchema(`${schemaId}#/components/schemas/${schemaName}`);
  if (!validate) throw new Error(`Missing pinned schema ${schemaName}.`);
  return validate;
}

describe('Anny mock contract', () => {
  const app = createAnnyMock({ token: 'contract-test-token' });

  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves paged JSON:API resource and service records matching the pinned models', async () => {
    const resourcesReply = await app.inject({
      method: 'GET',
      url: `/api/v1/resources?o=${MOCK_IDS.organization}&page%5Bnumber%5D=1&page%5Bsize%5D=2`,
      headers: { authorization: 'Bearer contract-test-token' }
    });
    expect(resourcesReply.statusCode).toBe(200);
    const resourcesBody = resourcesReply.json<{ data: Record<string, unknown>[]; meta: { page: Record<string, number> }; links: Record<string, string> }>();
    expect(resourcesBody.data).toHaveLength(2);
    expect(resourcesBody.meta.page['last-page']).toBe(2);
    expect(resourcesBody.links.next).toContain('page%5Bnumber%5D=2');
    const validateResource = validatorFor(adminOpenApi, 'admin', 'resources.v1');
    for (const resource of resourcesBody.data) expect(validateResource(resource)).toBe(true);

    const servicesReply = await app.inject({
      method: 'GET',
      url: `/api/v1/services?o=${MOCK_IDS.organization}&page%5Bnumber%5D=1&page%5Bsize%5D=50`,
      headers: { authorization: 'Bearer contract-test-token' }
    });
    expect(servicesReply.statusCode).toBe(200);
    const servicesBody = servicesReply.json<{ data: Record<string, unknown>[] }>();
    const validateService = validatorFor(adminOpenApi, 'admin', 'services.v1');
    expect(servicesBody.data).toHaveLength(3);
    for (const service of servicesBody.data) expect(validateService(service)).toBe(true);
    expect(MOCK_RESOURCE_VIEWS).toHaveLength(4);
    expect(MOCK_RESOURCE_VIEWS[0]?.capacity).toBe(12);
  });

  it('returns availability intervals conforming to the customer schema', async () => {
    const reply = await app.inject({
      method: 'GET',
      url: `/api/v1/availability/upcoming-intervals?service_id=${MOCK_IDS.services.students2}&resource_id=${MOCK_IDS.resources.seminarRoom}&start_date=2026-11-02T00%3A00%3A00Z&duration=60`
    });
    expect(reply.statusCode).toBe(200);
    const body = reply.json<{ data: Record<string, unknown>[]; meta: { has_more: boolean; interval_count: number } }>();
    expect(body.data).toHaveLength(3);
    expect(body.meta).toMatchObject({ has_more: false, interval_count: 3 });
    const validateInterval = validatorFor(customerOpenApi, 'customer', 'validated-interval.v1');
    for (const interval of body.data) expect(validateInterval(interval)).toBe(true);
  });

  it('returns customer bookings as orders linked to bookings, matching the pinned order model', async () => {
    const reply = await app.inject({
      method: 'GET',
      url: `/api/v1/customers/${MOCK_IDS.customers.student}/bookings?o=${MOCK_IDS.organization}&page%5Bnumber%5D=1&page%5Bsize%5D=15`,
      headers: { authorization: 'Bearer contract-test-token' }
    });
    expect(reply.statusCode).toBe(200);
    const body = reply.json<{ data: Record<string, unknown>[]; included: Record<string, unknown>[] }>();
    expect(body.data).toHaveLength(2);
    expect(body.included).toHaveLength(2);
    const validateOrder = validatorFor(adminOpenApi, 'admin', 'orders.v1');
    const validateBooking = validatorFor(adminOpenApi, 'admin', 'bookings.v1');
    for (const order of body.data) expect(validateOrder(order)).toBe(true);
    for (const booking of body.included) expect(validateBooking(booking)).toBe(true);
    expect((body.data[0]?.relationships as { bookings: { data: { id: string }[] } }).bookings.data[0]?.id)
      .toBe(MOCK_IDS.bookings.studentA);
  });

  it('rejects missing auth, a wrong organization, and malformed order bodies', async () => {
    const unauthenticated = await app.inject({ method: 'GET', url: '/api/v1/resources?o=' + MOCK_IDS.organization });
    expect(unauthenticated.statusCode).toBe(401);

    const wrongOrganization = await app.inject({
      method: 'GET',
      url: '/api/v1/resources?o=00000000-0000-4000-8000-000000000999',
      headers: { authorization: 'Bearer contract-test-token' }
    });
    expect(wrongOrganization.statusCode).toBe(400);

    const invalidOrder = await app.inject({
      method: 'POST',
      url: `/api/v1/orders/from-config?o=${MOCK_IDS.organization}`,
      headers: { authorization: 'Bearer contract-test-token', 'content-type': 'application/json' },
      payload: { order_customer_id: MOCK_IDS.customers.student, bookings: [{ resource_id: 'invalid' }] }
    });
    expect(invalidOrder.statusCode).toBe(400);
  });

  it('uses an optional catalog for availability and bookings with numeric-string Anny IDs', async () => {
    const catalog: AnnyMockCatalog = {
      resources: [{
        id: '1234567',
        name: 'Catalog room',
        description: 'Imported sanitized room metadata.',
        capacity: null,
        location: 'Campus',
        features: [],
        serviceId: '543210'
      }],
      services: [{ id: '543210', name: 'Room booking' }]
    };
    const catalogApp = createAnnyMock({ token: 'catalog-test-token', catalog });
    const start = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000);
    start.setUTCHours(9, 0, 0, 0);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    try {
      await catalogApp.ready();
      const resourcesReply = await catalogApp.inject({
        method: 'GET',
        url: `/api/v1/resources?o=${MOCK_IDS.organization}&page%5Bsize%5D=50`,
        headers: { authorization: 'Bearer catalog-test-token' }
      });
      expect(resourcesReply.json<{ data: { id: string }[] }>().data.map(({ id }) => id)).toEqual(['1234567']);

      const availability = await catalogApp.inject({
        method: 'GET',
        url: `/api/v1/availability/upcoming-intervals?service_id=543210&resource_id=1234567&start_date=${encodeURIComponent(start.toISOString())}&duration=60`
      });
      expect(availability.statusCode).toBe(200);
      expect(availability.json<{ data: { available: boolean; resource_ids: string[] }[] }>().data[0])
        .toMatchObject({ available: true, resource_ids: ['1234567'] });

      const created = await catalogApp.inject({
        method: 'POST',
        url: `/api/v1/orders/from-config?o=${MOCK_IDS.organization}`,
        headers: { authorization: 'Bearer catalog-test-token', 'content-type': 'application/json' },
        payload: {
          order_customer_id: MOCK_IDS.customers.student,
          bookings: [{
            resource_id: '1234567',
            service_id: { '543210': 1 },
            start_date: start.toISOString(),
            end_date: end.toISOString()
          }]
        }
      });
      expect(created.statusCode).toBe(200);
      const createdBody = created.json<{ included: { relationships: { resource: { data: { id: string } }; service: { data: { id: string } } } }[] }>();
      expect(createdBody.included[0]?.relationships).toMatchObject({
        resource: { data: { id: '1234567' } },
        service: { data: { id: '543210' } }
      });

      const bookings = await catalogApp.inject({
        method: 'GET',
        url: `/api/v1/customers/${MOCK_IDS.customers.student}/bookings?o=${MOCK_IDS.organization}&page%5Bsize%5D=50`,
        headers: { authorization: 'Bearer catalog-test-token' }
      });
      expect(bookings.statusCode).toBe(200);
      expect(bookings.json<{ included: { relationships: { resource: { data: { id: string } } } }[] }>().included[0]?.relationships.resource.data.id)
        .toBe('1234567');
    } finally {
      await catalogApp.close();
    }
  });

  it('includes the exact requested Berlin start for an eight-hour workplace slot and rejects its booked overlap', async () => {
    const catalog: AnnyMockCatalog = {
      resources: [{
        id: '1234567',
        name: 'Arbeitsplatz 1J',
        description: 'Synthetic workplace for availability tests.',
        capacity: null,
        location: '1J',
        features: [],
        serviceId: '543210',
        kind: 'workplace'
      }],
      services: [{ id: '543210', name: 'Workplace booking' }]
    };
    const catalogApp = createAnnyMock({ token: 'workplace-test-token', catalog });
    const start = '2030-01-07T07:00:00.000Z'; // Monday, 08:00 Europe/Berlin.
    const end = '2030-01-07T15:00:00.000Z'; // 16:00 Europe/Berlin.
    const availabilityUrl = `/api/v1/availability/upcoming-intervals?service_id=543210&resource_id=1234567&start_date=${encodeURIComponent(start)}&duration=480`;
    try {
      await catalogApp.ready();
      const availability = await catalogApp.inject({ method: 'GET', url: availabilityUrl });
      expect(availability.statusCode).toBe(200);
      const intervals = availability.json<{ data: { start_date: string; end_date: string; available: boolean; resource_ids: string[] }[] }>().data;
      expect(intervals.map(({ start_date }) => start_date)).toEqual([
        start,
        '2030-01-07T09:00:00.000Z',
        '2030-01-07T13:00:00.000Z'
      ]);
      expect(intervals[0]).toMatchObject({ start_date: start, end_date: end, available: true, resource_ids: ['1234567'] });

      const booking = await catalogApp.inject({
        method: 'POST',
        url: `/api/v1/orders/from-config?o=${MOCK_IDS.organization}`,
        headers: { authorization: 'Bearer workplace-test-token', 'content-type': 'application/json' },
        payload: {
          order_customer_id: MOCK_IDS.customers.student,
          bookings: [{ resource_id: '1234567', service_id: { '543210': 1 }, start_date: start, end_date: end }]
        }
      });
      expect(booking.statusCode).toBe(200);

      const afterBooking = await catalogApp.inject({ method: 'GET', url: availabilityUrl });
      const blocked = afterBooking.json<{ data: { start_date: string; end_date: string; available: boolean; resource_ids: string[] }[] }>().data[0];
      expect(blocked).toMatchObject({ start_date: start, end_date: end, available: false, resource_ids: [] });
    } finally {
      await catalogApp.close();
    }
  });
});
