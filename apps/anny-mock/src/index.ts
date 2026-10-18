import { createHash, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MemoryJsonStore, updateJson, type JsonStore } from '@hasi/state';

export const MOCK_IDS = {
  organization: '00000000-0000-4000-8000-000000000001',
  resources: {
    seminarRoom: '00000000-0000-4000-8000-000000000101',
    projectRoom: '00000000-0000-4000-8000-000000000102',
    mediaStudio: '00000000-0000-4000-8000-000000000103',
    computerLab: '00000000-0000-4000-8000-000000000104'
  },
  services: {
    students2: '00000000-0000-4000-8000-000000000201',
    staffOnly: '00000000-0000-4000-8000-000000000202',
    hybridMeeting: '00000000-0000-4000-8000-000000000203'
  },
  customers: {
    student: '00000000-0000-4000-8000-000000000301',
    employee: '00000000-0000-4000-8000-000000000302',
    admin: '00000000-0000-4000-8000-000000000303'
  },
  bookings: {
    studentA: '00000000-0000-4000-8000-000000000401',
    studentB: '00000000-0000-4000-8000-000000000402',
    employeeA: '00000000-0000-4000-8000-000000000403',
    adminA: '00000000-0000-4000-8000-000000000404'
  },
  orders: {
    studentA: '00000000-0000-4000-8000-000000000501',
    studentB: '00000000-0000-4000-8000-000000000502',
    employeeA: '00000000-0000-4000-8000-000000000503',
    adminA: '00000000-0000-4000-8000-000000000504'
  }
} as const;

export interface AnnyMockResourceView {
  id: string;
  name: string;
  description: string | null;
  capacity: number | null;
  location: string;
  features: string[];
  serviceId: string;
  serviceIds: string[];
}

export interface AnnyMockCatalogResource {
  id: string;
  name: string;
  description: string;
  capacity: number | null;
  location: string;
  features: string[];
  serviceId: string;
  kind?: 'workplace' | 'meeting_room' | 'lecture_hall' | 'room';
  parentId?: string | null;
  parentName?: string | null;
  officeWorkplaceCount?: number | null;
}

export interface AnnyMockCatalogService {
  id: string;
  name: string;
}

export interface AnnyMockCatalog {
  resources: AnnyMockCatalogResource[];
  services: AnnyMockCatalogService[];
}

export interface CreateAnnyMockOptions {
  token?: string;
  store?: JsonStore;
  scope?: string;
  /** Optional sanitized catalog supplied by the local demo composition. */
  catalog?: AnnyMockCatalog;
}

interface MockResource {
  id: string;
  type: 'resources';
  attributes: {
    name: string;
    slug: string;
    description: string;
    plain_description: string;
    quantity: number;
    timezone: string;
    bookings_enabled: boolean;
    requires_quota: boolean;
    live: boolean;
    public_listing: boolean;
  };
  relationships: {
    services: { data: { type: 'services'; id: string }[] };
  };
}

interface MockService {
  id: string;
  type: 'services';
  attributes: {
    name: string;
    slug: string;
    description: string;
    duration: number;
    currency: string;
    price: number;
    is_protected: boolean | 0 | 1;
    requires_quota: boolean;
    auto_accept_bookings: boolean;
  };
  relationships: {
    resources: { data: { type: 'resources'; id: string }[] };
  };
}

interface MockBooking {
  id: string;
  type: 'bookings';
  attributes: {
    number: string;
    status: 'reserved' | 'requested' | 'accepted' | 'rejected' | 'canceled' | 'expired';
    canceled_at?: string | null;
    is_blocker: boolean;
    start_date: string;
    end_date: string;
    charged_duration: number;
    weight: number;
    is_sequence: boolean;
    price_hidden: boolean;
    visible_for_customer: boolean;
    can_edit: boolean;
    is_own: boolean;
    total: number;
    is_net_total: boolean;
    customer_note: string | null;
  };
  relationships: {
    customer: { data: { type: 'customers'; id: string } };
    resource: { data: { type: 'resources'; id: string } };
    service: { data: { type: 'services'; id: string } };
    order: { data: { type: 'orders'; id: string } };
  };
}

interface MockOrder {
  id: string;
  type: 'orders';
  attributes: {
    number: string;
    currency: string;
    total: number;
    modification_total: number;
    net_amount: number;
    tax_amount: number;
    discount_amount: number;
    status: 'completed';
    access_token: null;
    has_payment: boolean;
    manually_created: boolean;
    expires_at: string;
    start_date: string;
    end_date: string;
  };
  relationships: {
    bookings: { data: { type: 'bookings'; id: string }[] };
    customer: { data: { type: 'customers'; id: string } };
  };
}

const annyIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const uuidSchema = z.uuid();
const serviceQuantitySchema = z.record(annyIdSchema, z.number().int().positive());

const orderFromConfigSchema = z.object({
  order_customer_id: uuidSchema,
  bookings: z.array(z.object({
    resource_id: annyIdSchema,
    service_id: serviceQuantitySchema,
    start_date: z.iso.datetime({ offset: true }),
    end_date: z.iso.datetime({ offset: true }),
    customer_id: uuidSchema.optional()
  }).loose()).min(1),
  complete_order: z.boolean().optional(),
  check_availability: z.boolean().optional(),
  notify_customer: z.boolean().optional()
}).loose();

const serviceSpecs = [
  {
    id: MOCK_IDS.services.students2,
    name: '2 Studierende',
    slug: '2-students',
    description: 'Besprechungen und gemeinsame Arbeit für Studierende.',
    duration: 60,
    isProtected: false,
    resources: [MOCK_IDS.resources.seminarRoom, MOCK_IDS.resources.projectRoom]
  },
  {
    id: MOCK_IDS.services.staffOnly,
    name: 'Mitarbeitendenservice',
    slug: 'staff-only',
    description: 'Besprechungen und Arbeit für Mitarbeitende.',
    duration: 60,
    isProtected: true,
    resources: [MOCK_IDS.resources.mediaStudio]
  },
  {
    id: MOCK_IDS.services.hybridMeeting,
    name: 'Hybride Besprechung',
    slug: 'hybrid-meeting',
    description: 'Besprechungen mit Video- und Präsentationstechnik.',
    duration: 60,
    isProtected: false,
    resources: [MOCK_IDS.resources.projectRoom, MOCK_IDS.resources.computerLab]
  }
] as const;

const presentationConfig: Record<string, Omit<AnnyMockResourceView, 'id' | 'name' | 'description' | 'serviceId' | 'serviceIds'>> = {
  [MOCK_IDS.resources.seminarRoom]: {
    capacity: 12,
    location: 'Campus Linden',
    features: ['Beamer', 'Whiteboard']
  },
  [MOCK_IDS.resources.projectRoom]: {
    capacity: 6,
    location: 'Campus Linden',
    features: ['Display', 'Videokonferenz']
  },
  [MOCK_IDS.resources.mediaStudio]: {
    capacity: 4,
    location: 'Campus Expo Plaza',
    features: ['Aufnahmekabine', 'Studiolicht']
  },
  [MOCK_IDS.resources.computerLab]: {
    capacity: 24,
    location: 'Campus Ricklinger Stadtweg',
    features: ['Arbeitsplätze', 'Beamer']
  }
};

const resources: MockResource[] = [
  {
    id: MOCK_IDS.resources.seminarRoom,
    type: 'resources',
    attributes: {
      name: 'Seminarraum 101',
      slug: 'seminar-room-101',
      description: 'Heller Seminarraum für gemeinsame Projekte und Workshops.',
      plain_description: 'Heller Seminarraum für gemeinsame Projekte und Workshops.',
      quantity: 1,
      timezone: 'Europe/Berlin',
      bookings_enabled: true,
      requires_quota: false,
      live: true,
      public_listing: true
    },
    relationships: {
      services: { data: [{ type: 'services', id: MOCK_IDS.services.students2 }] }
    }
  },
  {
    id: MOCK_IDS.resources.projectRoom,
    type: 'resources',
    attributes: {
      name: 'Projektraum 202',
      slug: 'project-room-202',
      description: 'Ruhiger Projektraum für Gruppenarbeit und Besprechungen.',
      plain_description: 'Ruhiger Projektraum für Gruppenarbeit und Besprechungen.',
      quantity: 1,
      timezone: 'Europe/Berlin',
      bookings_enabled: true,
      requires_quota: false,
      live: true,
      public_listing: true
    },
    relationships: {
      services: { data: [
        { type: 'services', id: MOCK_IDS.services.students2 },
        { type: 'services', id: MOCK_IDS.services.hybridMeeting }
      ] }
    }
  },
  {
    id: MOCK_IDS.resources.mediaStudio,
    type: 'resources',
    attributes: {
      name: 'Medienstudio',
      slug: 'media-studio',
      description: 'Studio für Audioaufnahmen und kleinere Produktionen.',
      plain_description: 'Studio für Audioaufnahmen und kleinere Produktionen.',
      quantity: 1,
      timezone: 'Europe/Berlin',
      bookings_enabled: true,
      requires_quota: false,
      live: true,
      public_listing: true
    },
    relationships: {
      services: { data: [{ type: 'services', id: MOCK_IDS.services.staffOnly }] }
    }
  },
  {
    id: MOCK_IDS.resources.computerLab,
    type: 'resources',
    attributes: {
      name: 'Computerraum 3',
      slug: 'computer-lab-3',
      description: 'Computerraum mit Arbeitsplätzen für Lehrveranstaltungen.',
      plain_description: 'Computerraum mit Arbeitsplätzen für Lehrveranstaltungen.',
      quantity: 1,
      timezone: 'Europe/Berlin',
      bookings_enabled: true,
      requires_quota: false,
      live: true,
      public_listing: true
    },
    relationships: {
      services: { data: [{ type: 'services', id: MOCK_IDS.services.hybridMeeting }] }
    }
  }
];

