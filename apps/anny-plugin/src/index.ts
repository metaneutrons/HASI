import type { KeyObject } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createPluginServer, digest, type ActorContext, type ExecutionBinding, type ExecutionJournal, type InvocationContext } from '@hasi/plugin-sdk';
import { AnnyClient } from '@hasi/anny-client';
import { annyAppManifest, annyAppResourceUri, annyManifest } from './manifest.js';
import { loadAnnyAppView } from './app-view.js';
import { createAnnySourceReconciler, type AnnyExecutionEvidenceReader } from './source-reconciliation.js';

export { annyAppManifest, annyAppPresentationId, annyAppResourceUri, annyManifest, demoPresentation } from './manifest.js';
export { annyAppViewSha256, loadAnnyAppView } from './app-view.js';
export type { AnnyExecutionEvidenceReader } from './source-reconciliation.js';
export type ResourceKind = 'workplace' | 'meeting_room' | 'lecture_hall' | 'room';
export interface Presentation { capacity: number | null; location: string; features: string[]; serviceId: string; kind?: ResourceKind; parentId?: string | null; parentName?: string | null; officeWorkplaceCount?: number | null }
export interface AnnyPluginOptions { executionJournal?: ExecutionJournal; readExecutionEvidence?: AnnyExecutionEvidenceReader; client: AnnyClient | ((actor: ActorContext, execution?: Readonly<ExecutionBinding>) => AnnyClient); allowedHosts?: string[]; consumeInvocation?: (jti: string, expiresAt: number) => Promise<boolean>; publicKey: KeyObject; serviceToken: string; presentation: Record<string, Presentation>; version?: string; enableAppView?: boolean }
const annyId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const interval = z.strictObject({ resourceId: annyId, serviceId: annyId, startDate: z.iso.datetime({ offset: true }), endDate: z.iso.datetime({ offset: true }) });
const cancellation = interval.omit({ serviceId: true }).extend({ bookingId: annyId });
const resourceKind = z.enum(['workplace', 'meeting_room', 'lecture_hall', 'room']);
const viewResourcesInput = z.strictObject({
  query: z.string().trim().max(100).optional(),
  kind: resourceKind.optional(),
  page: z.number().int().min(0).max(100),
  pageSize: z.number().int().min(1).max(6),
  requestedStartDate: z.iso.datetime({ offset: true }).optional(),
  requestedEndDate: z.iso.datetime({ offset: true }).optional(),
});

