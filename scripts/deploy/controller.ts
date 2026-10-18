#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const OWNER = 'metaneutrons';
const REPOSITORY = 'HASI';
const REPOSITORY_ID = 1421798810;
const WORKFLOW_ID = 386428207;
const WORKFLOW_PATH = '.github/workflows/ci.yml';
const BRANCH = 'main';
const GITHUB_API = 'https://api.github.com';
const GIT_REFS = 'https://github.com/metaneutrons/HASI.git/info/refs?service=git-upload-pack';
const COOLIFY_API = 'http://127.0.0.1:8000/api/v1';
const HEALTH_URL = 'https://hasi.metaneutrons.cc/api/health';
const REQUEST_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 120_000;
const MAX_HEALTH_CHECKS = 10;
// The Coolify host shares this controller's clock; allow only timestamp precision and a small clock drift.
const MAX_COOLIFY_CLOCK_SKEW_MS = 1_000;
const MAX_JOURNAL_BYTES = 1_000_000;
const MAX_RECORDS = 4096;
const TOKEN_PATH = '/run/secrets/coolify-token';
const CONFIG_PATH = '/etc/hasi/deploy-config.json';
const JOURNAL_PATH = '/var/lib/hasi-deploy/state.json';

const REQUIRED_JOBS = new Set([
  'CI Success',
  'Quality (Node 24)',
  'Quality (Node 26)',
  'Secrets and dependency advisories',
]);

export type DeploymentPhase =
  | 'authorized'
  | 'pinned'
  | 'submitting'
  | 'uncertain'
  | 'submitted'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'stale';

export interface DeploymentRecord {
  runId: number;
  attempt: number;
  sha: string;
  phase: DeploymentPhase;
  updatedAt: string;
  submittedAt?: string;
  deploymentId?: string;
  healthChecks?: number;
  failure?: string | undefined;
}

export interface DeploymentJournal {
  version: 1;
  records: DeploymentRecord[];
}

export interface ControllerIo {
  fetch: typeof fetch;
  readJournal: () => Promise<DeploymentJournal>;
  writeJournal: (journal: DeploymentJournal) => Promise<void>;
  now: () => Date;
}

export interface ControllerConfig {
  applicationUuid: string;
}

export interface StepResult {
  kind: 'waiting' | 'submitted' | 'completed' | 'rejected' | 'stale' | 'failed' | 'uncertain' | 'replay';
  reason: string;
}

class ControllerError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'ControllerError';
    this.code = code;
  }
}

function fail(code: string): never {
  throw new ControllerError(code);
}

function isSha(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordKey(record: Pick<DeploymentRecord, 'runId' | 'attempt' | 'sha'>): string {
  return [record.runId, record.attempt, record.sha.toLowerCase()].join(':');
}

function getRecord(journal: DeploymentJournal, key: string): DeploymentRecord {
  const record = journal.records.find((item) => recordKey(item) === key);
  if (!record) fail('journal_invalid');
  return record;
}

export function validateJournal(value: unknown): DeploymentJournal {
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.records) || value.records.length > MAX_RECORDS) {
    fail('journal_invalid');
  }
  const knownPhases = new Set<DeploymentPhase>([
    'authorized', 'pinned', 'submitting', 'uncertain', 'submitted', 'completed', 'failed', 'rejected', 'stale',
  ]);
  const keys = new Set<string>();
  const records: DeploymentRecord[] = [];
  for (const item of value.records) {
    if (!isObject(item)
        || !Number.isSafeInteger(item.runId) || Number(item.runId) <= 0
        || !Number.isSafeInteger(item.attempt) || Number(item.attempt) <= 0
        || !isSha(item.sha)
        || !knownPhases.has(item.phase as DeploymentPhase)
        || typeof item.updatedAt !== 'string' || !Number.isFinite(Date.parse(item.updatedAt))) {
      fail('journal_invalid');
    }
    const key = recordKey(item as unknown as DeploymentRecord);
    if (keys.has(key)) fail('journal_invalid');
    keys.add(key);
    const record: DeploymentRecord = {
      runId: Number(item.runId),
      attempt: Number(item.attempt),
      sha: item.sha.toLowerCase(),
      phase: item.phase as DeploymentPhase,
      updatedAt: item.updatedAt,
    };
    if (item.deploymentId !== undefined) {
      if (!isIdentifier(item.deploymentId)) fail('journal_invalid');
      record.deploymentId = item.deploymentId;
    }
    if (item.submittedAt !== undefined) {
      if (typeof item.submittedAt !== 'string' || !Number.isFinite(Date.parse(item.submittedAt))) fail('journal_invalid');
      record.submittedAt = item.submittedAt;
    }
    if (item.healthChecks !== undefined) {
      if (!Number.isSafeInteger(item.healthChecks) || Number(item.healthChecks) < 0 || Number(item.healthChecks) > MAX_HEALTH_CHECKS) {
        fail('journal_invalid');
      }
      record.healthChecks = Number(item.healthChecks);
    }
    if (item.failure !== undefined) {
      if (typeof item.failure !== 'string' || !/^[a-z_]{1,64}$/.test(item.failure)) fail('journal_invalid');
      record.failure = item.failure;
    }
    if ((record.phase === 'submitting' || record.phase === 'uncertain' || record.phase === 'submitted')
        && !record.submittedAt) fail('journal_invalid');
    if (record.phase === 'submitted' && !record.deploymentId) fail('journal_invalid');
    records.push(record);
  }
  return { version: 1, records };
}

