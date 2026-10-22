import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  collectContainerImageReferences,
  planImageCleanup,
  runMaintenance,
  withExclusiveLock,
} from './demo-storage-maintenance.mjs';

const APP_REPOSITORY = 'tjzdwweelb3zhjtfpgzvjs8k';
const FLOOR_SHA = 'b53701abe4b5cd0bb51c3ef1f67ad7ca8a76d4cf';
const SHA_OLD = '1'.repeat(40);
const SHA_PREVIOUS = '2'.repeat(40);
const SHA_CURRENT = '3'.repeat(40);
const SHA_UNRELATED = '4'.repeat(40);
const SHA_EXTRA = '0'.repeat(40);
const GIB = 1024 ** 3;
const LOW_FREE_BYTES = 9 * GIB;
const IMAGE_OLD_ID = `sha256:${'a'.repeat(64)}`;
const IMAGE_PREVIOUS_ID = `sha256:${'b'.repeat(64)}`;
const IMAGE_CURRENT_ID = `sha256:${'c'.repeat(64)}`;
const IMAGE_FLOOR_ID = `sha256:${'d'.repeat(64)}`;
const IMAGE_EXTRA_ID = `sha256:${'8'.repeat(64)}`;

function record(sha, updatedAt, phase = 'completed') {
  return {
    runId: Number.parseInt(sha.slice(0, 7), 16) + 1,
    attempt: 1,
    sha,
    phase,
    updatedAt,
  };
}

function journal(records = [
  record(FLOOR_SHA, '2026-10-10T00:00:00.000Z'),
  record(SHA_OLD, '2026-10-11T00:00:00.000Z'),
  record(SHA_PREVIOUS, '2026-10-12T00:00:00.000Z'),
  record(SHA_CURRENT, '2026-10-13T00:00:00.000Z'),
]) {
  return { version: 1, records };
}

function images() {
  return [
    { Repository: APP_REPOSITORY, Tag: FLOOR_SHA, ID: IMAGE_FLOOR_ID },
    { Repository: APP_REPOSITORY, Tag: SHA_OLD, ID: IMAGE_OLD_ID },
    { Repository: APP_REPOSITORY, Tag: SHA_PREVIOUS, ID: IMAGE_PREVIOUS_ID },
    { Repository: APP_REPOSITORY, Tag: SHA_CURRENT, ID: IMAGE_CURRENT_ID },
    { Repository: 'other-app', Tag: SHA_UNRELATED, ID: `sha256:${'e'.repeat(64)}` },
  ];
}

function noContainers() {
  return [];
}

test('plans only older completed managed tags and retains the floor and latest two revisions', () => {
  const plan = planImageCleanup(journal(), images(), noContainers(), LOW_FREE_BYTES);

  assert.equal(plan.lowStorage, true);
  assert.equal(plan.nonterminalCount, 0);
  assert.equal(plan.protectedCompletedCount, 2);
  assert.deepEqual(plan.candidates.map(({ reference, sha }) => ({ reference, sha })), [
    { reference: `${APP_REPOSITORY}:${SHA_OLD}`, sha: SHA_OLD },
  ]);
  assert.ok(plan.protectedShas.includes(FLOOR_SHA));
  assert.ok(plan.protectedShas.includes(SHA_PREVIOUS));
  assert.ok(plan.protectedShas.includes(SHA_CURRENT));
});

test('protects a stopped container reference and its image ID', () => {
  const stoppedContainer = {
    Image: `${APP_REPOSITORY}:${SHA_OLD}`,
    ImageID: IMAGE_OLD_ID,
    Status: 'Exited (0) 3 days ago',
  };
  const plan = planImageCleanup(journal(), images(), [stoppedContainer], LOW_FREE_BYTES);

  assert.deepEqual(plan.candidates, []);
});

