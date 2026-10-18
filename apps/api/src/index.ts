import { randomUUID, type KeyObject } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { z } from 'zod';
import { MemoryJsonStore, type JsonStore } from '@hasi/state';
import { PluginRegistry, RequestError, type ApprovedPluginSource } from './registry.js';
import { MockIdentityProvider, personas, type Persona, type IdentityProvider } from './identity.js';
import { isAllowedOidcReturnTo, OidcIdentityProvider } from './oidc.js';
import { PluginSettingsError } from './plugin-settings.js';

export { PluginRegistry, compatibleUpdate, RequestError } from './registry.js';
export { OidcIdentityProvider, OidcAuthenticationError } from './oidc.js';
export { startTestIdp } from './test-idp.js';
export { assertMockMode, MockIdentityProvider, withDemoPluginClaims } from './identity.js';
const ANNY = 'de.hsh.hasi.anny';
const annyId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const time = z.iso.datetime({ offset: true });
const roomRequest = z.strictObject({ resourceId: annyId, serviceId: annyId, startDate: time, endDate: time }).refine(value => Date.parse(value.endDate) > Date.parse(value.startDate) && Date.parse(value.endDate) - Date.parse(value.startDate) <= 86400000, 'Invalid interval');
const draftSchema = z.strictObject({ executionTool: z.string(), arguments: z.record(z.string(), z.unknown()), resourceName: z.string().max(200) });
interface Proposal { executionTitle?: string; executionDescription?: string; authorityDigest?: string; bindingDigest?: string; id: string; subject: string; pluginId: string; pluginVersion: string; executionTool: string; args: Record<string, unknown>; resourceName: string; startDate: string; endDate: string; expiresAt: string; status: 'pending' | 'executing' | 'confirmed' | 'failed' | 'outcome_unknown'; result?: Record<string, unknown>; executionId?: string; executionStartedAt?: number }
const publicUser = (user: Persona) => ({ id: user.id, displayName: user.displayName, role: user.role });
const publicProposal = (proposal: Proposal) => ({ id: proposal.id, resourceName: proposal.resourceName, startDate: proposal.startDate, endDate: proposal.endDate, expiresAt: proposal.expiresAt, status: proposal.status, arguments: proposal.args, pluginId: proposal.pluginId, executionTool: proposal.executionTool, ...(proposal.pluginId !== ANNY ? { executionTitle: proposal.executionTitle ?? proposal.executionTool, executionDescription: proposal.executionDescription ?? '' } : {}), action: proposal.pluginId === ANNY ? proposal.executionTool === 'anny.execute_cancellation' ? 'cancel_booking' : 'book' : 'execute_tool' });

export interface ApiOptions {
  mode: 'development' | 'test' | 'public-demo' | 'production'; registry: PluginRegistry; origin?: string;
  identity?: IdentityProvider; store?: JsonStore; pluginCatalog?: readonly ApprovedPluginSource[]; allowedHosts?: readonly string[];
  secureCookies?: boolean; sessionCookieName?: string;
}

