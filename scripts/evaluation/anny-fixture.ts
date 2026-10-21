import { createServer, type Server } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { DEMO_EXECUTION_HEADER, decodeDemoExecutionHeader } from '@hasi/anny-mock';
import { createDemoRuntime } from '@hasi/demo-runtime';
import { digest } from '@hasi/plugin-sdk';
import { MemoryJsonStore, type JsonStore } from '@hasi/state';
import { z } from 'zod';
import { hshDemoCatalog } from '../../fixtures/catalog.js';

export type EvaluationAnnyAction = 'book' | 'cancel_booking';

interface ConfirmationEvent {
  kind: 'action_confirmation';
  action: EvaluationAnnyAction;
  subject: string;
  proposalId: string;
  actionDigestSha256: string;
}

interface AttemptEvent {
  kind: 'action_attempt';
  action: EvaluationAnnyAction;
  subject: string;
  proposalId: string;
  actionDigestSha256: string;
  attempt: number;
  outcome: 'confirmed' | 'outcome_unknown' | 'rejected';
}

export type EvaluationAnnyEvent = ConfirmationEvent | AttemptEvent;

export interface EvaluationAnnyFixture {
  prepareUnknownOutcome(): Promise<{
    expectedEvents: EvaluationAnnyEvent[];
    proposalId: string;
    modelStatus: {
      state: 'outcome_unknown';
      action: EvaluationAnnyAction;
      externalAttempts: 1;
    };
  }>;
  observeEvents(): Promise<EvaluationAnnyEvent[]>;
  confirmAgain(): Promise<void>;
  foreignConfirm(): Promise<number>;
  /** Replaces only the fixture's private captured copy, never persisted mock state. */
  corruptSourceEvidence(): Promise<void>;
  /** Sends an unauthorized loopback write request; it must have no committed effect. */
  injectRejectedSourceAttempt(): Promise<void>;
  diagnostics(): {
    sourceWrites: number;
    sourceWriteRequests: number;
    setupSourceWrites: number;
    targetSourceWrites: number;
    targetWriteRequests: number;
    sourceStatusReads: number;
  };
  close(): Promise<void>;
}

