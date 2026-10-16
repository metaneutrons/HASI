import { z } from 'zod';
import type { ReadableStream } from 'node:stream/web';
import {
  availabilityResponseSchema,
  genericJsonObjectSchema,
  jsonApiResourceListResponseSchema,
  rawResourceListResponseSchema,
  rawServiceListResponseSchema,
  type JsonApiResource,
  type RawAvailabilityResponse,
  type RawResourceRecord,
  type RawServiceRecord
} from './schemas.js';

export type {
  JsonApiResource,
  RawAvailabilityInterval,
  RawAvailabilityResponse,
  RawResourceRecord,
  RawServiceRecord
} from './schemas.js';

export type RawResource = RawResourceRecord;
export type RawService = RawServiceRecord;
export type RawBooking = JsonApiResource;

export interface AnnyClientOptions {
  baseUrl: string;
  organizationId: string;
  token: string;
  allowLoopback?: boolean;
  allowWrites?: boolean;
  timeoutMs?: number;
  pageSize?: number;
  /** Injection point for deterministic local contract tests. */
  fetchImpl?: typeof fetch;
}

export interface AvailabilityQuery {
  resourceId: string;
  serviceId: string;
  startDate: string;
  duration: number;
}

export interface CreateBookingInput {
  customerId: string;
  resourceId: string;
  serviceId: string;
  startDate: string;
  endDate: string;
}

export interface CreatedBooking {
  bookingId: string;
  orderId?: string;
  customerId: string;
  resourceId: string;
  serviceId: string;
  startDate: string;
  endDate: string;
}

export interface BookingSummary {
  bookingId: string;
  resourceId?: string;
  serviceId?: string;
  startDate?: string;
  endDate?: string;
  status?: string;
}

export class AnnyClientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class AnnyHttpError extends AnnyClientError {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly responseBody: unknown
  ) {
    super(`Anny API returned HTTP ${String(status)} for ${method} ${path}.`);
  }
}

export class AnnyRequestTimeoutError extends AnnyClientError {
  constructor(readonly method: string, readonly path: string, options?: ErrorOptions) {
    super(`Anny API request timed out for ${method} ${path}.`, options);
  }
}

export class AnnyOutcomeUnknownError extends AnnyClientError {
  readonly kind = 'outcome_unknown';

  constructor(
    readonly operation: string,
    readonly reason: 'timeout' | 'transport_error',
    options?: ErrorOptions
  ) {
    super(`The outcome of ${operation} is unknown (${reason}); reconcile with Anny before retrying.`, options);
  }
}

export class AnnyResponseValidationError extends AnnyClientError {
  constructor(readonly method: string, readonly path: string, options?: ErrorOptions) {
    super(`Anny API response did not match its published response schema for ${method} ${path}.`, options);
  }
}

export class AnnyResponseShapeError extends AnnyClientError {
}

export class AnnyUnsupportedOperationError extends AnnyClientError {
  constructor(readonly operation: string, reason: string) {
    super(`${operation} is unsupported: ${reason}`);
  }
}

type HttpMethod = 'GET' | 'POST';

interface RequestOptions<T> {
  method: HttpMethod;
  path: string;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  auth?: 'admin' | 'anonymous';
  schema: z.ZodType<T>;
}

const pageSizeDefault = 100;
const pageLimit = 100;
const maxResponseBytes = 5 * 1024 * 1024;

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host.startsWith('127.');
}

function resourceArray(response: { data: unknown }): unknown[] {
  return Array.isArray(response.data) ? response.data : [response.data];
}

function getLastPage(meta: unknown): number | undefined {
  if (meta === null || typeof meta !== 'object') return undefined;
  const page = (meta as Record<string, unknown>).page;
  if (page === null || typeof page !== 'object') return undefined;
  const value = (page as Record<string, unknown>)['last-page'];
  return typeof value === 'number' ? value : undefined;
}