test('collects only bounded container IDs and selected image references, including the actual image ID', async () => {
  const containerIds = ['1'.repeat(64), '2'.repeat(64)];
  const inspectRows = [
    { Image: 'coolify-generated-alias:latest', ImageID: IMAGE_OLD_ID },
    { Image: 'independent:tag', ImageID: `sha256:${'9'.repeat(64)}` },
  ];
  const commands = [];
  const references = await collectContainerImageReferences(async (args) => {
    commands.push(args);
    if (args[0] === 'container' && args[1] === 'ls') return { stdout: `${containerIds.join('\n')}\n` };
    assert.deepEqual(args.slice(0, 3), ['container', 'inspect', '--format']);
    assert.equal(args[3], String.raw`{{printf "{\"Image\":%q,\"ImageID\":%q}" .Config.Image .Image}}`);
    assert.equal(args[3].includes('.Config.Image'), true);
    assert.equal(args[3].includes('.Image'), true);
    assert.equal(args[3].includes('Command'), false);
    assert.equal(args[3].includes('{{json .}}'), false);
    assert.deepEqual(args.slice(4), containerIds);
    return { stdout: `${inspectRows.map((row) => JSON.stringify(row)).join('\n')}\n` };
  });

  assert.deepEqual(commands[0], ['container', 'ls', '--all', '--no-trunc', '--quiet']);
  assert.deepEqual(references, inspectRows);
  const protectedPlan = planImageCleanup(journal(), images(), references, LOW_FREE_BYTES);
  assert.deepEqual(protectedPlan.candidates, []);
  const counterPlan = planImageCleanup(journal(), images(), [{ Image: 'coolify-generated-alias:latest', ImageID: `sha256:${'9'.repeat(64)}` }], LOW_FREE_BYTES);
  assert.deepEqual(counterPlan.candidates.map((candidate) => candidate.sha), [SHA_OLD]);

  let inspectCalled = false;
  await assert.rejects(collectContainerImageReferences(async (args) => {
    if (args[1] === 'ls') return { stdout: `${Array(1025).fill('a'.repeat(64)).join('\n')}\n` };
    inspectCalled = true;
    return { stdout: '' };
  }), { code: 'docker_output_invalid' });
  assert.equal(inspectCalled, false);
});

test('does not treat foreign repos, malformed tags, or unjournaled revisions as candidates', () => {
  const plan = planImageCleanup(journal(), [
    ...images(),
    { Repository: APP_REPOSITORY, Tag: 'short', ID: `sha256:${'f'.repeat(64)}` },
    { Repository: APP_REPOSITORY, Tag: '5'.repeat(40), ID: `sha256:${'6'.repeat(64)}` },
  ], noContainers(), LOW_FREE_BYTES);

  assert.deepEqual(plan.candidates.map((candidate) => candidate.sha), [SHA_OLD]);
});

test('does not plan cleanup at or above the 12 GiB threshold', () => {
  const plan = planImageCleanup(journal(), images(), noContainers(), 12 * GIB);
  assert.equal(plan.lowStorage, false);
  assert.deepEqual(plan.candidates, []);
});

test('skips planning and rejects malformed or unsupported journals', () => {
  const active = journal([...journal().records, {
    runId: 99,
    attempt: 1,
    sha: SHA_UNRELATED,
    phase: 'submitted',
    updatedAt: '2026-10-14T00:00:00.000Z',
    submittedAt: '2026-10-14T00:00:00.000Z',
    deploymentId: 'deployment-12345678',
  }]);
  const activePlan = planImageCleanup(active, images(), noContainers(), LOW_FREE_BYTES);
  assert.equal(activePlan.nonterminalCount, 1);
  assert.ok(activePlan.protectedShas.includes(SHA_UNRELATED));
  assert.deepEqual(activePlan.candidates, []);

  assert.throws(() => planImageCleanup({ version: 2, records: [] }, images(), noContainers(), LOW_FREE_BYTES), { code: 'journal_invalid' });
  assert.throws(() => planImageCleanup({ version: 1, records: [{ ...record(SHA_OLD, 'invalid') }] }, images(), noContainers(), LOW_FREE_BYTES), { code: 'journal_invalid' });
  assert.throws(() => planImageCleanup(journal([record(SHA_OLD, '2026-10-11T00:00:00Z'), record(SHA_OLD, '2026-10-12T00:00:00Z')]), images(), noContainers(), LOW_FREE_BYTES), { code: 'journal_invalid' });
});

