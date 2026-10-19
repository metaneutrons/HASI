import { afterEach, describe, expect, it, vi } from 'vitest';
import { qualifyDemoKnowledge } from '../scripts/qualify-demo-knowledge.js';

const REVISION = 'a'.repeat(40);
const workspaceCookie = '__Host-hasi-demo-workspace';
const sessionCookie = '__Host-hasi-session';
const studentToken = 's'.repeat(43);
const employeeToken = 'e'.repeat(43);
afterEach(() => { vi.unstubAllEnvs(); });
function fixture(id: string) {
  const sourceSystem = id.startsWith('svc-') ? 'service_it' : 'intranet';
  return { id, citationId: `knowledge:${sourceSystem}:${id}:1`, title: 'Synthetic qualification example',
    sourceSystem, language: id === 'svc-025' ? 'en' : 'de', revision: 1, synthetic: true,
    text: 'Synthetic fixture body.', updatedAt: '2026-10-19T00:00:00Z', fetchedAt: '2026-10-19T00:00:00Z',
    authorityRevision: 'b'.repeat(64), corpusRevision: 'c'.repeat(64), dataClass: 'synthetic_demo', images: [] };
}

function transport(options: { leakContext?: boolean; revision?: string; missingCookieFlag?: boolean;
  omitSession?: boolean; ignoreLogout?: boolean; changeWorkspace?: boolean; leakSearch?: boolean; missingSameSite?: boolean; mixedInstitutional?: boolean; leakDeniedContext?: boolean } = {}) {
  const calls: { path: string; method: string; cookie: string }[] = [];
  const revoked = new Set<string>();
  const json = (value: unknown, status = 200, headers?: Headers) => new Response(JSON.stringify(value), { status, ...(headers ? { headers } : {}) });
  const fetcher: typeof fetch = (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    expect(url.origin).toBe('https://hasi.metaneutrons.cc');
    const cookie = request.headers.get('cookie') ?? '';
    calls.push({ path: url.pathname, method: request.method, cookie });
    return (async () => {
      if (url.pathname === '/api/health') return json({ status: 'ready', revision: options.revision ?? REVISION });
      if (url.pathname === '/api/dev/login') {
        const { personaId } = await request.json() as { personaId: string };
        const headers = new Headers();
        const flags = `; Secure; Path=/${options.missingSameSite ? '' : '; SameSite=Strict'}${options.missingCookieFlag ? '' : '; HttpOnly'}`;
        headers.append('set-cookie', `${workspaceCookie}=${options.changeWorkspace && personaId === 'employee' ? 'synthetic-different-workspace' : 'synthetic-workspace-value'}${flags}`);
        if (!options.omitSession) headers.append('set-cookie', `${sessionCookie}=${personaId === 'employee' ? employeeToken : studentToken}${flags}`);
        return json({ mode: 'public-demo', user: { role: personaId } }, 200, headers);
      }
      const session = /__Host-hasi-session=([^;]+)/u.exec(cookie)?.[1];
      if (url.pathname === '/api/logout') {
        if (session && !options.ignoreLogout) revoked.add(session);
        return json({ ok: true }, 200, new Headers({ 'set-cookie': `${sessionCookie}=; Path=/; Secure; Expires=Thu, 01 Jan 1970 00:00:00 GMT` }));
      }
      const employee = session === employeeToken;
      if (url.pathname === '/api/session') return json({ mode: 'public-demo', user: session && !revoked.has(session) ? { role: employee ? 'employee' : 'student' } : null });
      if (!session || revoked.has(session)) return json({ error: 'Bitte wähle zuerst ein Testkonto.' }, 401);
      if (url.pathname === '/api/tools/call') {
        const body = await request.json() as { name: string; arguments: { sourceSystem: string } };
        expect(body.name).toBe('knowledge.search');
        const internal = body.arguments.sourceSystem === 'intranet';
        return json({ documents: internal ? employee ? [fixture('int-006')] : [] : [fixture('svc-025'),
          ...(options.mixedInstitutional ? [{ ...fixture('svc-099'), synthetic: false, dataClass: 'internal', canonicalUrl: 'https://source.example.edu/private' }] : [])],
          ...(internal && !employee && options.leakSearch ? { leakedDocuments: [fixture('int-006')] } : {}),
          contextId: internal && employee ? '00000000-0000-4000-8000-000000000001' : '00000000-0000-4000-8000-000000000002' });
      }
      if (url.pathname === '/api/knowledge/contexts/resolve') {
        const { contextIds } = await request.json() as { contextIds: string[] };
        if (options.leakDeniedContext && !employee && contextIds[0]?.endsWith('2')) return json({ contexts: [{
          contextId: contextIds[0], status: 'valid', documents: [fixture('int-006')], dataClasses: ['synthetic_demo'],
        }] });
        return json({ contexts: [{ contextId: contextIds[0], status: employee ? 'valid' : 'unavailable',
          ...(employee ? { dataClasses: ['synthetic_demo'] } : {}),
          ...(employee || options.leakContext && contextIds[0]?.endsWith('1') ? { documents: [fixture('int-006')] } : {}) }] });
      }
      if (url.pathname.endsWith('/demo-source')) return new Response(null, { status: 302,
        headers: { location: 'https://service-it.hasi.metaneutrons.cc/de/faqs/svc-001/' } });
      if (url.pathname.startsWith('/api/knowledge/documents/')) {
        const id = url.pathname.split('/').at(-1) ?? '';
        if (url.search || id === 'int-030' || id === 'int-006' && !employee) return json({ error: 'Dokument nicht verfügbar oder nicht freigegeben.' }, 404);
        return json({ document: fixture(id) });
      }
      throw new Error('Unexpected qualification request.');
    })();
  };
  return { fetcher, calls };
}

