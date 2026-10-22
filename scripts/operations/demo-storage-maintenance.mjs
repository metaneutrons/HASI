#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readFile, statfs, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const APP_UUID = 'tjzdwweelb3zhjtfpgzvjs8k';
const APP_IMAGE_REPOSITORY = APP_UUID;
const COMPATIBLE_FLOOR_SHA = 'b53701abe4b5cd0bb51c3ef1f67ad7ca8a76d4cf';
const STATE_DIRECTORY = '/var/lib/hasi-deploy';
const JOURNAL_PATH = `${STATE_DIRECTORY}/state.json`;
const LOCK_PATH = `${STATE_DIRECTORY}/storage-maintenance.lock`;
const DOCKER_PATH = '/usr/bin/docker';
const GIB = 1024 ** 3;
const CLEANUP_THRESHOLD_BYTES = 12 * GIB;
const MAX_JOURNAL_BYTES = 1_000_000;
const MAX_JOURNAL_RECORDS = 4096;
const MAX_DOCKER_OUTPUT_BYTES = 1_000_000;
const DOCKER_LIST_TIMEOUT_MS = 15_000;
const BUILDER_PRUNE_TIMEOUT_MS = 180_000;
const IMAGE_REMOVE_TIMEOUT_MS = 30_000;
const execFile = promisify(execFileCallback);
const NONTERMINAL_PHASES = new Set(['authorized', 'pinned', 'submitting', 'uncertain', 'submitted']);
const PHYSICAL_BUILD_PHASES = new Set(['submitting', 'uncertain', 'submitted']);
const CONTAINER_LIMIT = 1024;
const CONTAINER_INSPECT_FORMAT = String.raw`{{printf "{\"Image\":%q,\"ImageID\":%q}" .Config.Image .Image}}`;
const TERMINAL_PHASES = new Set(['completed', 'failed', 'rejected', 'stale']);
const SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu;
const IMAGE_TAG_PATTERN = /^[a-f0-9]{40}$/iu;
const IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/iu;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;

class StorageMaintenanceError extends Error {
  constructor(code) {
    super(`Demo storage maintenance failed (${code}).`);
    this.name = 'StorageMaintenanceError';
    this.code = code;
  }
}

function reject(code) {
  throw new StorageMaintenanceError(code);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validateControllerJournal(value) {
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.records)
      || value.records.length > MAX_JOURNAL_RECORDS) reject('journal_invalid');

  const allowedPhases = new Set([...NONTERMINAL_PHASES, ...TERMINAL_PHASES]);
  const keys = new Set();
  const records = [];
  for (const item of value.records) {
    if (!isObject(item)
        || !Number.isSafeInteger(item.runId) || item.runId <= 0
        || !Number.isSafeInteger(item.attempt) || item.attempt <= 0
        || typeof item.sha !== 'string' || !SHA_PATTERN.test(item.sha)
        || !allowedPhases.has(item.phase)
        || !isValidTimestamp(item.updatedAt)) reject('journal_invalid');

    const sha = item.sha.toLowerCase();
    const key = `${item.runId}:${item.attempt}:${sha}`;
    if (keys.has(key)) reject('journal_invalid');
    keys.add(key);

    const record = {
      runId: item.runId,
      attempt: item.attempt,
      sha,
      phase: item.phase,
      updatedAt: item.updatedAt,
    };
    if (item.deploymentId !== undefined) {
      if (typeof item.deploymentId !== 'string' || !IDENTIFIER_PATTERN.test(item.deploymentId)) reject('journal_invalid');
      record.deploymentId = item.deploymentId;
    }
    if (item.submittedAt !== undefined) {
      if (!isValidTimestamp(item.submittedAt)) reject('journal_invalid');
      record.submittedAt = item.submittedAt;
    }
    if (item.healthChecks !== undefined) {
      if (!Number.isSafeInteger(item.healthChecks) || item.healthChecks < 0 || item.healthChecks > 10) reject('journal_invalid');
      record.healthChecks = item.healthChecks;
    }
    if (item.failure !== undefined) {
      if (typeof item.failure !== 'string' || !/^[a-z_]{1,64}$/u.test(item.failure)) reject('journal_invalid');
      record.failure = item.failure;
    }
    if (['submitting', 'uncertain', 'submitted'].includes(record.phase) && !record.submittedAt) reject('journal_invalid');
    if (record.phase === 'submitted' && !record.deploymentId) reject('journal_invalid');
    records.push(record);
  }
  return { version: 1, records };
}