function activeRecords(journal: DeploymentJournal): DeploymentRecord[] {
  return journal.records.filter((record) => [
    'authorized', 'pinned', 'submitting', 'uncertain', 'submitted',
  ].includes(record.phase));
}

function nowText(io: ControllerIo): string {
  const value = io.now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail('clock_invalid');
  return value.toISOString();
}

async function saveRecord(
  journal: DeploymentJournal,
  record: DeploymentRecord,
  patch: Partial<DeploymentRecord>,
  io: ControllerIo,
): Promise<DeploymentJournal> {
  const timestamp = nowText(io);
  const nextRecord = {
    ...record,
    ...patch,
    updatedAt: timestamp,
    ...(patch.phase === 'submitting' && record.submittedAt === undefined ? { submittedAt: timestamp } : {}),
  };
  const key = recordKey(record);
  const next = validateJournal({
    version: 1,
    records: journal.records.map((item) => recordKey(item) === key ? nextRecord : item),
  });
  await io.writeJournal(next);
  return next;
}

async function addRecord(
  journal: DeploymentJournal,
  record: DeploymentRecord,
  io: ControllerIo,
): Promise<DeploymentJournal> {
  if (journal.records.length >= MAX_RECORDS) fail('journal_capacity');
  const next = validateJournal({ version: 1, records: [...journal.records, record] });
  await io.writeJournal(next);
  return next;
}

async function boundedBody(response: Response, limit: number): Promise<Uint8Array> {
  const responseBody = (response as unknown as { body: ReadableStream<Uint8Array> | null }).body;
  if (responseBody === null) return new Uint8Array();
  const reader = responseBody.getReader() as unknown as {
    read: () => Promise<{ done: boolean; value?: Uint8Array }>;
    cancel: () => Promise<void>;
    releaseLock: () => void;
  };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let reading = true;
  try {
    while (reading) {
      const result = await reader.read();
      if (result.done) {
        reading = false;
        continue;
      }
      const value = result.value;
      if (!value) fail('response_invalid');
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        fail('response_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function request(
  io: ControllerIo,
  url: string,
  options: RequestInit,
  maxBytes: number,
): Promise<{ response: Response; bytes: Uint8Array }> {
  let response: Response;
  try {
    response = await io.fetch(url, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    fail('network_error');
  }
  const bytes = await boundedBody(response, maxBytes);
  return { response, bytes };
}

function decodeJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail('response_invalid');
  }
}

type PacketLine = { kind: 'data'; payload: Uint8Array; next: number } | { kind: 'flush'; next: number };

function pktLine(payload: Uint8Array, offset: number): PacketLine {
  if (offset + 4 > payload.length) fail('git_advertisement_invalid');
  let header = '';
  for (let index = offset; index < offset + 4; index += 1) {
    const byte = payload[index];
    if (byte === undefined) fail('git_advertisement_invalid');
    header += String.fromCharCode(byte);
  }
  if (!/^[0-9a-fA-F]{4}$/.test(header)) fail('git_advertisement_invalid');
  const length = Number.parseInt(header, 16);
  if (length === 0) return { kind: 'flush', next: offset + 4 };
  if (length < 4 || length > 65_520 || offset + length > payload.length) fail('git_advertisement_invalid');
  return { kind: 'data', payload: payload.subarray(offset + 4, offset + length), next: offset + length };
}

export function parseGitSmartAdvertisement(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let offset = 0;
  const service = pktLine(bytes, offset);
  if (service.kind !== 'data' || new TextDecoder('utf-8', { fatal: true }).decode(service.payload) !== '# service=git-upload-pack\n') {
    fail('git_advertisement_invalid');
  }
  offset = service.next;
  const separator = pktLine(bytes, offset);
  if (separator.kind !== 'flush') fail('git_advertisement_invalid');
  offset = separator.next;
  let mainSha: string | undefined;
  let terminated = false;
  while (offset < bytes.length) {
    const packet = pktLine(bytes, offset);
    offset = packet.next;
    if (packet.kind === 'flush') {
      terminated = true;
      break;
    }
    let line: string;
    try {
      line = new TextDecoder('utf-8', { fatal: true }).decode(packet.payload);
    } catch {
      fail('git_advertisement_invalid');
    }
    const firstSegment = line.split('\0', 1).at(0);
    if (firstSegment === undefined) fail('git_advertisement_invalid');
    const entry = firstSegment.replace(/\n$/, '');
    const match = /^([0-9a-fA-F]{40}|[0-9a-fA-F]{64}) refs\/heads\/main$/.exec(entry);
    const foundSha = match?.[1];
    if (foundSha) {
      if (mainSha) fail('git_advertisement_invalid');
      mainSha = foundSha.toLowerCase();
    }
  }
  if (!terminated || offset !== bytes.length || !mainSha) fail('git_advertisement_invalid');
  return mainSha;
}

function githubHeaders(): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'HASI-Coolify-controller',
  };
}