describe('public demo knowledge qualification boundaries', () => {
  it('accepts the complete synthetic journey with zero chat/provider requests', async () => {
    const { fetcher, calls } = transport();
    const result = await qualifyDemoKnowledge({ enabled: true, expectedRevision: REVISION, fetcher });
    expect(result).toMatchObject({ qualified: true, cleanupVerified: true, requests: 23, modelCalls: 0,
      institutionalAcceptance: false, signedInstitutionalSourceAcceptance: false });
    expect(calls.filter(value => value.path === '/api/logout')).toHaveLength(2);
    const logins = calls.filter(value => value.path === '/api/dev/login');
    expect(logins[1]?.cookie).toContain(workspaceCookie);
    expect(logins[1]?.cookie).not.toContain(sessionCookie);
    expect(JSON.stringify(result)).not.toContain(studentToken);
    expect(JSON.stringify(result)).not.toContain(employeeToken);
    expect(JSON.stringify(result)).not.toContain('synthetic-workspace-value');
  });

  it('rejects unavailable status accompanied by leaked content and still logs out both sessions', async () => {
    const { fetcher, calls } = transport({ leakContext: true });
    const result = await qualifyDemoKnowledge({ enabled: true, expectedRevision: REVISION, fetcher });
    expect(result).toMatchObject({ qualified: false, blocker: 'foreign_context_leak', cleanupVerified: true });
    expect(calls.filter(value => value.path === '/api/logout')).toHaveLength(2);
  });

  it('rejects unsafe session cookies before proceeding to document reads', async () => {
    const { fetcher, calls } = transport({ missingCookieFlag: true });
    const result = await qualifyDemoKnowledge({ enabled: true, expectedRevision: REVISION, fetcher });
    expect(result).toMatchObject({ qualified: false, blocker: 'demo_cookie_boundary_invalid', cleanupVerified: true });
    expect(calls.filter(value => value.path === '/api/logout')).toHaveLength(1);
    expect(calls.filter(value => value.path.startsWith('/api/knowledge/documents/'))).toHaveLength(1); // Old-session denial probe only.
  });

  it('requires explicit opt-in and exact revision before any network I/O', async () => {
    const { fetcher, calls } = transport();
    await expect(qualifyDemoKnowledge({ enabled: false, expectedRevision: REVISION, fetcher })).rejects.toThrow('explicit_opt_in_required');
    await expect(qualifyDemoKnowledge({ enabled: true, expectedRevision: 'main', fetcher })).rejects.toThrow('exact_revision_required');
    expect(calls).toEqual([]);
  });

  it('rejects a different deployment before creating a demo workspace', async () => {
    const { fetcher, calls } = transport({ revision: 'd'.repeat(40) });
    expect(await qualifyDemoKnowledge({ enabled: true, expectedRevision: REVISION, fetcher }))
      .toMatchObject({ qualified: false, blocker: 'demo_revision_changed', sessionCleanup: 'No login was attempted.' });
    expect(calls.map(value => value.path)).toEqual(['/api/health']);
  });

  it('refuses to qualify when TLS verification is disabled', async () => {
    const { fetcher, calls } = transport();
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0');
    await expect(qualifyDemoKnowledge({ enabled: true, expectedRevision: REVISION, fetcher })).rejects.toThrow('tls_verification_required');
    expect(calls).toEqual([]);
  });

  it('does not claim cleanup for an attempted login whose session was never observed', async () => {
    const { fetcher } = transport({ omitSession: true });
    expect(await qualifyDemoKnowledge({ enabled: true, expectedRevision: REVISION, fetcher }))
      .toMatchObject({ qualified: false, blocker: 'synthetic_login_failed', cleanupVerified: false });
  });

  it('does not accept a logout acknowledgement while the old session is still authorized', async () => {
    const { fetcher } = transport({ ignoreLogout: true });
    expect(await qualifyDemoKnowledge({ enabled: true, expectedRevision: REVISION, fetcher }))
      .toMatchObject({ qualified: false, blocker: 'session_cleanup_unconfirmed', cleanupVerified: false });
  });

  it('rejects a changed employee workspace instead of claiming same-workspace isolation', async () => {
    const { fetcher } = transport({ changeWorkspace: true });
    const result = await qualifyDemoKnowledge({ enabled: true, expectedRevision: REVISION, fetcher });
    expect(result).toMatchObject({ qualified: false, blocker: 'same_workspace_separate_sessions_required' });
    expect(result.checks).not.toHaveProperty('separateSubjectsInSameWorkspace');
  });

  it('rejects extra denied-search payload rather than stripping a private document leak', async () => {
    const { fetcher } = transport({ leakSearch: true });
    expect(await qualifyDemoKnowledge({ enabled: true, expectedRevision: REVISION, fetcher }))
      .toMatchObject({ qualified: false, blocker: 'demo_knowledge_qualification_failed', cleanupVerified: true });
  });

  it('rejects newly issued cookies without the strict SameSite boundary', async () => {
    const { fetcher } = transport({ missingSameSite: true });
    expect(await qualifyDemoKnowledge({ enabled: true, expectedRevision: REVISION, fetcher }))
      .toMatchObject({ qualified: false, blocker: 'demo_cookie_boundary_invalid', cleanupVerified: true });
  });

  it('rejects institutional content mixed into a synthetic public-demo result', async () => {
    const { fetcher } = transport({ mixedInstitutional: true });
    expect(await qualifyDemoKnowledge({ enabled: true, expectedRevision: REVISION, fetcher }))
      .toMatchObject({ qualified: false, blocker: 'demo_knowledge_qualification_failed', cleanupVerified: true });
  });

  it('rejects an empty denied search that issues a context containing private content', async () => {
    const { fetcher } = transport({ leakDeniedContext: true });
    expect(await qualifyDemoKnowledge({ enabled: true, expectedRevision: REVISION, fetcher }))
      .toMatchObject({ qualified: false, blocker: 'private_search_context_leak', cleanupVerified: true });
  });
});