function validateAvailableBytes(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) reject('storage_unavailable');
  return value;
}

function imageRows(value) {
  if (!Array.isArray(value)) reject('docker_schema');
  return value.map((row) => {
    if (!isObject(row) || typeof row.Repository !== 'string' || typeof row.Tag !== 'string'
        || typeof row.ID !== 'string' || !IMAGE_ID_PATTERN.test(row.ID)) reject('docker_schema');
    return { repository: row.Repository, tag: row.Tag, imageId: row.ID.toLowerCase() };
  });
}

function containerRows(value) {
  if (!Array.isArray(value)) reject('docker_schema');
  return value.map((row) => {
    if (!isObject(row) || typeof row.Image !== 'string' || row.Image.length === 0 || row.Image.length > 512) {
      reject('docker_schema');
    }
    const references = [row.Image];
    if (row.ImageID !== undefined) {
      if (typeof row.ImageID !== 'string' || !IMAGE_ID_PATTERN.test(row.ImageID)) reject('docker_schema');
      references.push(row.ImageID.toLowerCase());
    }
    return { references };
  });
}

/**
 * Purely plans removal of old completed revisions for the one fixed Coolify
 * app. It never returns a candidate used by a container or protected by the
 * compatible floor, latest two completed revisions, or an active journal row.
 */
export function planImageCleanup(journalValue, imagesValue, containersValue, availableBytes) {
  const journal = validateControllerJournal(journalValue);
  const available = validateAvailableBytes(availableBytes);
  const images = imageRows(imagesValue);
  const containers = containerRows(containersValue);
  const nonterminal = journal.records.filter((record) => NONTERMINAL_PHASES.has(record.phase));
  const physicalBuildCount = journal.records.filter((record) => PHYSICAL_BUILD_PHASES.has(record.phase)).length;
  const completed = journal.records
    .filter((record) => record.phase === 'completed')
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const completedShas = new Set(completed.map((record) => record.sha));
  const protectedShas = new Set([COMPATIBLE_FLOOR_SHA]);
  const latestCompletedShas = [];
  for (const record of completed) {
    if (latestCompletedShas.includes(record.sha)) continue;
    latestCompletedShas.push(record.sha);
    protectedShas.add(record.sha);
    if (latestCompletedShas.length === 2) break;
  }
  for (const record of nonterminal) protectedShas.add(record.sha);

  const containerReferences = new Set(containers.flatMap((container) => container.references));
  const lowStorage = available < CLEANUP_THRESHOLD_BYTES;
  const candidates = [];
  if (lowStorage && physicalBuildCount === 0) {
    for (const image of images) {
      if (image.repository !== APP_IMAGE_REPOSITORY || !IMAGE_TAG_PATTERN.test(image.tag)) continue;
      const sha = image.tag.toLowerCase();
      if (!completedShas.has(sha) || protectedShas.has(sha)) continue;
      const reference = `${APP_IMAGE_REPOSITORY}:${sha}`;
      if (containerReferences.has(reference) || containerReferences.has(image.imageId)) continue;
      candidates.push({ reference, sha, imageId: image.imageId });
    }
    const completionTime = new Map();
    for (const record of completed) {
      const known = completionTime.get(record.sha);
      if (known === undefined || Date.parse(record.updatedAt) < known) completionTime.set(record.sha, Date.parse(record.updatedAt));
    }
    candidates.sort((left, right) => (completionTime.get(left.sha) ?? 0) - (completionTime.get(right.sha) ?? 0));
  }

  return {
    lowStorage,
    nonterminalCount: nonterminal.length,
    physicalBuildCount,
    completedCount: completedShas.size,
    protectedCompletedCount: latestCompletedShas.length,
    protectedShas: [...protectedShas].sort(),
    candidates,
  };
}

