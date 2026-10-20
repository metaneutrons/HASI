import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgresJsonStore } from '@hasi/state';
import { digest, manifestSchema, type PluginManifest } from '@hasi/plugin-sdk';
import { managedPluginCommandSchema, managedPluginViewSchema, type ManagedPluginView } from '@hasi/plugin-sdk/deployment-admin';
import { createApi, type Persona } from '../apps/api/src/index.js';
import { OidcIdentityProvider } from '../apps/api/src/oidc.js';
import { startTestIdp } from '../apps/api/src/test-idp.js';
import { ProductionAuthorityDirectory, stableOidcSubject } from '../apps/api/src/production-runtime.js';
import { PluginRegistry, type ApprovedPluginSource } from '../apps/api/src/registry.js';
import { PluginSettingsStore } from '../apps/api/src/plugin-settings.js';
import { PluginRouteController } from '../apps/api/src/plugin-route-controller.js';
import { PluginDeploymentBinding } from '../apps/api/src/plugin-deployment-binding.js';
import { createPluginFetch } from '../apps/api/src/network-policy.js';
import { createManagedPluginContractClient, createManagedPluginRpcClient } from '../apps/api/src/managed-plugin-rpc.js';
import {
  pluginReleaseSigningBytes, verifyPluginRelease,
  type PluginContainerLaunchOptions, type PluginReleaseEnvelope, type PublisherApproval,
  type UnsignedPluginRelease,
} from '../apps/api/src/plugin-artifacts.js';
import { DOCKER_PLUGIN_MANAGED_VALUE } from '../apps/api/src/docker-plugin-relay.js';
import { qualificationFailureCategory, qualificationFixtures as f } from './healthy-plugin-qualification.js';
import { assertNoPostgresEnvironment, qualificationDatabase } from './plugin-gateway-qualification-config.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OWNER_LABEL = 'com.hasi.qualification.owner';
const REPOSITORY = 'localhost/hasi-reference-qualification';
const PLUGIN_ID = 'hasi.reference';
const SOURCE_FILES = ['package.json', 'README.md', 'src/manifest.json', 'src/server.js', 'src/state.js'] as const;
const SAFE_LIFECYCLE_FAILURE_CATEGORIES = [
  'managed_state_cleanup_key_mismatch', 'managed_state_cleanup_delete_mismatch', 'managed_state_cleanup_key_unclassified',
  'package_id_counterprobe_not_rejected_before_gateway',
  'managed_worker_process_identity_invalid', 'managed_worker_process_not_ready', 'managed_worker_process_failed',
  'managed_worker_process_signal_failed', 'managed_worker_process_forced_termination',
  'api_not_started', 'confirmed_execution_journal_identity_missing', 'confirmed_proposal_record_invalid',
  'confirmed_proposal_record_invalid_after_replay', 'confirmed_proposal_record_missing',
  'confirmed_proposal_record_missing_after_replay', 'confirmed_proposal_status_failed',
  'confirmed_proposal_status_invoked_gateway_mcp', 'counterprobe_authorization_origin_mismatch',
  'counterprobe_expired_oidc_plan_invalid', 'counterprobe_partial_oidc_artifacts_not_tracked',
  'counterprobe_partial_second_auth_not_reproduced', 'counterprobe_transaction_fixture_missing',
  'explicit_api_confirmation_effect_invalid', 'explicit_api_confirmation_failed',
  'explicit_api_confirmation_invalid', 'explicit_confirmation_did_not_reach_gateway',
  'explicit_opt_in_required', 'final_action_count_not_exactly_one', 'final_v1_preconfirmation_read_mismatch',
  'guarded_fetch_not_started', 'inactive_managed_contract_was_adopted', 'local_operator_mode_required',
  'managed_admin_authority_seed_failed', 'managed_admin_disable_failed', 'managed_admin_list_failed',
  'managed_admin_list_invalid', 'managed_admin_reenable_failed', 'managed_api_catalog_connect_failed',
  'managed_api_prepare_failed', 'managed_api_prepare_invalid', 'managed_api_read_status_failed',
  'managed_api_read_status_invalid', 'managed_authority_cleanup_owner_mismatch',
  'managed_authority_cleanup_state_invalid', 'managed_command_cleanup_owner_mismatch',
  'managed_command_cleanup_state_invalid', 'managed_configuration_activation_failed',
  'managed_configuration_activation_invalid', 'managed_configuration_draft_failed',
  'managed_configuration_draft_invalid', 'managed_configuration_draft_revision_invalid',
  'managed_configuration_revision_not_active', 'managed_connection_cleanup_owner_mismatch',
  'managed_connection_cleanup_state_invalid', 'managed_container_cleanup_inspection_failed',
  'managed_container_cleanup_owner_mismatch', 'managed_container_identity_inspection_failed',
  'managed_container_identity_mismatch', 'managed_container_inventory_failed',
  'managed_container_inventory_invalid', 'managed_container_inventory_duplicate',
  'managed_container_labels_invalid', 'managed_container_operation_identity_missing',
  'managed_credential_cleanup_owner_mismatch', 'managed_credential_cleanup_state_invalid',
  'managed_deployment_cleanup_owner_mismatch', 'managed_deployment_cleanup_state_invalid',
  'managed_disable_reenable_or_stale_status_invoked_gateway_mcp', 'managed_disabled_status_reload_failed',
  'managed_image_collision_check_failed', 'managed_image_tag_collision', 'managed_installation_not_listed',
  'managed_installations_missing', 'managed_invalidation_cleanup_scope_mismatch',
  'managed_invalidation_cleanup_state_invalid', 'managed_namespace_not_physically_empty',
  'managed_namespace_not_physically_empty_after_marker_removal',
  'managed_namespace_not_physically_empty_after_owned_cleanup',
  'managed_namespace_owner_marker_claim_failed', 'managed_namespace_owner_marker_delete_mismatch',
  'managed_namespace_owner_marker_invalid', 'managed_namespace_owner_marker_mismatch',
  'managed_namespace_owner_marker_missing', 'managed_offline_image_build_failed',
  'managed_owned_container_cleanup_failed', 'managed_plugin_list_reload_failed',
  'managed_proposal_cleanup_owner_mismatch', 'managed_proposal_cleanup_state_invalid',
  'managed_qualification_state_collision', 'managed_reenable_did_not_restore_v2_read',
  'managed_registry_cleanup_owner_mismatch', 'managed_registry_cleanup_state_invalid',
  'managed_release_pair_invalid', 'managed_rollback_to_v1_failed', 'managed_rollback_v1_api_read_mismatch',
  'managed_rollback_v1_contract_not_live', 'managed_route_cleanup_owner_mismatch',
  'managed_route_cleanup_state_invalid', 'managed_settings_cleanup_owner_mismatch',
  'managed_settings_cleanup_state_invalid', 'managed_student_authority_seed_failed',
  'managed_tool_list_reload_failed', 'managed_v1_api_read_mismatch', 'managed_v1_approval_missing',
  'managed_v1_contract_not_live', 'managed_v1_initial_effects_nonzero', 'managed_v1_not_activated',
  'managed_v1_proposal_not_pending', 'managed_v1_stage_review_required_missing', 'managed_v2_api_read_mismatch',
  'managed_v2_api_reads_did_not_reach_gateway', 'managed_v2_approval_missing',
  'managed_v2_contract_not_live', 'managed_v2_initial_effects_nonzero', 'managed_v2_not_activated',
  'managed_v2_pending_read_mismatch', 'managed_v2_rollback_pending_read_mismatch',
  'managed_v2_stage_review_required_missing', 'managed_worker_initial_state_invalid',
  'mark_source_or_journal_count_not_exactly_one', 'oidc_artifact_identity_invalid',
  'oidc_captured_key_outside_owned_issuer', 'oidc_expiry_missing_or_invalid',
  'oidc_physical_delete_count_mismatch', 'oidc_physical_row_outside_owned_issuer',
  'plugin_stats_invalid', 'plugin_stats_missing', 'proposal_id_invalid', 'proposal_missing',
  'proposal_status_or_reload_invoked_gateway_mcp', 'proposal_status_route_result_mismatch',
  'reference_artifact_identity_invalid', 'reference_manifest_invalid', 'reference_package_invalid',
  'reference_read_status_missing', 'reference_read_status_required_missing',
  'reference_read_status_schema_invalid', 'reference_stats_instrumentation_anchor_missing',
  'reference_tools_missing', 'repeated_confirmation_changed_execution_identity',
  'repeated_confirmation_failed', 'repeated_confirmation_invalid',
  'repeated_confirmation_invoked_gateway_mcp', 'repeated_confirmation_replayed_effect',
  'rollback_container_inherited_old_effects', 'stale_proposal_confirmation_error_invalid',
  'stale_proposal_confirmation_was_not_rejected', 'stale_proposal_did_not_persist_invalidation',
  'stale_proposal_invalidation_code_missing', 'stale_proposal_record_invalid',
  'stale_proposal_record_missing', 'stale_proposal_status_or_confirmation_invoked_gateway_mcp',
  'stale_proposal_status_was_not_rejected', 'synthetic_cookie_invalid',
  'synthetic_cookie_missing_or_ambiguous', 'synthetic_oidc_authorization_failed',
  'synthetic_oidc_authorization_missing', 'synthetic_oidc_callback_failed',
  'synthetic_oidc_callback_mismatch', 'synthetic_oidc_login_failed', 'synthetic_oidc_origin_mismatch',
  'synthetic_oidc_session_failed', 'v1_pending_invalid',
] as const;
const LABEL = `Managed lifecycle ${randomUUID().slice(0, 8)}`;
const ACCOUNT = 'managed-lifecycle-account';
const API_CLIENT_ID = 'hasi-managed-lifecycle-qualification';
const API_ORIGIN_HOST = '127.0.0.1';
const OWNER_MARKER_KEY = 'qualification:managed-plugin-lifecycle:owner:v1';
const SAFE_FAILURE_CATEGORIES = new Set<string>([
  ...SAFE_LIFECYCLE_FAILURE_CATEGORIES,
  'reference_package_invalid', 'reference_manifest_invalid', 'reference_tools_missing',
  'reference_read_status_missing', 'reference_read_status_schema_invalid',
  'reference_stats_instrumentation_anchor_missing', 'reference_plugin_offline_packaging_failed',
  'artifact_manifest_file_invalid', 'artifact_manifest_read_failed', 'artifact_manifest_invalid',
  'artifact_manifest_duplicate_payload_path', 'artifact_manifest_payload_entry_invalid',
  'artifact_manifest_hash_mismatch', 'artifact_evidence_payload_count_mismatch',
  'artifact_payload_tree_mismatch', 'artifact_payload_entry_mismatch', 'artifact_payload_digest_mismatch',
  'packaged_manifest_file_invalid', 'packaged_manifest_hash_mismatch', 'reference_artifact_identity_invalid',
  'managed_image_collision_check_failed', 'managed_image_tag_collision', 'managed_offline_image_build_failed',
  'built_image_inspection_failed', 'built_image_metadata_invalid', 'built_image_repo_digests_invalid',
  'built_image_repo_digests_missing', 'built_image_repo_digest_not_unique',
  ...(['stage', 'approve', 'activate', 'rollback'] as const).flatMap(operation => [
    `managed_${operation}_route_failed`, `managed_${operation}_response_invalid`,
    `managed_${operation}_not_completed`, `managed_${operation}_status_failed`,
    `managed_${operation}_status_invalid`, `managed_${operation}_status_not_completed`,
    `managed_${operation}_status_or_command_invoked_gateway_mcp`,
  ]),
]);
const assert: (condition: unknown, category: string) => asserts condition = f.assert;
type Artifact = Awaited<ReturnType<typeof f.readArtifactManifest>>;
type Api = Awaited<ReturnType<typeof createApi>>;
interface Worker { pid: number; ready(): Promise<void>; close(): Promise<void>; }
interface Stats { marks: number; journalRows: number; sourceRows: number; invocationRows: number }
interface ArtifactRelease {
  id: string;
  manifest: PluginManifest;
  evidence: Awaited<ReturnType<typeof f.packageReferencePluginWithAllowlistedEnvironment>>;
  artifact: Artifact;
  sourceTreeSha256: string;
  sourceFiles: Record<string, string>;
  envelope: PluginReleaseEnvelope;
  releaseDigest: string;
  imageId: string;
  imageReference: string;
  launch: PluginContainerLaunchOptions;
}
interface ImageRecord { tag: string; id?: string }
interface OwnedContainer { id: string; operationId?: string }
interface PgResult<T> { rows: T[]; rowCount: number | null }
interface PgClient { query<T extends Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<PgResult<T>>; release(): void }
interface PgPool { connect(): Promise<PgClient>; end(): Promise<void> }
interface PgModule { Pool: new (config: object) => PgPool }
interface OidcArtifactTracker { issuer: string; keys: Set<string> }
interface PhysicalOidcRow extends Record<string, unknown> { key: string; expires_at: Date | null }
interface OidcCleanupPlan { deleteKeys: string[]; expiredKeys: string[]; missingTrackedKeys: string[]; untrackedKeys: string[] }

