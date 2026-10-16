import { randomUUID, type KeyObject } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { z } from 'zod';
import { PluginRegistry, RequestError } from './registry.js';
import { MockIdentityProvider, personas, type Persona } from './identity.js';

export { PluginRegistry, compatibleUpdate, RequestError } from './registry.js';
export { assertMockMode, MockIdentityProvider } from './identity.js';
const ANNY = 'de.hsh.hasi.anny';
const time = z.iso.datetime({ offset: true });
const roomRequest = z.strictObject({ resourceId: z.uuid(), serviceId: z.uuid(), startDate: time, endDate: time }).refine(value => Date.parse(value.endDate) > Date.parse(value.startDate) && Date.parse(value.endDate) - Date.parse(value.startDate) <= 86400000, 'Invalid interval');
const draftSchema = z.strictObject({ executionTool: z.string(), arguments: z.record(z.string(), z.unknown()), resourceName: z.string().max(200) });
interface Proposal { id: string; subject: string; pluginId: string; pluginVersion: string; executionTool: string; args: Record<string, unknown>; resourceName: string; startDate: string; endDate: string; expiresAt: string; status: 'pending' | 'executing' | 'confirmed' | 'failed' | 'outcome_unknown'; result?: Record<string, unknown> }
const publicUser = (user: Persona) => ({ id: user.id, displayName: user.displayName, role: user.role });
const publicProposal = (proposal: Proposal) => ({ id: proposal.id, resourceName: proposal.resourceName, startDate: proposal.startDate, endDate: proposal.endDate, expiresAt: proposal.expiresAt, status: proposal.status, arguments: proposal.args });

export interface ApiOptions { mode: 'development' | 'test'; registry: PluginRegistry; origin?: string }