const services: MockService[] = serviceSpecs.map((service) => ({
  id: service.id,
  type: 'services',
  attributes: {
    name: service.name,
    slug: service.slug,
    description: service.description,
    duration: service.duration,
    currency: 'EUR',
    price: 0,
    is_protected: service.isProtected,
    requires_quota: false,
    auto_accept_bookings: true
  },
  relationships: {
    resources: { data: service.resources.map((resourceId) => ({ type: 'resources', id: resourceId })) }
  }
}));

export const MOCK_RESOURCE_VIEWS: AnnyMockResourceView[] = resources.map((resource) => {
  const serviceIds = resource.relationships.services.data.map((entry) => entry.id);
  const config = presentationConfig[resource.id];
  if (!config || serviceIds.length === 0) throw new Error(`Missing synthetic presentation config for ${resource.id}.`);
  const serviceId = serviceIds[0];
  if (serviceId === undefined) throw new Error(`Missing default service relationship for ${resource.id}.`);
  return {
    id: resource.id,
    name: resource.attributes.name,
    description: resource.attributes.description,
    ...config,
    serviceId,
    serviceIds
  };
});

function isoDayOffset(offsetDays: number, hour: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
}

function makeBooking(
  id: string,
  customerId: string,
  resourceId: string,
  serviceId: string,
  orderId: string,
  dayOffset: number,
  status: 'accepted' | 'requested' = 'accepted'
): MockBooking {
  const startDate = isoDayOffset(dayOffset, 10);
  const endDate = isoDayOffset(dayOffset, 11);
  return {
    id,
    type: 'bookings',
    attributes: {
      number: `M-${id.slice(-4)}`,
      status,
      is_blocker: false,
      start_date: startDate,
      end_date: endDate,
      charged_duration: 60,
      weight: 1,
      is_sequence: false,
      price_hidden: false,
      visible_for_customer: true,
      can_edit: true,
      is_own: true,
      total: 0,
      is_net_total: false,
      customer_note: null
    },
    relationships: {
      customer: { data: { type: 'customers', id: customerId } },
      resource: { data: { type: 'resources', id: resourceId } },
      service: { data: { type: 'services', id: serviceId } },
      order: { data: { type: 'orders', id: orderId } }
    }
  };
}

function makeOrder(id: string, customerId: string, booking: MockBooking): MockOrder {
  return {
    id,
    type: 'orders',
    attributes: {
      number: `O-${id.slice(-4)}`,
      currency: 'EUR',
      total: 0,
      modification_total: 0,
      net_amount: 0,
      tax_amount: 0,
      discount_amount: 0,
      status: 'completed',
      access_token: null,
      has_payment: false,
      manually_created: true,
      expires_at: booking.attributes.end_date,
      start_date: booking.attributes.start_date,
      end_date: booking.attributes.end_date
    },
    relationships: {
      bookings: { data: [{ type: 'bookings', id: booking.id }] },
      customer: { data: { type: 'customers', id: customerId } }
    }
  };
}

