import { describe, expect, it } from 'vitest';
import {
  controllerStep,
  parseGitSmartAdvertisement,
  parseOperatorConfig,
  selectTrustedRun,
  validateJournal,
  verifySuccessfulJobs,
  type ControllerIo,
  type DeploymentJournal,
} from '../scripts/deploy/controller.js';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const APP_UUID = 'tjzdwweelb3zhjtfpgzvjs8k';
const DEPLOYMENT_UUID = 'deployment-12345678';
const TOKEN = 'test-only-token';
const REQUIRED = [
  'CI Success',
  'Quality (Node 24)',
  'Quality (Node 26)',
  'Secrets and dependency advisories',
];

function pktLine(value: string): string {
  const size = new TextEncoder().encode(value).length + 4;
  return `${size.toString(16).padStart(4, '0')}${value}`;
}

function gitAdvertisement(sha = SHA): string {
  return [
    pktLine('# service=git-upload-pack\n'),
    '0000',
    pktLine(`${sha} HEAD\0symref=HEAD:refs/heads/main\n`),
    pktLine(`${sha} refs/heads/main\n`),
    '0000',
  ].join('');
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: 12345,
    run_attempt: 1,
    run_number: 87,
    workflow_id: 386428207,
    path: '.github/workflows/ci.yml',
    event: 'push',
    head_branch: 'main',
    head_sha: SHA,
    status: 'completed',
    conclusion: 'success',
    repository: { id: 1421798810 },
    head_repository: { id: 1421798810 },
    ...overrides,
  };
}

