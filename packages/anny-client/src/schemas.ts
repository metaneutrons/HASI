import { z } from 'zod';

const relationshipIdentifierSchema = z.object({
  type: z.string(),
  id: z.string()
}).loose();

const relationshipDataSchema = z.union([
  relationshipIdentifierSchema,
  z.array(relationshipIdentifierSchema),
  z.null()
]);

const relationshipSchema = z.object({
  data: relationshipDataSchema.optional(),
  links: z.record(z.string(), z.unknown()).optional(),
  meta: z.record(z.string(), z.unknown()).optional()
}).loose();

const resourceAttributesSchema = z.object({
  name: z.string().optional(),
  slug: z.string().optional(),
  description: z.string().nullable().optional(),
  plain_description: z.string().nullable().optional(),
  quantity: z.number().int().optional(),
  timezone: z.string().optional(),
  bookings_enabled: z.boolean().optional(),
  requires_quota: z.boolean().optional(),
  viewing_requires_community: z.boolean().optional(),
  booking_requires_community: z.boolean().optional()
}).loose();

const serviceAttributesSchema = z.object({
  name: z.string().optional(),
  slug: z.string().optional(),
  description: z.string().nullable().optional(),
  plain_description: z.string().nullable().optional(),
  duration: z.number().int().optional(),
  is_protected: z.boolean().optional(),
  requires_quota: z.boolean().optional(),
  auto_accept_bookings: z.boolean().optional()
}).loose();

export const rawResourceSchema = z.object({
  id: z.string(),
  type: z.string(),
  attributes: resourceAttributesSchema.optional(),
  relationships: z.record(z.string(), relationshipSchema).optional(),
  links: z.record(z.string(), z.unknown()).optional(),
  meta: z.record(z.string(), z.unknown()).optional()
}).loose();

export const rawServiceSchema = z.object({
  id: z.string(),
  type: z.string(),
  attributes: serviceAttributesSchema.optional(),
  relationships: z.record(z.string(), relationshipSchema).optional(),
  links: z.record(z.string(), z.unknown()).optional(),
  meta: z.record(z.string(), z.unknown()).optional()
}).loose();

const paginationMetaSchema = z.object({
  page: z.object({
    'current-page': z.number().int().optional(),
    'per-page': z.number().int().optional(),
    from: z.number().int().nullable().optional(),
    to: z.number().int().nullable().optional(),
    total: z.number().int().optional(),
    'last-page': z.number().int().optional()
  }).loose().optional()
}).loose();

export const rawResourceListResponseSchema = z.object({
  data: z.union([z.array(rawResourceSchema), rawResourceSchema]),
  meta: paginationMetaSchema.optional(),
  links: z.record(z.string(), z.unknown()).optional(),
  included: z.array(z.record(z.string(), z.unknown())).optional()
}).loose();

export const rawServiceListResponseSchema = z.object({
  data: z.union([z.array(rawServiceSchema), rawServiceSchema]),
  meta: paginationMetaSchema.optional(),
  links: z.record(z.string(), z.unknown()).optional(),
  included: z.array(z.record(z.string(), z.unknown())).optional()
}).loose();

const intervalSchema = z.object({
  start_date: z.iso.datetime({ offset: true }).optional(),
  end_date: z.iso.datetime({ offset: true }).optional(),
  unit: z.enum(['minute', 'hour', 'day', 'week', 'month']).optional(),
  available: z.boolean().optional(),
  number_available: z.number().int().optional(),
  remaining_number_available: z.number().int().optional(),
  quota: z.number().int().nullable().optional(),
  unavailability_type: z.string().optional(),
  resource_ids: z.array(z.string()).optional(),
  messages: z.array(z.string()).optional(),
  series_periods: z.array(z.object({
    id: z.string().optional(),
    start: z.iso.datetime({ offset: true }).optional(),
    end: z.iso.datetime({ offset: true }).optional(),
    title: z.string().optional()
  }).loose()).nullable().optional(),
  timeslot_series_id: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  date_time: z.iso.datetime({ offset: true }).optional(),
  local_date_time: z.iso.datetime({ offset: true }).optional(),
  next_end_date: z.iso.datetime({ offset: true }).nullable().optional()
}).loose();

export const availabilityResponseSchema = z.object({
  meta: z.object({
    page_start_date: z.iso.datetime({ offset: true }).nullable().optional(),
    page_end_date: z.iso.datetime({ offset: true }).nullable().optional(),
    unavailability_messages: z.string().nullable().optional(),
    has_more: z.boolean().optional(),
    interval_count: z.number().int().optional()
  }).loose().optional(),
  data: z.array(intervalSchema)
}).loose();

export const jsonApiResourceSchema = z.object({
  id: z.string(),
  type: z.string(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  relationships: z.record(z.string(), relationshipSchema).optional(),
  links: z.record(z.string(), z.unknown()).optional(),
  meta: z.record(z.string(), z.unknown()).optional()
}).loose();

export const jsonApiResourceListResponseSchema = z.object({
  data: z.union([z.array(jsonApiResourceSchema), jsonApiResourceSchema]),
  meta: paginationMetaSchema.optional(),
  links: z.record(z.string(), z.unknown()).optional(),
  included: z.array(jsonApiResourceSchema).optional()
}).loose();

export const genericJsonObjectSchema = z.record(z.string(), z.unknown());

export type RawResourceRecord = z.infer<typeof rawResourceSchema>;
export type RawServiceRecord = z.infer<typeof rawServiceSchema>;
export type RawAvailabilityInterval = z.infer<typeof intervalSchema>;
export type RawAvailabilityResponse = z.infer<typeof availabilityResponseSchema>;
export type JsonApiResource = z.infer<typeof jsonApiResourceSchema>;
export type JsonApiResourceListResponse = z.infer<typeof jsonApiResourceListResponseSchema>;