const seedBookings = [
  makeBooking(MOCK_IDS.bookings.studentA, MOCK_IDS.customers.student, MOCK_IDS.resources.seminarRoom, MOCK_IDS.services.students2, MOCK_IDS.orders.studentA, 2),
  makeBooking(MOCK_IDS.bookings.studentB, MOCK_IDS.customers.student, MOCK_IDS.resources.projectRoom, MOCK_IDS.services.hybridMeeting, MOCK_IDS.orders.studentB, 4, 'requested'),
  makeBooking(MOCK_IDS.bookings.employeeA, MOCK_IDS.customers.employee, MOCK_IDS.resources.mediaStudio, MOCK_IDS.services.staffOnly, MOCK_IDS.orders.employeeA, 3),
  makeBooking(MOCK_IDS.bookings.adminA, MOCK_IDS.customers.admin, MOCK_IDS.resources.computerLab, MOCK_IDS.services.hybridMeeting, MOCK_IDS.orders.adminA, 5)
];

const seedOrders = seedBookings.map((booking) => {
  const customerId = booking.relationships.customer.data.id;
  return makeOrder(booking.relationships.order.data.id, customerId, booking);
});

const customerIds = new Set<string>(Object.values(MOCK_IDS.customers));

const catalogResourceSchema = z.strictObject({
  id: annyIdSchema,
  name: z.string().min(1),
  description: z.string(),
  capacity: z.number().int().min(1).nullable(),
  location: z.string(),
  features: z.array(z.string()),
  serviceId: annyIdSchema,
  kind: z.enum(['workplace', 'meeting_room', 'lecture_hall', 'room']).optional(),
  parentId: annyIdSchema.nullable().optional(),
  parentName: z.string().nullable().optional(),
  officeWorkplaceCount: z.number().int().min(1).max(1000).nullable().optional()
});
const catalogServiceSchema = z.strictObject({ id: annyIdSchema, name: z.string().min(1) });
const catalogSchema = z.strictObject({
  resources: z.array(catalogResourceSchema).min(1),
  services: z.array(catalogServiceSchema).min(1)
});

function catalogSlug(name: string, id: string): string {
  const normalized = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return normalized || `resource-${id}`;
}

function recordsForCatalog(catalog: AnnyMockCatalog): { resources: MockResource[]; services: MockService[] } {
  const parsed = catalogSchema.parse(catalog);
  const resourceIds = new Set(parsed.resources.map(({ id }) => id));
  const serviceIds = new Set(parsed.services.map(({ id }) => id));
  if (resourceIds.size !== parsed.resources.length || serviceIds.size !== parsed.services.length) {
    throw new TypeError('Catalog resource and service IDs must be unique.');
  }
  for (const resource of parsed.resources) {
    if (!serviceIds.has(resource.serviceId)) {
      throw new TypeError(`Catalog resource ${resource.id} references an unknown service.`);
    }
  }

  const resources: MockResource[] = parsed.resources.map((resource) => ({
    id: resource.id,
    type: 'resources',
    attributes: {
      name: resource.name,
      slug: catalogSlug(resource.name, resource.id),
      description: resource.description,
      plain_description: resource.description,
      quantity: 1,
      timezone: 'Europe/Berlin',
      bookings_enabled: true,
      requires_quota: false,
      live: true,
      public_listing: true
    },
    relationships: {
      services: { data: [{ type: 'services', id: resource.serviceId }] }
    }
  }));
  const services: MockService[] = parsed.services.map((service) => ({
    id: service.id,
    type: 'services',
    attributes: {
      name: service.name,
      slug: catalogSlug(service.name, service.id),
      description: service.name,
      duration: 60,
      currency: 'EUR',
      price: 0,
      is_protected: 0,
      requires_quota: false,
      auto_accept_bookings: true
    },
    relationships: {
      resources: {
        data: parsed.resources
          .filter((resource) => resource.serviceId === service.id)
          .map((resource) => ({ type: 'resources', id: resource.id }))
      }
    }
  }));
  return { resources, services };
}

type PageQuery = Record<string, unknown>;

function parsedPositiveInteger(value: unknown, fallback: number, maximum: number): number | undefined {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : undefined;
}