async function assertNoSymlinkDirectories(path, expectedUid) {
  if (!isAbsolute(path)) reject('unsafe_path');
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch {
      reject('unsafe_path');
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) reject('unsafe_path');
  }
  const directory = await lstat(absolute).catch(() => undefined);
  if (!directory || !directory.isDirectory() || directory.uid !== expectedUid || (directory.mode & 0o7777) !== 0o700) {
    reject('unsafe_directory');
  }
}

async function readControllerJournal(path = JOURNAL_PATH, expectedUid = 0) {
  const directory = dirname(path);
  await assertNoSymlinkDirectories(directory, expectedUid);
  let linkMetadata;
  try {
    linkMetadata = await lstat(path);
  } catch {
    reject('journal_unavailable');
  }
  if (!linkMetadata.isFile() || linkMetadata.uid !== expectedUid || (linkMetadata.mode & 0o077) !== 0
      || linkMetadata.nlink !== 1 || linkMetadata.size > MAX_JOURNAL_BYTES) reject('journal_unsafe');

  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.dev !== linkMetadata.dev || metadata.ino !== linkMetadata.ino
        || metadata.uid !== expectedUid || (metadata.mode & 0o077) !== 0 || metadata.nlink !== 1
        || metadata.size > MAX_JOURNAL_BYTES) reject('journal_unsafe');
    const text = await handle.readFile({ encoding: 'utf8' });
    if (Buffer.byteLength(text, 'utf8') > MAX_JOURNAL_BYTES) reject('journal_unsafe');
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      reject('journal_invalid');
    }
    return validateControllerJournal(value);
  } catch (error) {
    if (error instanceof StorageMaintenanceError) throw error;
    reject('journal_unavailable');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function availableStorageBytes(path = STATE_DIRECTORY) {
  try {
    const stats = await statfs(path, { bigint: true });
    return validateAvailableBytes(Number(stats.bavail * stats.bsize));
  } catch (error) {
    if (error instanceof StorageMaintenanceError) throw error;
    reject('storage_unavailable');
  }
}

export async function withExclusiveLock(lockPath, operation, expectedUid = 0) {
  await assertNoSymlinkDirectories(dirname(lockPath), expectedUid);
  try {
    const existing = await lstat(lockPath);
    if (existing.isSymbolicLink() || !existing.isFile() || existing.uid !== expectedUid
        || (existing.mode & 0o7777) !== 0o600 || existing.nlink !== 1) reject('lock_unsafe');
    reject('lock_busy');
  } catch (error) {
    if (error instanceof StorageMaintenanceError) throw error;
    if (!isObject(error) || error.code !== 'ENOENT') reject('lock_unavailable');
  }

  let handle;
  let identity;
  try {
    handle = await open(lockPath, 'wx', 0o600);
    identity = await handle.stat();
    if (!identity.isFile() || identity.uid !== expectedUid || (identity.mode & 0o7777) !== 0o600 || identity.nlink !== 1) {
      reject('lock_unsafe');
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (identity) {
      const current = await lstat(lockPath).catch(() => undefined);
      if (current?.isFile() && current.dev === identity.dev && current.ino === identity.ino) {
        await unlink(lockPath).catch(() => undefined);
      }
    }
    if (error instanceof StorageMaintenanceError) throw error;
    if (isObject(error) && error.code === 'EEXIST') reject('lock_busy');
    reject('lock_unavailable');
  }

  try {
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    let current;
    try {
      current = await lstat(lockPath);
    } catch {
      reject('lock_release_failed');
    }
    if (!identity || !current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino
        || current.uid !== expectedUid || (current.mode & 0o7777) !== 0o600 || current.nlink !== 1) reject('lock_release_failed');
    await unlink(lockPath).catch(() => reject('lock_release_failed'));
  }
}

async function dockerCommand(args, { timeoutMs = DOCKER_LIST_TIMEOUT_MS } = {}) {
  try {
    const result = await execFile(DOCKER_PATH, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: MAX_DOCKER_OUTPUT_BYTES,
      windowsHide: true,
    });
    return { stdout: result.stdout };
  } catch {
    reject('docker_command_failed');
  }
}

function parseJsonLines(text, mapRow) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_DOCKER_OUTPUT_BYTES) reject('docker_output_invalid');
  const lines = text.split('\n').filter((line) => line.length > 0);
  if (lines.length > 10_000) reject('docker_output_invalid');
  return lines.map((line) => {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      reject('docker_output_invalid');
    }
    return mapRow(value);
  });
}