export async function createApi(options: ApiOptions) {
  const app = Fastify({ logger: false, bodyLimit: 65536 });
  const identity = new MockIdentityProvider(options.mode);
  const proposals = new Map<string, Proposal>();
  const origin = options.origin ?? 'http://127.0.0.1:3000';
  await app.register(cookie);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('cache-control', 'private, no-store');
    const host = request.headers.host?.split(':')[0];
    if (host !== '127.0.0.1' && host !== 'localhost') throw new RequestError(403, 'Unzulässiger Host.');
    if (!['GET', 'HEAD'].includes(request.method) && request.headers.origin !== origin) throw new RequestError(403, 'Ungültiger Anfrageursprung.');
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RequestError) return reply.code(error.status).send({ error: error.message });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'Bitte prüfe die eingegebenen Daten.' });
    return reply.code(502).send({ error: 'Die Anfrage konnte nicht abgeschlossen werden.' });
  });
  const requireUser = (token: string | undefined) => { const user = identity.resolve(token); if (!user) throw new RequestError(401, 'Bitte wähle zuerst ein Testkonto.'); return user; };
  const requireAdmin = (token: string | undefined) => { const user = requireUser(token); if (user.role !== 'admin') throw new RequestError(403, 'Diese Funktion ist der Administration vorbehalten.'); return user; };
  const makeProposal = async (user: Persona, pluginId: string, name: string, args: Record<string, unknown>) => {
    const output = await options.registry.invoke(pluginId, name, args, user.actor);
    const draft = draftSchema.parse(output.draft);
    const execution = options.registry.list().find(plugin => plugin.id === pluginId)?.tools.find(tool => tool.name === draft.executionTool && tool.effect === 'execute');
    if (!execution?.requiredPermissions.every(permission => user.actor.permissions.includes(permission))) throw new RequestError(403, 'Der Vorschlag ist nicht freigegeben.');
    const proposal: Proposal = { id: randomUUID(), subject: user.actor.subject, pluginId, pluginVersion: options.registry.version(pluginId), executionTool: draft.executionTool, args: draft.arguments, resourceName: draft.resourceName, startDate: typeof draft.arguments.startDate === 'string' ? draft.arguments.startDate : '', endDate: typeof draft.arguments.endDate === 'string' ? draft.arguments.endDate : '', expiresAt: new Date(Date.now() + 300000).toISOString(), status: 'pending' };
    proposals.set(proposal.id, proposal);
    return { proposal: publicProposal(proposal) };
  };
  app.get('/api/session', request => ({ mode: 'mock', user: identity.resolve(request.cookies['hasi-session']) ? publicUser(requireUser(request.cookies['hasi-session'])) : null }));
  app.get('/api/dev/personas', () => ({ personas: personas.map(publicUser) }));
  app.post('/api/dev/login', (request, reply) => {
    const body = z.strictObject({ personaId: z.string() }).parse(request.body);
    identity.logout(request.cookies['hasi-session']);
    const session = identity.login(body.personaId);
    reply.setCookie('hasi-session', session.token, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 3600 });
    return { user: publicUser(session.user), mode: 'mock' };
  });
  app.post('/api/logout', (request, reply) => { identity.logout(request.cookies['hasi-session']); reply.clearCookie('hasi-session', { path: '/' }); return { ok: true }; });
  app.get('/api/plugins', request => { requireUser(request.cookies['hasi-session']); return { plugins: options.registry.list() }; });
  app.get('/api/tools', request => { const user = requireUser(request.cookies['hasi-session']); return { tools: options.registry.modelTools(user.actor) }; });
  app.get('/api/admin/plugins', request => { requireAdmin(request.cookies['hasi-session']); return { plugins: options.registry.list() }; });
  app.post('/api/admin/plugins/:id/enabled', request => { requireAdmin(request.cookies['hasi-session']); const { id } = z.object({ id: z.string() }).parse(request.params); const { enabled } = z.strictObject({ enabled: z.boolean() }).parse(request.body); options.registry.setEnabled(id, enabled); return { ok: true }; });
  app.post('/api/admin/plugins/:id/check-update', async request => { requireAdmin(request.cookies['hasi-session']); const { id } = z.object({ id: z.string() }).parse(request.params); return options.registry.checkUpdate(id); });
  app.post('/api/admin/plugins/:id/activate-update', request => { requireAdmin(request.cookies['hasi-session']); const { id } = z.object({ id: z.string() }).parse(request.params); options.registry.activateUpdate(id); return { ok: true }; });
  app.get('/api/resources', request => { const user = requireUser(request.cookies['hasi-session']); return options.registry.invoke(ANNY, 'anny.search_resources', {}, user.actor); });
  app.get('/api/bookings', request => { const user = requireUser(request.cookies['hasi-session']); return options.registry.invoke(ANNY, 'anny.list_my_bookings', {}, user.actor); });
  app.post('/api/availability', request => {
    const user = requireUser(request.cookies['hasi-session']);
    const args = z.strictObject({ resourceId: z.uuid(), serviceId: z.uuid(), startDate: time, durationMinutes: z.number().int().min(15).max(1440) }).parse(request.body);
    if (!user.actor.resourceIds.includes(args.resourceId)) throw new RequestError(403, 'Dieser Raum ist für das Testkonto nicht freigegeben.');
    return options.registry.invoke(ANNY, 'anny.get_availability', args, user.actor);
  });
  app.post('/api/proposals', request => {
    const user = requireUser(request.cookies['hasi-session']);
    const args = roomRequest.parse(request.body);
    if (!user.actor.resourceIds.includes(args.resourceId)) throw new RequestError(403, 'Dieser Raum ist für das Testkonto nicht freigegeben.');
    return makeProposal(user, ANNY, 'anny.propose_booking', args);
  });
  app.post('/api/tools/call', request => {
    const user = requireUser(request.cookies['hasi-session']);
    const body = z.strictObject({ pluginId: z.string(), name: z.string(), arguments: z.record(z.string(), z.unknown()) }).parse(request.body);
    const tool = options.registry.list().find(plugin => plugin.id === body.pluginId)?.tools.find(candidate => candidate.name === body.name);
    if (tool?.effect === 'prepare') return makeProposal(user, body.pluginId, body.name, body.arguments);
    return options.registry.invoke(body.pluginId, body.name, body.arguments, user.actor);
  });
  app.post('/api/proposals/:id/confirm', async request => {
    const user = requireUser(request.cookies['hasi-session']);
    z.strictObject({}).parse(request.body);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const proposal = proposals.get(id);
    if (proposal?.subject !== user.actor.subject) throw new RequestError(404, 'Vorschlag nicht gefunden.');
    if (proposal.status === 'confirmed' || proposal.status === 'outcome_unknown') return { ...(proposal.result ?? {}), proposal: publicProposal(proposal) };
    if (proposal.status !== 'pending') throw new RequestError(409, 'Dieser Vorschlag wird bereits bearbeitet.');
    if (Date.parse(proposal.expiresAt) <= Date.now() || proposal.pluginVersion !== options.registry.version(proposal.pluginId)) throw new RequestError(409, 'Der Vorschlag ist abgelaufen oder das Plugin wurde aktualisiert. Bitte neu prüfen.');
    proposal.status = 'executing';
    try {
      proposal.result = await options.registry.invoke(proposal.pluginId, proposal.executionTool, proposal.args, user.actor, true);
      proposal.status = 'confirmed';
    } catch (error) {
      // The external system may have committed before a transport failure.
      proposal.status = error instanceof RequestError && error.status < 500 ? 'failed' : 'outcome_unknown';
    }
    return { ...(proposal.result ?? {}), proposal: publicProposal(proposal) };
  });
  return app;
}

export function createRegistry(privateKey: KeyObject): PluginRegistry { return new PluginRegistry(privateKey); }