export function createAnnyPlugin(options: AnnyPluginOptions): FastifyInstance {
  const enableAppView = options.enableAppView === true;
  const pluginActor = (actor: ActorContext): ActorContext => {
    if (!enableAppView || actor.claims === undefined) return actor;
    const customerId = actor.claims['anny.customerId'];
    const resourceIds = actor.claims['anny.resourceIds'];
    return {
      subject: actor.subject,
      permissions: [...actor.permissions],
      ...(typeof customerId === 'string' ? { customerId } : {}),
      ...(Array.isArray(resourceIds) ? { resourceIds: [...resourceIds] } : {}),
    };
  };
  const customerForActor = (actor: ActorContext): string => {
    const customerId = pluginActor(actor).customerId;
    if (!customerId) throw new Error('No authorized anny account is linked.');
    return customerId;
  };
  const client = (actor: ActorContext, execution?: Readonly<ExecutionBinding>) => typeof options.client === 'function' ? options.client(pluginActor(actor), execution) : options.client;
  const executionBinding = (actor: ActorContext, context: InvocationContext | undefined, tool: string, args: Record<string, unknown>): Readonly<ExecutionBinding> | undefined => context?.executionId
    ? Object.freeze({ subject: actor.subject, installationId: context.installationId, executionId: context.executionId, tool,
      argsHash: digest(args), configurationRevision: context.configurationRevision }) : undefined;
  const selectedManifest = enableAppView ? annyAppManifest : annyManifest;
  const manifest = { ...selectedManifest, version: options.version ?? selectedManifest.version };
  const authorized = (resourceId: string, serviceId: string, actor: ActorContext) => {
    actor = pluginActor(actor);
    const metadata = options.presentation[resourceId];
    if (!(actor.resourceIds ?? []).includes(resourceId) || metadata?.serviceId !== serviceId) throw new Error('Resource/service access denied.');
    return metadata;
  };
  const names = async (actor: ActorContext) => new Map((await client(actor).listResources()).map(resource => {
    const profile = options.presentation[resource.id];
    const name = resource.attributes?.name ?? 'Ressource';
    const qualified = profile?.parentName && profile.parentName !== name ? `${name} · ${profile.parentName}` : name;
    return [resource.id, profile?.kind === 'workplace' ? `Arbeitsplatz · ${qualified}` : qualified];
  }));
  const assertAvailable = async (args: z.infer<typeof interval>, actor: ActorContext) => {
    authorized(args.resourceId, args.serviceId, actor);
    const minutes = (Date.parse(args.endDate) - Date.parse(args.startDate)) / 60000;
    if (!Number.isInteger(minutes) || minutes < 15 || minutes > 1440 || Date.parse(args.startDate) <= Date.now()) throw new Error('Invalid booking interval.');
    const result = await client(actor).getAvailability({ resourceId: args.resourceId, serviceId: args.serviceId, startDate: args.startDate, duration: minutes });
    if (!result.data.some(entry => entry.available === true && Date.parse(entry.start_date ?? '') === Date.parse(args.startDate) && Date.parse(entry.end_date ?? '') === Date.parse(args.endDate))) throw new Error('Requested interval is unavailable.');
  };
  const ownedBooking = async (bookingId: string, actor: ActorContext) => {
    actor = pluginActor(actor);
    const booking = (await client(actor).listBookings(customerForActor(actor))).find(candidate => candidate.bookingId === bookingId);
    if (!booking?.resourceId || !(actor.resourceIds ?? []).includes(booking.resourceId) || !booking.startDate || !booking.endDate) throw new Error('Booking not available for this actor.');
    return { ...booking, resourceId: booking.resourceId, startDate: booking.startDate, endDate: booking.endDate };
  };
  const cancellable = (booking: Awaited<ReturnType<typeof ownedBooking>>) => {
    if (!['accepted', 'confirmed', 'requested'].includes(booking.status ?? '') || Date.parse(booking.startDate) <= Date.now()) throw new Error('Only active future bookings can be cancelled.');
  };
  return createPluginServer({
    ...(options.readExecutionEvidence ? { reconcileExecution: createAnnySourceReconciler({
      readEvidence: options.readExecutionEvidence, customerId: customerForActor, ownedBooking,
      authorizeResource: (resourceId, serviceId, actor) => {
        if (serviceId !== undefined) authorized(resourceId, serviceId, actor);
        else if (!(pluginActor(actor).resourceIds ?? []).includes(resourceId)) throw new Error('Resource access denied.');
      },
    }) } : {}),
    ...(options.executionJournal ? { executionJournal: options.executionJournal } : {}), manifest, publicKey: options.publicKey, serviceToken: options.serviceToken, ...(enableAppView ? { appResources: { [annyAppResourceUri]: loadAnnyAppView() } } : {}), ...(options.allowedHosts ? { allowedHosts: options.allowedHosts } : {}), ...(options.consumeInvocation ? { consumeInvocation: options.consumeInvocation } : {}),
    handlers: {
      'anny.search_resources': async (_args, actor) => ({ resources: (await client(actor).listResources()).flatMap(resource => {
        const profile = options.presentation[resource.id];
        if (!(pluginActor(actor).resourceIds ?? []).includes(resource.id) || !profile || resource.attributes?.bookings_enabled === false) return [];
        return [{ id: resource.id, name: resource.attributes?.name ?? 'Raum', description: resource.attributes?.plain_description ?? '', ...profile, kind: profile.kind ?? 'room', parentId: profile.parentId ?? null, parentName: profile.parentName ?? null, officeWorkplaceCount: profile.officeWorkplaceCount ?? null }];
      }) }),
      ...(enableAppView ? { 'anny.view_resources': async (args: Record<string, unknown>, actor: ActorContext) => {
        const parsed = viewResourcesInput.parse(args);
        const query = parsed.query?.toLocaleLowerCase('de-DE') ?? '';
        const allowedIds = new Set(pluginActor(actor).resourceIds ?? []);
        const resources = (await client(actor).listResources()).flatMap(resource => {
          const profile = options.presentation[resource.id];
          if (!allowedIds.has(resource.id) || !profile || resource.attributes?.bookings_enabled !== true || !profile.serviceId) return [];
          const kind = profile.kind ?? 'room';
          if (parsed.kind !== undefined && parsed.kind !== kind) return [];
          const name = resource.attributes.name ?? 'Raum';
          const description = resource.attributes.plain_description ?? '';
          if (query && [name, description, profile.location, profile.parentName ?? '', ...profile.features].every(value => !value.toLocaleLowerCase('de-DE').includes(query))) return [];
          return [{ id: resource.id, name, description, ...profile, kind, parentId: profile.parentId ?? null, parentName: profile.parentName ?? null, officeWorkplaceCount: profile.officeWorkplaceCount ?? null }];
        });
        const start = parsed.page * parsed.pageSize;
        return {
          resources: resources.slice(start, start + parsed.pageSize),
          total: resources.length,
          page: parsed.page,
          pageSize: parsed.pageSize,
          availabilityChecked: false,
          ...(parsed.requestedStartDate === undefined ? {} : { requestedStartDate: parsed.requestedStartDate }),
          ...(parsed.requestedEndDate === undefined ? {} : { requestedEndDate: parsed.requestedEndDate }),
        };
      } } : {}),
      'anny.get_availability': async (args, actor) => {
        const parsed = z.strictObject({ resourceId: annyId, serviceId: annyId, startDate: z.iso.datetime({ offset: true }), durationMinutes: z.number().int().min(15).max(1440) }).parse(args);
        authorized(parsed.resourceId, parsed.serviceId, actor);
        const result = await client(actor).getAvailability({ resourceId: parsed.resourceId, serviceId: parsed.serviceId, startDate: parsed.startDate, duration: parsed.durationMinutes });
        return { intervals: result.data.flatMap(entry => entry.start_date && entry.end_date && typeof entry.available === 'boolean' ? [{ startDate: entry.start_date, endDate: entry.end_date, available: entry.available }] : []) };
      },
      'anny.list_my_bookings': async (_args, actor) => {
        actor = pluginActor(actor);
        const roomNames = await names(actor);
        const bookings = await client(actor).listBookings(customerForActor(actor));
        return { bookings: bookings.flatMap(booking => booking.resourceId && (actor.resourceIds ?? []).includes(booking.resourceId) && booking.startDate && booking.endDate ? [{ id: booking.bookingId, resourceName: roomNames.get(booking.resourceId) ?? 'Raum', startDate: booking.startDate, endDate: booking.endDate, status: booking.status ?? 'confirmed' }] : []) };
      },
      'anny.propose_booking': async (args, actor) => {
        const parsed = interval.parse(args);
        await assertAvailable(parsed, actor);
        const roomNames = await names(actor);
        return { draft: { executionTool: 'anny.execute_booking', arguments: parsed, resourceName: roomNames.get(parsed.resourceId) ?? 'Raum' } };
      },
      'anny.execute_booking': async (args, actor, context) => {
        const parsed = interval.parse(args);
        await assertAvailable(parsed, actor);
        const booking = await client(actor, executionBinding(actor, context, 'anny.execute_booking', parsed)).createBooking({ ...parsed, customerId: customerForActor(actor) });
        return { bookingId: booking.bookingId };
      },
      'anny.propose_cancellation': async (args, actor) => {
        const { bookingId } = z.strictObject({ bookingId: annyId }).parse(args);
        const booking = await ownedBooking(bookingId, actor);
        cancellable(booking);
        const roomNames = await names(actor);
        return { draft: { executionTool: 'anny.execute_cancellation', arguments: { bookingId, resourceId: booking.resourceId, startDate: booking.startDate, endDate: booking.endDate }, resourceName: roomNames.get(booking.resourceId) ?? 'Raum' } };
      },
      'anny.execute_cancellation': async (args, actor, context) => {
        const parsed = cancellation.parse(args);
        const booking = await ownedBooking(parsed.bookingId, actor);
        if (booking.resourceId !== parsed.resourceId || Date.parse(booking.startDate) !== Date.parse(parsed.startDate) || Date.parse(booking.endDate) !== Date.parse(parsed.endDate)) throw new Error('Booking changed; prepare a new cancellation.');
        // A previous confirmed cancellation needs no second vendor mutation.
        if (['canceled', 'cancelled'].includes(booking.status ?? '')) return { bookingId: parsed.bookingId, status: 'cancelled' };
        cancellable(booking);
        await client(actor, executionBinding(actor, context, 'anny.execute_cancellation', parsed)).cancelBooking(parsed.bookingId);
        const updated = await ownedBooking(parsed.bookingId, actor);
        if (!['canceled', 'cancelled'].includes(updated.status ?? '')) throw new Error('Cancellation outcome is not established; reconcile before retrying.');
        return { bookingId: parsed.bookingId, status: 'cancelled' };
      }
    }
  });
}
