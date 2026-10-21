import { digest } from '@hasi/plugin-sdk';
import { DOCKER_PLUGIN_MANAGED_VALUE } from '../apps/api/src/docker-plugin-relay.js';

const FULL_ID = /^[a-f0-9]{64}$/u;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface ObservedManagedContainerOwnership {
  readonly operationId: string;
  readonly labelsDigest: string;
}

export interface ManagedContainerOwnershipInput {
  readonly id: string;
  readonly name: string;
  readonly labels: unknown;
  readonly ownerId: string;
  readonly installationId: string;
  readonly pluginId: string;
  readonly allowedReleaseDigests: readonly string[];
  readonly observed: ObservedManagedContainerOwnership | undefined;
  readonly knownOperationIds: ReadonlySet<string>;
}

function reject(): never {
  throw new Error('Managed container ownership evidence is invalid.');
}

function stringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') return false;
  }
  return true;
}

/** Rejects container metadata that is not tied to a host-observed, known operation. */
export function validateObservedManagedContainer(input: ManagedContainerOwnershipInput): void {
  try {
    validateObservedManagedContainerValue(input);
  } catch {
    reject();
  }
}

function validateObservedManagedContainerValue(input: ManagedContainerOwnershipInput): void {
  if (!FULL_ID.test(input.id) || !input.name.startsWith('/')) reject();
  if (!input.ownerId || !input.installationId || !input.pluginId) reject();
  if (!input.allowedReleaseDigests.every(release => FULL_ID.test(release))) reject();
  if (!input.observed || !FULL_ID.test(input.observed.labelsDigest)
    || !OPERATION_ID.test(input.observed.operationId)
    || !input.knownOperationIds.has(input.observed.operationId)) reject();

  const labels = input.labels;
  if (!stringRecord(labels)) reject();
  const operationId = labels['hasi.operation'];
  const releaseDigest = labels['hasi.release'];
  if (labels['hasi.owner'] !== input.ownerId
    || labels['hasi.managed-by'] !== DOCKER_PLUGIN_MANAGED_VALUE
    || labels['hasi.installation'] !== input.installationId
    || labels['hasi.plugin'] !== input.pluginId
    || labels['hasi.role'] !== 'candidate' && labels['hasi.role'] !== 'relay'
    || !input.allowedReleaseDigests.includes(releaseDigest ?? '')
    || operationId !== input.observed.operationId
    || digest(labels) !== input.observed.labelsDigest) reject();
}