function parseContainerIds(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_DOCKER_OUTPUT_BYTES) reject('docker_output_invalid');
  const ids = text.split('\n').filter((line) => line.length > 0);
  if (ids.length > CONTAINER_LIMIT || ids.some((id) => !/^[a-f0-9]{64}$/iu.test(id))) reject('docker_output_invalid');
  return ids.map((id) => id.toLowerCase());
}

function parseContainerInspection(text, expectedCount) {
  const rows = parseJsonLines(text, (row) => {
    if (!isObject(row) || Object.keys(row).length !== 2
        || typeof row.Image !== 'string' || row.Image.length === 0 || row.Image.length > 512
        || typeof row.ImageID !== 'string' || !IMAGE_ID_PATTERN.test(row.ImageID)) reject('docker_output_invalid');
    return { Image: row.Image, ImageID: row.ImageID.toLowerCase() };
  });
  if (rows.length !== expectedCount || rows.length > CONTAINER_LIMIT) reject('docker_output_invalid');
  return rows;
}

export async function collectContainerImageReferences(runDocker = dockerCommand) {
  const listed = await runDocker(['container', 'ls', '--all', '--no-trunc', '--quiet'], { timeoutMs: DOCKER_LIST_TIMEOUT_MS });
  const ids = parseContainerIds(listed.stdout);
  if (ids.length === 0) return [];
  const inspected = await runDocker(['container', 'inspect', '--format', CONTAINER_INSPECT_FORMAT, ...ids], {
    timeoutMs: DOCKER_LIST_TIMEOUT_MS,
  });
  return parseContainerInspection(inspected.stdout, ids.length);
}

async function listImages() {
  const result = await dockerCommand(['image', 'ls', '--no-trunc', '--format', '{{json .}}']);
  return parseJsonLines(result.stdout, (row) => row);
}

function buildSummary({ freeBytes, candidateCount = 0, builderPruneRuns = 0, imageTagsRemoved = 0, skippedCount = 0 }) {
  return { freeBytes, candidateCount, builderPruneRuns, imageTagsRemoved, skippedCount };
}

async function readBytes(getAvailableBytes) {
  try {
    return validateAvailableBytes(await getAvailableBytes());
  } catch (error) {
    if (error instanceof StorageMaintenanceError) throw error;
    reject('storage_unavailable');
  }
}