test('dry run reports candidates without invoking mutating Docker commands', async () => {
  const commands = [];
  const summary = await runMaintenance({
    readJournal: async () => journal(),
    getAvailableBytes: async () => LOW_FREE_BYTES,
    getImages: async () => images(),
    getContainers: async () => noContainers(),
    runDocker: async (args) => { commands.push(args); return { stdout: '' }; },
  });

  assert.deepEqual(summary, {
    freeBytes: LOW_FREE_BYTES,
    candidateCount: 1,
    builderPruneRuns: 0,
    imageTagsRemoved: 0,
    skippedCount: 0,
  });
  assert.deepEqual(commands, []);
});

test('apply prunes unused builder cache first, then removes only an eligible exact tag', async () => {
  const commands = [];
  const freeSequence = [7 * GIB, 9 * GIB, 9 * GIB, 13 * GIB];
  let freeReads = 0;
  const summary = await runMaintenance({
    apply: true,
    readJournal: async () => journal(),
    getAvailableBytes: async () => freeSequence[Math.min(freeReads++, freeSequence.length - 1)],
    getImages: async () => images(),
    getContainers: async () => noContainers(),
    runDocker: async (args, options) => {
      commands.push({ args, options });
      return { stdout: 'private docker output is ignored' };
    },
  });

  assert.deepEqual(commands.map(({ args }) => args), [
    ['builder', 'prune', '--all', '--force'],
    ['image', 'rm', '--no-prune', `${APP_REPOSITORY}:${SHA_OLD}`],
  ]);
  assert.equal(commands[0].options.timeoutMs, 180_000);
  assert.deepEqual(summary, {
    freeBytes: 13 * GIB,
    candidateCount: 1,
    builderPruneRuns: 1,
    imageTagsRemoved: 1,
    skippedCount: 0,
  });
});

test('revalidates all container references immediately before each image deletion', async () => {
  const secondOldSha = '5'.repeat(40);
  const secondOldId = `sha256:${'7'.repeat(64)}`;
  const extendedJournal = journal([
    ...journal().records,
    record(secondOldSha, '2026-10-11T12:00:00.000Z'),
  ]);
  const extendedImages = [...images(), { Repository: APP_REPOSITORY, Tag: secondOldSha, ID: secondOldId }];
  const commands = [];
  let freeReads = 0;
  let containerReads = 0;
  const summary = await runMaintenance({
    apply: true,
    readJournal: async () => extendedJournal,
    getAvailableBytes: async () => [7 * GIB, 9 * GIB, 9 * GIB, 9 * GIB, 13 * GIB][Math.min(freeReads++, 4)],
    getImages: async () => extendedImages,
    getContainers: async () => {
      containerReads += 1;
      return containerReads === 2
        ? [{ Image: `${APP_REPOSITORY}:${SHA_OLD}`, Status: 'Exited (0)' }]
        : noContainers();
    },
    runDocker: async (args) => { commands.push(args); return { stdout: '' }; },
  });

  assert.equal(containerReads, 3);
  assert.deepEqual(commands, [
    ['builder', 'prune', '--all', '--force'],
    ['image', 'rm', '--no-prune', `${APP_REPOSITORY}:${secondOldSha}`],
  ]);
  assert.equal(summary.imageTagsRemoved, 1);
  assert.equal(summary.skippedCount, 1);
});