function getRelationshipIds(resource: JsonApiResource, relationshipName: string): string[] {
  const data = resource.relationships?.[relationshipName]?.data;
  if (Array.isArray(data)) {
    return data.flatMap((entry) => typeof entry.id === 'string' ? [entry.id] : []);
  }
  return data && typeof data.id === 'string' ? [data.id] : [];
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

function bookingSummary(resource: JsonApiResource): BookingSummary {
  const attributes = resource.attributes;
  const summary: BookingSummary = { bookingId: resource.id };
  const resourceId = getRelationshipIds(resource, 'resource')[0];
  const serviceId = getRelationshipIds(resource, 'service')[0];
  const startDate = readString(attributes, 'start_date');
  const endDate = readString(attributes, 'end_date');
  const status = readString(attributes, 'status');
  if (resourceId !== undefined) summary.resourceId = resourceId;
  if (serviceId !== undefined) summary.serviceId = serviceId;
  if (startDate !== undefined) summary.startDate = startDate;
  if (endDate !== undefined) summary.endDate = endDate;
  if (status !== undefined) summary.status = status;
  return summary;
}

function bookingSummaries(response: z.infer<typeof jsonApiResourceListResponseSchema>): BookingSummary[] {
  const data = resourceArray(response) as JsonApiResource[];
  const included = response.included ?? [];
  const result: BookingSummary[] = [];
  let orderWithoutBookingRelationship = false;

  for (const resource of data) {
    if (resource.type === 'bookings') {
      result.push(bookingSummary(resource));
      continue;
    }

    // The pinned Admin OpenAPI declares this route's data as orders.v1. Translate
    // only the documented order -> bookings relationship and included resources.
    if (resource.type === 'orders' && resource.relationships?.bookings?.data === undefined) {
      orderWithoutBookingRelationship = true;
    }
    for (const bookingId of getRelationshipIds(resource, 'bookings')) {
      const booking = included.find((candidate) => candidate.type === 'bookings' && candidate.id === bookingId);
      result.push(booking ? bookingSummary(booking) : { bookingId });
    }
  }
  if (orderWithoutBookingRelationship) {
    throw new AnnyResponseShapeError(
      'The customer bookings route returned an order without its documented bookings relationship; booking records cannot be safely inferred from this response.'
    );
  }
  return result;
}

function bookingIdFromOrderResponse(response: Record<string, unknown>): { bookingId: string; orderId?: string } {
  const rawData = response.data;
  const data = Array.isArray(rawData) ? rawData : rawData === undefined ? [] : [rawData];
  const included: unknown[] = Array.isArray(response.included) ? response.included : [];

  for (const candidate of data) {
    if (candidate === null || typeof candidate !== 'object') continue;
    const record = candidate as Record<string, unknown>;
    const orderId = typeof record.id === 'string' && record.type === 'orders' ? record.id : undefined;
    if (record.type === 'bookings' && typeof record.id === 'string') return { bookingId: record.id };

    const relationships = record.relationships;
    if (relationships === null || typeof relationships !== 'object') continue;
    const bookingsRelationship = (relationships as Record<string, unknown>).bookings;
    if (bookingsRelationship === null || typeof bookingsRelationship !== 'object') continue;
    const bookingsData = (bookingsRelationship as Record<string, unknown>).data;
    const bookingRefs = Array.isArray(bookingsData) ? bookingsData : bookingsData === null || bookingsData === undefined ? [] : [bookingsData];
    for (const bookingRef of bookingRefs) {
      if (bookingRef === null || typeof bookingRef !== 'object') continue;
      const bookingRecord = bookingRef as Record<string, unknown>;
      if (typeof bookingRecord.id !== 'string') continue;
      const includedBooking = included.find((value) => {
        if (value === null || typeof value !== 'object') return false;
        const includedRecord = value as Record<string, unknown>;
        return includedRecord.type === 'bookings' && includedRecord.id === bookingRecord.id;
      });
      if (includedBooking || bookingRecord.type === 'bookings') {
        return orderId === undefined
          ? { bookingId: bookingRecord.id }
          : { bookingId: bookingRecord.id, orderId };
      }
    }
  }

  throw new AnnyResponseShapeError(
    'Anny accepted the order configuration but the response did not identify a booking through a documented booking resource or order relationship; reconcile the order before retrying.'
  );
}

async function readResponseText(response: Response, method: string, path: string): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    await response.body?.cancel();
    throw new AnnyResponseValidationError(method, path);
  }
  const body = response.body;
  if (!body) return '';
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const bytes of body as ReadableStream<Uint8Array>) {
    byteLength += bytes.byteLength;
    if (byteLength > maxResponseBytes) {
      throw new AnnyResponseValidationError(method, path);
    }
    chunks.push(bytes);
  }
  const combined = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