/** Dependencies are injectable so this operation can be exercised offline. */
export async function runMaintenance({
  apply = false,
  withLock = (operation) => operation(),
  readJournal = () => readControllerJournal(),
  getAvailableBytes = () => availableStorageBytes(),
  getContainers = () => collectContainerImageReferences(),
  getImages = () => listImages(),
  runDocker = dockerCommand,
}) {
  return withLock(async () => {
    let journal = validateControllerJournal(await readJournal());
    let freeBytes = await readBytes(getAvailableBytes);
    if (journal.records.some((record) => PHYSICAL_BUILD_PHASES.has(record.phase))) {
      return buildSummary({ freeBytes, skippedCount: 1 });
    }
    if (freeBytes >= CLEANUP_THRESHOLD_BYTES) return buildSummary({ freeBytes });

    let builderPruneRuns = 0;
    if (apply) {
      await runDocker(['builder', 'prune', '--all', '--force'], { timeoutMs: BUILDER_PRUNE_TIMEOUT_MS });
      builderPruneRuns += 1;
      journal = validateControllerJournal(await readJournal());
      freeBytes = await readBytes(getAvailableBytes);
      if (journal.records.some((record) => PHYSICAL_BUILD_PHASES.has(record.phase))) {
        return buildSummary({ freeBytes, builderPruneRuns, skippedCount: 1 });
      }
      if (freeBytes >= CLEANUP_THRESHOLD_BYTES) return buildSummary({ freeBytes, builderPruneRuns });
    }

    let plan = planImageCleanup(journal, await getImages(), await getContainers(), freeBytes);
    if (!apply) return buildSummary({ freeBytes, candidateCount: plan.candidates.length });
    let candidateCount = plan.candidates.length;
    let imageTagsRemoved = 0;
    let skippedCount = 0;
    const pending = new Map(plan.candidates.map((candidate) => [candidate.reference, candidate]));

    while (pending.size > 0) {
      const reference = pending.keys().next().value;
      const expected = pending.get(reference);
      pending.delete(reference);
      journal = validateControllerJournal(await readJournal());
      if (journal.records.some((record) => PHYSICAL_BUILD_PHASES.has(record.phase))) {
        skippedCount += pending.size + 1;
        break;
      }
      freeBytes = await readBytes(getAvailableBytes);
      if (freeBytes >= CLEANUP_THRESHOLD_BYTES) {
        skippedCount += pending.size + 1;
        break;
      }
      const images = await getImages();
      const containers = await getContainers();
      plan = planImageCleanup(journal, images, containers, freeBytes);
      const fresh = plan.candidates.find((candidate) => candidate.reference === reference
        && candidate.imageId === expected?.imageId);
      if (!fresh) {
        skippedCount += 1;
        continue;
      }
      await runDocker(['image', 'rm', '--no-prune', fresh.reference], { timeoutMs: IMAGE_REMOVE_TIMEOUT_MS });
      imageTagsRemoved += 1;
    }

    freeBytes = await readBytes(getAvailableBytes);
    return buildSummary({ freeBytes, candidateCount, builderPruneRuns, imageTagsRemoved, skippedCount });
  });
}

async function assertHostExecution() {
  if (process.platform === 'win32' || typeof process.getuid !== 'function' || process.getuid() !== 0) reject('host_root_required');
  try {
    await lstat('/.dockerenv');
    reject('host_only');
  } catch (error) {
    if (error instanceof StorageMaintenanceError) throw error;
    if (!isObject(error) || error.code !== 'ENOENT') reject('host_only');
  }
  await assertNoSymlinkDirectories(STATE_DIRECTORY, 0);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--apply') || args.length > 1) reject('usage');
  await assertHostExecution();
  const summary = await runMaintenance({
    apply: args.includes('--apply'),
    withLock: (operation) => withExclusiveLock(LOCK_PATH, operation, 0),
    readJournal: () => readControllerJournal(JOURNAL_PATH, 0),
    getAvailableBytes: () => availableStorageBytes(STATE_DIRECTORY),
  });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

const isDirectExecution = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectExecution) {
  main().catch((error) => {
    const code = error instanceof StorageMaintenanceError ? error.code : 'internal_failure';
    process.stderr.write(`demo-storage-maintenance failed: ${code}\n`);
    process.exitCode = 1;
  });
}
