import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { knowledgeDocumentV2Schema } from '../apps/knowledge-plugin/src/institutional-contracts.js';

const ORIGIN = 'https://hasi.metaneutrons.cc';
const WORKSPACE = '__Host-hasi-demo-workspace';
const SESSION = '__Host-hasi-session';
const PLUGIN = 'de.hsh.hasi.knowledge';
const MAX_BYTES = 128 * 1024;
const syntheticDocument = knowledgeDocumentV2Schema.refine(value => value.synthetic && value.dataClass === 'synthetic_demo');
type Jar = Map<string, string>;
class QualificationFailure extends Error {}
function assert(condition: unknown, category: string): asserts condition {
  if (!condition) throw new QualificationFailure(category);
}

async function boundedText(response: Response): Promise<string> {
  const reader: ReadableStreamDefaultReader<unknown> | undefined = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      assert(chunk.value instanceof Uint8Array, 'response_chunk_invalid');
      size += chunk.value.byteLength;
      assert(size <= MAX_BYTES, 'response_size_exceeded');
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel(); }
}

/** Fixed synthetic public demo only; session values are never returned or logged. */
export async function qualifyDemoKnowledge(input: {
  enabled: boolean; expectedRevision: string; fetcher?: typeof fetch;
}): Promise<Record<string, unknown>> {
  assert(input.enabled, 'explicit_opt_in_required');
  assert(/^[a-f0-9]{40}$/u.test(input.expectedRevision), 'exact_revision_required');
  assert(process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0', 'tls_verification_required');
  const fetcher = input.fetcher ?? fetch;
  const jars: Jar[] = [];
  const attemptedLogins = new Set<Jar>();
  const checks: Record<string, boolean> = {};
  let cleanupVerified = true;
  let failure: string | undefined;
  let requests = 0;
  const request = async (path: string, jar?: Jar, body?: unknown) => {
    assert(path.startsWith('/api/') && !path.startsWith('//') && !path.includes('#'), 'fixed_api_path_required');
    if (path === '/api/dev/login' && jar) attemptedLogins.add(jar);
    const response = await fetcher(ORIGIN + path, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000),
      headers: { accept: 'application/json', ...(body === undefined ? {} : { origin: ORIGIN, 'content-type': 'application/json' }),
        ...(jar?.size ? { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; ') } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    requests += 1;
    try {
      let cookiesValid = true;
      if (jar) for (const cookie of response.headers.getSetCookie()) {
        const pair = /^([^=;]+)=([^;]*)/u.exec(cookie);
        const name = pair?.[1]; const value = pair?.[2];
        const knownPair = typeof name === 'string' && typeof value === 'string' && [WORKSPACE, SESSION].includes(name);
        if (!knownPair) { cookiesValid = false; continue; }
        // Collect bounded same-origin cleanup credentials even if flags are
        // invalid; no document request follows a failed boundary check.
        if (/;\s*Max-Age=0(?:;|$)/iu.test(cookie) || value === '') { jar.delete(name); continue; }
        if ((name === SESSION ? /^[A-Za-z0-9_-]{43}$/u : /^[A-Za-z0-9_.-]{16,2048}$/u).test(value)) jar.set(name, value);
        else cookiesValid = false;
        if (!/;\s*Secure(?:;|$)/iu.test(cookie) || !/;\s*HttpOnly(?:;|$)/iu.test(cookie)
          || !/;\s*SameSite=Strict(?:;|$)/iu.test(cookie) || !/;\s*Path=\/(?:;|$)/iu.test(cookie) || /;\s*Domain=/iu.test(cookie)) cookiesValid = false;
      }
      assert(cookiesValid, 'demo_cookie_boundary_invalid');
    } catch (error) { await response.body?.cancel(); throw error; }
    const text = await boundedText(response);
    return { status: response.status, headers: response.headers, json: () => JSON.parse(text) as unknown };
  };
  const health = async () => {
    const response = await request('/api/health');
    assert(response.status === 200, 'demo_health_failed');
    const value = z.object({ status: z.literal('ready'), revision: z.literal(input.expectedRevision) }).safeParse(response.json());
    assert(value.success, 'demo_revision_changed');
  };
  const document = async (jar: Jar, id: string) => {
    const response = await request(`/api/knowledge/documents/${id}`, jar);
    assert(response.status === 200, 'allowed_document_missing');
    const value = z.object({ document: knowledgeDocumentV2Schema }).parse(response.json()).document;
    assert(value.synthetic && value.id === id && value.dataClass === 'synthetic_demo', 'non_synthetic_document_returned');
    assert(value.citationId === `knowledge:${value.sourceSystem}:${id}:${String(value.revision)}`
      && Number.isFinite(Date.parse(value.updatedAt)) && Number.isFinite(Date.parse(value.fetchedAt))
      && Date.parse(value.fetchedAt) <= Date.now() + 30_000, 'citation_or_freshness_invalid');
    return value;
  };
  const search = async (jar: Jar, query: string, sourceSystem: 'service_it' | 'intranet') => {
    const response = await request('/api/tools/call', jar, { pluginId: PLUGIN, name: 'knowledge.search', arguments: { query, sourceSystem, limit: 3 } });
    assert(response.status === 200, 'knowledge_search_failed');
    return z.strictObject({ documents: z.array(syntheticDocument.refine(value => value.sourceSystem === sourceSystem)).max(3), contextId: z.uuid() }).parse(response.json());
  };

  try {
    await health();
    const student: Jar = new Map(); jars.push(student);
    const login = await request('/api/dev/login', student, { personaId: 'student' });
    assert(login.status === 200 && student.has(WORKSPACE) && student.has(SESSION), 'synthetic_login_failed');
    assert(z.object({ mode: z.literal('public-demo'), user: z.object({ role: z.literal('student') }) }).safeParse(login.json()).success, 'synthetic_mode_required');
    const sharedWorkspace = student.get(WORKSPACE);
    assert(sharedWorkspace !== undefined, 'demo_workspace_missing');
    const employee: Jar = new Map([[WORKSPACE, sharedWorkspace]]); jars.push(employee);
    const staffLogin = await request('/api/dev/login', employee, { personaId: 'employee' });
    assert(staffLogin.status === 200 && employee.has(SESSION), 'synthetic_staff_login_failed');
    assert(z.object({ mode: z.literal('public-demo'), user: z.object({ role: z.literal('employee') }) }).safeParse(staffLogin.json()).success, 'synthetic_mode_required');
    assert(employee.get(WORKSPACE) === sharedWorkspace && employee.get(SESSION) !== student.get(SESSION), 'same_workspace_separate_sessions_required');
    checks.separateSubjectsInSameWorkspace = true;
    const publicDocument = await document(student, 'svc-001');
    const english = await document(student, 'svc-025');
    const internal = await document(employee, 'int-006');
    assert(publicDocument.language === 'de' && english.language === 'en' && internal.sourceSystem === 'intranet', 'source_language_mismatch');
    checks.germanEnglishDocumentsAndFreshnessFields = true;
    const englishSearch = await search(student, 'Toolgarden', 'service_it');
    assert(englishSearch.documents.some(value => value.id === english.id), 'english_search_missed_fixture');
    const internalSearch = await search(employee, 'Taktstein', 'intranet');
    assert(internalSearch.documents.some(value => value.id === internal.id), 'staff_search_missed_fixture');
    checks.authorizedSearchAndCitations = true;
    const deniedSearch = await search(student, 'Taktstein', 'intranet');
    assert(deniedSearch.documents.length === 0, 'private_search_leak');
    const deniedContext = await request('/api/knowledge/contexts/resolve', student, { contextIds: [deniedSearch.contextId] });
    const emptyContext = z.strictObject({ contextId: z.literal(deniedSearch.contextId), status: z.literal('valid'),
      documents: z.array(z.never()).length(0), dataClasses: z.array(z.never()).length(0) });
    const unavailableContext = z.strictObject({ contextId: z.literal(deniedSearch.contextId), status: z.literal('unavailable') });
    assert(deniedContext.status === 200 && z.strictObject({ contexts: z.array(z.union([emptyContext, unavailableContext])).length(1) })
      .safeParse(deniedContext.json()).success, 'private_search_context_leak');
    for (const [jar, id] of [[student, 'int-006'], [employee, 'int-030']] as const) {
      const denied = await request(`/api/knowledge/documents/${id}`, jar);
      assert(denied.status === 404 && z.strictObject({ error: z.literal('Dokument nicht verfügbar oder nicht freigegeben.') }).safeParse(denied.json()).success, 'private_document_leak');
    }
    checks.sourceAudienceDenials = true;
    const resolved = await request('/api/knowledge/contexts/resolve', employee, { contextIds: [internalSearch.contextId] });
    assert(resolved.status === 200, 'own_context_unavailable');
    const ownContext = z.strictObject({ contexts: z.array(z.strictObject({ contextId: z.literal(internalSearch.contextId),
      status: z.literal('valid'), documents: z.array(syntheticDocument.refine(value => value.sourceSystem === 'intranet')).max(3),
      dataClasses: z.array(z.literal('synthetic_demo')).length(1),
    })).length(1) }).parse(resolved.json());
    assert(ownContext.contexts[0]?.documents.some(value => value.id === internal.id), 'own_context_document_missing');
    const foreign = await request('/api/knowledge/contexts/resolve', student, { contextIds: [internalSearch.contextId] });
    assert(foreign.status === 200 && z.strictObject({ contexts: z.array(z.strictObject({
      contextId: z.literal(internalSearch.contextId), status: z.literal('unavailable'),
    })).length(1) }).safeParse(foreign.json()).success, 'foreign_context_leak');
    checks.subjectBoundContexts = true;
    assert((await request(`/api/knowledge/documents/svc-001?revision=${String(publicDocument.revision + 1)}`, student)).status === 404, 'wrong_revision_accepted');
    checks.wrongRevisionDenied = true;
    const demoSource = await request(`/api/knowledge/documents/svc-001/demo-source?revision=${String(publicDocument.revision)}`, student);
    assert(demoSource.status === 302 && demoSource.headers.get('location') === 'https://service-it.hasi.metaneutrons.cc/de/faqs/svc-001/', 'reviewed_html_source_not_linked');
    checks.reviewedHtmlSourceLink = true;
    await health(); checks.exactRevisionStable = true;
  } catch (error) { failure = error instanceof QualificationFailure ? error.message : 'demo_knowledge_qualification_failed'; }
  finally {
    for (const jar of jars) {
      const originalWorkspace = jar.get(WORKSPACE);
      if (!attemptedLogins.has(jar) || !originalWorkspace || !jar.has(SESSION)) { cleanupVerified = false; jar.clear(); continue; }
      const previous = new Map(jar);
      try {
        const before = await request('/api/session', jar);
        assert(before.status === 200 && z.object({ mode: z.literal('public-demo'), user: z.object({ role: z.enum(['student', 'employee']) }) }).safeParse(before.json()).success
          && jar.get(WORKSPACE) === originalWorkspace, 'original_session_not_verified');
      } catch { cleanupVerified = false; }
      try { assert((await request('/api/logout', jar, {})).status === 200, 'logout_failed'); } catch { cleanupVerified = false; }
      try {
        const after = await request('/api/knowledge/documents/svc-001', previous);
        assert(after.status === 401 && previous.get(WORKSPACE) === originalWorkspace
          && z.strictObject({ error: z.literal('Bitte wähle zuerst ein Testkonto.') }).safeParse(after.json()).success, 'old_session_still_authorized');
      } catch { cleanupVerified = false; }
      jar.clear();
    }
  }
  return { qualification: 'public-synthetic-demo-knowledge', qualified: !failure && cleanupVerified,
    expectedRevision: input.expectedRevision, checks, requests, modelCalls: 0, cleanupVerified,
    ...(failure ? { blocker: failure } : !cleanupVerified ? { blocker: 'session_cleanup_unconfirmed' } : {}),
    retainedState: 'Synthetic workspace/context records retain the normal demo TTL. Login/logout use the deployed session store.',
    sessionCleanup: attemptedLogins.size === 0 ? 'No login was attempted.' : cleanupVerified
      ? 'Observed sessions were authenticated before logout and rejected afterward.'
      : 'Session invalidation could not be confirmed for every attempted login.',
    institutionalAcceptance: false, signedInstitutionalSourceAcceptance: false };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await qualifyDemoKnowledge({ enabled: process.env.HASI_DEMO_KNOWLEDGE_QUALIFY === '1', expectedRevision: process.env.HASI_EXPECTED_REVISION ?? '' });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.qualified !== true) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ qualified: false, blocker: error instanceof QualificationFailure ? error.message : 'demo_knowledge_qualification_failed' })}\n`);
    process.exitCode = 1;
  }
}
