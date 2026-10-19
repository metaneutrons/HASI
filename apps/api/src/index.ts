import { randomUUID, type KeyObject } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { z } from 'zod';
import { MemoryJsonStore, type JsonStore } from '@hasi/state';
import { PluginRegistry, RequestError, type ApprovedPluginSource } from './registry.js';
import { MockIdentityProvider, personas, type Persona, type IdentityProvider } from './identity.js';
import { isAllowedOidcReturnTo, OidcIdentityProvider } from './oidc.js';
import { PluginSettingsError } from './plugin-settings.js';
import { actionPreviewSchema, actionResolutionSchema, type ActionPolicy, type ActionPreview, type ActionResolution } from './action-policy.js';
import type { KnowledgeContextStore } from './knowledge-context.js';
import { PluginAccountError } from './plugin-accounts.js';
import { SERVICE_IT_DEMO_ORIGIN } from '@hasi/demo-fixtures/knowledge-catalog';
import { registerOperationalEventHooks, type OperationalEventSink } from './operational-events.js';
import type { ManagedPluginAdmin } from './managed-plugin-admin.js';
import { registerManagedPluginAdminRoutes } from './managed-plugin-admin-routes.js';

export { PluginRegistry, compatibleUpdate, RequestError } from './registry.js';
export { OidcIdentityProvider, OidcAuthenticationError } from './oidc.js';
export { startTestIdp } from './test-idp.js';
export { PluginAccountService, PluginAccountError, type PluginAccountAdapter, type PluginAccountServiceOptions } from './plugin-accounts.js';
export { createProductionRuntime, ProductionAuthorityDirectory, stableOidcSubject, type ProductionRuntimeOptions } from './production-runtime.js';
export { EnvironmentPluginSecretCustody, type PluginSecretCustody } from './plugin-secrets.js';
export { createReviewedPlainMcpAdapter, type ReviewedPlainMcpOptions } from './plain-mcp-adapter.js';
export { createKnowledgeEmbeddingClient } from './knowledge-embeddings.js';
export { KnowledgeIngestionWorker } from './knowledge-worker.js';
export { KnowledgeContextStore } from './knowledge-context.js';
export { createRegistryKnowledgeContexts } from './knowledge-context-runtime.js';
export { PluginRouteController } from './plugin-route-controller.js';
export { PluginDeploymentBinding } from './plugin-deployment-binding.js';
export { createPluginDeploymentGateway } from './plugin-deployment-proxy.js';
export { createDockerPluginDriver } from './docker-plugin-driver.js';
export { PluginDeploymentCoordinator, verifyPluginRelease } from './plugin-artifacts.js';
export { assertMockMode, MockIdentityProvider, withDemoPluginClaims } from './identity.js';
export { createConsoleOperationalEventSink, operationalEventName, operationalRequestMethods, type OperationalEventSink, type OperationalRequestEvent, type OperationalRequestMethod } from './operational-events.js';
const ANNY = 'de.hsh.hasi.anny';
const annyId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const time = z.iso.datetime({ offset: true });
const roomRequest = z.strictObject({ resourceId: annyId, serviceId: annyId, startDate: time, endDate: time }).refine(value => Date.parse(value.endDate) > Date.parse(value.startDate) && Date.parse(value.endDate) - Date.parse(value.startDate) <= 86400000, 'Invalid interval');
const draftSchema = z.strictObject({ executionTool: z.string(), arguments: z.record(z.string(), z.unknown()), resourceName: z.string().max(200) });
interface Proposal { reconciliationAuthorityDigest?: string; preview?: ActionPreview; actionPolicyRevision?: string; reconciledAt?: number; executionTitle?: string; executionDescription?: string; authorityDigest?: string; bindingDigest?: string; id: string; subject: string; pluginId: string; pluginVersion: string; executionTool: string; args: Record<string, unknown>; resourceName: string; startDate: string; endDate: string; expiresAt: string; status: 'pending' | 'executing' | 'confirmed' | 'failed' | 'outcome_unknown'; result?: Record<string, unknown>; executionId?: string; executionStartedAt?: number }
const publicUser = (user: Persona) => ({ id: user.id, displayName: user.displayName, role: user.role });
class InvalidatedProposalError extends Error {
  constructor() { super('Die Dienstfreigabe wurde geändert. Dieser Vorschlag ist ungültig. Bitte neu vorbereiten.'); }
}
const publicProposal = (proposal: Proposal) => ({ ...(proposal.preview ? { preview: proposal.preview } : {}), id: proposal.id, resourceName: proposal.resourceName, startDate: proposal.startDate, endDate: proposal.endDate, expiresAt: proposal.expiresAt, status: proposal.status, arguments: proposal.args, pluginId: proposal.pluginId, executionTool: proposal.executionTool, ...(proposal.pluginId !== ANNY ? { executionTitle: proposal.executionTitle ?? proposal.executionTool, executionDescription: proposal.executionDescription ?? '' } : {}), action: proposal.pluginId === ANNY ? proposal.executionTool === 'anny.execute_cancellation' ? 'cancel_booking' : 'book' : 'execute_tool' });

