import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, manifestSchema, type PluginManifestV2 } from '@hasi/plugin-sdk';
import type { ReferencePluginArtifactEvidence } from './package-reference-plugin.js';
import { qualificationFixtures } from './healthy-plugin-qualification.js';
import {
  createVerifiedArtifactSnapshot,
  EXTERNAL_ARTIFACT_ENV,
  ExternalPluginArtifactInputError,
  loadExternalPluginArtifactPair,
  type ExternalPluginArtifact,
  type ExternalPluginArtifactPair,
  type ExternalPluginSourceIdentity,
} from './plugin-gateway-qualification-artifacts.js';
import { createManagedReferenceManifest } from './reference-managed-state-profile.js';

type ArtifactManifest = Awaited<ReturnType<typeof qualificationFixtures.readArtifactManifest>>;
type ExternalJourneyArtifactPair = ExternalPluginArtifactPair<ArtifactManifest>;

export interface JourneyArtifactRelease {
  readonly directory: string;
  readonly sourceSha: string;
  readonly evidence: ReferencePluginArtifactEvidence;
  readonly sourceIdentity?: ExternalPluginSourceIdentity;
}

export interface PreparedJourneyArtifacts {
  readonly artifactInputMode: 'workspace-reference-fixture' | 'external-prebuilt-pair';
  readonly manifest: PluginManifestV2;
  readonly releases: readonly JourneyArtifactRelease[];
}

const EXPECTED_RELEASE_VERSIONS = ['1.0.0', '1.0.1'] as const;
const OPERATOR_DECLARED_SOURCE_IDENTITY = 'operator-declared-metadata-only-not-verified-publisher-provenance';

function fail(category: string): never {
  throw new ExternalPluginArtifactInputError(category);
}

async function readArtifactManifestSafely(
  directory: string,
  evidence: ReferencePluginArtifactEvidence,
): Promise<ArtifactManifest> {
  try {
    return await qualificationFixtures.readArtifactManifest(directory, evidence);
  } catch (error) {
    if (error instanceof ExternalPluginArtifactInputError) throw error;
    return fail('external_artifact_payload_invalid');
  }
}

/** Capture only the four operator inputs before the launcher scrubs process.env. */
export function captureExternalJourneyArtifactEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv {
  return Object.freeze(Object.fromEntries(
    Object.values(EXTERNAL_ARTIFACT_ENV)
      .filter(name => environment[name] !== undefined)
      .map(name => [name, environment[name]]),
  ));
}

async function managedProfileManifest(directory: string, expectedVersion: string): Promise<PluginManifestV2> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(directory, 'src/manifest.json'), 'utf8')) as unknown;
  } catch {
    return fail('external_artifact_managed_manifest_unavailable');
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success || parsed.data.version !== expectedVersion) {
    return fail('external_artifact_managed_manifest_invalid');
  }
  try {
    const expected = createManagedReferenceManifest(parsed.data);
    // This is an admission comparison only. The supplied manifest is never rewritten.
    if (digest(parsed.data) !== digest(expected)) fail('external_artifact_managed_state_profile_mismatch');
  } catch (error) {
    if (error instanceof ExternalPluginArtifactInputError) throw error;
    return fail('external_artifact_managed_state_profile_mismatch');
  }
  return parsed.data as PluginManifestV2;
}

/** Read and admit external inputs before any child, database, or Docker work begins. */
export async function loadExternalJourneyArtifactPair(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly workspaceRoot: string;
  readonly managedMode: boolean;
}): Promise<ExternalJourneyArtifactPair | undefined> {
  const pair = await loadExternalPluginArtifactPair({
    env: input.environment,
    workspaceRoot: input.workspaceRoot,
    readArtifactManifest: readArtifactManifestSafely,
  });
  if (!pair) return undefined;
  if (!input.managedMode) fail('external_artifact_mode_requires_managed');

  if (pair.a.evidence.pluginVersion !== EXPECTED_RELEASE_VERSIONS[0]
    || pair.b.evidence.pluginVersion !== EXPECTED_RELEASE_VERSIONS[1]) {
    fail('external_artifact_managed_release_pair_invalid');
  }
  await managedProfileManifest(pair.a.directory, EXPECTED_RELEASE_VERSIONS[0]);
  await managedProfileManifest(pair.b.directory, EXPECTED_RELEASE_VERSIONS[1]);
  return pair;
}

/** Snapshot admitted inputs into the journey's private directory and verify them again before Docker starts. */
export async function snapshotExternalJourneyArtifacts(
  pair: ExternalJourneyArtifactPair,
  privateJourneyDirectory: string,
): Promise<PreparedJourneyArtifacts> {
  const snapshotRoot = join(privateJourneyDirectory, 'external-reference-artifacts');
  try {
    await mkdir(snapshotRoot, { mode: 0o700 });
  } catch {
    return fail('external_artifact_snapshot_directory_unavailable');
  }

  const sources: readonly ExternalPluginArtifact<ArtifactManifest>[] = [pair.a, pair.b];
  const releases: JourneyArtifactRelease[] = [];
  let firstManifest: PluginManifestV2 | undefined;
  for (const source of sources) {
    const version = source.evidence.pluginVersion;
    const snapshotDirectory = join(snapshotRoot, `reference-${version}`);
    const snapshot = await createVerifiedArtifactSnapshot({
      sourceDirectory: source.directory,
      destinationDirectory: snapshotDirectory,
      evidence: source.evidence,
      inventory: source.artifact.payloadFiles,
      readArtifactManifest: readArtifactManifestSafely,
    });
    const manifest = await managedProfileManifest(snapshot.directory, version);
    // Re-read the full payload inventory immediately before handing snapshots to the Docker runtime.
    await readArtifactManifestSafely(snapshot.directory, source.evidence);
    if (version === EXPECTED_RELEASE_VERSIONS[0]) firstManifest = manifest;
    releases.push({
      directory: snapshot.directory,
      sourceSha: source.source.revision,
      evidence: source.evidence,
      sourceIdentity: source.source,
    });
  }
  if (!firstManifest || releases.length !== EXPECTED_RELEASE_VERSIONS.length) {
    return fail('external_artifact_managed_release_pair_invalid');
  }
  return Object.freeze({
    artifactInputMode: 'external-prebuilt-pair',
    manifest: firstManifest,
    releases: Object.freeze(releases),
  });
}

/** Evidence keeps external source metadata while stating its operator-declared assurance level. */
export function journeyArtifactEvidence(artifacts: PreparedJourneyArtifacts): {
  readonly artifactInputMode: PreparedJourneyArtifacts['artifactInputMode'];
  readonly independentDistributionAcceptance: false;
  readonly sourceIdentityAssurance: string;
  readonly releases: readonly Record<string, unknown>[];
} {
  const external = artifacts.artifactInputMode === 'external-prebuilt-pair';
  return {
    artifactInputMode: artifacts.artifactInputMode,
    independentDistributionAcceptance: false,
    sourceIdentityAssurance: external ? OPERATOR_DECLARED_SOURCE_IDENTITY : 'workspace-reference-fixture',
    releases: artifacts.releases.map(release => ({
      sourceSha: release.sourceSha,
      sourceIdentity: release.sourceIdentity ?? {
        kind: 'workspace-reference-fixture',
        revision: release.sourceSha,
      },
      ...release.evidence,
    })),
  };
}