function jobs(attempt = 1) {
  return {
    total_count: 5,
    jobs: [
      ...REQUIRED.map((name) => ({ name, run_attempt: attempt, status: 'completed', conclusion: 'success' })),
      { name: 'Commit hygiene', run_attempt: attempt, status: 'completed', conclusion: 'skipped' },
    ],
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

interface Harness {
  io: ControllerIo;
  calls: { url: string; method: string; body: unknown; authorization: string | undefined }[];
  getJournal: () => DeploymentJournal;
  writes: DeploymentJournal[];
  setMainSequence: (values: string[]) => void;
}

function harness(handler?: (request: Harness['calls'][number], index: number) => Promise<Response> | Response): Harness {
  let journal: DeploymentJournal = { version: 1, records: [] };
  let mainSequence = [SHA];
  let mainReads = 0;
  const writes: DeploymentJournal[] = [];
  const calls: Harness['calls'] = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    const headers = new Headers(init?.headers);
    let body: unknown;
    if (typeof init?.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    const call = { url, method: init?.method ?? 'GET', body, authorization: headers.get('authorization') ?? undefined };
    calls.push(call);
    const index = calls.length - 1;
    if (handler) return await handler(call, index);
    if (url.startsWith('https://github.com/metaneutrons/HASI.git/info/refs?')) {
      const next = mainSequence[Math.min(mainReads, mainSequence.length - 1)];
      mainReads += 1;
      return new Response(gitAdvertisement(next), { status: 200 });
    }
    if (url.includes('/actions/workflows/386428207/runs?')) return jsonResponse({ workflow_runs: [run()] });
    if (url.includes('/actions/runs/12345/attempts/1/jobs?')) return jsonResponse(jobs());
    if (url === 'http://127.0.0.1:8000/api/v1/applications/' + APP_UUID) {
      return call.method === 'PATCH'
        ? jsonResponse({ ok: true })
        : jsonResponse({
          git_repository: 'metaneutrons/HASI',
          git_branch: 'main',
          git_commit_sha: SHA,
          settings: { is_auto_deploy_enabled: false },
        });
    }
    if (url === 'http://127.0.0.1:8000/api/v1/deploy') {
      return jsonResponse({ deployments: [{ resource_uuid: APP_UUID, deployment_uuid: DEPLOYMENT_UUID }] });
    }
    if (url === `http://127.0.0.1:8000/api/v1/deployments/${DEPLOYMENT_UUID}`) {
      return jsonResponse({ deployment_uuid: DEPLOYMENT_UUID, commit: SHA, status: 'in_progress' });
    }
    return new Response('', { status: 404 });
  };
  return {
    io: {
      fetch: fakeFetch,
      readJournal: () => Promise.resolve(structuredClone(journal)),
      writeJournal: (value) => {
        journal = structuredClone(value);
        writes.push(structuredClone(value));
        return Promise.resolve();
      },
      now: () => new Date('2026-10-18T12:00:00.000Z'),
    },
    calls,
    getJournal: () => structuredClone(journal),
    writes,
    setMainSequence(values) { mainSequence = values; mainReads = 0; },
  };
}

describe('Coolify deployment controller gates', () => {
  it('parses the exact main ref from a bounded Git smart advertisement', () => {
    expect(parseGitSmartAdvertisement(gitAdvertisement())).toBe(SHA);
    expect(() => parseGitSmartAdvertisement(gitAdvertisement().slice(0, -4))).toThrow('git_advertisement_invalid');
    expect(() => parseGitSmartAdvertisement(gitAdvertisement().replace(`${SHA} refs/heads/main`, `${SHA} refs/heads/staging`))).toThrow('git_advertisement_invalid');
    expect(() => parseGitSmartAdvertisement(gitAdvertisement() + '0000')).toThrow('git_advertisement_invalid');
    expect(() => parseGitSmartAdvertisement('0003bad')).toThrow('git_advertisement_invalid');
  });

  it('selects only exact repository, workflow, branch, event, and commit runs', () => {
    expect(selectTrustedRun({ workflow_runs: [run()] }, SHA).kind).toBe('success');
    const spoofed = [
      { repository: { id: 7 } },
      { head_repository: { id: 7 } },
      { workflow_id: 9 },
      { path: '.github/workflows/other.yml' },
      { event: 'workflow_dispatch' },
      { head_branch: 'release' },
      { head_sha: OTHER_SHA },
    ];
    for (const override of spoofed) {
      expect(selectTrustedRun({ workflow_runs: [run(override)] }, SHA).kind).toBe('none');
    }
    expect(selectTrustedRun({ workflow_runs: [run({ status: 'in_progress', conclusion: null })] }, SHA).kind).toBe('pending');
    expect(selectTrustedRun({ workflow_runs: [run({ conclusion: 'failure' })] }, SHA).kind).toBe('failed');
  });

  it('requires unique successful required jobs and permits skipped commit hygiene', () => {
    expect(verifySuccessfulJobs(jobs(), 1)).toBe(true);
    expect(verifySuccessfulJobs({ ...jobs(), jobs: [...jobs().jobs, jobs().jobs[0]] }, 1)).toBe(false);
    expect(verifySuccessfulJobs({ ...jobs(), jobs: jobs().jobs.map((job, i) => i === 1 ? { ...job, conclusion: 'failure' } : job) }, 1)).toBe(false);
    expect(verifySuccessfulJobs({ ...jobs(), jobs: jobs().jobs.map((job, i) => i === 0 ? { ...job, status: 'in_progress' } : job) }, 1)).toBe(false);
    expect(verifySuccessfulJobs(jobs(2), 1)).toBe(false);
    expect(verifySuccessfulJobs({ ...jobs(), jobs: jobs().jobs.filter((job) => job.name !== 'Quality (Node 26)') }, 1)).toBe(false);
    expect(verifySuccessfulJobs({ ...jobs(), jobs: [...jobs().jobs, { name: 'Unexpected', run_attempt: 1, status: 'completed', conclusion: 'cancelled' }] }, 1)).toBe(false);
  });

  it('performs a pinned, journaled deployment and completes only after exact-revision health', async () => {
    let currentRun = run();
    let currentJobs = jobs();
    const test = harness((call) => {
      if (call.url.startsWith('https://github.com/metaneutrons/HASI.git/info/refs?')) return new Response(gitAdvertisement(), { status: 200 });
      if (call.url.includes('/actions/workflows/386428207/runs?')) return jsonResponse({ workflow_runs: [currentRun] });
      if (call.url.includes('/actions/runs/12345/attempts/')) return jsonResponse(currentJobs);
      if (call.url === `http://127.0.0.1:8000/api/v1/applications/${APP_UUID}`) {
        return call.method === 'PATCH'
          ? jsonResponse({ ok: true })
          : jsonResponse({ git_repository: 'metaneutrons/HASI', git_branch: 'main', git_commit_sha: SHA, settings: { is_auto_deploy_enabled: false } });
      }
      if (call.url === 'http://127.0.0.1:8000/api/v1/deploy') return jsonResponse({ deployments: [{ resource_uuid: APP_UUID, deployment_uuid: DEPLOYMENT_UUID }] });
      if (call.url === `http://127.0.0.1:8000/api/v1/deployments/${DEPLOYMENT_UUID}`) {
        return jsonResponse({ deployment_uuid: DEPLOYMENT_UUID, commit: SHA, status: 'finished' });
      }
      if (call.url === 'https://hasi.metaneutrons.cc/api/health') return jsonResponse({ status: 'ready', revision: SHA });
      return new Response('', { status: 404 });
    });

    const first = await controllerStep({ applicationUuid: APP_UUID }, TOKEN, test.io);
    expect(first).toEqual({ kind: 'submitted', reason: 'coolify_accepted' });
    expect(test.getJournal().records.at(0)?.phase).toBe('submitted');
    expect(test.writes.map((write) => write.records.at(0)?.phase)).toEqual(['authorized', 'pinned', 'submitting', 'submitted']);
    expect(test.writes.at(2)?.records.at(0)?.submittedAt).toBe('2026-10-18T12:00:00.000Z');
    const patch = test.calls.find((call) => call.method === 'PATCH');
    expect(patch?.body).toEqual({ git_commit_sha: SHA });
    const post = test.calls.find((call) => call.url.endsWith('/api/v1/deploy'));
    expect(post?.body).toEqual({ uuid: APP_UUID });
    expect(post?.authorization).toBe(`Bearer ${TOKEN}`);

    const second = await controllerStep({ applicationUuid: APP_UUID }, TOKEN, test.io);
    expect(second).toEqual({ kind: 'completed', reason: 'health_verified' });
    expect(test.getJournal().records.at(0)?.phase).toBe('completed');
    expect(test.calls.some((call) => call.url === 'http://127.0.0.1:8000/api/v1/deployments/applications/' + APP_UUID + '?skip=0&take=10')).toBe(false);

    currentRun = run({ run_attempt: 2, run_number: 88 });
    currentJobs = jobs(2);
    const replay = await controllerStep({ applicationUuid: APP_UUID }, TOKEN, test.io);
    expect(replay).toEqual({ kind: 'replay', reason: 'sha_already_deployed' });
    expect(test.calls.filter((call) => call.url.endsWith('/api/v1/deploy'))).toHaveLength(1);
  });

  it('rechecks main immediately before each mutation and refuses a moved commit', async () => {
    const test = harness();
    test.setMainSequence([SHA, SHA, SHA, OTHER_SHA]);
    const result = await controllerStep({ applicationUuid: APP_UUID }, TOKEN, test.io);
    expect(result).toEqual({ kind: 'stale', reason: 'main_moved' });
    expect(test.calls.some((call) => call.method === 'PATCH')).toBe(true);
    expect(test.calls.some((call) => call.url.endsWith('/api/v1/deploy'))).toBe(false);
    expect(test.getJournal().records.at(0)).toMatchObject({ phase: 'stale', failure: 'main_moved' });
  });

  it('does not start a deployment if main moves before application pinning', async () => {
    const test = harness();
    test.setMainSequence([SHA, SHA, OTHER_SHA]);
    const result = await controllerStep({ applicationUuid: APP_UUID }, TOKEN, test.io);
    expect(result).toEqual({ kind: 'stale', reason: 'main_moved' });
    expect(test.calls.some((call) => call.method === 'PATCH')).toBe(false);
    expect(test.getJournal().records.at(0)).toMatchObject({ phase: 'stale', failure: 'main_moved' });
  });

  it('rejects a foreign Coolify repository before the first write', async () => {
    const test = harness((call) => {
      if (call.url.startsWith('https://github.com/metaneutrons/HASI.git/info/refs?')) return new Response(gitAdvertisement(), { status: 200 });
      if (call.url.includes('/actions/workflows/386428207/runs?')) return jsonResponse({ workflow_runs: [run()] });
      if (call.url.includes('/actions/runs/12345/attempts/1/jobs?')) return jsonResponse(jobs());
      if (call.url === `http://127.0.0.1:8000/api/v1/applications/${APP_UUID}`) {
        return call.method === 'PATCH'
          ? jsonResponse({ ok: true })
          : jsonResponse({ git_repository: 'attacker/other', git_branch: 'main', git_commit_sha: SHA, settings: { is_auto_deploy_enabled: false } });
      }
      return new Response('', { status: 404 });
    });
    expect(await controllerStep({ applicationUuid: APP_UUID }, TOKEN, test.io)).toEqual({ kind: 'failed', reason: 'application_binding_mismatch' });
    expect(test.calls.some((call) => call.method === 'PATCH')).toBe(false);
    expect(test.calls.some((call) => call.url.endsWith('/api/v1/deploy'))).toBe(false);
    expect(test.getJournal().records.at(0)).toMatchObject({ phase: 'failed', failure: 'application_binding_mismatch' });
  });

  it('rechecks the pinned SHA after PATCH and refuses deployment if the binding changed', async () => {
    let patched = false;
    const test = harness((call) => {
      if (call.url.startsWith('https://github.com/metaneutrons/HASI.git/info/refs?')) return new Response(gitAdvertisement(), { status: 200 });
      if (call.url.includes('/actions/workflows/386428207/runs?')) return jsonResponse({ workflow_runs: [run()] });
      if (call.url.includes('/actions/runs/12345/attempts/1/jobs?')) return jsonResponse(jobs());
      if (call.url === `http://127.0.0.1:8000/api/v1/applications/${APP_UUID}`) {
        if (call.method === 'PATCH') { patched = true; return jsonResponse({ ok: true }); }
        return jsonResponse({ git_repository: 'metaneutrons/HASI', git_branch: 'main', git_commit_sha: patched ? OTHER_SHA : SHA, settings: { is_auto_deploy_enabled: false } });
      }
      return new Response('', { status: 404 });
    });
    expect(await controllerStep({ applicationUuid: APP_UUID }, TOKEN, test.io)).toEqual({ kind: 'failed', reason: 'application_binding_mismatch' });
    expect(test.calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
    expect(test.calls.some(call => call.url.endsWith('/api/v1/deploy'))).toBe(false);
  });

  it('revalidates an authorized attempt after restart and waits through a rerun', async () => {
    let currentRun = run({ run_attempt: 2, run_number: 87, status: 'in_progress', conclusion: null });
    const test = harness((call) => {
      if (call.url.includes('/actions/workflows/386428207/runs?')) return jsonResponse({ workflow_runs: [currentRun] });
      return new Response('', { status: 404 });
    });
    await test.io.writeJournal({
      version: 1,
      records: [{ runId: 12345, attempt: 1, sha: SHA, phase: 'authorized', updatedAt: '2026-10-18T11:00:00.000Z' }],
    });
    expect(await controllerStep({ applicationUuid: APP_UUID }, TOKEN, test.io)).toEqual({ kind: 'waiting', reason: 'ci_pending' });
    expect(test.getJournal().records.at(0)?.phase).toBe('authorized');
    expect(test.calls.some((call) => call.method === 'PATCH')).toBe(false);

    currentRun = run({ run_attempt: 2, run_number: 87 });
    expect(await controllerStep({ applicationUuid: APP_UUID }, TOKEN, test.io)).toEqual({ kind: 'stale', reason: 'ci_attempt_changed' });
    expect(test.getJournal().records.at(0)).toMatchObject({ phase: 'stale', failure: 'ci_attempt_changed' });
    expect(test.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('keeps an ambiguous submission uncertain across restart without posting twice', async () => {
    let listedDeployments: unknown[] = [{
      resource_uuid: APP_UUID,
      deployment_uuid: DEPLOYMENT_UUID,
      commit: SHA,
      created_at: '2026-10-17T12:00:00.000Z',
    }];
    const test = harness((call) => {
      if (call.url.startsWith('https://github.com/metaneutrons/HASI.git/info/refs?')) return new Response(gitAdvertisement(), { status: 200 });
      if (call.url.includes('/actions/workflows/386428207/runs?')) return jsonResponse({ workflow_runs: [run()] });
      if (call.url.includes('/actions/runs/12345/attempts/1/jobs?')) return jsonResponse(jobs());
      if (call.url === `http://127.0.0.1:8000/api/v1/applications/${APP_UUID}`) {
        return call.method === 'PATCH'
          ? jsonResponse({ ok: true })
          : jsonResponse({ git_repository: 'metaneutrons/HASI', git_branch: 'main', git_commit_sha: SHA, settings: { is_auto_deploy_enabled: false } });
      }
      if (call.url === 'http://127.0.0.1:8000/api/v1/deploy') throw new Error(`socket closed after Bearer ${TOKEN}`);
      if (call.url === `http://127.0.0.1:8000/api/v1/deployments/applications/${APP_UUID}?skip=0&take=10`) {
        return jsonResponse({ deployments: listedDeployments });
      }
      return new Response('', { status: 404 });
    });
    expect(await controllerStep({ applicationUuid: APP_UUID }, TOKEN, test.io)).toEqual({ kind: 'uncertain', reason: 'submission_unknown' });
    expect(test.getJournal().records.at(0)?.phase).toBe('uncertain');
    listedDeployments = [{
      resource_uuid: APP_UUID,
      deployment_uuid: DEPLOYMENT_UUID,
      commit: SHA,
      created_at: '2026-10-18T12:00:01.000Z',
    }];
    expect(await controllerStep({ applicationUuid: APP_UUID }, TOKEN, test.io)).toEqual({ kind: 'submitted', reason: 'submission_reconciled' });
    expect(test.getJournal().records.at(0)?.phase).toBe('submitted');
    expect(test.calls.filter((call) => call.url.endsWith('/api/v1/deploy'))).toHaveLength(1);
  });

  it('fails the recorded attempt when readiness reports a different revision', async () => {
    const test = harness((call) => {
      if (call.url.startsWith('https://github.com/metaneutrons/HASI.git/info/refs?')) return new Response(gitAdvertisement(), { status: 200 });
      if (call.url.includes('/actions/workflows/386428207/runs?')) return jsonResponse({ workflow_runs: [run()] });
      if (call.url.includes('/actions/runs/12345/attempts/1/jobs?')) return jsonResponse(jobs());
      if (call.url === `http://127.0.0.1:8000/api/v1/applications/${APP_UUID}`) {
        return call.method === 'PATCH'
          ? jsonResponse({ ok: true })
          : jsonResponse({ git_repository: 'metaneutrons/HASI', git_branch: 'main', git_commit_sha: SHA, settings: { is_auto_deploy_enabled: false } });
      }
      if (call.url === 'http://127.0.0.1:8000/api/v1/deploy') return jsonResponse({ deployments: [{ resource_uuid: APP_UUID, deployment_uuid: DEPLOYMENT_UUID }] });
      if (call.url === `http://127.0.0.1:8000/api/v1/deployments/${DEPLOYMENT_UUID}`) return jsonResponse({ deployment_uuid: DEPLOYMENT_UUID, commit: SHA, status: 'finished' });
      if (call.url === 'https://hasi.metaneutrons.cc/api/health') return jsonResponse({ status: 'ready', revision: OTHER_SHA });
      return new Response('', { status: 404 });
    });
    await controllerStep({ applicationUuid: APP_UUID }, TOKEN, test.io);
    expect(await controllerStep({ applicationUuid: APP_UUID }, TOKEN, test.io)).toEqual({ kind: 'failed', reason: 'health_revision_mismatch' });
    expect(test.getJournal().records.at(0)).toMatchObject({ phase: 'failed', failure: 'health_revision_mismatch' });
    expect(test.calls.filter((call) => call.url.endsWith('/api/v1/deploy'))).toHaveLength(1);
  });

  it('requires Coolify to report the exact deployed commit before checking health', async () => {
    const test = harness((call) => {
      if (call.url.startsWith('https://github.com/metaneutrons/HASI.git/info/refs?')) return new Response(gitAdvertisement(), { status: 200 });
      if (call.url.includes('/actions/workflows/386428207/runs?')) return jsonResponse({ workflow_runs: [run()] });
      if (call.url.includes('/actions/runs/12345/attempts/1/jobs?')) return jsonResponse(jobs());
      if (call.url === `http://127.0.0.1:8000/api/v1/applications/${APP_UUID}`) {
        return call.method === 'PATCH'
          ? jsonResponse({ ok: true })
          : jsonResponse({ git_repository: 'metaneutrons/HASI', git_branch: 'main', git_commit_sha: SHA, settings: { is_auto_deploy_enabled: false } });
      }
      if (call.url === 'http://127.0.0.1:8000/api/v1/deploy') return jsonResponse({ deployments: [{ resource_uuid: APP_UUID, deployment_uuid: DEPLOYMENT_UUID }] });
      if (call.url === `http://127.0.0.1:8000/api/v1/deployments/${DEPLOYMENT_UUID}`) return jsonResponse({ deployment_uuid: DEPLOYMENT_UUID, status: 'finished' });
      if (call.url === 'https://hasi.metaneutrons.cc/api/health') return jsonResponse({ status: 'ready', revision: SHA });
      return new Response('', { status: 404 });
    });
    await controllerStep({ applicationUuid: APP_UUID }, TOKEN, test.io);
    expect(await controllerStep({ applicationUuid: APP_UUID }, TOKEN, test.io)).toEqual({ kind: 'failed', reason: 'coolify_revision_unverified' });
    expect(test.calls.some((call) => call.url === 'https://hasi.metaneutrons.cc/api/health')).toBe(false);
  });

  it('allows a failed deployment only through a fresh qualified CI attempt', async () => {
    let currentRun = run();
    let currentJobs = jobs();
    let postCount = 0;
    const test = harness((call) => {
      if (call.url.startsWith('https://github.com/metaneutrons/HASI.git/info/refs?')) return new Response(gitAdvertisement(), { status: 200 });
      if (call.url.includes('/actions/workflows/386428207/runs?')) return jsonResponse({ workflow_runs: [currentRun] });
      if (call.url.includes('/actions/runs/12345/attempts/')) return jsonResponse(currentJobs);
      if (call.url === `http://127.0.0.1:8000/api/v1/applications/${APP_UUID}`) {
        return call.method === 'PATCH'
          ? jsonResponse({ ok: true })
          : jsonResponse({ git_repository: 'metaneutrons/HASI', git_branch: 'main', git_commit_sha: SHA, settings: { is_auto_deploy_enabled: false } });
      }
      if (call.url === 'http://127.0.0.1:8000/api/v1/deploy') {
        postCount += 1;
        return jsonResponse({ deployments: [{ resource_uuid: APP_UUID, deployment_uuid: `deployment-${String(postCount)}-12345678` }] });
      }
      if (call.url.startsWith('http://127.0.0.1:8000/api/v1/deployments/')) {
        const id = call.url.split('/').at(-1);
        return jsonResponse({ deployment_uuid: id, commit: SHA, status: 'failed' });
      }
      return new Response('', { status: 404 });
    });

    expect(await controllerStep({ applicationUuid: APP_UUID }, TOKEN, test.io)).toEqual({ kind: 'submitted', reason: 'coolify_accepted' });
    expect(await controllerStep({ applicationUuid: APP_UUID }, TOKEN, test.io)).toEqual({ kind: 'failed', reason: 'coolify_failed' });
    currentRun = run({ run_attempt: 2, run_number: 87 });
    currentJobs = jobs(2);
    expect(await controllerStep({ applicationUuid: APP_UUID }, TOKEN, test.io)).toEqual({ kind: 'submitted', reason: 'coolify_accepted' });
    expect(postCount).toBe(2);
    expect(test.getJournal().records.map((record) => record.phase)).toEqual(['failed', 'submitted']);
  });

  it('rejects malformed initialized state before making network requests', async () => {
    const test = harness();
    test.io.readJournal = () => Promise.resolve({ version: 2, records: [] } as unknown as DeploymentJournal);
    await expect(controllerStep({ applicationUuid: APP_UUID }, TOKEN, test.io)).rejects.toThrow('journal_invalid');
    expect(test.calls).toHaveLength(0);
    expect(() => validateJournal({ version: 1, records: [{ runId: 1, attempt: 1, sha: 'short', phase: 'completed', updatedAt: new Date().toISOString() }] })).toThrow('journal_invalid');
  });

  it('keeps secret-bearing transport errors out of controller errors and logs', async () => {
    const test = harness((call) => {
      if (call.url.startsWith('https://github.com/metaneutrons/HASI.git/info/refs?')) {
        throw new Error(`transport diagnostic Bearer ${TOKEN}`);
      }
      return new Response('', { status: 404 });
    });
    await expect(controllerStep({ applicationUuid: APP_UUID }, TOKEN, test.io)).rejects.toThrow('network_error');
    await expect(controllerStep({ applicationUuid: APP_UUID }, TOKEN, test.io)).rejects.not.toThrow(TOKEN);
  });

  it('loads only a fixed Coolify application identifier from operator config', () => {
    expect(parseOperatorConfig(JSON.stringify({ applicationUuid: APP_UUID }))).toEqual({ applicationUuid: APP_UUID });
    expect(() => parseOperatorConfig(JSON.stringify({ applicationUuid: APP_UUID, apiOrigin: 'https://attacker.invalid' }))).toThrow('operator_config_invalid');
    expect(() => parseOperatorConfig('{')).toThrow('operator_config_invalid');
  });
});