export interface ApiOptions {
  mode: 'development' | 'test' | 'public-demo' | 'production'; registry: PluginRegistry; origin?: string;
  identity?: IdentityProvider; store?: JsonStore; pluginCatalog?: readonly ApprovedPluginSource[]; allowedHosts?: readonly string[];
  knowledgeContexts?: KnowledgeContextStore;
  knowledgeOriginalOrigins?: Readonly<Record<'service_it' | 'intranet', string>>;
  knowledgeDemoServiceItOrigin?: string;
  secureCookies?: boolean; sessionCookieName?: string; actionPolicies?: Readonly<Record<string, ActionPolicy>>;
  operationalEventSink?: OperationalEventSink;
  managedPlugins?: ManagedPluginAdmin;
}

export async function createApi(options: ApiOptions) {
  if (options.knowledgeDemoServiceItOrigin !== undefined && (options.mode === 'production'
    || options.knowledgeDemoServiceItOrigin !== SERVICE_IT_DEMO_ORIGIN)) throw new Error('Unapproved synthetic source origin.');
  const app = Fastify({ logger: false, bodyLimit: 65536 });
  registerOperationalEventHooks(app, options.operationalEventSink);
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
  // A fixed server-derived deadline avoids extending invalidated proposal content
  // every time a client reloads it. Audit projection retention is separate.
  const proposalBindingGuard = options.registry.proposalBindingGuard(store, proposal =>
    typeof proposal.expiresAt === 'string' ? Date.parse(proposal.expiresAt) + 86400000 : Number.NaN);
  if ((options.mode === 'production' || options.mode === 'public-demo') && !proposalBindingGuard) throw new Error('Hosted API requires durable plugin lifecycle authority.');
  const origin = options.origin ?? 'http://127.0.0.1:3000';
  await app.register(cookie);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('cache-control', 'private, no-store');
    const host = request.hostname;
    if (!allowedHosts.includes(host)) throw new RequestError(403, 'Unzulässiger Host.');
    if (!['GET', 'HEAD'].includes(request.method) && request.headers.origin !== origin) throw new RequestError(403, 'Ungültiger Anfrageursprung.');
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof InvalidatedProposalError) return reply.code(409).send({ error: error.message, code: 'proposal_invalidated' });
    if (error instanceof PluginAccountError) return reply.code(error.statusCode).send({ error: error.message, code: error.code });
    if (error instanceof PluginSettingsError && error.errors) return reply.code(error.status).send({ error: error.message, code: 'configuration_invalid', errors: error.errors });
    if (error instanceof RequestError || error instanceof PluginSettingsError) return reply.code(error.status).send({ error: error.message });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'Bitte prüfe die eingegebenen Daten.' });
    return reply.code(502).send({ error: 'Die Anfrage konnte nicht abgeschlossen werden.' });
  });
  const requireUser = async (token: string | undefined) => { const user = await identity.resolve(token); if (!user) throw new RequestError(401, oidc ? 'Bitte melde dich an.' : 'Bitte wähle zuerst ein Testkonto.'); return user; };
  const requireAdmin = async (token: string | undefined) => { const user = await requireUser(token); if (user.role !== 'admin' || !user.actor.permissions.includes('plugins:manage')) throw new RequestError(403, 'Diese Funktion ist der Administration vorbehalten.'); return user; };
  const assertProposalBinding = async (id: string, subject: string) => {
    if (!proposalBindingGuard) return; // Process-local development retains the existing execution checks.
    const observed = await proposalBindingGuard.observeOwnedProposal(id, subject);
    if (observed.status === 'missing') throw new RequestError(404, 'Vorschlag nicht gefunden.');
    if (observed.status === 'unavailable') throw new RequestError(503, 'Die aktuelle Dienstfreigabe kann gerade nicht geprüft werden. Bitte später erneut versuchen.');
    if (observed.status === 'invalidated') throw new InvalidatedProposalError();
  };
  registerManagedPluginAdminRoutes(app, {
    cookieName,
    requireAdmin,
    ...(options.managedPlugins ? { service: options.managedPlugins } : {}),
  });
  const accountService = (id: string) => {
    options.registry.manifest(id);
    const service = options.registry.accounts.get(id);
    if (!service) throw new RequestError(404, 'Dieser Dienst benötigt keine persönliche Kontoverknüpfung.');
    return service;
  };
  app.get('/api/plugin-accounts', async request => {
    const user = await requireUser(request.cookies[cookieName]);
    await options.registry.refreshAll();
    const installed = options.registry.list();
    const accounts = [];
    for (const [id, service] of options.registry.accounts) {
      const plugin = installed.find(item => item.id === id);
      if (plugin) accounts.push({ ...await service.status(user.actor.subject), label: plugin.name });
    }
    return { accounts };
  });
  app.post('/api/plugin-accounts/:id/authorization', async request => {
    const user = await requireUser(request.cookies[cookieName]);
    const { id } = z.strictObject({ id: z.string().min(1).max(128) }).parse(request.params);
    const input = z.strictObject({ operation: z.enum(['consent', 'renewal']), returnTo: z.enum(['/', '/bookings', '/admin', '/account/connections']) }).parse(request.body);
    return accountService(id).begin(user.actor.subject, input);
  });
  app.get('/api/plugin-accounts/:id/callback', async (request, reply) => {
    const user = await requireUser(request.cookies[cookieName]);
    const { id } = z.strictObject({ id: z.string().min(1).max(128) }).parse(request.params);
    const callback = z.record(z.string().max(64), z.string().max(4096)).parse(request.query);
    const state = z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(callback.state);
    const result = await accountService(id).complete(user.actor.subject, state, callback);
    return reply.redirect(new URL(result.returnTo, origin).href);
  });
  app.post('/api/plugin-accounts/:id/consent', async request => {
    if (options.mode === 'production') throw new RequestError(404, 'Nicht verfügbar.');
    const user = await requireUser(request.cookies[cookieName]);
    const { id } = z.strictObject({ id: z.string().min(1).max(128) }).parse(request.params);
    const { state } = z.strictObject({ state: z.string().regex(/^[A-Za-z0-9_-]{43}$/), approved: z.literal(true) }).parse(request.body);
    const service = accountService(id);
    if ((await service.status(user.actor.subject)).adapterTrust !== 'demo-only') throw new RequestError(403, 'Diese Bestätigung ist nur für simulierte Anmeldedienste freigegeben.');
    return service.complete(user.actor.subject, state, { state, approved: 'true' });
  });
  for (const operation of ['disconnect', 'revocation/retry'] as const) app.post(`/api/plugin-accounts/:id/${operation}`, async request => {
    const user = await requireUser(request.cookies[cookieName]);
    const { id } = z.strictObject({ id: z.string().min(1).max(128) }).parse(request.params);
    const { expectedAuthorityRevision } = z.strictObject({ expectedAuthorityRevision: z.number().int().nonnegative() }).parse(request.body);
    const service = accountService(id);
    return operation === 'disconnect' ? service.disconnect(user.actor.subject, expectedAuthorityRevision) : service.retryRevocation(user.actor.subject, expectedAuthorityRevision);
  });
  const assertProposalReadAccess = async (proposal: Proposal, user: Persona) => {
    if (proposal.pluginVersion !== options.registry.version(proposal.pluginId) || proposal.bindingDigest !== await options.registry.binding(proposal.pluginId)) throw new RequestError(409, 'Die Dienstfreigabe wurde geändert. Bitte den aktuellen Stand im zuständigen Dienst prüfen.');
    const matches = proposal.reconciliationAuthorityDigest
      ? proposal.reconciliationAuthorityDigest === await options.registry.reconciliationAuthorityBinding(proposal.pluginId, user.actor)
      : proposal.authorityDigest === await options.registry.authorityBinding(proposal.pluginId, user.actor);
    if (!matches) throw new RequestError(409, 'Die aktuellen Kontorechte geben diesen Aktionsbeleg nicht frei. Bitte die Kontoverbindung prüfen.');
  };
  const makeProposal = async (user: Persona, pluginId: string, name: string, args: Record<string, unknown>) => {
    const bindingDigest = await options.registry.binding(pluginId);
    const authorityDigest = await options.registry.authorityBinding(pluginId, user.actor);
    const reconciliationAuthorityDigest = await options.registry.reconciliationAuthorityBinding(pluginId, user.actor);
    const output = await options.registry.invoke(pluginId, name, args, user.actor);
    if (bindingDigest !== await options.registry.binding(pluginId)) throw new RequestError(409, 'Das Plugin wurde verändert. Bitte den Vorschlag neu vorbereiten.');
    const draft = draftSchema.parse(output.draft);
    const execution = options.registry.list().find(plugin => plugin.id === pluginId)?.tools.find(tool => tool.name === draft.executionTool && tool.effect === 'execute');
    if (!execution?.requiredPermissions.every(permission => user.actor.permissions.includes(permission))) throw new RequestError(403, 'Der Vorschlag ist nicht freigegeben.');
    const policy = options.actionPolicies?.[pluginId];
    if (options.mode === 'production' && !policy) throw new RequestError(409, 'Für diesen Dienst fehlt die freigegebene Aktionsvorschau.');
    const preview = actionPreviewSchema.parse(policy ? await policy.preview({ actor: user.actor, executionTool: draft.executionTool, arguments: draft.arguments }) : {
      instance: options.registry.manifest(pluginId).name,
      account: user.displayName,
      effect: execution.title,
      consequences: ['Diese Aktion ändert ausschließlich Daten in der Testumgebung.'],
      costs: 'Keine echten Buchungen oder Zahlungen in der Testumgebung.',
    });
    if (bindingDigest !== await options.registry.binding(pluginId) || authorityDigest !== await options.registry.authorityBinding(pluginId, user.actor)) throw new RequestError(409, 'Konto oder Dienst wurden während der Vorbereitung geändert. Bitte neu vorbereiten.');
    const proposal: Proposal = { preview, ...(policy ? { actionPolicyRevision: policy.revision } : {}), executionTitle: execution.title, executionDescription: execution.description, reconciliationAuthorityDigest, authorityDigest, bindingDigest, id: randomUUID(), subject: user.actor.subject, pluginId, pluginVersion: options.registry.version(pluginId), executionTool: draft.executionTool, args: draft.arguments, resourceName: draft.resourceName, startDate: typeof draft.arguments.startDate === 'string' ? draft.arguments.startDate : '', endDate: typeof draft.arguments.endDate === 'string' ? draft.arguments.endDate : '', expiresAt: new Date(Date.now() + 300000).toISOString(), status: 'pending' };
    if (!await store.compareAndSet(proposalKey(proposal.id), null, proposal, proposalLifetime())) throw new RequestError(503, 'Der Vorschlag konnte nicht gespeichert werden.');
    return { proposal: publicProposal(proposal) };
  };
  app.get('/api/session', async request => { const user = await identity.resolve(request.cookies[cookieName]); return { mode: sessionMode, user: user ? publicUser(user) : null, ...(options.mode === 'production' && user ? { modelContext: { dataClasses: ['public', 'internal', 'confidential'] } } : {}) }; });
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
  app.get('/api/tools', async request => { const user = await requireUser(request.cookies[cookieName]); await options.registry.refreshAll(); return { tools: await options.registry.authorizedModelTools(user.actor) }; });
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
    const result = await options.registry.settings.activate(id, options.registry.manifest(id), revision, user.actor.subject, options.registry.registration(id).secretReady);
    await options.registry.configurationActivated(id);
    return result;
  });
  app.get('/api/plugin-apps/:id/:presentationId', async request => {
    const user = await requireUser(request.cookies[cookieName]); const { id, presentationId } = z.object({ id: z.string(), presentationId: z.string() }).parse(request.params);
    return options.registry.readPresentation(id, presentationId, user.actor);
  });
  app.post('/api/admin/plugins/:id/enabled', async request => { await requireAdmin(request.cookies[cookieName]); const { id } = z.object({ id: z.string() }).parse(request.params); const { enabled } = z.strictObject({ enabled: z.boolean() }).parse(request.body); await options.registry.setEnabled(id, enabled); return { ok: true }; });
  app.post('/api/admin/plugins/:id/check-update', async request => { await requireAdmin(request.cookies[cookieName]); const { id } = z.object({ id: z.string() }).parse(request.params); return options.registry.checkUpdate(id); });
  app.post('/api/admin/plugins/:id/activate-update', async request => { await requireAdmin(request.cookies[cookieName]); const { id } = z.object({ id: z.string() }).parse(request.params); await options.registry.activateUpdate(id); return { ok: true }; });
  app.get('/api/resources', async request => { const user = await requireUser(request.cookies[cookieName]); return options.registry.invoke(ANNY, 'anny.search_resources', {}, user.actor); });
  const readKnowledge = async (user: Persona, id: string, revision?: number) => {
    try {
      const result = await options.registry.invoke('de.hsh.hasi.knowledge', 'knowledge.get_document', { documentId: id, ...(revision !== undefined ? { revision } : {}) }, user.actor, false, 'app');
      const document = z.record(z.string(), z.unknown()).parse(result.document);
      if (revision !== undefined && document.revision !== revision) throw new Error('Changed source revision');
      return { document };
    } catch { throw new RequestError(404, 'Dokument nicht verfügbar oder nicht freigegeben.'); }
  };
  const documentId = z.string().regex(/^(svc|int)-[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/);
  const documentQuery = z.strictObject({ revision: z.coerce.number().int().positive().optional() });
  app.get('/api/knowledge/documents/:id', async request => {
    const user = await requireUser(request.cookies[cookieName]);
    const { id } = z.strictObject({ id: documentId }).parse(request.params);
    const { revision } = documentQuery.parse(request.query);
    return readKnowledge(user, id, revision);
  });
  app.get('/api/knowledge/documents/:id/original', async (request, reply) => {
    const user = await requireUser(request.cookies[cookieName]);
    const { id } = z.strictObject({ id: documentId }).parse(request.params);
    const { revision } = documentQuery.parse(request.query);
    const { document } = await readKnowledge(user, id, revision);
    if (document.synthetic !== false || typeof document.canonicalUrl !== 'string' || (document.sourceSystem !== 'service_it' && document.sourceSystem !== 'intranet')) throw new RequestError(404, 'Originalquelle nicht verfügbar.');
    const origins = options.knowledgeOriginalOrigins ?? { service_it: 'https://service.it.hs-hannover.de', intranet: 'https://intranet.hs-hannover.de' };
    const canonical = new URL(document.canonicalUrl);
    if (canonical.protocol !== 'https:' || canonical.username || canonical.password || canonical.search || canonical.origin !== origins[document.sourceSystem]) throw new RequestError(404, 'Originalquelle nicht verfügbar.');
    return reply.redirect(canonical.href);
  });
  app.get('/api/knowledge/documents/:id/demo-source', async (request, reply) => {
    const user = await requireUser(request.cookies[cookieName]);
    const { id } = z.strictObject({ id: documentId }).parse(request.params);
    const { revision } = documentQuery.parse(request.query);
    if (!options.knowledgeDemoServiceItOrigin) throw new RequestError(404, 'Demoquelle nicht verfügbar.');
    const { document } = await readKnowledge(user, id, revision);
    const acquisition = document.acquisition as Record<string, unknown> | undefined;
    if (document.synthetic !== true || document.sourceSystem !== 'service_it' || acquisition?.adapter !== 'web') {
      throw new RequestError(404, 'Demoquelle nicht verfügbar.');
    }
    return reply.redirect(`${options.knowledgeDemoServiceItOrigin}/de/faqs/${encodeURIComponent(id)}/`);
  });
  app.post('/api/knowledge/contexts/resolve', async request => {
    const user = await requireUser(request.cookies[cookieName]);
    const { contextIds } = z.strictObject({ contextIds: z.array(z.uuid()).max(32).refine(ids => new Set(ids).size === ids.length) }).parse(request.body);
    const contexts = [];
    for (const contextId of contextIds) {
      try {
        const binding = await options.registry.binding('de.hsh.hasi.knowledge');
        const result = await options.knowledgeContexts?.resolve(user.actor.subject, contextId, binding);
        contexts.push({ contextId, ...(result ?? { status: 'unavailable' as const }) });
      } catch { contexts.push({ contextId, status: 'unavailable' as const }); }
    }
    return { contexts };
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
    const result = await options.registry.invoke(body.pluginId, body.name, body.arguments, user.actor, false, body.source ?? 'model');
    if (body.pluginId === 'de.hsh.hasi.knowledge' && body.name === 'knowledge.search' && options.knowledgeContexts) {
      const documents = z.array(z.record(z.string(), z.unknown())).max(5).parse(result.documents);
      const binding = await options.registry.binding(body.pluginId);
      const { contextId } = await options.knowledgeContexts.issue(user.actor.subject, binding, documents);
      const verified = await options.knowledgeContexts.resolve(user.actor.subject, contextId, binding);
      if (verified.status !== 'valid') throw new RequestError(409, 'Die Quellenrechte oder Fassungen wurden geändert. Bitte erneut suchen.');
      return { documents: verified.documents, contextId };
    }
    if (body.pluginId === 'de.hsh.hasi.knowledge') return Object.fromEntries(Object.entries(result).filter(([key]) => key !== '_hasi'));
    return result;
  });
  app.get('/api/proposals/:id', async request => {
    const user = await requireUser(request.cookies[cookieName]);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    await assertProposalBinding(id, user.actor.subject);
    const record = await store.read(proposalKey(id));
    const proposal = record?.value as Proposal | undefined;
    if (proposal?.subject !== user.actor.subject) throw new RequestError(404, 'Vorschlag nicht gefunden.');
    await assertProposalReadAccess(proposal, user);
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
      await assertProposalBinding(id, user.actor.subject);
      if (proposal.status === 'confirmed' || proposal.status === 'outcome_unknown') { await assertProposalReadAccess(proposal, user); return { ...(proposal.result ?? {}), proposal: publicProposal(proposal) }; }
      if (proposal.status === 'executing' && proposal.executionStartedAt && Date.now() - proposal.executionStartedAt > 60000) {
        await assertProposalReadAccess(proposal, user);
        const unknown = { ...proposal, status: 'outcome_unknown' as const };
        if (await store.compareAndSet(key, record.revision, unknown, proposalLifetime())) { await assertProposalReadAccess(unknown, user); return { proposal: publicProposal(unknown) }; }
        continue;
      }
      if (proposal.status !== 'pending') throw new RequestError(409, 'Dieser Vorschlag wird bereits bearbeitet.');
      if (Date.parse(proposal.expiresAt) <= Date.now() || proposal.pluginVersion !== options.registry.version(proposal.pluginId) || (proposal.bindingDigest === undefined || proposal.bindingDigest !== await options.registry.binding(proposal.pluginId))) throw new RequestError(409, 'Der Vorschlag ist abgelaufen oder das Plugin wurde aktualisiert. Bitte neu prüfen.');
      if (proposal.actionPolicyRevision !== options.actionPolicies?.[proposal.pluginId]?.revision) throw new RequestError(409, 'Die Aktionsbedingungen wurden geändert. Bitte neu vorbereiten.');
      if (proposal.authorityDigest !== await options.registry.authorityBinding(proposal.pluginId, user.actor)) throw new RequestError(409, 'Die Kontoverknüpfung oder Berechtigung wurde geändert. Bitte neu vorbereiten.');
      const next = { ...proposal, status: 'executing' as const, executionId: randomUUID(), executionStartedAt: Date.now() };
      if (await store.compareAndSet(key, record.revision, next, proposalLifetime())) { claimed = next; break; }
    }
    if (!claimed) throw new RequestError(409, 'Der Vorschlag wurde gleichzeitig verändert. Bitte erneut prüfen.');
    let result: Record<string, unknown> | undefined;
    let status: Proposal['status'];
    try {
      result = await options.registry.invoke(claimed.pluginId, claimed.executionTool, claimed.args, user.actor, true, 'model', claimed.bindingDigest, claimed.executionId);
      status = 'confirmed';
    } catch {
      // Once claimed, an ambiguous external failure never authorizes a retry.
      // Even a post-call permission/configuration conflict may follow a completed write.
      // Only authoritative reconciliation is allowed to establish terminal failure.
      status = 'outcome_unknown';
    }
    const completed: Proposal = { ...claimed, status, ...(result ? { result } : {}) };
    const record = await store.read(key);
    const current = record?.value as Proposal | undefined;
    if (!record || !current || current.executionId !== claimed.executionId) throw new RequestError(503, 'Das Ergebnis ist noch nicht sicher gespeichert. Bitte den Buchungsstatus prüfen.');
    // A later status transition owns the outcome. A slow original response must
    // never discard a receipt or replace reconciliation with an older unknown.
    if (current.status !== 'executing' || current.reconciledAt !== undefined) {
      await assertProposalReadAccess(current, user);
      return { ...(current.result ?? {}), proposal: publicProposal(current) };
    }
    if (!await store.compareAndSet(key, record.revision, completed, proposalLifetime())) throw new RequestError(503, 'Das Ergebnis ist noch nicht sicher gespeichert. Bitte den Buchungsstatus prüfen.');
    await assertProposalReadAccess(completed, user);
    return { ...(completed.result ?? {}), proposal: publicProposal(completed) };
  });
  app.post('/api/proposals/:id/reconcile', async request => {
    const user = await requireUser(request.cookies[cookieName]);
    z.strictObject({}).parse(request.body);
    const { id } = z.strictObject({ id: z.uuid() }).parse(request.params);
    const key = proposalKey(id);
    const record = await store.read(key);
    const proposal = record?.value as Proposal | undefined;
    if (!record || proposal?.subject !== user.actor.subject) throw new RequestError(404, 'Vorschlag nicht gefunden.');
    await assertProposalReadAccess(proposal, user);
    if (proposal.status === 'confirmed' || proposal.status === 'failed') return { ...(proposal.result ?? {}), proposal: publicProposal(proposal) };
    if (proposal.status === 'pending' || (proposal.status === 'executing' && Date.now() - (proposal.executionStartedAt ?? Date.now()) < 60000)) throw new RequestError(409, 'Die Aktion ist noch nicht zur Statusklärung bereit.');
    if (!proposal.executionId || !proposal.bindingDigest) throw new RequestError(409, 'Für diesen alten Vorschlag fehlt ein sicherer Ausführungsbeleg. Bitte den Dienst prüfen.');
    if (proposal.reconciledAt && Date.now() - proposal.reconciledAt < 10000) throw new RequestError(429, 'Bitte vor der nächsten Statusprüfung kurz warten.');
    if (proposal.pluginVersion !== options.registry.version(proposal.pluginId) || proposal.bindingDigest !== await options.registry.binding(proposal.pluginId) || proposal.actionPolicyRevision !== options.actionPolicies?.[proposal.pluginId]?.revision) throw new RequestError(409, 'Konto oder Dienst wurden geändert. Der Status muss mit aktueller Dienstfreigabe geklärt werden.');
    const checking: Proposal = { ...proposal, status: 'outcome_unknown', reconciledAt: Date.now() };
    if (!await store.compareAndSet(key, record.revision, checking, proposalLifetime())) throw new RequestError(409, 'Der Status wird bereits geprüft.');
    let resolution: ActionResolution;
    try {
      const policy = options.actionPolicies?.[proposal.pluginId];
      resolution = actionResolutionSchema.parse(policy ? await policy.reconcile({ actor: user.actor, arguments: proposal.args, executionTool: proposal.executionTool, executionId: proposal.executionId }) : await options.registry.reconcile(proposal.pluginId, proposal.executionTool, proposal.args, user.actor, proposal.executionId, proposal.bindingDigest));
      if (resolution.status === 'confirmed') resolution = { status: 'confirmed', result: await options.registry.projectExecutionReceipt(proposal.pluginId, proposal.executionTool, resolution.result, user.actor) };
    } catch { resolution = { status: 'outcome_unknown' as const }; }
    // Recheck authority and installation after the status read, before exposing a receipt.
    await assertProposalReadAccess(proposal, user);
    const completed: Proposal = { ...checking, status: resolution.status, ...(resolution.status === 'confirmed' ? { result: resolution.result } : {}) };
    const latest = await store.read(key);
    const value = latest?.value as Proposal | undefined;
    if (!latest || value?.reconciledAt !== checking.reconciledAt || value?.executionId !== checking.executionId || !await store.compareAndSet(key, latest.revision, completed, proposalLifetime())) throw new RequestError(409, 'Der Aktionsstatus wurde gleichzeitig geändert. Bitte neu laden.');
    return { ...(completed.result ?? {}), proposal: publicProposal(completed) };
  });
  return app;
}

export function createRegistry(privateKey: KeyObject): PluginRegistry { return new PluginRegistry(privateKey); }

export { personas, type Persona, type IdentityProvider } from './identity.js';
export type { ManagedPluginAdmin } from './managed-plugin-admin.js';

export { createContentHttpClient, type ContentHttpClient, type ContentHttpOptions } from './content-transport.js';