function pageSlice<T>(
  items: T[],
  query: PageQuery,
  request: FastifyRequest,
  reply: FastifyReply
): { data: T[]; meta: Record<string, unknown>; links: Record<string, string> } | undefined {
  const pageNumber = parsedPositiveInteger(query['page[number]'], 1, 10_000);
  const pageSize = parsedPositiveInteger(query['page[size]'], 15, 50);
  if (pageNumber === undefined || pageSize === undefined) {
    sendError(reply, 400, 'Bad Request', 'page[number] must be positive and page[size] must be between 1 and 50.');
    return undefined;
  }
  const lastPage = Math.max(1, Math.ceil(items.length / pageSize));
  const firstIndex = (pageNumber - 1) * pageSize;
  const data = items.slice(firstIndex, firstIndex + pageSize);
  const pageLink = (page: number): string => {
    const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
    url.searchParams.set('page[number]', String(page));
    url.searchParams.set('page[size]', String(pageSize));
    return `${url.origin}${url.pathname}${url.search}`;
  };
  return {
    data,
    meta: {
      page: {
        'current-page': pageNumber,
        'per-page': pageSize,
        from: data.length > 0 ? firstIndex + 1 : null,
        to: data.length > 0 ? firstIndex + data.length : null,
        total: items.length,
        'last-page': lastPage
      }
    },
    links: {
      first: pageLink(1),
      last: pageLink(lastPage),
      ...(pageNumber > 1 ? { prev: pageLink(pageNumber - 1) } : {}),
      ...(pageNumber < lastPage ? { next: pageLink(pageNumber + 1) } : {})
    }
  };
}

function sendError(reply: FastifyReply, status: number, title: string, detail: string): void {
  reply.code(status).type('application/vnd.api+json').send({
    errors: [{ status: String(status), title, detail }]
  });
}

function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  token: string
): boolean {
  if (request.headers.authorization !== `Bearer ${token}`) {
    sendError(reply, 401, 'Unauthorized', 'A valid mock Admin API Bearer token is required.');
    return false;
  }
  return true;
}

function requireOrganization(query: PageQuery, reply: FastifyReply): boolean {
  if (query.o !== MOCK_IDS.organization) {
    sendError(reply, 400, 'Bad Request', 'The mock organization query parameter o must match MOCK_IDS.organization.');
    return false;
  }
  return true;
}

function intervalsOverlap(firstStart: string, firstEnd: string, secondStart: string, secondEnd: string): boolean {
  return Date.parse(firstStart) < Date.parse(secondEnd) && Date.parse(secondStart) < Date.parse(firstEnd);
}

function bookingOccupiesAvailability(booking: MockBooking): boolean {
  return ['reserved', 'requested', 'accepted'].includes(booking.attributes.status);
}

function availabilityIntervals(
  resourceIds: string[],
  startDate: string,
  duration: number,
  bookings: MockBooking[]
): Record<string, unknown>[] {
  const base = new Date(startDate);
  const day = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
  const requestedStart = Date.parse(startDate);
  const now = Date.now();
  const candidateStarts = new Set([requestedStart]);
  for (const hour of [9, 13]) {
    const start = new Date(day);
    start.setUTCHours(hour, 0, 0, 0);
    candidateStarts.add(start.getTime());
  }
  return [...candidateStarts].sort((first, second) => first - second).flatMap((timestamp) => {
    const start = new Date(timestamp);
    const end = new Date(start.getTime() + duration * 60_000);
    const startIso = start.toISOString();
    const endIso = end.toISOString();
    if (start.getTime() < requestedStart || start.getTime() < now) return [];
    const availableResourceIds = resourceIds.filter((resourceId) => !bookings.some((booking) => (
      booking.relationships.resource.data.id === resourceId
      && bookingOccupiesAvailability(booking)
      && intervalsOverlap(
        startIso,
        endIso,
        booking.attributes.start_date,
        booking.attributes.end_date
      )
    )));
    return {
      start_date: startIso,
      end_date: endIso,
      unit: 'minute',
      available: availableResourceIds.length > 0,
      number_available: availableResourceIds.length,
      remaining_number_available: availableResourceIds.length,
      quota: null,
      unavailability_type: availableResourceIds.length > 0 ? '' : 'resource',
      resource_ids: availableResourceIds,
      messages: [],
      series_periods: null,
      timeslot_series_id: null,
      title: null,
      date_time: startIso,
      local_date_time: startIso,
      next_end_date: endIso
    };
  });
}

interface MockAggregate {
  orders: MockOrder[];
  bookings: MockBooking[];
}

const MOCK_STATE_KEY_PREFIX = 'orders-bookings:';
const MOCK_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function initialAggregate(bookings: MockBooking[], orders: MockOrder[]): MockAggregate {
  return structuredClone({ orders, bookings });
}