const proposalStatusSchema = z.enum(['pending', 'executing', 'confirmed', 'failed', 'outcome_unknown']);
const toolSchema = z.enum(['anny.execute_booking', 'anny.execute_cancellation']);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const identifierSchema = z.string().min(1).max(256);
const bookingArgumentsSchema = z.strictObject({
  resourceId: z.string().min(1).max(128),
  serviceId: z.string().min(1).max(128),
  startDate: z.iso.datetime({ offset: true }),
  endDate: z.iso.datetime({ offset: true }),
});
const cancellationArgumentsSchema = z.strictObject({
  bookingId: z.string().min(1).max(128),
  resourceId: z.string().min(1).max(128),
  startDate: z.iso.datetime({ offset: true }),
  endDate: z.iso.datetime({ offset: true }),
});
const proposalProjectionSchema = z.object({
  id: z.uuid(),
  subject: identifierSchema,
  executionTool: toolSchema,
  args: z.record(z.string(), z.unknown()),
  status: proposalStatusSchema,
  executionId: z.uuid().optional(),
  result: z.record(z.string(), z.unknown()).optional(),
});
const publicProposalSchema = z.object({
  id: z.uuid(),
  action: z.enum(['book', 'cancel_booking']),
  executionTool: toolSchema,
  arguments: z.record(z.string(), z.unknown()),
  status: proposalStatusSchema,
});
const bindingSchema = z.strictObject({
  subject: identifierSchema,
  installationId: z.string().min(1).max(128),
  executionId: z.uuid(),
  tool: toolSchema,
  argsHash: digestSchema,
  configurationRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
const executionEvidenceSchema = z.strictObject({
  binding: bindingSchema,
  customerId: identifierSchema,
  arguments: z.record(z.string(), z.unknown()),
  result: z.record(z.string(), z.unknown()),
});
const executionEvidenceMapSchema = z.record(digestSchema, executionEvidenceSchema);
const aggregateEvidenceSchema = z.object({ demoExecutionEvidence: z.unknown() });
const uuid = z.uuid();

type ProposalSnapshot = z.infer<typeof proposalProjectionSchema>;
type ExecutionEvidence = z.infer<typeof executionEvidenceSchema>;
interface ProposalTransition { before?: ProposalSnapshot; after: ProposalSnapshot }

async function closeServer(listener: Server | undefined): Promise<void> {
  if (!listener?.listening) return;
  await new Promise<void>((resolve, reject) => {
    listener.close(error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function actionForTool(tool: z.infer<typeof toolSchema>): EvaluationAnnyAction {
  return tool === 'anny.execute_booking' ? 'book' : 'cancel_booking';
}

function parseProposalSnapshot(key: string, value: unknown): ProposalSnapshot | undefined {
  const match = /^workspace:([0-9a-f-]{36}):proposal:([0-9a-f-]{36})$/u.exec(key);
  if (!match) return undefined;
  const parsed = proposalProjectionSchema.safeParse(value);
  if (!parsed.success || parsed.data.id !== match[2]) throw new TypeError('Invalid observed proposal state.');
  const args = parsed.data.executionTool === 'anny.execute_booking'
    ? bookingArgumentsSchema.parse(parsed.data.args)
    : cancellationArgumentsSchema.parse(parsed.data.args);
  return { ...parsed.data, args };
}

function parseEvidenceMap(value: unknown): Record<string, ExecutionEvidence> {
  const parsed = executionEvidenceMapSchema.parse(value);
  const executionIdentities = new Map<string, string>();
  for (const [key, evidence] of Object.entries(parsed)) {
    if (key !== digest(evidence.binding)) throw new TypeError('Mock evidence key does not match its execution binding.');
    if (evidence.binding.tool === 'anny.execute_booking') {
      const args = bookingArgumentsSchema.parse(evidence.arguments);
      if (digest(args) !== evidence.binding.argsHash) throw new TypeError('Mock evidence arguments do not match their bound digest.');
      z.strictObject({ bookingId: z.string().min(1).max(128) }).parse(evidence.result);
    } else {
      const args = cancellationArgumentsSchema.parse(evidence.arguments);
      if (digest(args) !== evidence.binding.argsHash) throw new TypeError('Mock evidence arguments do not match their bound digest.');
      const result = z.strictObject({ bookingId: z.string().min(1).max(128), status: z.literal('cancelled') }).parse(evidence.result);
      if (result.bookingId !== args.bookingId) throw new TypeError('Mock cancellation receipt does not match its submitted booking.');
    }
    const identity = `${evidence.binding.subject}\0${evidence.binding.installationId}\0${evidence.binding.executionId}`;
    const priorKey = executionIdentities.get(identity);
    if (priorKey && priorKey !== key) throw new TypeError('Duplicate mock execution correlation was persisted.');
    executionIdentities.set(identity, key);
  }
  return parsed;
}

function evidenceFromAggregate(value: unknown, required: boolean): Record<string, ExecutionEvidence> | undefined {
  if (value === undefined) return undefined;
  const aggregate = aggregateEvidenceSchema.safeParse(value);
  if (!aggregate.success) {
    if (required) throw new TypeError('Mock aggregate has no execution evidence field.');
    return undefined;
  }
  return parseEvidenceMap(aggregate.data.demoExecutionEvidence);
}

function copyJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function proposalKeyId(key: string): string | undefined {
  const match = /^workspace:[0-9a-f-]{36}:proposal:([0-9a-f-]{36})$/u.exec(key);
  return match?.[1];
}

function uniquePendingRead(reads: ProposalSnapshot[], proposalId: string): ProposalSnapshot {
  if (reads.length === 0 || reads.some(read => read.id !== proposalId || read.status !== 'pending')) {
    throw new Error('Synthetic host confirmation lacks only pending reads of its proposal.');
  }
  const canonical = new Map(reads.map(read => [digest(read), read]));
  if (canonical.size !== 1) throw new Error('Synthetic host confirmation has inconsistent pending proposal reads.');
  const proposal = canonical.values().next().value;
  if (!proposal) throw new Error('Synthetic host confirmation lacks a canonical pending proposal.');
  return proposal;
}

export async function createEvaluationAnnyFixture(action: EvaluationAnnyAction): Promise<EvaluationAnnyFixture> {
  const storeId = randomUUID();
  const innerStore = new MemoryJsonStore(`evaluation-anny-${storeId}`);
  const proposalTransitions: ProposalTransition[] = [];
  const proposalReads = new Map<string, ProposalSnapshot[]>();
  const committedEvidence = new Map<string, ExecutionEvidence>();
  const evidenceOverrides = new Map<string, ExecutionEvidence>();
  const sourceWriteRequestExecutions: (string | undefined)[] = [];
  const sourceStatusReads: number[] = [];
  let captureProposalReadId: string | undefined;
  let currentTargetProposalId: string | undefined;
  let targetExecutionId: string | undefined;
  let targetRequestStartIndex: number | undefined;
  let targetDropArmed = false;
  let targetDropCount = 0;
  let closed = false;
  let prepared = false;
  let server: Server | undefined;
  let origin: string | undefined;
  let runtime: ReturnType<typeof createDemoRuntime> | undefined;

  const store: JsonStore = {
    async read(key) {
      const record = await innerStore.read(key);
      const id = proposalKeyId(key);
      if (id && captureProposalReadId === id && record) {
        const snapshot = parseProposalSnapshot(key, record.value);
        if (snapshot) {
          const reads = proposalReads.get(id) ?? [];
          reads.push(snapshot);
          proposalReads.set(id, reads);
        }
      }
      return record;
    },
    async compareAndSet(key, expectedRevision, value, expiresAt) {
      const id = proposalKeyId(key);
      const mockAggregate = /^workspace:[0-9a-f-]{36}:orders-bookings:anny(?:$|:)/u.test(key);
      const track = id !== undefined || mockAggregate;
      const previous = track ? await innerStore.read(key) : undefined;
      const candidate = track ? copyJson(value) : undefined;
      const committed = await innerStore.compareAndSet(key, expectedRevision, value, expiresAt);
      if (!committed) return false;

      if (id) {
        const after = parseProposalSnapshot(key, candidate);
        const before = previous ? parseProposalSnapshot(key, previous.value) : undefined;
        if (!after) throw new TypeError('Committed proposal could not be observed.');
        if (before?.status === 'pending' && after.status === 'executing') {
          if (before.id !== after.id || before.subject !== after.subject || digest(before.args) !== digest(after.args)
            || !after.executionId) throw new TypeError('Proposal execution claim changed its bound action.');
          proposalTransitions.push({ before, after });
          if (after.id === currentTargetProposalId) targetExecutionId = after.executionId;
        } else if (before?.status === 'executing' && after.status === 'outcome_unknown') {
          if (before.id !== after.id || before.subject !== after.subject || before.executionId !== after.executionId
            || digest(before.args) !== digest(after.args)) throw new TypeError('Unknown terminal proposal changed its execution binding.');
          proposalTransitions.push({ before, after });
        } else if (!before && after.status === 'pending') {
          proposalTransitions.push({ after });
        } else if (before && before.status !== after.status && after.status === 'confirmed') {
          proposalTransitions.push({ before, after });
        }
      }

      if (mockAggregate) {
        const beforeEvidence = evidenceFromAggregate(previous?.value, false) ?? {};
        const afterEvidence = evidenceFromAggregate(candidate, true) ?? {};
        for (const [key, prior] of Object.entries(beforeEvidence)) {
          const next = afterEvidence[key];
          if (!next || digest(next) !== digest(prior)) throw new TypeError('Persisted mock execution evidence was changed or removed.');
        }
        const added = Object.entries(afterEvidence).filter(([key]) => !Object.hasOwn(beforeEvidence, key));
        if (added.length > 1) throw new TypeError('Mock write committed ambiguous execution evidence.');
        for (const [key, evidence] of added) {
          if (committedEvidence.has(key)) throw new TypeError('Mock execution evidence was committed more than once.');
          committedEvidence.set(key, evidence);
        }
      }
      return true;
    },
    delete(key) { return innerStore.delete(key); },
  };

  const sourceFetch: typeof fetch = async (input, init) => {
    const destination = new URL(input instanceof Request ? input.url : String(input));
    if (!origin || destination.origin !== origin || destination.hostname !== '127.0.0.1' || destination.protocol !== 'http:') {
      throw new Error('Evaluation Anny fixture rejected a non-loopback destination.');
    }
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const isWrite = (method === 'POST' && destination.pathname === '/api/v1/orders/from-config')
      || (method === 'GET' && /^\/api\/v1\/bookings\/[^/]+\/cancel$/u.test(destination.pathname));
    if (destination.pathname === '/api/v1/_hasi-demo/execution-status') sourceStatusReads.push(1);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => { headers.set(name, value); });
    let executionId: string | undefined;
    if (isWrite) {
      const decoded = decodeDemoExecutionHeader(headers.get(DEMO_EXECUTION_HEADER) ?? undefined);
      if (decoded.kind === 'valid') executionId = decoded.binding.executionId;
      sourceWriteRequestExecutions.push(executionId);
    }
    const response = await fetch(input, { ...init, redirect: 'error' });
    if (isWrite && targetDropArmed && executionId && executionId === targetExecutionId && response.ok && targetDropCount === 0) {
      targetDropCount += 1;
      await response.body?.cancel();
      throw new TypeError('Synthetic source response lost after commit.');
    }
    return response;
  };

  try {
    server = createServer((incoming, outgoing) => {
      void (async () => {
        if (!origin || incoming.headers.host !== new URL(origin).host) throw new Error('Unexpected fixture host.');
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk as Uint8Array));
        const path = incoming.url ?? '/';
        const url = new URL(path, origin);
        if (url.origin !== origin) throw new Error('Unexpected fixture origin.');
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        const request = new Request(`${origin}${path}`, {
          method: incoming.method ?? 'GET',
          headers,
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        });
        if (!runtime) throw new Error('Fixture runtime is unavailable.');
        const response = url.pathname.startsWith('/api/v1/') ? await runtime.handleMock(request)
          : url.pathname.startsWith('/plugins/knowledge/') ? await runtime.handleKnowledgePlugin(request)
            : url.pathname === '/mcp' || url.pathname === '/.well-known/hasi-plugin.json' || url.pathname.startsWith('/hasi/actions/') ? await runtime.handlePlugin(request)
              : await runtime.handleCore(request);
        outgoing.statusCode = response.status;
        response.headers.forEach((value, name) => { if (name !== 'set-cookie') outgoing.setHeader(name, value); });
        const cookies = response.headers.getSetCookie();
        if (cookies.length) outgoing.setHeader('set-cookie', cookies);
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      })().catch(() => {
        if (!outgoing.headersSent) outgoing.statusCode = 500;
        outgoing.end('Synthetic evaluation fixture failure.');
      });
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Evaluation fixture failed to bind a loopback listener.');
    origin = `http://127.0.0.1:${String(address.port)}`;
    runtime = createDemoRuntime({ origin, store, secret: randomBytes(32).toString('base64url'), fetch: sourceFetch, catalog: hshDemoCatalog });
  } catch (error) {
    try { await runtime?.close(); } finally { await closeServer(server); }
    throw error;
  }

  const cookieJars = new Map<string, Map<string, string>>();
  const request = async (visitor: string, path: string, body?: unknown): Promise<Response> => {
    if (!origin || closed) throw new Error('Evaluation Anny fixture is closed.');
    if (!path.startsWith('/') || new URL(path, origin).origin !== origin) throw new Error('Evaluation fixture request must stay on loopback.');
    const jar = cookieJars.get(visitor) ?? new Map<string, string>();
    cookieJars.set(visitor, jar);
    const response = await fetch(`${origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        origin,
        cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0];
      if (!pair) continue;
      const separator = pair.indexOf('=');
      if (separator > 0) jar.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    return response;
  };

  const expectStatus = (response: Response, status: number): void => {
    if (response.status !== status) throw new Error(`Synthetic Anny fixture expected HTTP ${String(status)}.`);
  };
  const login = async (visitor: string, personaId: 'employee' | 'student') => {
    const response = await request(visitor, '/api/dev/login', { personaId });
    expectStatus(response, 200);
  };
  const authorizeAnny = async (visitor: string) => {
    const start = await request(visitor, '/api/plugin-accounts/de.hsh.hasi.anny/authorization', { operation: 'consent', returnTo: '/' });
    expectStatus(start, 200);
    const payload = z.object({ authorizationUrl: z.string().min(1).max(4096) }).parse(await start.json());
    const authorizationUrl = new URL(payload.authorizationUrl, origin);
    if (authorizationUrl.origin !== origin) throw new Error('Anny consent escaped the loopback fixture.');
    const state = authorizationUrl.searchParams.get('state');
    if (!state) throw new Error('Synthetic Anny authorization omitted state.');
    expectStatus(await request(visitor, '/api/plugin-accounts/de.hsh.hasi.anny/consent', { state, approved: true }), 200);
  };

  try {
    await login('owner', 'employee');
    const ownerJar = cookieJars.get('owner');
    const workspaceCookie = ownerJar?.get('hasi-demo-workspace');
    if (!workspaceCookie) throw new Error('Synthetic owner session omitted its workspace cookie.');
    const foreignJar = cookieJars.get('foreign') ?? new Map<string, string>();
    foreignJar.set('hasi-demo-workspace', workspaceCookie);
    cookieJars.set('foreign', foreignJar);
    await login('foreign', 'student');
    await authorizeAnny('owner');
    await authorizeAnny('foreign');
  } catch (error) {
    closed = true;
    try { await runtime.close(); } finally { await closeServer(server); }
    throw error;
  }

  const makeBookingProposal = async (): Promise<string> => {
    const resource = hshDemoCatalog.resources.find(item => item.kind === 'workplace');
    if (!resource) throw new Error('Synthetic fixture catalog has no workplace.');
    const start = new Date(Date.now() + 8 * 86_400_000);
    start.setUTCHours(9, 0, 0, 0);
    const args = {
      resourceId: resource.id,
      serviceId: resource.serviceId,
      startDate: start.toISOString(),
      endDate: new Date(start.getTime() + 3_600_000).toISOString(),
    };
    const response = await request('owner', '/api/proposals', args);
    expectStatus(response, 200);
    return z.object({ proposal: z.object({ id: uuid }) }).parse(await response.json()).proposal.id;
  };

  const makeCancellationProposal = async (bookingId: string): Promise<string> => {
    const response = await request('owner', '/api/cancellations', { bookingId });
    expectStatus(response, 200);
    return z.object({ proposal: z.object({ id: uuid }) }).parse(await response.json()).proposal.id;
  };

  const readPendingProposal = async (proposalId: string): Promise<{ action: EvaluationAnnyAction; proposal: ProposalSnapshot; digest: string }> => {
    const observed = proposalReads.get(proposalId) ?? [];
    observed.length = 0;
    proposalReads.set(proposalId, observed);
    captureProposalReadId = proposalId;
    let response: Response;
    try { response = await request('owner', `/api/proposals/${encodeURIComponent(proposalId)}`); }
    finally { captureProposalReadId = undefined; }
    expectStatus(response, 200);
    const publicValue = z.object({ proposal: publicProposalSchema }).parse(await response.json()).proposal;
    const actualReads = proposalReads.get(proposalId) ?? [];
    const proposal = uniquePendingRead(actualReads, proposalId);
    if (publicValue.id !== proposalId || publicValue.status !== 'pending') {
      throw new Error('Synthetic host confirmation lacks a server-read pending proposal.');
    }
    if (proposal.executionTool !== publicValue.executionTool
      || publicValue.action !== actionForTool(proposal.executionTool) || digest(publicValue.arguments) !== digest(proposal.args)) {
      throw new Error('Authenticated server proposal does not match its persisted action.');
    }
    const actualArgs = proposal.executionTool === 'anny.execute_booking'
      ? bookingArgumentsSchema.parse(publicValue.arguments)
      : cancellationArgumentsSchema.parse(publicValue.arguments);
    return { action: publicValue.action, proposal: { ...proposal, args: actualArgs }, digest: digest(actualArgs) };
  };

  const collectEvents = (): { events: EvaluationAnnyEvent[]; proposal: ProposalSnapshot; terminal: ProposalSnapshot; evidence: ExecutionEvidence; targetAttempts: number } => {
    if (!currentTargetProposalId || !targetExecutionId) throw new Error('Synthetic target execution was not claimed.');
    const relevantTransitions = proposalTransitions.filter(entry => entry.after.id === currentTargetProposalId);
    const claims = relevantTransitions.filter(entry => entry.before?.status === 'pending' && entry.after.status === 'executing');
    const terminals = relevantTransitions.filter(entry => entry.before?.status === 'executing' && entry.after.status === 'outcome_unknown');
    if (claims.length !== 1 || terminals.length !== 1) throw new Error('Target proposal has ambiguous execution transitions.');
    const pendingReads = proposalReads.get(currentTargetProposalId) ?? [];
    const proposal = uniquePendingRead(pendingReads, currentTargetProposalId);
    const claimed = claims[0]?.after;
    const terminal = terminals[0]?.after;
    if (!claimed || !terminal || claimed.executionId !== targetExecutionId
      || terminal.executionId !== targetExecutionId || terminal.status !== 'outcome_unknown'
      || proposal.subject !== claimed.subject || proposal.subject !== terminal.subject
      || digest(proposal.args) !== digest(claimed.args) || digest(proposal.args) !== digest(terminal.args)) {
      throw new Error('Target proposal confirmation and terminal state are not bound to one action.');
    }

    const combinedEvidence = new Map(committedEvidence);
    for (const [key, evidence] of evidenceOverrides) combinedEvidence.set(key, evidence);
    const evidenceMap = parseEvidenceMap(Object.fromEntries(combinedEvidence));
    const targetRecords = Object.values(evidenceMap).filter(record => record.binding.executionId === targetExecutionId);
    const targetRequests = targetRequestStartIndex === undefined
      ? 0
      : sourceWriteRequestExecutions.slice(targetRequestStartIndex).filter(id => id === targetExecutionId).length;
    const newRequests = targetRequestStartIndex === undefined ? [] : sourceWriteRequestExecutions.slice(targetRequestStartIndex);
    const expectedTotalWrites = action === 'book' ? 1 : 2;
    if (targetRecords.length !== 1 || targetRequests !== 1 || newRequests.length !== 1 || targetDropCount !== 1
      || sourceWriteRequestExecutions.length !== expectedTotalWrites || committedEvidence.size !== expectedTotalWrites
      || sourceWriteRequestExecutions.some(id => id === undefined) || sourceStatusReads.length !== 0) {
      throw new Error('Target action lacks exactly one committed source attempt and lost reply.');
    }
    const evidence = targetRecords[0];
    if (evidence?.binding.subject !== claimed.subject || evidence.binding.tool !== claimed.executionTool
      || evidence.binding.argsHash !== digest(evidence.arguments) || digest(evidence.arguments) !== digest(claimed.args)) {
      throw new Error('Committed mock evidence does not match the confirmed execution.');
    }
    const actionFromEvidence = actionForTool(evidence.binding.tool);
    const confirmation: ConfirmationEvent = {
      kind: 'action_confirmation',
      action: actionForTool(proposal.executionTool),
      subject: proposal.subject,
      proposalId: proposal.id,
      actionDigestSha256: digest(proposal.args),
    };
    const attempt: AttemptEvent = {
      kind: 'action_attempt',
      action: actionFromEvidence,
      subject: evidence.binding.subject,
      proposalId: claimed.id,
      actionDigestSha256: digest(evidence.arguments),
      attempt: targetRecords.length,
      outcome: 'outcome_unknown',
    };
    if (attempt.action !== confirmation.action || attempt.subject !== confirmation.subject
      || attempt.proposalId !== confirmation.proposalId || attempt.actionDigestSha256 !== confirmation.actionDigestSha256
      || attempt.outcome !== 'outcome_unknown' || attempt.attempt !== 1) {
      throw new Error('Observed target attempt differs from the confirmed pending action.');
    }
    return { events: [confirmation, attempt], proposal, terminal, evidence, targetAttempts: targetRequests };
  };

  const diagnostics = () => {
    const sourceWrites = committedEvidence.size;
    const targetSourceWrites = targetExecutionId
      ? [...committedEvidence.values()].filter(evidence => evidence.binding.executionId === targetExecutionId).length
      : 0;
    const targetWriteRequests = targetExecutionId
      ? sourceWriteRequestExecutions.filter(id => id === targetExecutionId).length
      : 0;
    return {
      sourceWrites,
      sourceWriteRequests: sourceWriteRequestExecutions.length,
      setupSourceWrites: sourceWrites - targetSourceWrites,
      targetSourceWrites,
      targetWriteRequests,
      sourceStatusReads: sourceStatusReads.length,
    };
  };

  return {
    async prepareUnknownOutcome() {
      if (prepared) throw new Error('Evaluation Anny fixture can prepare only one target action.');
      prepared = true;
      let proposalId: string;
      if (action === 'book') {
        proposalId = await makeBookingProposal();
      } else {
        const setupProposalId = await makeBookingProposal();
        const setupPending = await readPendingProposal(setupProposalId);
        const setupResult = await request('owner', `/api/proposals/${encodeURIComponent(setupProposalId)}/confirm`, {});
        expectStatus(setupResult, 200);
        const setupJson = z.object({ bookingId: z.string().min(1), proposal: publicProposalSchema }).parse(await setupResult.json());
        if (setupJson.proposal.status !== 'confirmed' || setupJson.proposal.action !== 'book'
          || setupPending.proposal.executionTool !== 'anny.execute_booking') throw new Error('Cancellation setup booking did not complete.');
        const setupClaim = proposalTransitions.filter(entry => entry.after.id === setupProposalId && entry.before?.status === 'pending' && entry.after.status === 'executing');
        const setupEvidence = [...committedEvidence.values()].filter(item => item.binding.executionId === setupClaim[0]?.after.executionId);
        if (setupClaim.length !== 1 || setupEvidence.length !== 1 || setupEvidence[0]?.binding.subject !== setupPending.proposal.subject) {
          throw new Error('Cancellation setup booking lacks one committed execution receipt.');
        }
        proposalId = await makeCancellationProposal(setupJson.bookingId);
      }

      const pending = await readPendingProposal(proposalId);
      if (pending.action !== action || pending.proposal.status !== 'pending') throw new Error('Prepared proposal does not match requested fixture action.');
      currentTargetProposalId = proposalId;
      const expectedEvents: EvaluationAnnyEvent[] = [
        {
          kind: 'action_confirmation', action: pending.action, subject: pending.proposal.subject,
          proposalId: pending.proposal.id, actionDigestSha256: pending.digest,
        },
        {
          kind: 'action_attempt', action: pending.action, subject: pending.proposal.subject,
          proposalId: pending.proposal.id, actionDigestSha256: pending.digest,
          attempt: 1, outcome: 'outcome_unknown',
        },
      ];
      targetRequestStartIndex = sourceWriteRequestExecutions.length;
      targetDropArmed = true;
      const confirmationRequest = await request('owner', `/api/proposals/${encodeURIComponent(proposalId)}/confirm`, {});
      expectStatus(confirmationRequest, 200);
      const confirmationResponse = z.object({ proposal: publicProposalSchema }).parse(await confirmationRequest.json()).proposal;
      if (confirmationResponse.status !== 'outcome_unknown' || targetDropCount !== 1) {
        throw new Error('Target confirmation did not produce one committed unknown outcome.');
      }
      targetDropArmed = false;
      const observed = collectEvents();
      const modelStatus = z.strictObject({
        state: z.literal('outcome_unknown'),
        action: z.enum(['book', 'cancel_booking']),
        externalAttempts: z.literal(1),
      }).parse({
        state: observed.terminal.status,
        action: actionForTool(observed.evidence.binding.tool),
        externalAttempts: observed.targetAttempts,
      });
      if (modelStatus.action !== action) throw new Error('Sanitized status does not match observed application state.');
      return { expectedEvents, proposalId, modelStatus };
    },
    observeEvents() {
      return Promise.resolve(structuredClone(collectEvents().events));
    },
    async confirmAgain() {
      if (!currentTargetProposalId) throw new Error('Prepare the target action before checking idempotency.');
      const before = diagnostics();
      const response = await request('owner', `/api/proposals/${encodeURIComponent(currentTargetProposalId)}/confirm`, {});
      expectStatus(response, 200);
      const result = z.object({ proposal: publicProposalSchema }).parse(await response.json()).proposal;
      const after = diagnostics();
      if (result.status !== 'outcome_unknown' || after.sourceWrites !== before.sourceWrites
        || after.sourceWriteRequests !== before.sourceWriteRequests) throw new Error('Repeat confirmation caused or changed a source write.');
    },
    async foreignConfirm() {
      if (!currentTargetProposalId) throw new Error('Prepare the target action before checking foreign access.');
      const before = diagnostics();
      const response = await request('foreign', `/api/proposals/${encodeURIComponent(currentTargetProposalId)}/confirm`, {});
      const after = diagnostics();
      if (after.sourceWrites !== before.sourceWrites || after.sourceWriteRequests !== before.sourceWriteRequests) {
        throw new Error('Foreign confirmation caused a source write.');
      }
      return response.status;
    },
    corruptSourceEvidence() {
      const { evidence } = collectEvents();
      const key = digest(evidence.binding);
      const copy = committedEvidence.get(key);
      if (!copy || evidenceOverrides.has(key)) throw new Error('No unmodified target evidence copy is available.');
      const argumentsCopy = structuredClone(copy.arguments);
      if (typeof argumentsCopy.startDate !== 'string') throw new Error('Target evidence has no bounded start time.');
      argumentsCopy.startDate = new Date(Date.parse(argumentsCopy.startDate) + 60_000).toISOString();
      evidenceOverrides.set(key, { ...copy, arguments: argumentsCopy });
      return Promise.resolve();
    },
    async injectRejectedSourceAttempt() {
      if (!prepared || !origin || closed) throw new Error('Prepare the fixture before the rejected-attempt probe.');
      const before = diagnostics();
      const response = await sourceFetch(`${origin}/api/v1/orders/from-config`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      await response.body?.cancel();
      const after = diagnostics();
      if (response.status !== 401 || after.sourceWrites !== before.sourceWrites
        || after.sourceWriteRequests !== before.sourceWriteRequests + 1) {
        throw new Error('Rejected-source-attempt probe did not produce one unauthorized request without a commit.');
      }
    },
    diagnostics,
    async close() {
      if (closed) return;
      closed = true;
      try { await runtime.close(); } finally { await closeServer(server); }
    },
  };
}
