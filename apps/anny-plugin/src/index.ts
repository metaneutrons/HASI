import type { KeyObject } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createPluginServer, type ActorContext } from '@hasi/plugin-sdk';
import { AnnyClient } from '@hasi/anny-client';
import { annyManifest } from './manifest.js';

export { annyManifest, demoPresentation } from './manifest.js';
export interface Presentation { capacity: number; location: string; features: string[]; serviceId: string }
export interface AnnyPluginOptions { client: AnnyClient; publicKey: KeyObject; serviceToken: string; presentation: Record<string, Presentation>; version?: string }
const interval = z.strictObject({ resourceId: z.uuid(), serviceId: z.uuid(), startDate: z.iso.datetime({ offset: true }), endDate: z.iso.datetime({ offset: true }) });

export function createAnnyPlugin(options: AnnyPluginOptions): FastifyInstance {
  const manifest = { ...annyManifest, version: options.version ?? annyManifest.version };
  const authorized = (resourceId: string, serviceId: string, actor: ActorContext) => {
    const metadata = options.presentation[resourceId];
    if (!actor.resourceIds.includes(resourceId) || metadata?.serviceId !== serviceId) throw new Error('Resource/service access denied.');
    return metadata;
  };
  const names = async () => new Map((await options.client.listResources()).map(resource => [resource.id, resource.attributes?.name ?? 'Raum']));
  const assertAvailable = async (args: z.infer<typeof interval>, actor: ActorContext) => {
    authorized(args.resourceId, args.serviceId, actor);
    const minutes = (Date.parse(args.endDate) - Date.parse(args.startDate)) / 60000;
    if (!Number.isInteger(minutes) || minutes < 15 || minutes > 1440 || Date.parse(args.startDate) <= Date.now()) throw new Error('Invalid booking interval.');
    const result = await options.client.getAvailability({ resourceId: args.resourceId, serviceId: args.serviceId, startDate: args.startDate, duration: minutes });
    if (!result.data.some(entry => entry.available === true && Date.parse(entry.start_date ?? '') === Date.parse(args.startDate) && Date.parse(entry.end_date ?? '') === Date.parse(args.endDate))) throw new Error('Requested interval is unavailable.');
  };
  return createPluginServer({
    manifest, publicKey: options.publicKey, serviceToken: options.serviceToken,
    handlers: {
      'anny.search_resources': async (_args, actor) => ({ resources: (await options.client.listResources()).flatMap(resource => {
        const profile = options.presentation[resource.id];
        if (!actor.resourceIds.includes(resource.id) || !profile || resource.attributes?.bookings_enabled === false) return [];
        return [{ id: resource.id, name: resource.attributes?.name ?? 'Raum', description: resource.attributes?.plain_description ?? '', ...profile }];
      }) }),
      'anny.get_availability': async (args, actor) => {
        const parsed = z.strictObject({ resourceId: z.uuid(), serviceId: z.uuid(), startDate: z.iso.datetime({ offset: true }), durationMinutes: z.number().int().min(15).max(1440) }).parse(args);
        authorized(parsed.resourceId, parsed.serviceId, actor);
        const result = await options.client.getAvailability({ resourceId: parsed.resourceId, serviceId: parsed.serviceId, startDate: parsed.startDate, duration: parsed.durationMinutes });
        return { intervals: result.data.flatMap(entry => entry.start_date && entry.end_date && typeof entry.available === 'boolean' ? [{ startDate: entry.start_date, endDate: entry.end_date, available: entry.available }] : []) };
      },
      'anny.list_my_bookings': async (_args, actor) => {
        const roomNames = await names();
        const bookings = await options.client.listBookings(actor.customerId);
        return { bookings: bookings.flatMap(booking => booking.resourceId && actor.resourceIds.includes(booking.resourceId) && booking.startDate && booking.endDate ? [{ id: booking.bookingId, resourceName: roomNames.get(booking.resourceId) ?? 'Raum', startDate: booking.startDate, endDate: booking.endDate, status: booking.status ?? 'confirmed' }] : []) };
      },
      'anny.propose_booking': async (args, actor) => {
        const parsed = interval.parse(args);
        await assertAvailable(parsed, actor);
        const roomNames = await names();
        return { draft: { executionTool: 'anny.execute_booking', arguments: parsed, resourceName: roomNames.get(parsed.resourceId) ?? 'Raum' } };
      },
      'anny.execute_booking': async (args, actor) => {
        const parsed = interval.parse(args);
        await assertAvailable(parsed, actor);
        const booking = await options.client.createBooking({ ...parsed, customerId: actor.customerId });
        return { bookingId: booking.bookingId };
      }
    }
  });
}
