import { readFile } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAnnyMock, MOCK_IDS, MOCK_RESOURCE_VIEWS } from '../src/index.js';

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
      url: `/api/v1/services?o=${MOCK_IDS.organization}&page%5Bnumber%5D=1&page%5Bsize%5D=100`,
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
    expect(body.data).toHaveLength(2);
    expect(body.meta).toMatchObject({ has_more: false, interval_count: 2 });
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
});