let phase = 'preflight';

function startWorkerProcess(environment: Readonly<Record<string, string | undefined>>): Worker {
  const childEnvironment: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'XDG_CONFIG_HOME', 'LANG'] as const) {
    const value = process.env[name];
    if (value !== undefined) childEnvironment[name] = value;
  }
  Object.assign(childEnvironment, environment);
  const child: ChildProcess = spawn(process.execPath,
    ['--import', 'tsx', join(ROOT, 'apps/api/src/managed-plugin-worker.ts')],
    { cwd: ROOT, env: childEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
  let ready = false;
  let failed = false;
  let tail = '';
  child.once('error', () => { failed = true; });
  assert(typeof child.pid === 'number' && child.pid !== process.pid, 'managed_worker_process_identity_invalid');
  child.stdout?.on('data', (chunk: Buffer) => {
    tail = `${tail}${chunk.toString('utf8')}`.slice(-256);
    if (tail.includes('HASI managed plugin installer ready')) ready = true;
  });
  // Drain diagnostics without retaining or forwarding arbitrary subprocess text.
  child.stderr?.resume();
  const running = () => child.exitCode === null && child.signalCode === null && !failed;
  return {
    pid: child.pid,
    ready: async () => {
      const deadline = Date.now() + 15_000;
      while (!ready && running() && Date.now() < deadline) await delay(50);
      assert(ready && running(), 'managed_worker_process_not_ready');
    },
    close: async () => {
      if (!running()) {
        assert(!failed && child.exitCode === 0 && child.signalCode === null, 'managed_worker_process_failed');
        return;
      }
      assert(child.kill('SIGTERM'), 'managed_worker_process_signal_failed');
      const deadline = Date.now() + 5_000;
      while (running() && Date.now() < deadline) await delay(50);
      if (running()) {
        child.kill('SIGKILL');
        const killDeadline = Date.now() + 3_000;
        while (running() && Date.now() < killDeadline) await delay(50);
        fail('managed_worker_process_forced_termination');
      }
      assert(!failed && child.exitCode === 0 && child.signalCode === null, 'managed_worker_process_failed');
    },
  };
}

function exactFullContainerList(): Set<string> {
  const output = f.runDocker(['container', 'ls', '--all', '--quiet', '--no-trunc'], 'managed_container_inventory_failed');
  if (output.length === 0) return new Set<string>();
  const ids = output.split('\n');
  assert(ids.every(id => /^[a-f0-9]{64}$/u.test(id)), 'managed_container_inventory_invalid');
  assert(new Set(ids).size === ids.length, 'managed_container_inventory_duplicate');
  return new Set(ids);
}

function asRecord(value: unknown, category: string): Record<string, unknown> {
  assert(typeof value === 'object' && value !== null && !Array.isArray(value), category);
  return value as Record<string, unknown>;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function safeFailureCategory(error: unknown): string {
  const category = qualificationFailureCategory(error);
  if (SAFE_FAILURE_CATEGORIES.has(category)) return category;
  return phase === 'offline-artifacts'
    ? 'managed_offline_artifact_generation_failed'
    : 'managed_plugin_lifecycle_qualification_failed';
}

function oidcIssuerKey(issuer: string): string {
  return sha256Base64Url(issuer).slice(0, 32);
}

function oidcKeyPrefix(issuer: string): string {
  return `oidc:${oidcIssuerKey(issuer)}:`;
}

function trackOidcToken(tracker: OidcArtifactTracker, kind: 'transaction' | 'session', token: string): string {
  assert(tracker.issuer.length > 0 && /^[A-Za-z0-9_-]{43}$/u.test(token), 'oidc_artifact_identity_invalid');
  const key = `${oidcKeyPrefix(tracker.issuer)}${kind}:${sha256Base64Url(token)}`;
  tracker.keys.add(key);
  return key;
}

function planPhysicalOidcCleanup(issuer: string, capturedKeys: ReadonlySet<string>, rows: readonly PhysicalOidcRow[], now = Date.now()): OidcCleanupPlan {
  const prefix = oidcKeyPrefix(issuer);
  const validKey = (key: string) => key.startsWith(prefix) && /^(?:transaction|session):[A-Za-z0-9_-]{43}$/u.test(key.slice(prefix.length));
  for (const key of capturedKeys) assert(validKey(key), 'oidc_captured_key_outside_owned_issuer');
  const rowKeys = rows.map(row => row.key);
  assert(new Set(rowKeys).size === rowKeys.length && rowKeys.every(validKey), 'oidc_physical_row_outside_owned_issuer');
  for (const row of rows) assert(row.expires_at instanceof Date && Number.isFinite(row.expires_at.getTime()), 'oidc_expiry_missing_or_invalid');
  const present = new Set(rowKeys);
  return {
    deleteKeys: rowKeys,
    expiredKeys: rows.filter(row => row.expires_at !== null && row.expires_at.getTime() <= now).map(row => row.key),
    missingTrackedKeys: [...capturedKeys].filter(key => !present.has(key)),
    untrackedKeys: rowKeys.filter(key => !capturedKeys.has(key)),
  };
}

function createPhysicalPool(database: object): PgPool {
  const stateRequire = createRequire(import.meta.resolve('@hasi/state'));
  const pg = stateRequire('pg') as PgModule;
  return new pg.Pool({ ...database, max: 1, connectionTimeoutMillis: 2_000, idleTimeoutMillis: 1_000 });
}

async function assertPhysicalNamespaceEmpty(database: object, namespace: string): Promise<void> {
  const pool = createPhysicalPool(database);
  let client: PgClient | undefined;
  try {
    client = await pool.connect();
    const selected = await client.query<{ key: string }>('SELECT key FROM hasi_state_v1 WHERE namespace = $1 LIMIT 1', [namespace]);
    assert(selected.rows.length === 0, 'managed_namespace_not_physically_empty');
  } finally {
    client?.release();
    await pool.end();
  }
}

async function removePhysicalStateArtifacts(input: {
  database: object;
  namespace: string;
  ownerId: string;
  nonce: string;
  keys: ReadonlySet<string>;
  validate: (key: string, value: unknown) => void;
}): Promise<number> {
  const pool = createPhysicalPool(input.database);
  let client: PgClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const marker = await client.query<{ value: unknown }>(
      'SELECT value FROM hasi_state_v1 WHERE namespace = $1 AND key = $2 FOR UPDATE',
      [input.namespace, OWNER_MARKER_KEY],
    );
    assert(marker.rows.length === 1, 'managed_namespace_owner_marker_missing');
    const value = asRecord(marker.rows[0]?.value, 'managed_namespace_owner_marker_invalid');
    assert(value.purpose === 'managed-plugin-lifecycle' && value.ownerId === input.ownerId
      && value.namespace === input.namespace && value.nonce === input.nonce, 'managed_namespace_owner_marker_mismatch');
    const selected = await client.query<{ key: string; value: unknown }>(
      'SELECT key, value FROM hasi_state_v1 WHERE namespace = $1 AND key = ANY($2::text[]) ORDER BY key FOR UPDATE',
      [input.namespace, [...input.keys]],
    );
    // Physical selection includes expired rows; JsonStore.read deliberately hides them.
    for (const row of selected.rows) {
      assert(input.keys.has(row.key), 'managed_state_cleanup_key_mismatch');
      input.validate(row.key, row.value);
    }
    const keys = selected.rows.map(row => row.key);
    if (keys.length > 0) {
      const removed = await client.query<{ key: string }>(
        'DELETE FROM hasi_state_v1 WHERE namespace = $1 AND key = ANY($2::text[]) RETURNING key',
        [input.namespace, keys],
      );
      const removedKeys = new Set(removed.rows.map(row => row.key));
      assert(removedKeys.size === keys.length && keys.every(key => removedKeys.has(key)), 'managed_state_cleanup_delete_mismatch');
    }
    await client.query('COMMIT');
    return keys.length;
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
}

async function removePhysicalOidcArtifacts(input: {
  database: object;
  namespace: string;
  ownerId: string;
  nonce: string;
  tracker: OidcArtifactTracker;
}): Promise<{ removed: number; expiredRemoved: number; missingTracked: number; discovered: number }> {
  const pool = createPhysicalPool(input.database);
  let client: PgClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const marker = await client.query<{ value: unknown }>(
      'SELECT value FROM hasi_state_v1 WHERE namespace = $1 AND key = $2 FOR UPDATE',
      [input.namespace, OWNER_MARKER_KEY],
    );
    assert(marker.rows.length === 1, 'managed_namespace_owner_marker_missing');
    const markerValue = asRecord(marker.rows[0]?.value, 'managed_namespace_owner_marker_invalid');
    assert(markerValue.purpose === 'managed-plugin-lifecycle' && markerValue.ownerId === input.ownerId
      && markerValue.namespace === input.namespace && markerValue.nonce === input.nonce, 'managed_namespace_owner_marker_mismatch');

    const prefix = oidcKeyPrefix(input.tracker.issuer);
    const selected = await client.query<PhysicalOidcRow>(
      'SELECT key, expires_at FROM hasi_state_v1 WHERE namespace = $1 AND left(key, length($2)) = $2 ORDER BY key FOR UPDATE',
      [input.namespace, prefix],
    );
    const plan = planPhysicalOidcCleanup(input.tracker.issuer, input.tracker.keys, selected.rows);
    let removed = 0;
    if (plan.deleteKeys.length > 0) {
      const deleted = await client.query<{ key: string }>(
        'DELETE FROM hasi_state_v1 WHERE namespace = $1 AND key = ANY($2::text[]) RETURNING key',
        [input.namespace, plan.deleteKeys],
      );
      const deletedKeys = new Set(deleted.rows.map(row => row.key));
      assert(deletedKeys.size === plan.deleteKeys.length && plan.deleteKeys.every(key => deletedKeys.has(key)), 'oidc_physical_delete_count_mismatch');
      removed = deletedKeys.size;
    }
    const otherRows = await client.query<{ key: string }>(
      'SELECT key FROM hasi_state_v1 WHERE namespace = $1 AND key <> $2 LIMIT 1',
      [input.namespace, OWNER_MARKER_KEY],
    );
    assert(otherRows.rows.length === 0, 'managed_namespace_not_physically_empty_after_owned_cleanup');
    const markerDeleted = await client.query<{ key: string }>(
      'DELETE FROM hasi_state_v1 WHERE namespace = $1 AND key = $2 RETURNING key',
      [input.namespace, OWNER_MARKER_KEY],
    );
    assert(markerDeleted.rows.length === 1, 'managed_namespace_owner_marker_delete_mismatch');
    const remaining = await client.query<{ key: string }>(
      'SELECT key FROM hasi_state_v1 WHERE namespace = $1 LIMIT 1', [input.namespace],
    );
    assert(remaining.rows.length === 0, 'managed_namespace_not_physically_empty_after_marker_removal');
    await client.query('COMMIT');
    return { removed: removed + 1, expiredRemoved: plan.expiredKeys.length,
      missingTracked: plan.missingTrackedKeys.length, discovered: plan.untrackedKeys.length };
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
}

function fail(category: string): never {
  return f.fail(category);
}

function requireExplicitOptIn(): void {
  if (process.env.HASI_MANAGED_PLUGIN_QUALIFY !== '1') fail('explicit_opt_in_required');
  if (process.env.VERCEL || process.env.HASI_DEMO_MODE === '1') fail('local_operator_mode_required');
}

async function writeInstrumentedReferenceSource(root: string, version: '1.0.0' | '1.1.0'): Promise<{
  directory: string;
  fileHashes: Record<string, string>;
  treeSha256: string;
}> {
  const directory = join(root, `source-${version}`);
  await mkdir(join(directory, 'src'), { recursive: true });
  for (const name of SOURCE_FILES) await copyFile(join(ROOT, 'examples/reference-plugin', name), join(directory, name));

  const packageMetadata = asRecord(JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as unknown, 'reference_package_invalid');
  packageMetadata.version = version;
  const manifest = asRecord(JSON.parse(await readFile(join(directory, 'src/manifest.json'), 'utf8')) as unknown, 'reference_manifest_invalid');
  manifest.version = version;
  assert(Array.isArray(manifest.tools), 'reference_tools_missing');
  const tools = manifest.tools as Record<string, unknown>[];
  const readTool = tools.find(tool => tool.name === 'read_status');
  assert(readTool, 'reference_read_status_missing');
  const outputSchema = asRecord(readTool.outputSchema, 'reference_read_status_schema_invalid');
  const properties = asRecord(outputSchema.properties, 'reference_read_status_schema_invalid');
  properties.qualificationStats = {
    type: 'object',
    properties: {
      marks: { type: 'integer', minimum: 0 },
      journalRows: { type: 'integer', minimum: 0 },
      sourceRows: { type: 'integer', minimum: 0 },
      invocationRows: { type: 'integer', minimum: 0 },
    },
    required: ['marks', 'journalRows', 'sourceRows', 'invocationRows'],
    additionalProperties: false,
  };
  assert(Array.isArray(outputSchema.required), 'reference_read_status_required_missing');
  (outputSchema.required as string[]).push('qualificationStats');

  const serverPath = join(directory, 'src/server.js');
  const server = await readFile(serverPath, 'utf8');
  const marker = '      actionCount: await state.count(context?.installationId ?? installationId, actor),';
  assert(server.split(marker).length === 2, 'reference_stats_instrumentation_anchor_missing');
  await writeFile(serverPath, server.replace(marker, `${marker}\n      qualificationStats: state.stats(),`), { flag: 'w' });
  await writeFile(join(directory, 'package.json'), `${JSON.stringify(packageMetadata, null, 2)}\n`, { flag: 'w' });
  await writeFile(join(directory, 'src/manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'w' });

  const fileHashes: Record<string, string> = {};
  for (const name of SOURCE_FILES) fileHashes[name] = sha256(await readFile(join(directory, name)));
  return { directory, fileHashes, treeSha256: digest(fileHashes) };
}

async function buildRelease(input: {
  root: string;
  version: '1.0.0' | '1.1.0';
  suffix: 'v1' | 'v2';
  ownerId: string;
  networkName: string;
  hostPort: number;
  publisher: PublisherApproval;
  publisherPrivateKey: KeyObject;
  images: ImageRecord[];
}): Promise<ArtifactRelease> {
  const source = await writeInstrumentedReferenceSource(input.root, input.version);
  const outputDirectory = join(input.root, `artifact-${input.suffix}`);
  const evidence = f.packageReferencePluginWithAllowlistedEnvironment(outputDirectory, source.directory);
  const artifact = await f.readArtifactManifest(outputDirectory, evidence);
  const manifest = manifestSchema.parse(JSON.parse(await readFile(join(outputDirectory, 'src/manifest.json'), 'utf8')) as unknown);
  assert(manifest.id === PLUGIN_ID && manifest.version === input.version, 'reference_artifact_identity_invalid');

  const dockerfile = join(input.root, `Dockerfile-${input.suffix}`);
  await writeFile(dockerfile, f.pluginLauncherDockerfile(), { flag: 'wx' });
  const tag = `${REPOSITORY}:${input.ownerId.slice(-12)}-${input.suffix}`;
  assert(f.runDocker(['image', 'ls', '--quiet', tag], 'managed_image_collision_check_failed') === '', 'managed_image_tag_collision');
  const image: ImageRecord = { tag };
  input.images.push(image);
  f.runDocker(['build', '--network=none', '--pull=false', '--label', `${OWNER_LABEL}=${input.ownerId}`,
    '--tag', tag, '--file', dockerfile, outputDirectory], 'managed_offline_image_build_failed', 180_000);
  const imageIdentity = f.dockerImageIdentity(tag, input.ownerId);
  image.id = imageIdentity.id;

  const unsigned: UnsignedPluginRelease = {
    schemaVersion: 1,
    pluginId: PLUGIN_ID,
    version: manifest.version,
    manifestDigest: digest(manifest),
    image: imageIdentity.repoDigest,
    publisherId: input.publisher.publisherId,
    configSchemaVersion: 1,
    stateMigration: 'none',
  };
  const envelope: PluginReleaseEnvelope = {
    ...unsigned,
    signature: sign(null, pluginReleaseSigningBytes(unsigned), input.publisherPrivateKey).toString('base64url'),
  };
  const verified = verifyPluginRelease(envelope, publisherId => publisherId === input.publisher.publisherId ? input.publisher : undefined);
  const launch: PluginContainerLaunchOptions = {
    network: { mode: 'internal', name: input.networkName },
    hostPort: input.hostPort,
    containerPort: 3000,
    cpuMillicores: 500,
    memoryBytes: 268_435_456,
    pidsLimit: 64,
    startupTimeoutMs: 30_000,
    shutdownTimeoutMs: 2_000,
  };
  return {
    id: `reference-${input.suffix}`,
    manifest,
    evidence,
    artifact,
    sourceTreeSha256: source.treeSha256,
    sourceFiles: source.fileHashes,
    envelope,
    releaseDigest: verified.releaseDigest,
    imageId: imageIdentity.id,
    imageReference: imageIdentity.repoDigest,
    launch,
  };
}

function cookiePair(headers: Record<string, unknown>, name: string): string {
  const raw = headers['set-cookie'];
  const values: string[] = typeof raw === 'string' ? [raw]
    : Array.isArray(raw) ? raw.filter((value: unknown): value is string => typeof value === 'string') : [];
  const matches = values.filter(value => typeof value === 'string' && value.startsWith(`${name}=`));
  assert(matches.length === 1, 'synthetic_cookie_missing_or_ambiguous');
  const match = matches[0];
  assert(typeof match === 'string', 'synthetic_cookie_invalid');
  const pair = match.split(';', 1)[0];
  assert(pair?.startsWith(`${name}=`) === true, 'synthetic_cookie_invalid');
  return pair;
}

function parseJsonBody(response: { body: string }, category: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(response.body) as unknown; } catch { return f.fail(category); }
  return asRecord(parsed, category);
}

async function authenticate(
  app: Api,
  issuer: string,
  subjectChoice: string,
  apiOrigin: string,
  recordOidcArtifact: (kind: 'transaction' | 'session', token: string) => void,
): Promise<{ cookie: string }> {
  const login = await app.inject({ method: 'GET', url: '/api/auth/login?returnTo=%2Fadmin', headers: { host: API_ORIGIN_HOST } });
  const transaction = cookiePair(login.headers, 'hasi-oidc-transaction');
  const transactionId = transaction.slice('hasi-oidc-transaction='.length);
  recordOidcArtifact('transaction', transactionId);
  assert(login.statusCode === 302, 'synthetic_oidc_login_failed');
  const authorization = login.headers.location;
  assert(typeof authorization === 'string', 'synthetic_oidc_authorization_missing');
  const authorizationUrl = new URL(authorization);
  assert(authorizationUrl.origin === issuer && authorizationUrl.pathname === '/authorize', 'synthetic_oidc_origin_mismatch');
  authorizationUrl.searchParams.set('test_subject', subjectChoice);
  const approved = await fetch(authorizationUrl, { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
  const callback = approved.headers.get('location');
  await approved.body?.cancel();
  assert(approved.status === 302 && typeof callback === 'string', 'synthetic_oidc_authorization_failed');
  const callbackUrl = new URL(callback);
  assert(callbackUrl.origin === apiOrigin && callbackUrl.pathname === '/api/auth/callback', 'synthetic_oidc_callback_mismatch');
  const completed = await app.inject({ method: 'GET', url: `${callbackUrl.pathname}${callbackUrl.search}`,
    headers: { host: API_ORIGIN_HOST, cookie: transaction } });
  const session = cookiePair(completed.headers, 'hasi-session');
  const sessionToken = session.slice('hasi-session='.length);
  recordOidcArtifact('session', sessionToken);
  assert(completed.statusCode === 302, 'synthetic_oidc_callback_failed');
  const check = await app.inject({ method: 'GET', url: '/api/session', headers: { host: API_ORIGIN_HOST, cookie: session } });
  assert(check.statusCode === 200, 'synthetic_oidc_session_failed');
  return { cookie: session };
}

function parseStats(value: unknown): Stats {
  const stats = asRecord(value, 'plugin_stats_missing');
  const parsed = {
    marks: stats.marks,
    journalRows: stats.journalRows,
    sourceRows: stats.sourceRows,
    invocationRows: stats.invocationRows,
  };
  assert(Object.values(parsed).every(item => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0), 'plugin_stats_invalid');
  return parsed as Stats;
}

async function runOidcCleanupCounterprobe(): Promise<Record<string, unknown>> {
  const issuer = 'http://127.0.0.1:43210';
  const apiOrigin = 'http://127.0.0.1:43211';
  const tracker: OidcArtifactTracker = { issuer, keys: new Set<string>() };
  const transactionTokens = ['A'.repeat(43), 'B'.repeat(43)] as const;
  const sessionToken = 'C'.repeat(43);
  let loginCount = 0;
  const fakeApi = {
    inject: (options: { url: string }) => {
      if (options.url.startsWith('/api/auth/login')) {
        const transaction = transactionTokens[loginCount];
        loginCount += 1;
        assert(transaction, 'counterprobe_transaction_fixture_missing');
        return Promise.resolve({ statusCode: 302, headers: {
          location: `${issuer}/authorize?client_id=counterprobe`,
          'set-cookie': `hasi-oidc-transaction=${transaction}; Path=/api/auth/callback;`,
        } });
      }
      if (options.url.startsWith('/api/auth/callback')) {
        return Promise.resolve({ statusCode: 302, headers: { 'set-cookie': `hasi-session=${sessionToken}; Path=/;` } });
      }
      if (options.url === '/api/session') return Promise.resolve({ statusCode: 200, headers: {} });
      return Promise.resolve({ statusCode: 404, headers: {} });
    },
  } as unknown as Api;
  const originalFetch = globalThis.fetch;
  let authorizationRequests = 0;
  globalThis.fetch = input => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert(url.origin === issuer && url.pathname === '/authorize', 'counterprobe_authorization_origin_mismatch');
    authorizationRequests += 1;
    if (authorizationRequests === 2) return Promise.reject(new Error('counterprobe_second_authorization_failed'));
    return Promise.resolve(new Response(null, { status: 302, headers: { location: `${apiOrigin}/api/auth/callback?code=probe&state=probe` } }));
  };
  let secondAuthFailed = false;
  try {
    const record = (kind: 'transaction' | 'session', token: string) => { trackOidcToken(tracker, kind, token); };
    await authenticate(fakeApi, issuer, 'first-subject', apiOrigin, record);
    try { await authenticate(fakeApi, issuer, 'second-subject', apiOrigin, record); }
    catch { secondAuthFailed = true; }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert(secondAuthFailed && authorizationRequests === 2, 'counterprobe_partial_second_auth_not_reproduced');
  const now = Date.now();
  const firstTransactionKey = `${oidcKeyPrefix(issuer)}transaction:${sha256Base64Url(transactionTokens[0])}`;
  const secondTransactionKey = `${oidcKeyPrefix(issuer)}transaction:${sha256Base64Url(transactionTokens[1])}`;
  const sessionKey = `${oidcKeyPrefix(issuer)}session:${sha256Base64Url(sessionToken)}`;
  assert(tracker.keys.size === 3 && tracker.keys.has(firstTransactionKey) && tracker.keys.has(secondTransactionKey)
    && tracker.keys.has(sessionKey), 'counterprobe_partial_oidc_artifacts_not_tracked');
  const plan = planPhysicalOidcCleanup(issuer, tracker.keys, [
    { key: firstTransactionKey, expires_at: new Date(now - 1) },
    { key: secondTransactionKey, expires_at: new Date(now + 60_000) },
    { key: sessionKey, expires_at: new Date(now + 60_000) },
  ], now);
  assert(plan.deleteKeys.length === 3 && plan.expiredKeys.length === 1 && plan.expiredKeys[0] === firstTransactionKey
    && plan.missingTrackedKeys.length === 0 && plan.untrackedKeys.length === 0, 'counterprobe_expired_oidc_plan_invalid');
  return { probe: 'managed-oidc-cleanup-counterprobe', passed: true, partialSecondAuthFailure: true,
    trackedExactOidcKeys: tracker.keys.size, plannedExpiredRowCount: plan.expiredKeys.length,
    keysPlannedForDeletion: plan.deleteKeys.length, networkOrDatabaseCalls: 0 };
}

async function runPhysicalStateCleanupCounterprobe(): Promise<Record<string, unknown>> {
  requireExplicitOptIn();
  assertNoPostgresEnvironment();
  const database = qualificationDatabase(process.env.TEST_DATABASE_URL);
  const nonce = randomUUID().replaceAll('-', '').slice(0, 12);
  const ownerId = `managed-cleanup-probe-${nonce}`;
  const namespace = `qualification:managed-cleanup-probe:${nonce}`;
  const store = new PostgresJsonStore(namespace, { poolConfig: { ...database, max: 1 } });
  const keys = new Set(['probe:active', 'probe:expired']);
  const validate = (key: string, value: unknown) => {
    const record = asRecord(value, 'cleanup_probe_record_invalid');
    assert(keys.has(key) && record.ownerId === ownerId, 'cleanup_probe_record_owner_mismatch');
  };
  const physicalCount = async () => {
    const pool = createPhysicalPool(database);
    let client: PgClient | undefined;
    try {
      client = await pool.connect();
      const result = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM hasi_state_v1 WHERE namespace = $1', [namespace]);
      return Number(result.rows[0]?.count);
    } finally { client?.release(); await pool.end(); }
  };
  let cleanupVerified = false;
  try {
    await store.initialize();
    await assertPhysicalNamespaceEmpty(database, namespace);
    assert(await store.compareAndSet(OWNER_MARKER_KEY, null, { purpose: 'managed-plugin-lifecycle', ownerId, namespace, nonce }), 'cleanup_probe_marker_collision');
    assert(await store.compareAndSet('probe:active', null, { ownerId }), 'cleanup_probe_active_collision');
    assert(await store.compareAndSet('probe:expired', null, { ownerId }, Date.now() - 1_000), 'cleanup_probe_expired_collision');
    assert(await store.read('probe:expired') === undefined && await physicalCount() === 3, 'cleanup_probe_expired_fixture_failed');
    let wrongNonceRejected = false;
    try { await removePhysicalStateArtifacts({ database, namespace, ownerId, nonce: 'wrong', keys, validate }); }
    catch (error) { wrongNonceRejected = qualificationFailureCategory(error) === 'managed_namespace_owner_marker_mismatch'; }
    assert(wrongNonceRejected && await physicalCount() === 3, 'cleanup_probe_wrong_nonce_changed_state');
    let invalidRowRejected = false;
    try {
      await removePhysicalStateArtifacts({ database, namespace, ownerId, nonce, keys, validate: key => {
        if (key === 'probe:expired') fail('cleanup_probe_invalid_row');
      } });
    } catch (error) { invalidRowRejected = qualificationFailureCategory(error) === 'cleanup_probe_invalid_row'; }
    assert(invalidRowRejected && await physicalCount() === 3, 'cleanup_probe_invalid_row_changed_state');
    const removed = await removePhysicalStateArtifacts({ database, namespace, ownerId, nonce, keys, validate });
    assert(removed === 2 && await physicalCount() === 1, 'cleanup_probe_exact_physical_delete_failed');
    const last = await removePhysicalOidcArtifacts({ database, namespace, ownerId, nonce,
      tracker: { issuer: `http://127.0.0.1:43210/cleanup-${nonce}`, keys: new Set() } });
    assert(last.removed === 1 && await physicalCount() === 0, 'cleanup_probe_marker_not_removed');
    cleanupVerified = true;
    return { probe: 'managed-physical-state-cleanup-counterprobe', passed: true,
      wrongNonceRejectedWithoutDeletion: true, invalidRowRejectedWithoutDeletion: true,
      expiredPhysicalRowRemoved: true, exactStateRowsRemoved: removed, namespacePhysicallyEmpty: true,
      providerCalls: 0, callerDatabaseRetained: true };
  } finally {
    await store.close();
    if (!cleanupVerified) process.stderr.write(`${JSON.stringify({ probe: 'managed-physical-state-cleanup-counterprobe', cleanupVerified: false, retainedNamespace: namespace })}\n`);
  }
}

function newPendingId(value: unknown): string {
  const proposal = asRecord(value, 'proposal_missing');
  const id = asRecord(proposal.proposal, 'proposal_missing').id;
  assert(typeof id === 'string' && /^[0-9a-f-]{36}$/u.test(id), 'proposal_id_invalid');
  return id;
}

async function main(): Promise<Record<string, unknown>> {
  requireExplicitOptIn();
  assertNoPostgresEnvironment();
  const databaseUrl = process.env.TEST_DATABASE_URL;
  const database = qualificationDatabase(databaseUrl);
  const dockerSocket = f.dockerSocketPath();
  f.assertLocalNodeImage();

  const nonce = randomUUID().replaceAll('-', '').slice(0, 12);
  const scope = `managed-lifecycle-${nonce}`;
  const ownerId = `managed-qualifier-${nonce}`;
  const installationId = `reference-${nonce}`;
  const networks: [string, string] = [`hasi-managed-${nonce}-a`, `hasi-managed-${nonce}-b`];
  const relayNetwork = `hasi-managed-${nonce}-relay`;
  const pluginServiceToken = randomUUID().replaceAll('-', '').padEnd(43, 'x').slice(0, 43);
  const publisherKeys = generateKeyPairSync('ed25519');
  const authorityKeys = generateKeyPairSync('ed25519');
  const publisher: PublisherApproval = {
    publisherId: `qualification-publisher-${nonce}`,
    publicKey: publisherKeys.publicKey,
    sourceRegistryPrefix: REPOSITORY,
    allowedPluginIds: [PLUGIN_ID],
  };
  const serviceTokenAssignment = { name: 'SERVICE_TOKEN', secretRef: `token-${nonce}` } as const;
  const publicKeyAssignment = { name: 'PUBLIC_KEY', secretRef: `key-${nonce}` } as const;
  const secretAssignments = [serviceTokenAssignment, publicKeyAssignment] as const;
  const portA = await f.ephemeralLoopbackPort();
  let portB = await f.ephemeralLoopbackPort();
  while (portB === portA) portB = await f.ephemeralLoopbackPort();
  const rpcPort = await f.ephemeralLoopbackPort();
  let gatewayPort = await f.ephemeralLoopbackPort();
  while ([portA, portB, rpcPort].includes(gatewayPort)) gatewayPort = await f.ephemeralLoopbackPort();
  const apiPort = await f.ephemeralLoopbackPort();
  const apiOrigin = `http://127.0.0.1:${String(apiPort)}`;
  const databaseNamespace = `production:${scope}`;
  const store = new PostgresJsonStore(databaseNamespace, { poolConfig: { ...database, max: 4 } });
  const baselineContainers = exactFullContainerList();
  const root = await mkdtemp(join(tmpdir(), 'hasi-managed-plugin-lifecycle-'));
  const images: ImageRecord[] = [];
  const attemptedNetworks: string[] = [];
  const commandIds: string[] = [];
  const proposals: string[] = [];
  const oidcArtifacts: OidcArtifactTracker = { issuer: '', keys: new Set<string>() };
  const runtimeOperationIds = new Set<string>();
  let identityProvider: Awaited<ReturnType<typeof startTestIdp>> | undefined;
  let worker: Worker | undefined;
  let app: Api | undefined;
  let routes: PluginRouteController | undefined;
  let guardedFetch: ReturnType<typeof createPluginFetch> | undefined;
  let storeInitialized = false;
  let cleanupVerified = true;
  let namespaceOwnershipClaimed = false;
  let stateKeysRemoved = 0;
  let expiredOidcKeysRemoved = 0;
  let physicallyMissingOidcKeys = 0;
  let discoveredOidcKeys = 0;
  let containersRemoved = 0;
  let networksRemoved = 0;
  let imagesRemoved = 0;
  let routeWithdrawn = false;
  let gatewayMcpSuccesses = 0;
  const gatewayMcpStatusCounts: Record<string, number> = {};
  const toolApiStatusCounts: Record<string, number> = {};
  let report: Record<string, unknown> = { qualification: 'managed-reference-plugin-lifecycle', qualified: false };
  let blocker = 'qualification_failed';
  let configSha256: string | undefined;
  const releases: ArtifactRelease[] = [];
  let pluginSourceHashes: Record<string, string> = {};
  let authoritySubjects: string[] = [];
  const managedStageOutcomes: Record<'v1' | 'v2', {
    afterStage?: ManagedPluginView['status'];
    afterApproval?: ManagedPluginView['status'];
  }> = { v1: {}, v2: {} };

  const apiCall = async (method: 'GET' | 'POST', path: string, cookie?: string, payload?: object) => {
    if (!app) fail('api_not_started');
    const headers: Record<string, string> = { host: API_ORIGIN_HOST };
    if (cookie) headers.cookie = cookie;
    if (method === 'POST') headers.origin = apiOrigin;
    const response = await app.inject({ method, url: path, headers, ...(payload !== undefined ? { payload } : {}) });
    if (path === '/api/tools/call') {
      const code = String(response.statusCode);
      toolApiStatusCounts[code] = (toolApiStatusCounts[code] ?? 0) + 1;
    }
    return response;
  };
  const captureRuntimeOperations = (): void => {
    for (const id of exactFullContainerList()) {
      if (baselineContainers.has(id)) continue;
      const fields = f.runDocker(['container', 'inspect', '--format', '{{.Id}}|{{.Name}}|{{json .Config.Labels}}', id],
        'managed_container_identity_inspection_failed').split('|');
      const labels = asRecord(JSON.parse(fields[2] ?? '{}') as unknown, 'managed_container_labels_invalid');
      assert(fields[0] === id && typeof fields[1] === 'string' && fields[1].startsWith('/')
        && labels['hasi.owner'] === ownerId && labels['hasi.managed-by'] === DOCKER_PLUGIN_MANAGED_VALUE
        && labels['hasi.installation'] === installationId, 'managed_container_identity_mismatch');
      const operationId = labels['hasi.operation'];
      assert(typeof operationId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(operationId),
        'managed_container_operation_identity_missing');
      runtimeOperationIds.add(operationId);
    }
  };
  const getView = async (adminCookie: string): Promise<ManagedPluginView> => {
    const response = await apiCall('GET', '/api/admin/managed-plugins', adminCookie);
    assert(response.statusCode === 200, 'managed_admin_list_failed');
    const body = parseJsonBody(response, 'managed_admin_list_invalid');
    assert(Array.isArray(body.installations), 'managed_installations_missing');
    const match = (body.installations as unknown[]).map(value => managedPluginViewSchema.parse(value)).find(value => value.id === installationId);
    assert(match, 'managed_installation_not_listed');
    return match;
  };
  const command = async (adminCookie: string, operation: 'stage' | 'approve' | 'activate' | 'rollback', releaseId?: string): Promise<ManagedPluginView> => {
    const before = gatewayMcpSuccesses;
    const current = await getView(adminCookie);
    const commandId = randomUUID();
    commandIds.push(commandId);
    const input = managedPluginCommandSchema.parse({ commandId, expectedState: current.stateToken, operation,
      ...(operation === 'stage' ? { releaseId } : {}) });
    const response = await apiCall('POST', `/api/admin/managed-plugins/${installationId}/commands`, adminCookie, input);
    assert(response.statusCode === 200, `managed_${operation}_route_failed`);
    const result = parseJsonBody(response, `managed_${operation}_response_invalid`);
    assert(result.commandId === commandId && result.status === 'completed', `managed_${operation}_not_completed`);
    managedPluginViewSchema.parse(result.view);
    if (operation === 'stage') captureRuntimeOperations();
    const status = await apiCall('GET', `/api/admin/managed-plugins/${installationId}/commands/${commandId}`, adminCookie);
    assert(status.statusCode === 200, `managed_${operation}_status_failed`);
    const statusResult = parseJsonBody(status, `managed_${operation}_status_invalid`);
    assert(statusResult.commandId === commandId && statusResult.status === 'completed', `managed_${operation}_status_not_completed`);
    assert(gatewayMcpSuccesses === before, `managed_${operation}_status_or_command_invoked_gateway_mcp`);
    return managedPluginViewSchema.parse(statusResult.view);
  };
  const readStatus = async (studentCookie: string): Promise<Record<string, unknown>> => {
    const response = await apiCall('POST', '/api/tools/call', studentCookie, {
      pluginId: installationId, name: 'read_status', arguments: {}, source: 'model', requiredEffect: 'read',
    });
    assert(response.statusCode === 200, 'managed_api_read_status_failed');
    return parseJsonBody(response, 'managed_api_read_status_invalid');
  };
  const prepare = async (studentCookie: string): Promise<string> => {
    const response = await apiCall('POST', '/api/tools/call', studentCookie, {
      pluginId: installationId, name: 'prepare_mark', arguments: {}, source: 'model',
    });
    assert(response.statusCode === 200, 'managed_api_prepare_failed');
    const id = newPendingId(parseJsonBody(response, 'managed_api_prepare_invalid'));
    proposals.push(id);
    return id;
  };
  const observeReadOnly = async (studentCookie: string, proposalId: string, expectedStatus: number): Promise<void> => {
    const before = gatewayMcpSuccesses;
    const status = await apiCall('GET', `/api/proposals/${proposalId}`, studentCookie);
    assert(status.statusCode === expectedStatus, 'proposal_status_route_result_mismatch');
    const tools = await apiCall('GET', '/api/tools', studentCookie);
    assert(tools.statusCode === 200, 'managed_tool_list_reload_failed');
    const plugins = await apiCall('GET', '/api/plugins', studentCookie);
    assert(plugins.statusCode === 200, 'managed_plugin_list_reload_failed');
    assert(gatewayMcpSuccesses === before, 'proposal_status_or_reload_invoked_gateway_mcp');
  };
  const rejectOldProposal = async (studentCookie: string, proposalId: string): Promise<void> => {
    const before = gatewayMcpSuccesses;
    const status = await apiCall('GET', `/api/proposals/${proposalId}`, studentCookie);
    assert(status.statusCode === 409, 'stale_proposal_status_was_not_rejected');
    const confirm = await apiCall('POST', `/api/proposals/${proposalId}/confirm`, studentCookie, {});
    assert(confirm.statusCode === 409, 'stale_proposal_confirmation_was_not_rejected');
    const failure = parseJsonBody(confirm, 'stale_proposal_confirmation_error_invalid');
    assert(failure.code === 'proposal_invalidated', 'stale_proposal_invalidation_code_missing');
    const record = await store.read(`proposal:${proposalId}`);
    assert(record !== undefined, 'stale_proposal_record_missing');
    const proposal = asRecord(record.value, 'stale_proposal_record_invalid');
    assert(proposal.status === 'invalidated', 'stale_proposal_did_not_persist_invalidation');
    assert(gatewayMcpSuccesses === before, 'stale_proposal_status_or_confirmation_invoked_gateway_mcp');
  };

  try {
    phase = 'database-and-docker-preflight';
    await store.initialize(); storeInitialized = true;
    await assertPhysicalNamespaceEmpty(database, databaseNamespace);
    assert(await store.compareAndSet(OWNER_MARKER_KEY, null, {
      purpose: 'managed-plugin-lifecycle', ownerId, namespace: databaseNamespace, nonce,
    }), 'managed_namespace_owner_marker_claim_failed');
    namespaceOwnershipClaimed = true;
    const keyCheck = [
      `plugin-settings:v1:${digest({ scope, instanceId: installationId })}`,
      `hasi:plugin-route:v1:${digest(scope)}:${digest([ownerId, installationId])}`,
      `hasi:plugin-deployment:v1:${digest(scope)}:${digest(installationId)}`,
      `hasi:plugin-registry:v1:${digest({ scope, pluginId: installationId })}`,
      `plugin-connection:v1:${digest({ scope, id: installationId })}`,
    ];
    for (const key of keyCheck) assert(await store.read(key) === undefined, 'managed_qualification_state_collision');

    phase = 'offline-artifacts';
    for (const name of networks) { attemptedNetworks.push(name); f.createQualificationNetwork(name, ownerId, true); }
    attemptedNetworks.push(relayNetwork); f.createQualificationNetwork(relayNetwork, ownerId, false);
    const labelsA = portA;
    const labelsB = portB;
    const provisionalPublisher: PublisherApproval = {
      ...publisher,
      sourceRegistryPrefix: REPOSITORY,
    };
    pluginSourceHashes = Object.fromEntries(await Promise.all(SOURCE_FILES.map(async (name): Promise<[string, string]> => [
      `examples/reference-plugin/${name}`, sha256(await readFile(join(ROOT, 'examples/reference-plugin', name))),
    ])));
    releases.push(await buildRelease({ root, version: '1.0.0', suffix: 'v1', ownerId, networkName: networks[0], hostPort: labelsA,
      publisher: provisionalPublisher, publisherPrivateKey: publisherKeys.privateKey, images }));
    releases.push(await buildRelease({ root, version: '1.1.0', suffix: 'v2', ownerId, networkName: networks[1], hostPort: labelsB,
      publisher: provisionalPublisher, publisherPrivateKey: publisherKeys.privateKey, images }));
    const releaseV1 = releases[0]; const releaseV2 = releases[1];
    assert(releaseV1 && releaseV2 && releaseV1.releaseDigest !== releaseV2.releaseDigest && releaseV1.manifest.version === '1.0.0' && releaseV2.manifest.version === '1.1.0', 'managed_release_pair_invalid');
    const sourceCatalog = [releaseV1, releaseV2].map(release => ({ id: release.id, envelope: release.envelope, manifest: release.manifest,
      launch: release.launch, secretAssignments, license: 'GPL-3.0-only', inventoryDigest: release.artifact.artifactSha256 }));
    const installerConfig = {
      version: 1, scope, ownerId, rpcPort, gatewayPort, socketPath: dockerSocket,
      internalNetworks: networks, relayNetwork,
      publishers: [{ publisherId: publisher.publisherId,
        publicKey: publisherKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        sourceRegistryPrefix: REPOSITORY, allowedPluginIds: [PLUGIN_ID], revoked: false }],
      installations: [{ id: installationId, label: 'Synthetic managed reference plugin', pluginId: PLUGIN_ID,
        configurationSchemaVersion: 1, restorePlans: [], releases: sourceCatalog }],
      credentials: { [installationId]: {
        transport: { environmentName: 'HASI_PLUGIN_SECRET_TRANSPORT', revision: 'transport-r1' },
        slots: {
          [secretAssignments[0].secretRef]: { environmentName: 'HASI_PLUGIN_SECRET_SERVICE_TOKEN', revision: 'service-token-r1' },
          [secretAssignments[1].secretRef]: { environmentName: 'HASI_PLUGIN_SECRET_PUBLIC_KEY', revision: 'runtime-key-r1' },
        },
      } },
    };
    const configPath = join(root, 'installer-config.json');
    const configBytes = `${JSON.stringify(installerConfig, null, 2)}\n`;
    await writeFile(configPath, configBytes, { mode: 0o600, flag: 'wx' });
    configSha256 = sha256(configBytes);

    phase = 'synthetic-authority-and-managed-worker';
    identityProvider = await startTestIdp({ mode: 'test', clientId: API_CLIENT_ID,
      redirectUri: `${apiOrigin}/api/auth/callback`, subjects: [
        { subject: 'managed-journey-admin', label: 'Synthetic administrator' },
        { subject: 'managed-journey-student', label: 'Synthetic student' },
      ] });
    oidcArtifacts.issuer = identityProvider.issuer;
    const adminSubject = stableOidcSubject(identityProvider.issuer, 'managed-journey-admin');
    const studentSubject = stableOidcSubject(identityProvider.issuer, 'managed-journey-student');
    authoritySubjects = [adminSubject, studentSubject];
    const authority = new ProductionAuthorityDirectory(store, authorityKeys.privateKey, scope);
    const admin: Persona = { id: adminSubject, displayName: 'Synthetic lifecycle administrator', role: 'admin',
      actor: { subject: adminSubject, permissions: ['plugins:manage'] } };
    const student: Persona = { id: studentSubject, displayName: 'Synthetic lifecycle student', role: 'student',
      actor: { subject: studentSubject, permissions: ['reference:read', 'reference:prepare', 'reference:execute'], claims: { 'reference.account': ACCOUNT } } };
    assert(await authority.replace(adminSubject, null, admin), 'managed_admin_authority_seed_failed');
    assert(await authority.replace(studentSubject, null, student), 'managed_student_authority_seed_failed');
    const workerEnvironment = {
      HASI_MODE: 'production', HASI_MANAGED_INSTALLER: '1', HASI_INSTALLER_CONFIG: configPath,
      DATABASE_URL: databaseUrl,
      HASI_PRIVATE_KEY: authorityKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      HASI_PLUGIN_SECRET_TRANSPORT: pluginServiceToken,
      HASI_PLUGIN_SECRET_SERVICE_TOKEN: pluginServiceToken,
      HASI_PLUGIN_SECRET_PUBLIC_KEY: authorityKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    };
    worker = startWorkerProcess(workerEnvironment);
    await worker.ready();
    const rpcOrigin = `http://127.0.0.1:${String(rpcPort)}`;
    const gatewayOrigin = `http://127.0.0.1:${String(gatewayPort)}`;
    const contractClient = createManagedPluginContractClient({ origin: rpcOrigin, privateKey: authorityKeys.privateKey, scope });
    const managedAdmin = createManagedPluginRpcClient({ origin: rpcOrigin, privateKey: authorityKeys.privateKey, scope });
    assert(await contractClient.read(installationId) === null, 'inactive_managed_contract_was_adopted');
    const initialCatalog = await managedAdmin.list(adminSubject);
    assert(initialCatalog.installations[0]?.status === 'empty', 'managed_worker_initial_state_invalid');

    phase = 'api-registry-private-rpc-composition';
    const sourcePolicy: NonNullable<ApprovedPluginSource['registration']['sourcePolicy']> = {
      sourceId: 'managed-lifecycle-qualification', revision: '1', dataClasses: ['synthetic_demo'],
    };
    const v1 = releaseV1;
    const approvedSource: ApprovedPluginSource = {
      id: installationId,
      label: 'Synthetic managed reference plugin',
      registration: {
        instanceId: installationId,
        endpoint: `${gatewayOrigin}/api/plugin-deployments/${installationId}/mcp`,
        serviceToken: pluginServiceToken,
        expectedManifestDigest: digest(v1.manifest),
        allowLoopback: false,
        sourcePolicy,
      },
    };
    const settings = new PluginSettingsStore(authorityKeys.privateKey, store, scope);
    routes = new PluginRouteController({ store, scope, ownerId });
    const binding = new PluginDeploymentBinding({ routes, ownerId,
      readAuthoritativeRevision: async id => (await settings.read(id, v1.manifest)).activeRevision });
    guardedFetch = createPluginFetch({ origins: [gatewayOrigin], allowLoopback: false,
      operatorManagedLoopbackOrigin: gatewayOrigin, maxResponseBytes: 2 * 1024 * 1024 });
    const countedFetch: typeof fetch = async (input, init) => {
      const raw = typeof input === 'string' || input instanceof URL ? input.toString() : input.url;
      const url = new URL(raw);
      const fetcher = guardedFetch;
      if (!fetcher) fail('guarded_fetch_not_started');
      const response = await fetcher(input, init);
      if (url.origin === gatewayOrigin && url.pathname === `/api/plugin-deployments/${installationId}/mcp`) {
        const code = String(response.status);
        gatewayMcpStatusCounts[code] = (gatewayMcpStatusCounts[code] ?? 0) + 1;
        if (response.status >= 200 && response.status < 300) gatewayMcpSuccesses += 1;
      }
      return response;
    };
    const registry = new PluginRegistry(authorityKeys.privateKey, {
      store, scope, envelopeResults: true,
      operatorManagedLoopbackOrigin: gatewayOrigin,
      resolveActor: async subject => (await authority.resolve(subject))?.actor,
      resolveActorSnapshot: async subject => { const snapshot = await authority.resolveSnapshot(subject); return snapshot ? { actor: snapshot.persona.actor, fence: snapshot.fence } : undefined; },
      deploymentBindings: new Map([[installationId, binding]]),
      managedContracts: new Map([[installationId, { initialManifest: v1.manifest, read: () => contractClient.read(installationId) }]]),
      fetch: countedFetch,
    });
    const identity = new OidcIdentityProvider({ mode: 'test', issuer: identityProvider.issuer, clientId: API_CLIENT_ID,
      redirectUri: `${apiOrigin}/api/auth/callback`, store,
      mapIdentity: async verified => {
        const subject = stableOidcSubject(verified.issuer, verified.subject);
        const user = await authority.resolve(subject);
        if (!user) throw new Error('Synthetic identity has no signed authority.');
        return user;
      },
      resolveAuthority: subject => authority.resolve(subject),
    });
    app = await createApi({ mode: 'test', registry, identity, store, origin: apiOrigin,
      allowedHosts: [API_ORIGIN_HOST], pluginCatalog: [approvedSource], managedPlugins: managedAdmin });
    const recordOidcArtifact = (kind: 'transaction' | 'session', token: string) => { trackOidcToken(oidcArtifacts, kind, token); };
    const adminSession = await authenticate(app, identityProvider.issuer, 'managed-journey-admin', apiOrigin, recordOidcArtifact);
    const studentSession = await authenticate(app, identityProvider.issuer, 'managed-journey-student', apiOrigin, recordOidcArtifact);
    const adminCookie = adminSession.cookie;
    const studentCookie = studentSession.cookie;

    phase = 'v1-configuration-and-activation';
    const draft = await apiCall('POST', `/api/admin/managed-plugins/${installationId}/configuration/draft`, adminCookie,
      { revision: 0, values: { label: LABEL }, disabledTools: [] });
    assert(draft.statusCode === 200, 'managed_configuration_draft_failed');
    const draftResult = parseJsonBody(draft, 'managed_configuration_draft_invalid');
    assert(draftResult.revision === 1 && draftResult.activeRevision === 0, 'managed_configuration_draft_revision_invalid');
    const activation = await apiCall('POST', `/api/admin/managed-plugins/${installationId}/configuration/activate`, adminCookie, { revision: 1 });
    assert(activation.statusCode === 200, 'managed_configuration_activation_failed');
    assert(parseJsonBody(activation, 'managed_configuration_activation_invalid').activeRevision === 1, 'managed_configuration_revision_not_active');
    let view = await command(adminCookie, 'stage', 'reference-v1');
    managedStageOutcomes.v1.afterStage = view.status;
    assert(view.status === 'review-required' && view.candidate?.id === 'reference-v1', 'managed_v1_stage_review_required_missing');
    view = await command(adminCookie, 'approve');
    managedStageOutcomes.v1.afterApproval = view.status;
    assert(view.status === 'candidate-ready' && view.candidate?.approved === true, 'managed_v1_approval_missing');
    view = await command(adminCookie, 'activate');
    assert(view.status === 'active' && view.current?.id === 'reference-v1', 'managed_v1_not_activated');
    assert((await contractClient.read(installationId))?.manifest.version === '1.0.0', 'managed_v1_contract_not_live');

    phase = 'v1-api-connection-and-pending-proposal';
    const connect = await apiCall('POST', '/api/admin/plugin-catalog/connect', adminCookie, { sourceId: installationId });
    assert(connect.statusCode === 200, 'managed_api_catalog_connect_failed');
    const beforePackageIdCounterprobe = gatewayMcpSuccesses;
    const packageIdCounterprobe = await apiCall('POST', '/api/tools/call', studentCookie, {
      pluginId: PLUGIN_ID, name: 'read_status', arguments: {}, source: 'model', requiredEffect: 'read',
    });
    assert(packageIdCounterprobe.statusCode === 403 && gatewayMcpSuccesses === beforePackageIdCounterprobe,
      'package_id_counterprobe_not_rejected_before_gateway');
    const v1Read = await readStatus(studentCookie);
    assert(v1Read.label === LABEL && v1Read.version === '1.0.0' && v1Read.account === ACCOUNT && v1Read.actionCount === 0,
      'managed_v1_api_read_mismatch');
    const v1Stats = parseStats(v1Read.qualificationStats);
    assert(v1Stats.marks === 0 && v1Stats.journalRows === 0 && v1Stats.sourceRows === 0, 'managed_v1_initial_effects_nonzero');
    const pendingV1 = await prepare(studentCookie);
    await observeReadOnly(studentCookie, pendingV1, 200);
    const v1PendingRecord = await store.read(`proposal:${pendingV1}`);
    assert(v1PendingRecord !== undefined && asRecord(v1PendingRecord.value, 'v1_pending_invalid').status === 'pending', 'managed_v1_proposal_not_pending');
    const mcpBeforeV2 = gatewayMcpSuccesses;

    phase = 'managed-v2-stage-preflight-approve-activate';
    view = await command(adminCookie, 'stage', 'reference-v2');
    managedStageOutcomes.v2.afterStage = view.status;
    assert(view.status === 'review-required' && view.candidate?.id === 'reference-v2', 'managed_v2_stage_review_required_missing');
    view = await command(adminCookie, 'approve');
    managedStageOutcomes.v2.afterApproval = view.status;
    assert(view.status === 'candidate-ready' && view.candidate?.approved === true, 'managed_v2_approval_missing');
    view = await command(adminCookie, 'activate');
    assert(view.status === 'active' && view.current?.id === 'reference-v2' && view.previous?.id === 'reference-v1', 'managed_v2_not_activated');
    assert((await contractClient.read(installationId))?.manifest.version === '1.1.0', 'managed_v2_contract_not_live');
    await rejectOldProposal(studentCookie, pendingV1);
    await observeReadOnly(studentCookie, pendingV1, 409);
    const v2Read = await readStatus(studentCookie);
    assert(v2Read.version === '1.1.0' && v2Read.label === LABEL && v2Read.actionCount === 0, 'managed_v2_api_read_mismatch');
    const v2InitialStats = parseStats(v2Read.qualificationStats);
    assert(v2InitialStats.marks === 0 && v2InitialStats.journalRows === 0 && v2InitialStats.sourceRows === 0, 'managed_v2_initial_effects_nonzero');
    assert(gatewayMcpSuccesses > mcpBeforeV2, 'managed_v2_api_reads_did_not_reach_gateway');

    phase = 'managed-disable-reenable';
    const pendingV2Toggle = await prepare(studentCookie);
    await observeReadOnly(studentCookie, pendingV2Toggle, 200);
    const v2PendingRead = await readStatus(studentCookie);
    assert(v2PendingRead.version === '1.1.0' && v2PendingRead.actionCount === 0, 'managed_v2_pending_read_mismatch');
    const beforeToggle = gatewayMcpSuccesses;
    const disable = await apiCall('POST', `/api/admin/plugins/${installationId}/enabled`, adminCookie, { enabled: false });
    assert(disable.statusCode === 200, 'managed_admin_disable_failed');
    const disabledList = await apiCall('GET', '/api/plugins', studentCookie);
    assert(disabledList.statusCode === 200, 'managed_disabled_status_reload_failed');
    await rejectOldProposal(studentCookie, pendingV2Toggle);
    const enable = await apiCall('POST', `/api/admin/plugins/${installationId}/enabled`, adminCookie, { enabled: true });
    assert(enable.statusCode === 200, 'managed_admin_reenable_failed');
    await rejectOldProposal(studentCookie, pendingV2Toggle);
    await observeReadOnly(studentCookie, pendingV2Toggle, 409);
    assert(gatewayMcpSuccesses === beforeToggle, 'managed_disable_reenable_or_stale_status_invoked_gateway_mcp');
    const afterReenable = await readStatus(studentCookie);
    assert(afterReenable.version === '1.1.0' && afterReenable.actionCount === 0, 'managed_reenable_did_not_restore_v2_read');

    phase = 'managed-v2-pending-and-rollback-v1';
    const pendingV2Rollback = await prepare(studentCookie);
    await observeReadOnly(studentCookie, pendingV2Rollback, 200);
    const rollbackRead = await readStatus(studentCookie);
    assert(rollbackRead.version === '1.1.0' && rollbackRead.actionCount === 0, 'managed_v2_rollback_pending_read_mismatch');
    view = await command(adminCookie, 'rollback');
    assert(view.status === 'active' && view.current?.id === 'reference-v1' && view.previous?.id === 'reference-v2', 'managed_rollback_to_v1_failed');
    assert((await contractClient.read(installationId))?.manifest.version === '1.0.0', 'managed_rollback_v1_contract_not_live');
    await rejectOldProposal(studentCookie, pendingV2Rollback);
    await observeReadOnly(studentCookie, pendingV2Rollback, 409);
    const afterRollback = await readStatus(studentCookie);
    assert(afterRollback.version === '1.0.0' && afterRollback.label === LABEL && afterRollback.actionCount === 0, 'managed_rollback_v1_api_read_mismatch');
    const rollbackStats = parseStats(afterRollback.qualificationStats);
    assert(rollbackStats.marks === 0 && rollbackStats.journalRows === 0 && rollbackStats.sourceRows === 0, 'rollback_container_inherited_old_effects');

    phase = 'post-rollback-explicit-api-confirmation';
    const finalPending = await prepare(studentCookie);
    await observeReadOnly(studentCookie, finalPending, 200);
    const finalBefore = await readStatus(studentCookie);
    assert(finalBefore.version === '1.0.0' && finalBefore.actionCount === 0, 'final_v1_preconfirmation_read_mismatch');
    const beforeConfirm = gatewayMcpSuccesses;
    const confirmed = await apiCall('POST', `/api/proposals/${finalPending}/confirm`, studentCookie, {});
    assert(confirmed.statusCode === 200, 'explicit_api_confirmation_failed');
    const confirmBody = parseJsonBody(confirmed, 'explicit_api_confirmation_invalid');
    assert(confirmBody.confirmed === true && confirmBody.actionCount === 1 && confirmBody.label === LABEL && confirmBody.account === ACCOUNT,
      'explicit_api_confirmation_effect_invalid');
    const afterConfirm = gatewayMcpSuccesses;
    assert(afterConfirm > beforeConfirm, 'explicit_confirmation_did_not_reach_gateway');
    const proposalBeforeReplay = await store.read(`proposal:${finalPending}`);
    assert(proposalBeforeReplay !== undefined, 'confirmed_proposal_record_missing');
    const proposalStateBeforeReplay = asRecord(proposalBeforeReplay.value, 'confirmed_proposal_record_invalid');
    assert(proposalStateBeforeReplay.status === 'confirmed' && typeof proposalStateBeforeReplay.executionId === 'string', 'confirmed_execution_journal_identity_missing');
    const repeated = await apiCall('POST', `/api/proposals/${finalPending}/confirm`, studentCookie, {});
    assert(repeated.statusCode === 200, 'repeated_confirmation_failed');
    const repeatedBody = parseJsonBody(repeated, 'repeated_confirmation_invalid');
    assert(repeatedBody.confirmed === true && repeatedBody.actionCount === 1, 'repeated_confirmation_replayed_effect');
    assert(gatewayMcpSuccesses === afterConfirm, 'repeated_confirmation_invoked_gateway_mcp');
    const statusAfterConfirm = await apiCall('GET', `/api/proposals/${finalPending}`, studentCookie);
    assert(statusAfterConfirm.statusCode === 200, 'confirmed_proposal_status_failed');
    assert(gatewayMcpSuccesses === afterConfirm, 'confirmed_proposal_status_invoked_gateway_mcp');
    const afterReplayAndStatus = gatewayMcpSuccesses;
    const proposalAfterReplay = await store.read(`proposal:${finalPending}`);
    assert(proposalAfterReplay !== undefined, 'confirmed_proposal_record_missing_after_replay');
    const finalProposal = asRecord(proposalAfterReplay.value, 'confirmed_proposal_record_invalid_after_replay');
    assert(finalProposal.status === 'confirmed' && finalProposal.executionId === proposalStateBeforeReplay.executionId, 'repeated_confirmation_changed_execution_identity');
    const finalRead = await readStatus(studentCookie);
    assert(finalRead.version === '1.0.0' && finalRead.actionCount === 1, 'final_action_count_not_exactly_one');
    const finalStats = parseStats(finalRead.qualificationStats);
    assert(finalStats.marks === 1 && finalStats.journalRows === 1 && finalStats.sourceRows === 1, 'mark_source_or_journal_count_not_exactly_one');

    report = {
      qualification: 'managed-reference-plugin-lifecycle',
      qualified: true,
      scope: 'isolated-local-managed-runtime; instrumented reference source derivative; synthetic-only OIDC and credentials',
      confirmationEvidence: 'explicit-API-confirm-route-only; not browser-click evidence',
      journey: {
        activatedV1: true,
        barePackageIdRejectedBeforeGateway: true,
        stagedPreflightApprovedAndActivatedV2: true,
        stageOutcomes: managedStageOutcomes,
        v1ProposalRejectedAfterV2: true,
        adminDisableReenableKeepsV2ProposalInvalid: true,
        managedRollbackToV1: true,
        v2ProposalRejectedAfterRollback: true,
        postRollbackApiConfirmation: true,
      },
      effects: { ...finalStats, apiExecutionId: finalProposal.executionId, actionCount: finalRead.actionCount,
        gatewayMcpSuccessfulUpstreamRequests: gatewayMcpSuccesses, gatewayMcpStatusCounts, toolApiStatusCounts,
        confirmationGatewayMcpDelta: afterConfirm - beforeConfirm,
        repeatedConfirmationAndStatusGatewayMcpDelta: afterReplayAndStatus - afterConfirm,
        finalReadGatewayMcpDelta: gatewayMcpSuccesses - afterReplayAndStatus },
      identities: {
        ownerId, installationId, scope,
        workerProcess: { pid: worker.pid, parentPid: process.pid, separate: worker.pid !== process.pid },
        approvedApiSource: { id: approvedSource.id, sourcePolicy },
        sourceFilesFromWorkspace: pluginSourceHashes,
        installerConfigurationSha256: configSha256,
        artifacts: releases.map(release => ({ id: release.id, version: release.manifest.version,
          instrumentedSourceTreeSha256: release.sourceTreeSha256, instrumentedSourceFiles: release.sourceFiles,
          artifactSha256: release.evidence.artifactSha256,
          artifactManifestSha256: release.evidence.artifactManifestSha256,
          manifestDigest: release.evidence.manifestDigest,
          imageId: release.imageId, immutableImage: release.imageReference, releaseDigest: release.releaseDigest })),
      },
      gatewayOrigin: `http://127.0.0.1:${String(gatewayPort)}`,
      cleanup: { verified: true, containersRemoved, networksRemoved, imagesRemoved, stateKeysRemoved },
    };
  } catch (error) {
    const failureCategory = safeFailureCategory(error);
    blocker = 'managed_plugin_lifecycle_qualification_failed';
    report = { qualification: 'managed-reference-plugin-lifecycle', qualified: false, phase, blocker, failureCategory,
      ownerId, installationId, scope, gatewayMcpSuccessfulUpstreamRequests: gatewayMcpSuccesses, gatewayMcpStatusCounts, toolApiStatusCounts,
      stageOutcomes: managedStageOutcomes,
      identities: { installerConfigurationSha256: configSha256,
        artifacts: releases.map(release => ({ id: release.id, version: release.manifest.version,
          artifactSha256: release.evidence.artifactSha256, manifestDigest: release.evidence.manifestDigest,
          imageId: release.imageId, immutableImage: release.imageReference, releaseDigest: release.releaseDigest })) } };
  } finally {
    try {
      if (routes) {
        const route = await routes.read({ ownerId, installationId });
        if (route.active) {
          await routes.withdraw({ ownerId, installationId, operationId: `cleanup-${randomUUID()}`,
            currentDeploymentId: route.active.deploymentId, currentReleaseDigest: route.active.releaseDigest,
            configurationRevision: route.configurationRevision });
        }
        routeWithdrawn = true;
      } else routeWithdrawn = true;
    } catch { cleanupVerified = false; }
    try { await app?.close(); } catch { cleanupVerified = false; }
    try { await worker?.close(); } catch { cleanupVerified = false; }
    try { await identityProvider?.close(); } catch { cleanupVerified = false; }
    try { await guardedFetch?.close(); } catch { cleanupVerified = false; }

    const ownedContainers: OwnedContainer[] = [];
    if (routeWithdrawn) {
      try {
        const after = exactFullContainerList();
        const added = [...after].filter(id => !baselineContainers.has(id));
        for (const id of added) {
          const fields = f.runDocker(['container', 'inspect', '--format', '{{.Id}}|{{.Name}}|{{json .Config.Labels}}', id], 'managed_container_cleanup_inspection_failed').split('|');
          const labels = asRecord(JSON.parse(fields[2] ?? '{}') as unknown, 'managed_container_labels_invalid');
          assert(fields[0] === id && typeof fields[1] === 'string' && fields[1].startsWith('/')
            && labels['hasi.owner'] === ownerId && labels['hasi.managed-by'] === DOCKER_PLUGIN_MANAGED_VALUE,
          'managed_container_cleanup_owner_mismatch');
          const operationId = labels['hasi.operation'];
          if (typeof operationId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(operationId)) runtimeOperationIds.add(operationId);
          ownedContainers.push({ id, ...(typeof operationId === 'string' ? { operationId } : {}) });
        }
        for (const container of ownedContainers) {
          f.runDocker(['container', 'rm', '--force', container.id], 'managed_owned_container_cleanup_failed');
          containersRemoved += 1;
        }
        const restored = exactFullContainerList();
        if (restored.size !== baselineContainers.size || [...restored].some(id => !baselineContainers.has(id))) cleanupVerified = false;
      } catch { cleanupVerified = false; }
      if (cleanupVerified) {
        for (const name of [...attemptedNetworks].reverse()) {
          try { if (!f.removeOwnedNetwork(name, ownerId)) cleanupVerified = false; else networksRemoved += 1; }
          catch { cleanupVerified = false; }
        }
      }
      if (cleanupVerified) {
        for (const image of [...images].reverse()) {
          try { if (!f.removeOwnedImage(image.tag, image.id, ownerId)) cleanupVerified = false; else imagesRemoved += 1; }
          catch { cleanupVerified = false; }
        }
      }
    } else cleanupVerified = false;

    if (storeInitialized && !namespaceOwnershipClaimed) cleanupVerified = false;
    if (storeInitialized && namespaceOwnershipClaimed && cleanupVerified) {
      const cleanupKeys = new Set<string>([
        `plugin-settings:v1:${digest({ scope, instanceId: installationId })}`,
        `hasi:plugin-route:v1:${digest(scope)}:${digest([ownerId, installationId])}`,
        `hasi:plugin-deployment:v1:${digest(scope)}:${digest(installationId)}`,
        `hasi:plugin-registry:v1:${digest({ scope, pluginId: installationId })}`,
        `plugin-connection:v1:${digest({ scope, id: installationId })}`,
        ...authoritySubjects.map(subject => `authority:v1:${sha256(subject)}`),
        ...commandIds.flatMap(commandId => {
          const prefix = `managed-plugin-command:v1:${digest(scope)}:${digest([installationId, commandId])}`;
          return [`${prefix}:intent`, `${prefix}:completion`];
        }),
        ...[...runtimeOperationIds].map(operationId => `plugin-runtime-credentials:v1:${digest(scope)}:${digest([installationId, operationId])}`),
        ...proposals.flatMap(proposalId => {
          const scopeDigest = digest(scope);
          const eventId = digest({ domain: 'hasi:proposal-invalidation-event-id:v1', scopeDigest, proposalIdDigest: digest(proposalId) });
          return [`proposal:${proposalId}`, `proposal-invalidation-audit:v1:${scopeDigest}:${eventId}`];
        }),
      ]);
      try {
        stateKeysRemoved += await removePhysicalStateArtifacts({ database, namespace: databaseNamespace, ownerId, nonce,
          keys: cleanupKeys, validate: (key, value) => {
            if (key.includes('plugin-route')) {
              const state = asRecord(value, 'managed_route_cleanup_state_invalid');
              assert(state.ownerId === ownerId && state.installationId === installationId, 'managed_route_cleanup_owner_mismatch');
            } else if (key.includes('plugin-deployment')) {
              const state = asRecord(value, 'managed_deployment_cleanup_state_invalid');
              assert(state.installationId === installationId && state.pluginId === PLUGIN_ID, 'managed_deployment_cleanup_owner_mismatch');
            } else if (key.includes('plugin-settings')) {
              const envelope = asRecord(value, 'managed_settings_cleanup_state_invalid');
              const state = asRecord(envelope.value, 'managed_settings_cleanup_state_invalid');
              assert(state.scope === scope && state.instanceId === installationId, 'managed_settings_cleanup_owner_mismatch');
            } else if (key.includes('plugin-registry')) {
              const state = asRecord(value, 'managed_registry_cleanup_state_invalid');
              assert(state.scope === scope && state.pluginId === installationId, 'managed_registry_cleanup_owner_mismatch');
            } else if (key.includes('plugin-connection')) {
              const envelope = asRecord(value, 'managed_connection_cleanup_state_invalid');
              const state = asRecord(envelope.value, 'managed_connection_cleanup_state_invalid');
              assert(state.scope === scope && state.id === installationId, 'managed_connection_cleanup_owner_mismatch');
            } else if (key.includes('authority:')) {
              const envelope = asRecord(value, 'managed_authority_cleanup_state_invalid');
              const state = asRecord(envelope.authority, 'managed_authority_cleanup_state_invalid');
              assert(authoritySubjects.includes(String(state.id)), 'managed_authority_cleanup_owner_mismatch');
            } else if (key.includes('managed-plugin-command')) {
              const envelope = asRecord(value, 'managed_command_cleanup_state_invalid');
              const state = asRecord(envelope.value, 'managed_command_cleanup_state_invalid');
              assert(state.installationId === installationId, 'managed_command_cleanup_owner_mismatch');
            } else if (key.includes('plugin-runtime-credentials')) {
              const envelope = asRecord(value, 'managed_credential_cleanup_state_invalid');
              const state = asRecord(envelope.value, 'managed_credential_cleanup_state_invalid');
              assert(state.installationId === installationId && runtimeOperationIds.has(String(state.operationId)), 'managed_credential_cleanup_owner_mismatch');
            } else if (key.startsWith('proposal:')) {
              const state = asRecord(value, 'managed_proposal_cleanup_state_invalid');
              assert(proposals.includes(String(state.id)), 'managed_proposal_cleanup_owner_mismatch');
            } else if (key.includes('proposal-invalidation-audit')) {
              const envelope = asRecord(value, 'managed_invalidation_cleanup_state_invalid');
              const event = asRecord(envelope.event, 'managed_invalidation_cleanup_state_invalid');
              assert(event.scopeDigest === digest(scope), 'managed_invalidation_cleanup_scope_mismatch');
            } else {
              fail('managed_state_cleanup_key_unclassified');
            }
        } });
      } catch { cleanupVerified = false; }
      if (cleanupVerified) {
        try {
          const oidcCleanup = await removePhysicalOidcArtifacts({ database, namespace: databaseNamespace, ownerId, nonce, tracker: oidcArtifacts });
          stateKeysRemoved += oidcCleanup.removed;
          expiredOidcKeysRemoved = oidcCleanup.expiredRemoved;
          physicallyMissingOidcKeys = oidcCleanup.missingTracked;
          discoveredOidcKeys = oidcCleanup.discovered;
        } catch { cleanupVerified = false; }
      }
    }
    try { if (storeInitialized) await store.close(); } catch { cleanupVerified = false; }
    if (cleanupVerified) { try { await rm(root, { recursive: true, force: true }); } catch { cleanupVerified = false; } }

    if (!cleanupVerified) {
      report = { ...report, qualified: false, blocker: 'cleanup_unconfirmed', primaryBlocker: blocker,
        cleanup: { verified: false, containersRemoved, networksRemoved, imagesRemoved, stateKeysRemoved,
          expiredOidcKeysRemoved, physicallyMissingOidcKeys, discoveredOidcKeys,
          retainedWorkspace: root } };
    } else if (report.qualified === true) {
      report = { ...report, cleanup: { verified: true, containersRemoved, networksRemoved, imagesRemoved, stateKeysRemoved,
        expiredOidcKeysRemoved, physicallyMissingOidcKeys, discoveredOidcKeys } };
    } else {
      report = { ...report, cleanup: { verified: true, containersRemoved, networksRemoved, imagesRemoved, stateKeysRemoved,
        expiredOidcKeysRemoved, physicallyMissingOidcKeys, discoveredOidcKeys } };
    }
  }
  return report;
}

if (process.env.HASI_MANAGED_PLUGIN_STATE_CLEANUP_PROBE === '1') {
  try {
    process.stdout.write(`${JSON.stringify(await runPhysicalStateCleanupCounterprobe(), null, 2)}\n`);
  } catch {
    process.stderr.write(`${JSON.stringify({ probe: 'managed-physical-state-cleanup-counterprobe', passed: false })}\n`);
    process.exitCode = 1;
  }
} else if (process.env.HASI_MANAGED_PLUGIN_CLEANUP_PROBE === '1') {
  try {
    const result = await runOidcCleanupCounterprobe();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch {
    process.stderr.write(`${JSON.stringify({ probe: 'managed-oidc-cleanup-counterprobe', passed: false })}\n`);
    process.exitCode = 1;
  }
} else {
  try {
    const result = await main();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.qualified !== true) process.exitCode = 1;
  } catch {
    process.stderr.write(`${JSON.stringify({ qualification: 'managed-reference-plugin-lifecycle', qualified: false,
      blocker: 'managed_qualification_preflight_failed' })}\n`);
    process.exitCode = 1;
  }
}