async function getCurrentMain(io: ControllerIo): Promise<string> {
  const { response, bytes } = await request(io, GIT_REFS, {
    method: 'GET',
    headers: { accept: 'application/x-git-upload-pack-advertisement' },
  }, 1_000_000);
  if (response.status !== 200) fail('git_refs_unavailable');
  return parseGitSmartAdvertisement(bytes);
}

async function getGithubJson(io: ControllerIo, path: string): Promise<unknown> {
  const { response, bytes } = await request(io, `${GITHUB_API}${path}`, {
    method: 'GET',
    headers: githubHeaders(),
  }, 1_000_000);
  if (response.status !== 200) fail('github_unavailable');
  return decodeJson(bytes);
}

interface TrustedRun {
  id: number;
  attempt: number;
  runNumber: number;
  status: string;
  conclusion: string | null;
}

export type RunSelection =
  | { kind: 'none' }
  | { kind: 'pending'; run: TrustedRun }
  | { kind: 'failed'; run: TrustedRun }
  | { kind: 'success'; run: TrustedRun };

export function selectTrustedRun(payload: unknown, sha: string): RunSelection {
  if (!isObject(payload) || !Array.isArray(payload.workflow_runs) || payload.workflow_runs.length > 20) {
    fail('github_schema');
  }
  const candidates: TrustedRun[] = [];
  for (const item of payload.workflow_runs) {
    if (!isObject(item) || item.head_sha !== sha) continue;
    const repository = item.repository;
    const headRepository = item.head_repository;
    const trusted = isObject(repository) && repository.id === REPOSITORY_ID
      && isObject(headRepository) && headRepository.id === REPOSITORY_ID
      && item.workflow_id === WORKFLOW_ID
      && item.path === WORKFLOW_PATH
      && item.event === 'push'
      && item.head_branch === BRANCH;
    if (!trusted) continue;
    if (!Number.isSafeInteger(item.id) || Number(item.id) <= 0
        || !Number.isSafeInteger(item.run_attempt) || Number(item.run_attempt) <= 0
        || !Number.isSafeInteger(item.run_number) || Number(item.run_number) <= 0
        || typeof item.status !== 'string'
        || (item.conclusion !== null && typeof item.conclusion !== 'string')) {
      fail('github_schema');
    }
    candidates.push({
      id: Number(item.id),
      attempt: Number(item.run_attempt),
      runNumber: Number(item.run_number),
      status: item.status,
      conclusion: item.conclusion,
    });
  }
  if (candidates.length === 0) return { kind: 'none' };
  candidates.sort((a, b) => b.runNumber - a.runNumber || b.attempt - a.attempt);
  const run = candidates.at(0);
  if (!run) return { kind: 'none' };
  const second = candidates.at(1);
  if (second?.runNumber === run.runNumber) {
    fail('github_ambiguous_run');
  }
  if (run.status !== 'completed') return { kind: 'pending', run };
  if (run.conclusion !== 'success') return { kind: 'failed', run };
  return { kind: 'success', run };
}