test('skips every Docker operation while a submitted deployment may be building', async () => {
  const activeJournal = journal([...journal().records, {
    runId: 88,
    attempt: 1,
    sha: SHA_UNRELATED,
    phase: 'submitted',
    updatedAt: '2026-10-14T00:00:00.000Z',
    submittedAt: '2026-10-14T00:00:00.000Z',
    deploymentId: 'deployment-12345678',
  }]);
  const commands = [];
  const summary = await runMaintenance({
    apply: true,
    readJournal: async () => activeJournal,
    getAvailableBytes: async () => LOW_FREE_BYTES,
    getImages: async () => { assert.fail('image inventory must be skipped'); },
    getContainers: async () => { assert.fail('container inventory must be skipped'); },
    runDocker: async (args) => { commands.push(args); return { stdout: '' }; },
  });

  assert.deepEqual(commands, []);
  assert.deepEqual(summary, {
    freeBytes: LOW_FREE_BYTES,
    candidateCount: 0,
    builderPruneRuns: 0,
    imageTagsRemoved: 0,
    skippedCount: 1,
  });
});

test('authorized and pinned SHAs stay protected while low-storage maintenance can recover space', async () => {
  const completedExtra = record(SHA_EXTRA, '2026-10-09T00:00:00.000Z');
  const authorizedSha = SHA_OLD;
  for (const phase of ['authorized', 'pinned']) {
    const activeRecord = {
      ...record(authorizedSha, '2026-10-14T00:00:00.000Z', phase),
      runId: 123456,
    };
    const activeJournal = journal([...journal().records, completedExtra, activeRecord]);
    const plan = planImageCleanup(activeJournal, [
      ...images(),
      { Repository: APP_REPOSITORY, Tag: SHA_EXTRA, ID: IMAGE_EXTRA_ID },
    ], noContainers(), LOW_FREE_BYTES);
    assert.equal(plan.physicalBuildCount, 0);
    assert.ok(plan.protectedShas.includes(authorizedSha));
    assert.deepEqual(plan.candidates.map((candidate) => candidate.sha), [SHA_EXTRA]);
  }

  const activeJournal = journal([
    ...journal().records,
    completedExtra,
    { ...record(authorizedSha, '2026-10-14T00:00:00.000Z', 'authorized'), runId: 123456 },
  ]);
  const commands = [];
  let freeReads = 0;
  const summary = await runMaintenance({
    apply: true,
    readJournal: async () => activeJournal,
    getAvailableBytes: async () => [7 * GIB, 9 * GIB, 9 * GIB, 13 * GIB][Math.min(freeReads++, 3)],
    getImages: async () => [...images(), { Repository: APP_REPOSITORY, Tag: SHA_EXTRA, ID: IMAGE_EXTRA_ID }],
    getContainers: async () => noContainers(),
    runDocker: async (args) => { commands.push(args); return { stdout: '' }; },
  });
  assert.deepEqual(commands, [
    ['builder', 'prune', '--all', '--force'],
    ['image', 'rm', '--no-prune', `${APP_REPOSITORY}:${SHA_EXTRA}`],
  ]);
  assert.equal(summary.imageTagsRemoved, 1);
});

test('requires finite nonnegative storage values before planning or applying cleanup', async () => {
  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    assert.throws(() => planImageCleanup(journal(), images(), noContainers(), invalid), { code: 'storage_unavailable' });
  }
  const commands = [];
  await assert.rejects(runMaintenance({
    apply: true,
    readJournal: async () => journal(),
    getAvailableBytes: async () => { throw new Error('private statfs output'); },
    runDocker: async (args) => { commands.push(args); return { stdout: '' }; },
  }), { code: 'storage_unavailable' });
  assert.deepEqual(commands, []);
});

test('exclusive lock serializes invocations and rejects a symlink lock input', async (t) => {
  const uid = process.getuid();
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'hasi-demo-storage-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const lockPath = join(directory, 'maintenance.lock');
  let nestedError;
  await withExclusiveLock(lockPath, async () => {
    await assert.rejects(withExclusiveLock(lockPath, async () => undefined, uid), (error) => {
      nestedError = error;
      return error.code === 'lock_busy';
    });
  }, uid);
  assert.equal(nestedError.code, 'lock_busy');

  const symlinkPath = join(directory, 'unsafe.lock');
  await symlink(join(directory, 'missing-target'), symlinkPath);
  await assert.rejects(withExclusiveLock(symlinkPath, async () => undefined, uid), { code: 'lock_unsafe' });
});
