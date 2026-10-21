import { describe, expect, it } from 'vitest';
import { digest } from '@hasi/plugin-sdk';
import { DOCKER_PLUGIN_MANAGED_VALUE } from '../apps/api/src/docker-plugin-relay.js';
import {
  validateObservedManagedContainer,
  type ManagedContainerOwnershipInput,
} from '../scripts/managed-lifecycle-container-ownership.js';

const OWNER_ID = 'qualification-owner-1';
const INSTALLATION_ID = 'hasi.reference';
const PLUGIN_ID = 'hasi.reference';
const OPERATION_ID = 'stage-operation-1';
const RELEASE_DIGEST = 'b'.repeat(64);

function validLabels(): Record<string, string> {
  return {
    'hasi.owner': OWNER_ID,
    'hasi.managed-by': DOCKER_PLUGIN_MANAGED_VALUE,
    'hasi.installation': INSTALLATION_ID,
    'hasi.plugin': PLUGIN_ID,
    'hasi.role': 'candidate',
    'hasi.release': RELEASE_DIGEST,
    'hasi.operation': OPERATION_ID,
    'com.example.extra': 'host-observed-extra-label',
  };
}

function validInput(): ManagedContainerOwnershipInput {
  const labels = validLabels();
  return {
    id: 'a'.repeat(64),
    name: '/hasi-qualification-candidate',
    labels,
    ownerId: OWNER_ID,
    installationId: INSTALLATION_ID,
    pluginId: PLUGIN_ID,
    allowedReleaseDigests: [RELEASE_DIGEST],
    observed: { operationId: OPERATION_ID, labelsDigest: digest(labels) },
    knownOperationIds: new Set([OPERATION_ID]),
  };
}

describe('managed lifecycle container ownership evidence', () => {
  it('accepts an exact host-observed candidate with a known operation and allowlisted release', () => {
    expect(() => { validateObservedManagedContainer(validInput()); }).not.toThrow();
  });

  it.each([
    ['unobserved container id', { observed: undefined }],
    ['unknown operation', { knownOperationIds: new Set<string>() }],
    ['wrong installation', { installationId: 'another-installation' }],
    ['wrong plugin', { pluginId: 'another.plugin' }],
    ['wrong owner', { ownerId: 'another-owner' }],
    ['release outside allowlist', { allowedReleaseDigests: ['c'.repeat(64)] }],
    ['non-container name', { name: 'hasi-qualification-candidate' }],
    ['short id', { id: 'a'.repeat(63) }],
    ['uppercase id', { id: 'A'.repeat(64) }],
  ])('rejects %s', (_case, overrides) => {
    expect(() => { validateObservedManagedContainer({ ...validInput(), ...overrides }); }).toThrow();
  });

  it('rejects unsupported roles, wrong operation labels, and labels changed since observation', () => {
    const wrongRole = { ...validInput(), labels: { ...validLabels(), 'hasi.role': 'active' } };
    expect(() => { validateObservedManagedContainer(wrongRole); }).toThrow();

    const wrongOperation = { ...validInput(), labels: { ...validLabels(), 'hasi.operation': 'stage-operation-2' } };
    expect(() => { validateObservedManagedContainer(wrongOperation); }).toThrow();

    const changedLabels = { ...validInput(), labels: { ...validLabels(), 'com.example.extra': 'changed-after-observation' } };
    expect(() => { validateObservedManagedContainer(changedLabels); }).toThrow();
  });

  it('rejects non-string label values with a fixed, metadata-free error', () => {
    const input = { ...validInput(), labels: { ...validLabels(), 'com.example.extra': 42 } };
    expect(() => { validateObservedManagedContainer(input); }).toThrow('Managed container ownership evidence is invalid.');
  });
});