export function verifySuccessfulJobs(payload: unknown, attempt: number): boolean {
  if (!isObject(payload) || !Array.isArray(payload.jobs) || payload.jobs.length > 100) return false;
  if (payload.total_count !== undefined && payload.total_count !== payload.jobs.length) return false;
  const seen = new Set<string>();
  const foundRequired = new Set<string>();
  for (const item of payload.jobs) {
    if (!isObject(item) || typeof item.name !== 'string' || seen.has(item.name)
        || item.run_attempt !== attempt || item.status !== 'completed') return false;
    seen.add(item.name);
    if (REQUIRED_JOBS.has(item.name)) {
      if (item.conclusion !== 'success') return false;
      foundRequired.add(item.name);
      continue;
    }
    if (item.name === 'Commit hygiene') {
      if (item.conclusion !== 'success' && item.conclusion !== 'skipped') return false;
      continue;
    }
    if (item.conclusion !== 'success' && item.conclusion !== 'skipped') return false;
  }
  return foundRequired.size === REQUIRED_JOBS.size;
}

async function coolifyRequest(
  io: ControllerIo,
  token: string,
  path: string,
  method = 'GET',
  body?: Record<string, unknown>,
  maxBytes = 256_000,
): Promise<{ status: number; payload?: unknown }> {
  const { response, bytes } = await request(io, `${COOLIFY_API}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, maxBytes);
  if (bytes.length > 0) return { status: response.status, payload: decodeJson(bytes) };
  return { status: response.status };
}

function deploymentsFrom(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter(isObject);
  if (isObject(payload) && Array.isArray(payload.deployments)) return payload.deployments.filter(isObject);
  fail('coolify_schema');
}

function deploymentIdFrom(payload: unknown, applicationUuid: string): string | undefined {
  if (!isObject(payload)) return undefined;
  const candidates: unknown[] = [];
  if (Array.isArray(payload.deployments)) {
    for (const item of payload.deployments) {
      if (isObject(item) && (item.resource_uuid === undefined || item.resource_uuid === applicationUuid)) {
        candidates.push(item.deployment_uuid, item.deploymentUuid);
      }
    }
  }
  if (!Array.isArray(payload.deployments)) candidates.push(payload.deployment_uuid, payload.deploymentUuid);
  const ids = [...new Set(candidates.filter(isIdentifier))];
  return ids.length === 1 ? ids[0] : undefined;
}

function deploymentRevision(item: Record<string, unknown>): string | undefined {
  for (const key of ['git_commit_sha', 'commit_sha', 'commit']) {
    const value = item[key];
    if (isSha(value)) return value.toLowerCase();
  }
  return undefined;
}

function isHasiRepository(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase().replace(/\.git$/, '').replace(/\/$/, '');
  return [
    'metaneutrons/hasi',
    'https://github.com/metaneutrons/hasi',
    'git@github.com:metaneutrons/hasi',
  ].includes(normalized);
}

function applicationBindingMatches(payload: unknown, sha?: string): boolean {
  if (!isObject(payload)) return false;
  const repository = payload.git_repository ?? payload.repository ?? payload.git_url;
  const branch = payload.git_branch ?? payload.branch;
  const settings = payload.settings;
  return isHasiRepository(repository)
    && branch === BRANCH
    && (sha === undefined ? isSha(payload.git_commit_sha) : payload.git_commit_sha === sha)
    && isObject(settings)
    && settings.is_auto_deploy_enabled === false;
}

async function verifyApplicationBinding(
  config: ControllerConfig,
  token: string,
  io: ControllerIo,
  sha?: string,
): Promise<'valid' | 'unavailable' | 'invalid'> {
  const response = await coolifyRequest(
    io,
    token,
    `/applications/${encodeURIComponent(config.applicationUuid)}`,
  );
  if (response.status !== 200 || !isObject(response.payload)) return 'unavailable';
  return applicationBindingMatches(response.payload, sha) ? 'valid' : 'invalid';
}

type RunRevalidation = 'green' | 'pending' | 'superseded' | 'failed';

async function revalidateRun(record: DeploymentRecord, io: ControllerIo): Promise<RunRevalidation> {
  const selection = selectTrustedRun(await getGithubJson(io, workflowRunsPath()), record.sha);
  if (selection.kind === 'none' || selection.kind === 'failed') return 'failed';
  if (selection.kind === 'pending') return 'pending';
  return selection.run.id === record.runId && selection.run.attempt === record.attempt ? 'green' : 'superseded';
}

async function checkRunBeforeMutation(
  io: ControllerIo,
  journal: DeploymentJournal,
  record: DeploymentRecord,
): Promise<{ journal: DeploymentJournal; result?: StepResult }> {
  const state = await revalidateRun(record, io);
  if (state === 'green') return { journal };
  if (state === 'pending') return { journal, result: { kind: 'waiting', reason: 'ci_pending' } };
  const failure = state === 'superseded' ? 'ci_attempt_changed' : 'ci_not_successful';
  const next = await saveRecord(journal, record, { phase: 'stale', failure }, io);
  return { journal: next, result: { kind: 'stale', reason: failure } };
}

function deploymentId(item: Record<string, unknown>): string | undefined {
  for (const key of ['deployment_uuid', 'deploymentUuid', 'uuid']) {
    const value = item[key];
    if (isIdentifier(value)) return value;
  }
  return undefined;
}

async function reconcileSubmission(
  config: ControllerConfig,
  token: string,
  io: ControllerIo,
  journal: DeploymentJournal,
  record: DeploymentRecord,
): Promise<{ journal: DeploymentJournal; result: StepResult }> {
  const response = await coolifyRequest(
    io,
    token,
    `/deployments/applications/${encodeURIComponent(config.applicationUuid)}?skip=0&take=10`,
  );
  if (response.status !== 200) return { journal, result: { kind: 'uncertain', reason: 'submission_unknown' } };
  if (!record.submittedAt || !Number.isFinite(Date.parse(record.submittedAt))) fail('journal_invalid');
  const earliestCreation = Date.parse(record.submittedAt) - MAX_COOLIFY_CLOCK_SKEW_MS;
  const matches = deploymentsFrom(response.payload).filter((item) =>
    (item.resource_uuid === undefined || item.resource_uuid === config.applicationUuid)
      && deploymentRevision(item) === record.sha
      && typeof item.created_at === 'string'
      && Number.isFinite(Date.parse(item.created_at))
      && Date.parse(item.created_at) >= earliestCreation);
  if (matches.length !== 1) return { journal, result: { kind: 'uncertain', reason: 'submission_unknown' } };
  const match = matches.at(0);
  if (!match) return { journal, result: { kind: 'uncertain', reason: 'submission_unknown' } };
  const id = deploymentId(match);
  if (!id) return { journal, result: { kind: 'uncertain', reason: 'submission_unknown' } };
  const next = await saveRecord(journal, record, { phase: 'submitted', deploymentId: id }, io);
  return { journal: next, result: { kind: 'submitted', reason: 'submission_reconciled' } };
}

async function submit(
  config: ControllerConfig,
  token: string,
  io: ControllerIo,
  journal: DeploymentJournal,
  record: DeploymentRecord,
): Promise<{ journal: DeploymentJournal; result: StepResult }> {
  const gate = await checkRunBeforeMutation(io, journal, record);
  if (gate.result) return { journal: gate.journal, result: gate.result };
  let binding: 'valid' | 'unavailable' | 'invalid';
  try {
    binding = await verifyApplicationBinding(config, token, io, record.sha);
  } catch {
    binding = 'unavailable';
  }
  if (binding === 'unavailable') return { journal, result: { kind: 'waiting', reason: 'coolify_unavailable' } };
  if (binding === 'invalid') {
    const next = await saveRecord(journal, record, { phase: 'failed', failure: 'application_binding_mismatch' }, io);
    return { journal: next, result: { kind: 'failed', reason: 'application_binding_mismatch' } };
  }
  const current = await getCurrentMain(io);
  if (current !== record.sha) {
    const next = await saveRecord(journal, record, { phase: 'stale', failure: 'main_moved' }, io);
    return { journal: next, result: { kind: 'stale', reason: 'main_moved' } };
  }
  const submitting = await saveRecord(journal, record, { phase: 'submitting', failure: undefined }, io);
  const currentRecord = submitting.records.find((item) => recordKey(item) === recordKey(record));
  if (!currentRecord) fail('journal_invalid');
  let response: { status: number; payload?: unknown } | undefined;
  try {
    response = await coolifyRequest(io, token, '/deploy', 'POST', { uuid: config.applicationUuid });
  } catch {
    const uncertainJournal = await saveRecord(submitting, currentRecord, { phase: 'uncertain' }, io);
    return reconcileSubmission(config, token, io, uncertainJournal, getRecord(uncertainJournal, recordKey(record)));
  }
  if (response.status < 200 || response.status >= 300) {
    const uncertainJournal = await saveRecord(submitting, currentRecord, { phase: 'uncertain' }, io);
    return reconcileSubmission(config, token, io, uncertainJournal, getRecord(uncertainJournal, recordKey(record)));
  }
  const id = deploymentIdFrom(response.payload, config.applicationUuid);
  if (!id) {
    const uncertainJournal = await saveRecord(submitting, currentRecord, { phase: 'uncertain' }, io);
    return reconcileSubmission(config, token, io, uncertainJournal, getRecord(uncertainJournal, recordKey(record)));
  }
  const next = await saveRecord(submitting, currentRecord, { phase: 'submitted', deploymentId: id }, io);
  return { journal: next, result: { kind: 'submitted', reason: 'coolify_accepted' } };
}

async function pinAndSubmit(
  config: ControllerConfig,
  token: string,
  io: ControllerIo,
  journal: DeploymentJournal,
  record: DeploymentRecord,
): Promise<{ journal: DeploymentJournal; result: StepResult }> {
  const gate = await checkRunBeforeMutation(io, journal, record);
  if (gate.result) return { journal: gate.journal, result: gate.result };
  // Resource identity and native push policy must hold before the first write.
  let binding: 'valid' | 'unavailable' | 'invalid';
  try {
    binding = await verifyApplicationBinding(config, token, io);
  } catch {
    binding = 'unavailable';
  }
  if (binding === 'unavailable') return { journal, result: { kind: 'waiting', reason: 'coolify_unavailable' } };
  if (binding === 'invalid') {
    const next = await saveRecord(journal, record, { phase: 'failed', failure: 'application_binding_mismatch' }, io);
    return { journal: next, result: { kind: 'failed', reason: 'application_binding_mismatch' } };
  }
  const current = await getCurrentMain(io);
  if (current !== record.sha) {
    const next = await saveRecord(journal, record, { phase: 'stale', failure: 'main_moved' }, io);
    return { journal: next, result: { kind: 'stale', reason: 'main_moved' } };
  }
  let patch: { status: number };
  try {
    patch = await coolifyRequest(
      io,
      token,
      `/applications/${encodeURIComponent(config.applicationUuid)}`,
      'PATCH',
      { git_commit_sha: record.sha },
    );
  } catch {
    return { journal, result: { kind: 'waiting', reason: 'coolify_unavailable' } };
  }
  if (patch.status < 200 || patch.status >= 300) return { journal, result: { kind: 'waiting', reason: 'coolify_unavailable' } };
  const pinnedJournal = await saveRecord(journal, record, { phase: 'pinned' }, io);
  const pinnedRecord = pinnedJournal.records.find((item) => recordKey(item) === recordKey(record));
  if (!pinnedRecord) fail('journal_invalid');
  return submit(config, token, io, pinnedJournal, pinnedRecord);
}

async function finishHealthCheck(
  record: DeploymentRecord,
  journal: DeploymentJournal,
  io: ControllerIo,
): Promise<{ journal: DeploymentJournal; result: StepResult }> {
  let status = 0;
  let payload: unknown;
  try {
    const response = await request(io, HEALTH_URL, { method: 'GET', headers: { accept: 'application/json' } }, 16_384);
    status = response.response.status;
    if (status === 200) payload = decodeJson(response.bytes);
  } catch {
    status = 0;
  }
  if (status === 200 && isObject(payload) && payload.status === 'ready') {
    if (payload.revision !== record.sha) {
      const next = await saveRecord(journal, record, { phase: 'failed', failure: 'health_revision_mismatch' }, io);
      return { journal: next, result: { kind: 'failed', reason: 'health_revision_mismatch' } };
    }
    const next = await saveRecord(journal, record, { phase: 'completed', healthChecks: (record.healthChecks ?? 0) + 1 }, io);
    return { journal: next, result: { kind: 'completed', reason: 'health_verified' } };
  }
  const checks = (record.healthChecks ?? 0) + 1;
  if (checks >= MAX_HEALTH_CHECKS) {
    const next = await saveRecord(journal, record, { phase: 'failed', healthChecks: checks, failure: 'health_unverified' }, io);
    return { journal: next, result: { kind: 'failed', reason: 'health_unverified' } };
  }
  const next = await saveRecord(journal, record, { healthChecks: checks }, io);
  return { journal: next, result: { kind: 'waiting', reason: 'health_pending' } };
}

async function pollSubmitted(
  token: string,
  io: ControllerIo,
  journal: DeploymentJournal,
  record: DeploymentRecord,
): Promise<{ journal: DeploymentJournal; result: StepResult }> {
  if (!record.deploymentId) fail('journal_invalid');
  const response = await coolifyRequest(io, token, `/deployments/${encodeURIComponent(record.deploymentId)}`);
  if (response.status !== 200 || !isObject(response.payload) || typeof response.payload.status !== 'string') {
    return { journal, result: { kind: 'waiting', reason: 'deployment_pending' } };
  }
  if (response.payload.deployment_uuid !== undefined && response.payload.deployment_uuid !== record.deploymentId) {
    const next = await saveRecord(journal, record, { phase: 'failed', failure: 'coolify_deployment_mismatch' }, io);
    return { journal: next, result: { kind: 'failed', reason: 'coolify_deployment_mismatch' } };
  }
  const status = response.payload.status.toLowerCase();
  if (['failed', 'cancelled', 'canceled', 'error', 'errored', 'cancelled_by_user', 'cancelled-by-user', 'cancelled by user'].includes(status)) {
    const next = await saveRecord(journal, record, { phase: 'failed', failure: 'coolify_failed' }, io);
    return { journal: next, result: { kind: 'failed', reason: 'coolify_failed' } };
  }
  if (['finished', 'success', 'succeeded', 'completed'].includes(status)) {
    const revision = deploymentRevision(response.payload);
    if (!revision || revision !== record.sha) {
      const reason = revision ? 'coolify_revision_mismatch' : 'coolify_revision_unverified';
      const next = await saveRecord(journal, record, { phase: 'failed', failure: reason }, io);
      return { journal: next, result: { kind: 'failed', reason } };
    }
    return finishHealthCheck(record, journal, io);
  }
  return { journal, result: { kind: 'waiting', reason: 'deployment_pending' } };
}

async function resumeActive(
  config: ControllerConfig,
  token: string,
  io: ControllerIo,
  journal: DeploymentJournal,
  record: DeploymentRecord,
): Promise<StepResult> {
  if (record.phase === 'authorized') return (await pinAndSubmit(config, token, io, journal, record)).result;
  if (record.phase === 'pinned') return (await submit(config, token, io, journal, record)).result;
  if (record.phase === 'submitting' || record.phase === 'uncertain') {
    return (await reconcileSubmission(config, token, io, journal, record)).result;
  }
  return (await pollSubmitted(token, io, journal, record)).result;
}

function workflowRunsPath(): string {
  return `/repos/${OWNER}/${REPOSITORY}/actions/workflows/${String(WORKFLOW_ID)}/runs?branch=${BRANCH}&event=push&per_page=20`;
}

function workflowJobsPath(run: TrustedRun): string {
  return `/repos/${OWNER}/${REPOSITORY}/actions/runs/${String(run.id)}/attempts/${String(run.attempt)}/jobs?per_page=100`;
}

export async function controllerStep(
  config: ControllerConfig,
  token: string,
  io: ControllerIo,
): Promise<StepResult> {
  if (!isIdentifier(config.applicationUuid) || typeof token !== 'string' || token.trim().length === 0 || token.length > 4096) {
    fail('operator_config_invalid');
  }
  const journal = validateJournal(await io.readJournal());
  const active = activeRecords(journal);
  if (active.length > 1) fail('journal_active_conflict');
  const activeRecord = active.at(0);
  if (activeRecord) return resumeActive(config, token, io, journal, activeRecord);

  const sha = await getCurrentMain(io);
  const runs = await getGithubJson(io, workflowRunsPath());
  const selection = selectTrustedRun(runs, sha);
  if (selection.kind === 'none') return { kind: 'waiting', reason: 'ci_run_missing' };
  if (selection.kind === 'pending') return { kind: 'waiting', reason: 'ci_pending' };
  const record: DeploymentRecord = {
    runId: selection.run.id,
    attempt: selection.run.attempt,
    sha,
    phase: selection.kind === 'failed' ? 'rejected' : 'authorized',
    updatedAt: nowText(io),
    ...(selection.kind === 'failed' ? { failure: 'ci_failed' } : {}),
  };
  if (journal.records.some((item) => recordKey(item) === recordKey(record))) {
    return { kind: 'replay', reason: 'attempt_already_recorded' };
  }
  if (selection.kind === 'success' && journal.records.some((item) => item.phase === 'completed' && item.sha === sha)) {
    return { kind: 'replay', reason: 'sha_already_deployed' };
  }
  if (selection.kind === 'failed') {
    await addRecord(journal, record, io);
    return { kind: 'rejected', reason: 'ci_failed' };
  }

  const jobs = await getGithubJson(io, workflowJobsPath(selection.run));
  if (!verifySuccessfulJobs(jobs, selection.run.attempt)) {
    await addRecord(journal, { ...record, phase: 'rejected', failure: 'ci_jobs_invalid' }, io);
    return { kind: 'rejected', reason: 'ci_jobs_invalid' };
  }
  const latest = await getCurrentMain(io);
  if (latest !== sha) return { kind: 'stale', reason: 'main_moved' };
  const authorizedJournal = await addRecord(journal, record, io);
  const authorizedRecord = authorizedJournal.records.find((item) => recordKey(item) === recordKey(record));
  if (!authorizedRecord) fail('journal_invalid');
  return (await pinAndSubmit(config, token, io, authorizedJournal, authorizedRecord)).result;
}

function assertRootDirectory(path: string): Promise<void> {
  return lstat(path).then((metadata) => {
    if (!metadata.isDirectory() || metadata.uid !== 0 || (metadata.mode & 0o077) !== 0) fail('journal_permissions');
  }).catch((error: unknown) => {
    if (error instanceof ControllerError) throw error;
    fail('journal_unavailable');
  });
}

async function readRootFile(path: string, limit: number): Promise<string> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o077) !== 0 || metadata.size > limit) {
        fail('operator_file_invalid');
      }
      return await handle.readFile({ encoding: 'utf8' });
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof ControllerError) throw error;
    fail('operator_file_unavailable');
  }
}

export function parseOperatorConfig(text: string): ControllerConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail('operator_config_invalid');
  }
  if (!isObject(value) || Object.keys(value).length !== 1 || !isIdentifier(value.applicationUuid)) {
    fail('operator_config_invalid');
  }
  return { applicationUuid: value.applicationUuid };
}

export async function readDurableJournal(path = JOURNAL_PATH): Promise<DeploymentJournal> {
  try {
    await assertRootDirectory(dirname(path));
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o077) !== 0
        || metadata.nlink !== 1 || metadata.size > MAX_JOURNAL_BYTES) fail('journal_permissions');
    const text = await readFile(path, 'utf8');
    return validateJournal(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof ControllerError) throw error;
    if (isObject(error) && error.code === 'ENOENT') fail('journal_missing');
    fail('journal_invalid');
  }
}

export async function writeDurableJournal(journal: DeploymentJournal, path = JOURNAL_PATH): Promise<void> {
  const valid = validateJournal(journal);
  const directory = dirname(path);
  await assertRootDirectory(directory);
  try {
    const existing = await lstat(path);
    if (!existing.isFile() || existing.uid !== 0 || (existing.mode & 0o077) !== 0 || existing.nlink !== 1) {
      fail('journal_permissions');
    }
  } catch (error) {
    if (!(isObject(error) && error.code === 'ENOENT')) throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(valid)}\n`, { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    const directoryHandle = await open(directory, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    fail('journal_write_failed');
  }
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--once') || args.length > 1) fail('usage');
  const once = args.includes('--once');
  const config = parseOperatorConfig(await readRootFile(CONFIG_PATH, 8192));
  const token = (await readRootFile(TOKEN_PATH, 4096)).trim();
  if (!token) fail('operator_config_invalid');
  const io: ControllerIo = {
    fetch,
    readJournal: () => readDurableJournal(),
    writeJournal: (journal) => writeDurableJournal(journal),
    now: () => new Date(),
  };
  let continuing = true;
  while (continuing) {
    try {
      const result = await controllerStep(config, token, io);
      process.stdout.write(`deployment controller: ${result.kind} (${result.reason})\n`);
      if (result.kind === 'failed' || result.kind === 'uncertain' || result.kind === 'rejected') process.exitCode = 1;
    } catch (error) {
      const code = error instanceof ControllerError ? error.code : 'internal_error';
      process.stderr.write(`deployment controller: cycle failed (${code})\n`);
      process.exitCode = 1;
      if (once) return;
    }
    if (once) continuing = false;
    else await wait(POLL_INTERVAL_MS);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli().catch((error: unknown) => {
    const code = error instanceof ControllerError ? error.code : 'internal_error';
    process.stderr.write(`deployment controller: startup failed (${code})\n`);
    process.exitCode = 1;
  });
}
