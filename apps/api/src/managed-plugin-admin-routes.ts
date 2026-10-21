import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  managedPluginCatalogSchema,
  managedPluginCommandResultSchema,
  managedPluginCommandSchema,
  managedPluginReviewSchema,
} from '@hasi/plugin-sdk/deployment-admin';
import { z } from 'zod';
import type { ManagedPluginAdmin } from './managed-plugin-admin.js';

interface AdminIdentity { actor: { subject: string } }
type RequireAdmin = (token: string | undefined) => Promise<AdminIdentity>;

const installationIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const paramsSchema = z.strictObject({ id: installationIdSchema });
const commandParamsSchema = z.strictObject({ id: installationIdSchema, commandId: z.uuid() });

const unavailable = (reply: FastifyReply) =>
  reply.code(503).send({ error: 'Die verwaltete Plug-in-Verwaltung ist derzeit nicht verfügbar.' });

/** Register the browser-safe operator bridge. Every service call receives only the
 * subject established by the existing session and admin policy callback.
 */
export function registerManagedPluginAdminRoutes(
  app: FastifyInstance,
  input: {
    cookieName: string;
    requireAdmin: RequireAdmin;
    service?: ManagedPluginAdmin;
  },
): void {
  app.get('/api/admin/managed-plugins', async (request, reply) => {
    const admin = await input.requireAdmin(request.cookies[input.cookieName]);
    if (!input.service) return { installations: [] };
    try {
      return managedPluginCatalogSchema.parse(await input.service.list(admin.actor.subject));
    } catch {
      return reply.code(502).send({ error: 'Die verwalteten Plug-in-Installationen konnten nicht geladen werden.' });
    }
  });

  app.get('/api/admin/managed-plugins/:id/review', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const admin = await input.requireAdmin(request.cookies[input.cookieName]);
    const { id } = paramsSchema.parse(request.params);
    if (!input.service?.describeReview) return unavailable(reply);
    try {
      const review = managedPluginReviewSchema.parse(await input.service.describeReview(id, admin.actor.subject));
      if (review.installationId !== id) throw new Error('Review installation binding invalid.');
      return await reply.header('cache-control', 'no-store').send(review);
    } catch {
      return reply.code(409).header('cache-control', 'no-store').send({ error: 'Die geprüfte Plug-in-Änderung ist nicht mehr aktuell. Bitte neu laden.' });
    }
  });

  app.post('/api/admin/managed-plugins/:id/commands', async (request, reply) => {
    const admin = await input.requireAdmin(request.cookies[input.cookieName]);
    const { id } = paramsSchema.parse(request.params);
    const command = managedPluginCommandSchema.parse(request.body);
    if (!input.service) return unavailable(reply);
    try {
      const result = managedPluginCommandResultSchema.parse(
        await input.service.command(id, command, admin.actor.subject),
      );
      if (result.commandId !== command.commandId || result.view.id !== id) throw new Error('Command identifier mismatch.');
      return result;
    } catch {
      return reply.code(502).send({ error: 'Der Verwaltungsbefehl konnte nicht bestätigt werden.' });
    }
  });

  app.get('/api/admin/managed-plugins/:id/commands/:commandId', async (request, reply) => {
    const admin = await input.requireAdmin(request.cookies[input.cookieName]);
    const { id, commandId } = commandParamsSchema.parse(request.params);
    if (!input.service) return unavailable(reply);
    try {
      const result = managedPluginCommandResultSchema.parse(
        await input.service.commandStatus(id, commandId, admin.actor.subject),
      );
      if (result.commandId !== commandId || result.view.id !== id) throw new Error('Command identifier mismatch.');
      return result;
    } catch {
      return reply.code(502).send({ error: 'Der Befehlsstatus konnte nicht geprüft werden.' });
    }
  });
  app.get('/api/admin/managed-plugins/:id/configuration', async (request, reply) => {
    const admin = await input.requireAdmin(request.cookies[input.cookieName]);
    const { id } = paramsSchema.parse(request.params);
    if (!input.service?.describeConfiguration) return unavailable(reply);
    try { return await input.service.describeConfiguration(id, admin.actor.subject); }
    catch { return reply.code(502).send({ error: 'Die Plugin-Konfiguration konnte nicht geladen werden.' }); }
  });
  app.post('/api/admin/managed-plugins/:id/configuration/draft', async (request, reply) => {
    const admin = await input.requireAdmin(request.cookies[input.cookieName]);
    const { id } = paramsSchema.parse(request.params);
    const draft = z.strictObject({ revision: z.number().int().nonnegative(), values: z.record(z.string(), z.unknown()), disabledTools: z.array(z.string().min(1).max(256)).max(64) }).parse(request.body);
    if (!input.service?.saveConfigurationDraft) return unavailable(reply);
    try { return await input.service.saveConfigurationDraft(id, draft, admin.actor.subject); }
    catch { return reply.code(409).send({ error: 'Die Konfiguration konnte nicht gespeichert werden. Bitte neu laden.' }); }
  });
  app.post('/api/admin/managed-plugins/:id/configuration/activate', async (request, reply) => {
    const admin = await input.requireAdmin(request.cookies[input.cookieName]);
    const { id } = paramsSchema.parse(request.params);
    const { revision } = z.strictObject({ revision: z.number().int().nonnegative() }).parse(request.body);
    if (!input.service?.activateConfiguration) return unavailable(reply);
    try { return await input.service.activateConfiguration(id, revision, admin.actor.subject); }
    catch { return reply.code(409).send({ error: 'Die Konfiguration konnte nicht aktiviert werden. Bitte den aktuellen Stand prüfen.' }); }
  });
}