export class AnnyClient {
  private readonly baseUrl: string;
  private readonly organizationId: string;
  private readonly token: string;
  private readonly allowWrites: boolean;
  private readonly timeoutMs: number;
  private readonly pageSize: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnnyClientOptions) {
    const url = new URL(options.baseUrl);
    const loopback = isLoopbackHost(url.hostname);
    if (loopback && options.allowLoopback !== true) {
      throw new TypeError('Loopback Anny API URLs require allowLoopback:true.');
    }
    if (!loopback && url.protocol !== 'https:') {
      throw new TypeError('Anny API base URLs must use HTTPS.');
    }
    if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
      throw new TypeError('baseUrl must be an origin without credentials, path, query, or fragment.');
    }
    if (!options.organizationId.trim()) throw new TypeError('organizationId must not be empty.');
    if (!options.token.trim()) throw new TypeError('token must not be empty.');

    const timeoutMs = options.timeoutMs ?? 10_000;
    const pageSize = options.pageSize ?? pageSizeDefault;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be a positive integer.');
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
      throw new TypeError('pageSize must be an integer between 1 and 1000.');
    }

    this.baseUrl = url.origin;
    this.organizationId = options.organizationId;
    this.token = options.token;
    this.allowWrites = options.allowWrites === true;
    this.timeoutMs = timeoutMs;
    this.pageSize = pageSize;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async listResources(): Promise<RawResource[]> {
    return this.listPaged<RawResource>('/api/v1/resources', rawResourceListResponseSchema);
  }

  async listServices(): Promise<RawService[]> {
    return this.listPaged<RawService>('/api/v1/services', rawServiceListResponseSchema);
  }

  async getAvailability(query: AvailabilityQuery): Promise<RawAvailabilityResponse> {
    if (!query.resourceId.trim() || !query.serviceId.trim()) {
      throw new TypeError('resourceId and serviceId must not be empty.');
    }
    if (!query.startDate.trim() || !Number.isFinite(Date.parse(query.startDate))) {
      throw new TypeError('startDate must be an ISO date or date-time string.');
    }
    if (!Number.isSafeInteger(query.duration) || query.duration < 1) {
      throw new TypeError('duration must be a positive integer number of minutes.');
    }

    return this.request({
      method: 'GET',
      path: '/api/v1/availability/upcoming-intervals',
      auth: 'anonymous',
      query: {
        resource_id: query.resourceId,
        service_id: query.serviceId,
        start_date: query.startDate,
        duration: query.duration
      },
      schema: availabilityResponseSchema
    });
  }

  async listBookings(customerId: string): Promise<BookingSummary[]> {
    if (!customerId.trim()) throw new TypeError('customerId must not be empty.');

    const summaries: BookingSummary[] = [];
    for (let page = 1; page <= pageLimit; page += 1) {
      const response = await this.request({
        method: 'GET',
        path: `/api/v1/customers/${encodeURIComponent(customerId)}/bookings`,
        query: {
          o: this.organizationId,
          'page[number]': page,
          'page[size]': this.pageSize,
          include: 'customer,resource.parent,service'
        },
        schema: jsonApiResourceListResponseSchema
      });
      summaries.push(...bookingSummaries(response));
      const pageItems = resourceArray(response).length;
      const lastPage = getLastPage(response.meta);
      if ((lastPage !== undefined && page >= lastPage) || (lastPage === undefined && pageItems < this.pageSize)) {
        return summaries;
      }
    }

    throw new AnnyClientError(`Anny bookings pagination exceeded ${String(pageLimit)} pages.`);
  }

  async createBooking(input: CreateBookingInput): Promise<CreatedBooking> {
    if (!this.allowWrites) {
      throw new AnnyUnsupportedOperationError('createBooking', 'set allowWrites:true to enable Anny writes.');
    }
    if ([input.customerId, input.resourceId, input.serviceId, input.startDate, input.endDate].some((value) => !value.trim())) {
      throw new TypeError('customerId, resourceId, serviceId, startDate, and endDate must not be empty.');
    }
    const start = Date.parse(input.startDate);
    const end = Date.parse(input.endDate);
    if (!z.iso.datetime({ offset: true }).safeParse(input.startDate).success
      || !z.iso.datetime({ offset: true }).safeParse(input.endDate).success
      || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new TypeError('startDate and endDate must be valid ISO date-time strings with endDate after startDate.');
    }

    const orderConfig = {
      order_customer_id: input.customerId,
      bookings: [{
        resource_id: input.resourceId,
        service_id: { [input.serviceId]: 1 },
        start_date: input.startDate,
        end_date: input.endDate,
        customer_id: input.customerId
      }],
      complete_order: true,
      check_availability: true,
      notify_customer: false
    };

    const response = await this.request({
      method: 'POST',
      path: '/api/v1/orders/from-config',
      query: { o: this.organizationId },
      body: orderConfig,
      schema: genericJsonObjectSchema
    });
    const { bookingId, ...orderResult } = bookingIdFromOrderResponse(response);
    const result: CreatedBooking = {
      bookingId,
      customerId: input.customerId,
      resourceId: input.resourceId,
      serviceId: input.serviceId,
      startDate: input.startDate,
      endDate: input.endDate
    };
    if (orderResult.orderId !== undefined) result.orderId = orderResult.orderId;
    return result;
  }

  cancelBooking(bookingId: string): Promise<never> {
    return Promise.reject(new AnnyUnsupportedOperationError(
      `cancelBooking(${bookingId})`,
      'the Admin lifecycle guide describes cancellation, but the route is absent from the pinned Admin OpenAPI snapshot; no cancel request was sent.'
    ));
  }

  private async listPaged<T>(
    path: string,
    schema: z.ZodType
  ): Promise<T[]> {
    const values: T[] = [];
    for (let page = 1; page <= pageLimit; page += 1) {
      const response = await this.request<unknown>({
        method: 'GET',
        path,
        query: {
          o: this.organizationId,
          'page[number]': page,
          'page[size]': this.pageSize
        },
        schema
      });
      if (response === null || typeof response !== 'object' || !('data' in response)) {
        throw new AnnyResponseValidationError('GET', path);
      }
      const envelope = response as { data: unknown; meta?: unknown };
      const entries = resourceArray(envelope);
      values.push(...entries as T[]);
      const pageItems = entries.length;
      const lastPage = getLastPage(envelope.meta);
      if ((lastPage !== undefined && page >= lastPage) || (lastPage === undefined && pageItems < this.pageSize)) {
        return values;
      }
    }
    throw new AnnyClientError(`Anny pagination exceeded ${String(pageLimit)} pages for ${path}.`);
  }

  private async request<T>(options: RequestOptions<T>): Promise<T> {
    const url = new URL(options.path, `${this.baseUrl}/`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, String(value));
    }

    const headers = new Headers({
      Accept: options.path.includes('/availability/') ? 'application/json' : 'application/vnd.api+json'
    });
    if (options.auth !== 'anonymous') headers.set('Authorization', `Bearer ${this.token}`);
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');

    const controller = new AbortController();
    const timeoutState = { didTimeout: false };
    const timeout = setTimeout(() => {
      timeoutState.didTimeout = true;
      controller.abort();
    }, this.timeoutMs);

    let response: Response;
    let responseText: string;
    try {
      const init: RequestInit = {
        method: options.method,
        headers,
        signal: controller.signal,
        redirect: 'error'
      };
      if (options.body !== undefined) init.body = JSON.stringify(options.body);
      response = await this.fetchImpl(url, init);
      responseText = await readResponseText(response, options.method, options.path);
    } catch (error) {
      if (error instanceof AnnyResponseValidationError) throw error;
      if (options.method === 'POST') {
        throw new AnnyOutcomeUnknownError('createBooking', timeoutState.didTimeout ? 'timeout' : 'transport_error', { cause: error });
      }
      if (timeoutState.didTimeout) throw new AnnyRequestTimeoutError(options.method, options.path, { cause: error });
      throw new AnnyClientError(`Anny API transport failed for ${options.method} ${options.path}.`, { cause: error });
    } finally {
      clearTimeout(timeout);
    }

    let responseBody: unknown;
    if (responseText) {
      try {
        responseBody = JSON.parse(responseText) as unknown;
      } catch (error) {
        if (response.ok) throw new AnnyResponseValidationError(options.method, options.path, { cause: error });
        responseBody = responseText;
      }
    }
    if (!response.ok) {
      throw new AnnyHttpError(response.status, options.method, options.path, responseBody);
    }

    const parsed = options.schema.safeParse(responseBody);
    if (!parsed.success) {
      throw new AnnyResponseValidationError(options.method, options.path, { cause: parsed.error });
    }
    return parsed.data;
  }
}