export async function createApi(options: ApiOptions) {
  const app = Fastify({ logger: false, bodyLimit: 65536 });
  options.registry.configureCatalog(options.pluginCatalog ?? []);
  await options.registry.restoreConnections();
  app.addHook('onClose', async () => { await options.registry.close(); });
  if (options.mode === 'public-demo' && (!options.identity || !options.store || !options.secureCookies || !options.allowedHosts?.length)) throw new Error('Public demo requires explicit durable identity, state and HTTPS configuration.');
  if (options.mode === 'production' && (!(options.identity instanceof OidcIdentityProvider) || !options.store || !options.secureCookies || !options.allowedHosts?.length || !options.origin?.startsWith('https://'))) throw new Error('Production requires explicit OIDC identity, durable state and HTTPS configuration.');
  const identity = options.identity ?? new MockIdentityProvider(options.mode);
  const oidc = identity instanceof OidcIdentityProvider ? identity : undefined;
  const store = options.store ?? new MemoryJsonStore('api-local');
  const cookieName = options.sessionCookieName ?? 'hasi-session';
  const sessionMode = oidc ? 'oidc' : options.mode === 'public-demo' ? 'public-demo' : 'mock';
  const allowedHosts = options.allowedHosts ?? ['127.0.0.1', 'localhost'];
  const proposalKey = (id: string) => `proposal:${id}`;
  const proposalLifetime = () => Date.now() + 86400000;
  const origin = options.origin ?? 'http://127.0.0.1:3000';
  await app.register(cookie);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('cache-control', 'private, no-store');
    const host = request.hostname;
    if (!allowedHosts.includes(host)) throw new RequestError(403, 'Unzulässiger Host.');
    if (!['GET', 'HEAD'].includes(request.method) && request.headers.origin !== origin) throw new RequestError(403, 'Ungültiger Anfrageursprung.');
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RequestError || error instanceof PluginSettingsError) return reply.code(error.status).send({ error: error.message });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'Bitte prüfe die eingegebenen Daten.' });
    return reply.code(502).send({ error: 'Die Anfrage konnte nicht abgeschlossen werden.' });
  });
  const requireUser = async (token: string | undefined) => { const user = await identity.resolve(token); if (!user) throw new RequestError(401, oidc ? 'Bitte melde dich an.' : 'Bitte wähle zuerst ein Testkonto.'); return user; };
  const requireAdmin = async (token: string | undefined) => { const user = await requireUser(token); if (user.role !== 'admin' || !user.actor.permissions.includes('plugins:manage')) throw new RequestError(403, 'Diese Funktion ist der Administration vorbehalten.'); return user; };
  const makeProposal = async (user: Persona, pluginId: string, name: string, args: Record<string, unknown>) => {
    const bindingDigest = await options.registry.binding(pluginId);
    const output = await options.registry.invoke(pluginId, name, args, user.actor);
    if (bindingDigest !== await options.registry.binding(pluginId)) throw new RequestError(409, 'Das Plugin wurde verändert. Bitte den Vorschlag neu vorbereiten.');
    const draft = draftSchema.parse(output.draft);
    const execution = options.registry.list().find(plugin => plugin.id === pluginId)?.tools.find(tool => tool.name === draft.executionTool && tool.effect === 'execute');
    if (!execution?.requiredPermissions.every(permission => user.actor.permissions.includes(permission))) throw new RequestError(403, 'Der Vorschlag ist nicht freigegeben.');
    const proposal: Proposal = { executionTitle: execution.title, executionDescription: execution.description, authorityDigest: options.registry.authorityBinding(pluginId, user.actor), bindingDigest, id: randomUUID(), subject: user.actor.subject, pluginId, pluginVersion: options.registry.version(pluginId), executionTool: draft.executionTool, args: draft.arguments, resourceName: draft.resourceName, startDate: typeof draft.arguments.startDate === 'string' ? draft.arguments.startDate : '', endDate: typeof draft.arguments.endDate === 'string' ? draft.arguments.endDate : '', expiresAt: new Date(Date.now() + 300000).toISOString(), status: 'pending' };
    if (!await store.compareAndSet(proposalKey(proposal.id), null, proposal, proposalLifetime())) throw new RequestError(503, 'Der Vorschlag konnte nicht gespeichert werden.');
    return { proposal: publicProposal(proposal) };
  };
  app.get('/api/session', async request => { const user = await identity.resolve(request.cookies[cookieName]); return { mode: sessionMode, user: user ? publicUser(user) : null }; });
  if (oidc) {
    app.get('/api/auth/login', async (request, reply) => {
      const { returnTo } = z.strictObject({ returnTo: z.string().max(128).optional() }).parse(request.query);
      const approvedReturnTo = returnTo ?? '/';
      if (!isAllowedOidcReturnTo(approvedReturnTo)) throw new RequestError(400, 'Die angeforderte Rücksprungseite ist nicht zulässig.');
      const started = await oidc.beginAuthorization(approvedReturnTo);
      reply.setCookie('hasi-oidc-transaction', started.transactionId, { httpOnly: true, secure: options.secureCookies ?? false, sameSite: 'lax', path: '/api/auth/callback', maxAge: 600 });
      return reply.redirect(started.url);
    });
    app.get('/api/auth/callback', async (request, reply) => {
      const args = z.object({ code: z.string().min(1).max(4096), state: z.string().min(1).max(256) }).parse(request.query);
      const transactionId = request.cookies['hasi-oidc-transaction'];
      reply.clearCookie('hasi-oidc-transaction', { path: '/api/auth/callback', secure: options.secureCookies ?? false, sameSite: 'lax' });
      if (!transactionId) throw new RequestError(401, 'Die Anmeldung ist abgelaufen. Bitte erneut anmelden.');
      const session = await oidc.completeAuthorization({ ...args, transactionId });
      await identity.logout(request.cookies[cookieName]);
      reply.setCookie(cookieName, session.token, { httpOnly: true, secure: options.secureCookies ?? false, sameSite: 'lax', path: '/', maxAge: 3600 });
      const applicationOrigin = new URL(origin);
      const destination = new URL(session.returnTo, applicationOrigin);
      if (destination.origin !== applicationOrigin.origin) throw new RequestError(500, 'Das Rücksprungziel konnte nicht geprüft werden.');
      return reply.redirect(destination.href);
    });
  }
  app.get('/api/dev/personas', () => { if (oidc) throw new RequestError(404, 'Nicht verfügbar.'); return { personas: personas.map(publicUser) }; });
  app.post('/api/dev/login', async (request, reply) => {
    if (oidc) throw new RequestError(404, 'Nicht verfügbar.');
    const body = z.strictObject({ personaId: z.string() }).parse(request.body);
    await identity.logout(request.cookies[cookieName]);
    const session = await identity.login(body.personaId);
    reply.setCookie(cookieName, session.token, { httpOnly: true, secure: options.secureCookies ?? false, sameSite: 'strict', path: '/', maxAge: 3600 });
    return { user: publicUser(session.user), mode: sessionMode };
  });
  app.post('/api/logout', async (request, reply) => { await identity.logout(request.cookies[cookieName]); reply.clearCookie(cookieName, { path: '/', secure: options.secureCookies ?? false }); return { ok: true }; });
  app.get('/api/plugins', async request => { await requireUser(request.cookies[cookieName]); await options.registry.refreshAll(); return { plugins: options.registry.list() }; });
  app.get('/api/tools', async request => { const user = await requireUser(request.cookies[cookieName]); await options.registry.refreshAll(); return { tools: options.registry.modelTools(user.actor) }; });
  app.get('/api/admin/plugins', async request => { await requireAdmin(request.cookies[cookieName]); await options.registry.refreshAll(); return { plugins: options.registry.list() }; });
  app.get('/api/admin/plugin-catalog', async request => { await requireAdmin(request.cookies[cookieName]); return { sources: options.registry.catalog() }; });
  app.post('/api/admin/plugin-catalog/connect', async request => { await requireAdmin(request.cookies[cookieName]); const { sourceId } = z.strictObject({ sourceId: z.string().min(1).max(128) }).parse(request.body); await options.registry.connectSource(sourceId); return { ok: true }; });
  app.post('/api/admin/plugins/:id/remove', async request => { await requireAdmin(request.cookies[cookieName]); const { id } = z.object({ id: z.string() }).parse(request.params); z.strictObject({ confirm: z.literal(true) }).parse(request.body); await options.registry.removeSource(id); return { ok: true }; });
  app.get('/api/admin/plugins/:id/configuration', async request => { await requireAdmin(request.cookies[cookieName]); const { id } = z.object({ id: z.string() }).parse(request.params); return options.registry.configuration(id); });
  app.post('/api/admin/plugins/:id/test-connection', async request => {
    await requireAdmin(request.cookies[cookieName]);
    const { id } = z.strictObject({ id: z.string().min(1).max(128) }).parse(request.params);
    z.strictObject({}).parse(request.body);
    return options.registry.testConnection(id);
  });
  app.post('/api/admin/plugins/:id/configuration/draft', async request => {
    const user = await requireAdmin(request.cookies[cookieName]); const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = z.strictObject({ revision: z.number().int().nonnegative(), values: z.record(z.string(), z.unknown()), disabledTools: z.array(z.string().min(1).max(256)).max(64) }).parse(request.body);
    await options.registry.refreshAll();
    return options.registry.settings.saveDraft(id, options.registry.manifest(id), input, user.actor.subject);
  });
  app.post('/api/admin/plugins/:id/configuration/activate', async request => {
    const user = await requireAdmin(request.cookies[cookieName]); const { id } = z.object({ id: z.string() }).parse(request.params);
    const { revision } = z.strictObject({ revision: z.number().int().nonnegative() }).parse(request.body);
    await options.registry.refreshAll();
    return options.registry.settings.activate(id, options.registry.manifest(id), revision, user.actor.subject, options.registry.registration(id).secretReady);
  });
  app.get('/api/plugin-apps/:id/:presentationId', async request => {
    const user = await requireUser(request.cookies[cookieName]); const { id, presentationId } = z.object({ id: z.string(), presentationId: z.string() }).parse(request.params);
    return options.registry.readPresentation(id, presentationId, user.actor);
  });
  app.post('/api/admin/plugins/:id/enabled', async request => { await requireAdmin(request.cookies[cookieName]); const { id } = z.object({ id: z.string() }).parse(request.params); const { enabled } = z.strictObject({ enabled: z.boolean() }).parse(request.body); await options.registry.setEnabled(id, enabled); return { ok: true }; });
  app.post('/api/admin/plugins/:id/check-update', async request => { await requireAdmin(request.cookies[cookieName]); const { id } = z.object({ id: z.string() }).parse(request.params); return options.registry.checkUpdate(id); });
  app.post('/api/admin/plugins/:id/activate-update', async request => { await requireAdmin(request.cookies[cookieName]); const { id } = z.object({ id: z.string() }).parse(request.params); await options.registry.activateUpdate(id); return { ok: true }; });
  app.get('/api/resources', async request => { const user = await requireUser(request.cookies[cookieName]); return options.registry.invoke(ANNY, 'anny.search_resources', {}, user.actor); });
  app.get('/api/knowledge/documents/:id', async request => {
    const user = await requireUser(request.cookies[cookieName]);
    const { id } = z.strictObject({ id: z.string().regex(/^(svc|int)-[0-9]{3}$/) }).parse(request.params);
    try { return await options.registry.invoke('de.hsh.hasi.knowledge', 'knowledge.get_document', { documentId: id }, user.actor); }
    catch (error) {
      if (error instanceof RequestError && error.status === 409) throw error;
      throw new RequestError(404, 'Dokument nicht verfügbar oder nicht freigegeben.');
    }
  });
  app.get('/api/bookings', async request => { const user = await requireUser(request.cookies[cookieName]); return options.registry.invoke(ANNY, 'anny.list_my_bookings', {}, user.actor); });
  app.post('/api/availability', async request => {
    const user = await requireUser(request.cookies[cookieName]);
    const args = z.strictObject({ resourceId: annyId, serviceId: annyId, startDate: time, durationMinutes: z.number().int().min(15).max(1440) }).parse(request.body);
    if (!(user.actor.resourceIds ?? []).includes(args.resourceId)) throw new RequestError(403, 'Dieser Raum ist für das Testkonto nicht freigegeben.');
    return options.registry.invoke(ANNY, 'anny.get_availability', args, user.actor);
  });
  app.post('/api/proposals', async request => {
    const user = await requireUser(request.cookies[cookieName]);
    const args = roomRequest.parse(request.body);
    if (!(user.actor.resourceIds ?? []).includes(args.resourceId)) throw new RequestError(403, 'Dieser Raum ist für das Testkonto nicht freigegeben.');
    return makeProposal(user, ANNY, 'anny.propose_booking', args);
  });
  app.post('/api/cancellations', async request => {
    const user = await requireUser(request.cookies[cookieName]);
    const args = z.strictObject({ bookingId: annyId }).parse(request.body);
    return makeProposal(user, ANNY, 'anny.propose_cancellation', args);
  });
  app.post('/api/tools/call', async request => {
    const user = await requireUser(request.cookies[cookieName]);
    const body = z.strictObject({ pluginId: z.string(), name: z.string(), arguments: z.record(z.string(), z.unknown()), source: z.enum(['model', 'app']).optional() }).parse(request.body);
    await options.registry.refreshAll();
    const tool = options.registry.list().find(plugin => plugin.id === body.pluginId)?.tools.find(candidate => candidate.name === body.name);
    if (body.source === 'app' && tool?.effect !== 'read') throw new RequestError(403, 'Die Ansicht darf nur freigegebene Leseaktionen ausführen.');
    if (tool?.effect === 'prepare') return makeProposal(user, body.pluginId, body.name, body.arguments);
    return options.registry.invoke(body.pluginId, body.name, body.arguments, user.actor, false, body.source ?? 'model');
  });
  app.get('/api/proposals/:id', async request => {
    const user = await requireUser(request.cookies[cookieName]);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const record = await store.read(proposalKey(id));
    const proposal = record?.value as Proposal | undefined;
    if (proposal?.subject !== user.actor.subject) throw new RequestError(404, 'Vorschlag nicht gefunden.');
    return { proposal: publicProposal(proposal) };
  });
  app.post('/api/proposals/:id/confirm', async request => {
    const user = await requireUser(request.cookies[cookieName]);
    z.strictObject({}).parse(request.body);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const key = proposalKey(id);
    let claimed: Proposal | undefined;
    for (let attempt = 0; attempt < 12; attempt++) {
      const record = await store.read(key);
      const proposal = record?.value as Proposal | undefined;
      if (!record || proposal?.subject !== user.actor.subject) throw new RequestError(404, 'Vorschlag nicht gefunden.');
      if (proposal.status === 'confirmed' || proposal.status === 'outcome_unknown') return { ...(proposal.result ?? {}), proposal: publicProposal(proposal) };
      if (proposal.status === 'executing' && proposal.executionStartedAt && Date.now() - proposal.executionStartedAt > 60000) {
        const unknown = { ...proposal, status: 'outcome_unknown' as const };
        if (await store.compareAndSet(key, record.revision, unknown, proposalLifetime())) return { proposal: publicProposal(unknown) };
        continue;
      }
      if (proposal.status !== 'pending') throw new RequestError(409, 'Dieser Vorschlag wird bereits bearbeitet.');
      if (Date.parse(proposal.expiresAt) <= Date.now() || proposal.pluginVersion !== options.registry.version(proposal.pluginId) || (proposal.bindingDigest === undefined || proposal.bindingDigest !== await options.registry.binding(proposal.pluginId))) throw new RequestError(409, 'Der Vorschlag ist abgelaufen oder das Plugin wurde aktualisiert. Bitte neu prüfen.');
      if (proposal.authorityDigest !== options.registry.authorityBinding(proposal.pluginId, user.actor)) throw new RequestError(409, 'Die Kontoverknüpfung oder Berechtigung wurde geändert. Bitte neu vorbereiten.');
      const next = { ...proposal, status: 'executing' as const, executionId: randomUUID(), executionStartedAt: Date.now() };
      if (await store.compareAndSet(key, record.revision, next, proposalLifetime())) { claimed = next; break; }
    }
    if (!claimed) throw new RequestError(409, 'Der Vorschlag wurde gleichzeitig verändert. Bitte erneut prüfen.');
    let result: Record<string, unknown> | undefined;
    let status: Proposal['status'];
    try {
      result = await options.registry.invoke(claimed.pluginId, claimed.executionTool, claimed.args, user.actor, true, 'model', claimed.bindingDigest);
      status = 'confirmed';
    } catch (error) {
      // Once claimed, an ambiguous external failure never authorizes a retry.
      status = error instanceof RequestError && error.status < 500 ? 'failed' : 'outcome_unknown';
    }
    const completed: Proposal = { ...claimed, status, ...(result ? { result } : {}) };
    const record = await store.read(key);
    const current = record?.value as Proposal | undefined;
    if (!record || current?.executionId !== claimed.executionId || !await store.compareAndSet(key, record.revision, completed, proposalLifetime())) throw new RequestError(503, 'Das Ergebnis ist noch nicht sicher gespeichert. Bitte den Buchungsstatus prüfen.');
    return { ...(completed.result ?? {}), proposal: publicProposal(completed) };
  });
  return app;
}

export function createRegistry(privateKey: KeyObject): PluginRegistry { return new PluginRegistry(privateKey); }

export { personas, type Persona, type IdentityProvider } from './identity.js';