function createOrder(orderId: string, customerId: string, plans: PlannedBooking[], bookings: MockBooking[]): MockOrder {
  const firstBookingPlan = plans[0];
  if (!firstBookingPlan) throw new TypeError('At least one booking is required to create a mock order.');
  return {
    id: orderId,
    type: 'orders',
    attributes: {
      number: `O-${orderId.slice(-4)}`,
      currency: 'EUR',
      total: 0,
      modification_total: 0,
      net_amount: 0,
      tax_amount: 0,
      discount_amount: 0,
      status: 'completed',
      access_token: null,
      has_payment: false,
      manually_created: true,
      expires_at: firstBookingPlan.endDate,
      start_date: plans.reduce((first, item) => item.startDate < first ? item.startDate : first, firstBookingPlan.startDate),
      end_date: plans.reduce((last, item) => item.endDate > last ? item.endDate : last, firstBookingPlan.endDate)
    },
    relationships: {
      bookings: { data: bookings.map((booking) => ({ type: 'bookings', id: booking.id })) },
      customer: { data: { type: 'customers', id: customerId } }
    }
  };
}

interface PlannedBooking {
  resourceId: string;
  serviceId: string;
  customerId: string;
  startDate: string;
  endDate: string;
}

export function createAnnyMock(options: CreateAnnyMockOptions = {}): FastifyInstance {
  const token = options.token ?? process.env.ANNY_MOCK_TOKEN ?? 'anny-mock-token';
  if (!token.trim()) throw new TypeError('Mock token must not be empty.');
  const store = options.store ?? new MemoryJsonStore('anny-mock');
  const scope = options.scope ?? 'local';
  if (!scope.trim()) throw new TypeError('Mock scope must not be empty.');
  const catalogRecords = options.catalog === undefined ? undefined : recordsForCatalog(options.catalog);
  const mockResources = catalogRecords?.resources ?? resources;
  const mockServices = catalogRecords?.services ?? services;
  const initialBookings = options.catalog === undefined ? seedBookings : [];
  const initialOrders = options.catalog === undefined ? seedOrders : [];
  const resourceById = new Map(mockResources.map((resource) => [resource.id, resource]));
  const serviceById = new Map(mockServices.map((service) => [service.id, service]));
  const resourceServiceIds = new Map(mockResources.map((resource) => [
    resource.id,
    new Set(resource.relationships.services.data.map((entry) => entry.id))
  ]));
  const catalogStateSuffix = catalogRecords === undefined
    ? ''
    : `:catalog:${createHash('sha256').update(JSON.stringify({
      resources: catalogRecords.resources.map(({ id }) => id),
      services: catalogRecords.services.map(({ id }) => id)
    })).digest('hex').slice(0, 16)}`;
  const stateKey = `${MOCK_STATE_KEY_PREFIX}${scope}${catalogStateSuffix}`;
  const expiresAt = (): number => Date.now() + MOCK_STATE_TTL_MS;
  const updateAggregate = <R>(update: (current: MockAggregate) => { value: MockAggregate; result: R }): Promise<R> => (
    updateJson(store, stateKey, () => initialAggregate(initialBookings, initialOrders), update, expiresAt())
  );
  const readAggregate = async (): Promise<MockAggregate> => {
    const record = await store.read(stateKey);
    if (record) return record.value as MockAggregate;
    return updateAggregate(current => ({ value: current, result: current }));
  };

  const app = Fastify({ logger: false });
  app.get('/health', () => ({ status: 'ok', mode: 'synthetic' }));

  app.get('/api/v1/resources', async (request, reply) => {
    if (!requireAdmin(request, reply, token)) return;
    const query = request.query as PageQuery;
    if (!requireOrganization(query, reply)) return;
    const page = pageSlice(mockResources, query, request, reply);
    if (!page) return;
    return reply.type('application/vnd.api+json').send(page);
  });

  app.get('/api/v1/services', async (request, reply) => {
    if (!requireAdmin(request, reply, token)) return;
    const query = request.query as PageQuery;
    if (!requireOrganization(query, reply)) return;
    const page = pageSlice(mockServices, query, request, reply);
    if (!page) return;
    return reply.type('application/vnd.api+json').send(page);
  });

  app.get('/api/v1/availability/upcoming-intervals', async (request, reply) => {
    const query = request.query as PageQuery;
    const serviceId = typeof query.service_id === 'string' ? query.service_id : undefined;
    const resourceId = typeof query.resource_id === 'string' ? query.resource_id : undefined;
    const startDate = typeof query.start_date === 'string' ? query.start_date : undefined;
    const duration = parsedPositiveInteger(query.duration, 60, 1440);
    if (!serviceId) {
      return reply.code(400).type('application/json').send({ errors: [{ title: 'Bad Request', detail: 'service_id is required.' }] });
    }
    if (!serviceById.has(serviceId)) {
      return reply.code(404).type('application/json').send({ errors: [{ title: 'Not Found', detail: 'Unknown service_id.' }] });
    }
    if (resourceId && !resourceById.has(resourceId)) {
      return reply.code(404).type('application/json').send({ errors: [{ title: 'Not Found', detail: 'Unknown resource_id.' }] });
    }
    if (!startDate || !Number.isFinite(Date.parse(startDate))) {
      return reply.code(400).type('application/json').send({ errors: [{ title: 'Bad Request', detail: 'start_date must be a valid ISO date or date-time.' }] });
    }
    if (duration === undefined) {
      return reply.code(400).type('application/json').send({ errors: [{ title: 'Bad Request', detail: 'duration must be a positive integer no greater than 1440.' }] });
    }

    const availableResources = mockResources
      .filter((resource) => resourceId ? resource.id === resourceId : true)
      .filter((resource) => resourceServiceIds.get(resource.id)?.has(serviceId) === true)
      .map((resource) => resource.id);
    const aggregate = await readAggregate();
    const data = availabilityIntervals(availableResources, startDate, duration, aggregate.bookings);
    const periodStart = new Date(startDate);
    const periodEnd = new Date(periodStart);
    periodEnd.setUTCDate(periodEnd.getUTCDate() + 1);
    return reply.type('application/json').send({
      meta: {
        page_start_date: periodStart.toISOString(),
        page_end_date: periodEnd.toISOString(),
        unavailability_messages: null,
        has_more: false,
        interval_count: data.length
      },
      data
    });
  });

  app.get('/api/v1/customers/:customerId/bookings', async (request, reply) => {
    if (!requireAdmin(request, reply, token)) return;
    const query = request.query as PageQuery;
    if (!requireOrganization(query, reply)) return;
    const { customerId } = request.params as { customerId: string };
    if (!customerIds.has(customerId)) {
      sendError(reply, 404, 'Not Found', 'Unknown mock customer.');
      return;
    }

    const aggregate = await readAggregate();
    const customerBookings = aggregate.bookings.filter((booking) => booking.relationships.customer.data.id === customerId);
    const customerBookingIds = new Set(customerBookings.map((booking) => booking.id));
    const customerOrders = aggregate.orders.filter((order) => order.relationships.customer.data.id === customerId);
    const page = pageSlice(customerOrders, query, request, reply);
    if (!page) return;
    return reply.type('application/vnd.api+json').send({
      ...page,
      included: customerBookings.filter((booking) => customerBookingIds.has(booking.id))
    });
  });

  app.get('/api/v1/bookings/:bookingId/cancel', async (request, reply) => {
    if (!requireAdmin(request, reply, token)) return;
    const query = request.query as PageQuery;
    if (!requireOrganization(query, reply)) return;
    const { bookingId } = request.params as { bookingId: string };

    const result = await updateAggregate<
      | { kind: 'missing' }
      | { kind: 'canceled'; booking: MockBooking }
      | { kind: 'not-cancellable' }
    >((current) => {
      const booking = current.bookings.find((item) => item.id === bookingId);
      if (!booking) return { value: current, result: { kind: 'missing' as const } };
      if (booking.attributes.status === 'canceled') {
        return { value: current, result: { kind: 'canceled' as const, booking } };
      }
      if (booking.attributes.status !== 'accepted' && booking.attributes.status !== 'requested') {
        return { value: current, result: { kind: 'not-cancellable' as const } };
      }

      const canceledBooking: MockBooking = {
        ...booking,
        attributes: {
          ...booking.attributes,
          status: 'canceled',
          canceled_at: new Date().toISOString()
        }
      };
      return {
        value: {
          ...current,
          bookings: current.bookings.map((item) => item.id === bookingId ? canceledBooking : item)
        },
        result: { kind: 'canceled' as const, booking: canceledBooking }
      };
    });

    if (result.kind === 'missing') {
      sendError(reply, 404, 'Not Found', 'Unknown mock booking.');
      return;
    }
    if (result.kind === 'not-cancellable') {
      sendError(reply, 409, 'Conflict', 'Only accepted or requested mock bookings can be canceled.');
      return;
    }

    return reply.code(200).type('application/vnd.api+json').send({ data: result.booking });
  });

  app.post('/api/v1/orders/from-config', async (request, reply) => {
    if (!requireAdmin(request, reply, token)) return;
    const query = request.query as PageQuery;
    if (!requireOrganization(query, reply)) return;
    const parsed = orderFromConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      sendError(reply, 400, 'Bad Request', 'The order configuration does not match the documented booking fields.');
      return;
    }

    const config = parsed.data;
    if (!customerIds.has(config.order_customer_id)) {
      sendError(reply, 404, 'Not Found', 'Unknown mock order customer.');
      return;
    }
    const plannedBookings: PlannedBooking[] = [];
    for (const item of config.bookings) {
      if (!resourceById.has(item.resource_id)) {
        sendError(reply, 404, 'Not Found', 'Unknown resource_id in order configuration.');
        return;
      }
      const serviceIds = Object.keys(item.service_id);
      const serviceId = serviceIds[0];
      if (serviceIds.length !== 1 || serviceId === undefined || !serviceById.has(serviceId)) {
        sendError(reply, 422, 'Unprocessable Entity', 'Each mock booking must identify one known service ID in service_id.');
        return;
      }
      if (resourceServiceIds.get(item.resource_id)?.has(serviceId) !== true) {
        sendError(reply, 422, 'Unprocessable Entity', 'The selected service is not linked to the selected mock resource.');
        return;
      }
      const customerId = item.customer_id ?? config.order_customer_id;
      if (!customerIds.has(customerId)) {
        sendError(reply, 404, 'Not Found', 'Unknown customer_id in booking configuration.');
        return;
      }
      if (Date.parse(item.end_date) <= Date.parse(item.start_date)) {
        sendError(reply, 422, 'Unprocessable Entity', 'end_date must be after start_date.');
        return;
      }
      plannedBookings.push({
        resourceId: item.resource_id,
        serviceId,
        customerId,
        startDate: item.start_date,
        endDate: item.end_date
      });
    }

    const orderId = randomUUID();
    const created: MockBooking[] = plannedBookings.map((planned) => {
      const id = randomUUID();
      return {
        id,
        type: 'bookings',
        attributes: {
          number: `M-${id.slice(-8)}`,
          status: 'accepted',
          is_blocker: false,
          start_date: planned.startDate,
          end_date: planned.endDate,
          charged_duration: Math.round((Date.parse(planned.endDate) - Date.parse(planned.startDate)) / 60_000),
          weight: 1,
          is_sequence: false,
          price_hidden: false,
          visible_for_customer: true,
          can_edit: true,
          is_own: true,
          total: 0,
          is_net_total: false,
          customer_note: null
        },
        relationships: {
          customer: { data: { type: 'customers', id: planned.customerId } },
          resource: { data: { type: 'resources', id: planned.resourceId } },
          service: { data: { type: 'services', id: planned.serviceId } },
          order: { data: { type: 'orders', id: orderId } }
        }
      };
    });
    const order = createOrder(orderId, config.order_customer_id, plannedBookings, created);
    const result = await updateAggregate((current) => {
      const hasInternalConflict = plannedBookings.some((planned, index) => plannedBookings.some((other, otherIndex) => (
        otherIndex < index
        && planned.resourceId === other.resourceId
        && intervalsOverlap(planned.startDate, planned.endDate, other.startDate, other.endDate)
      )));
      const hasExistingConflict = current.bookings.some((existing) => plannedBookings.some((planned) => (
        bookingOccupiesAvailability(existing)
        && existing.relationships.resource.data.id === planned.resourceId
        && intervalsOverlap(
          existing.attributes.start_date,
          existing.attributes.end_date,
          planned.startDate,
          planned.endDate
        )
      )));
      if (hasInternalConflict || hasExistingConflict) return { value: current, result: 'conflict' as const };
      return {
        value: {
          bookings: [...current.bookings, ...created],
          orders: [...current.orders, order]
        },
        result: 'created' as const
      };
    });
    if (result === 'conflict') {
      sendError(reply, 409, 'Conflict', 'A mock booking already occupies this resource during the requested interval.');
      return;
    }

    return reply.code(200).type('application/vnd.api+json').send({
      data: order,
      included: created
    });
  });

  app.setNotFoundHandler((request, reply) => {
    sendError(reply, 404, 'Not Found', `No mock Anny route for ${request.method} ${request.url}.`);
  });

  return app;
}

export const MOCK_SERVICE_IDS = Object.freeze(Object.values(MOCK_IDS.services));
