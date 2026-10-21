import { createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { pluginReleaseInventoryDigest } from '@hasi/plugin-sdk/releases';
import { digest, manifestSchema, managedStateValidator, type PluginManifest } from '@hasi/plugin-sdk';
import { managedPluginCommandSchema, managedPluginReviewSchema, type ManagedPluginCommand, type ManagedPluginCommandResult, type ManagedPluginReview, type ManagedPluginView } from '@hasi/plugin-sdk/deployment-admin';
import type { JsonStore } from '@hasi/state';
import { buildPluginContainerLaunchPolicy, PluginDeploymentCoordinator, verifyPluginRelease, type DeploymentDriver, type PluginContainerLaunchOptions, type PluginDeploymentSnapshot, type PluginReleaseIdentity, type PublisherApprovalResolver, type VerifiedPluginRelease, type LogicalSecretAssignment } from './plugin-artifacts.js';
import { PluginSettingsStore } from './plugin-settings.js';
import type { ManagedPluginAdmin, ManagedPluginConfigurationDraft } from './managed-plugin-admin.js';

const opaque = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const releaseSchema = z.strictObject({
  id: opaque, envelope: z.unknown(), manifest: manifestSchema,
  launch: z.custom<PluginContainerLaunchOptions>(value => typeof value === 'object' && value !== null),
  secretAssignments: z.array(z.strictObject({ name: opaque, secretRef: opaque })).max(32),
});
const installationSchema = z.strictObject({
  id: opaque, label: z.string().min(1).max(200), pluginId: opaque,
  configurationSchemaVersion: z.number().int().positive(),
  releases: z.array(releaseSchema).min(1).max(32), restorePlans: z.array(opaque).max(32),
});
export const managedPluginInstallerCatalogSchema = z.array(installationSchema).max(32);
type Installation = z.infer<typeof installationSchema>;
type ApprovedRelease = z.infer<typeof releaseSchema> & { verified: VerifiedPluginRelease };
type ApprovedInstallation = Omit<Installation, 'releases'> & { releases: ApprovedRelease[]; baselineManifest: PluginManifest };
const intentSchema = z.strictObject({ installationId: opaque, subject: z.string().min(1).max(256), command: managedPluginCommandSchema, at: z.iso.datetime(), candidateDigest: sha.nullable() });
const completionSchema = z.strictObject({ installationId: opaque, commandId: z.uuid(), status: z.enum(['completed', 'uncertain']), at: z.iso.datetime() });

export class ManagedPluginInstallerError extends Error {
  constructor(readonly status = 409) { super('Die Plugin-Änderung konnte nicht sicher abgeschlossen werden. Bitte den aktuellen Status prüfen.'); }
}

export interface ManagedPluginInstallerOptions {
  store: JsonStore; scope: string; privateKey: KeyObject;
  driver: DeploymentDriver;
  /** Reloads the operator-owned catalogue; never supplied by HTTP/model/plugin input. */
  readCatalog: () => Promise<unknown>;
  resolvePublisher: PublisherApprovalResolver;
  authorizeAdmin: (subject: string) => Promise<boolean>;
  secretsAuthorized: (installationId: string, assignments: readonly LogicalSecretAssignment[]) => Promise<boolean>;
  secretReady: (installationId: string, name: string, assignments?: readonly LogicalSecretAssignment[]) => boolean;
  /** Fetches the exact staged manifest through the trusted inspected loopback endpoint. */
  preflight: (input: { installationId: string; release: VerifiedPluginRelease; snapshot: PluginDeploymentSnapshot; manifest: PluginManifest }) => Promise<boolean>;
  /** Route/settings convergence is mandatory before coordinator revision sync. */
  synchronizeRoute: (installationId: string, revision: number) => Promise<void>;
}

/** Trusted installer process only. The public API depends on ManagedPluginAdmin,
 * not on this class, its Docker driver or its secret catalogue.
 *
 * Intents and completions are separate signed, append-only CAS records. A lost
 * reply can be read by command ID but never redispatches the mutation. Recovery
 * is an explicit new reconcile command against the coordinator's durable intent.
 */
export class ManagedPluginInstaller implements ManagedPluginAdmin {
  readonly coordinator: PluginDeploymentCoordinator;
  private readonly settings: PluginSettingsStore;
  private readonly publicKey: KeyObject;
  private readonly prefix: string;
  constructor(private readonly options: ManagedPluginInstallerOptions) {
    if (!options.scope || options.scope.length > 128 || options.scope.includes('\0')) throw new TypeError('Invalid installer scope');
    this.prefix = `managed-plugin-command:v1:${digest(options.scope)}:`;
    this.publicKey = createPublicKey(options.privateKey);
    this.settings = new PluginSettingsStore(options.privateKey, options.store, options.scope);
    this.coordinator = new PluginDeploymentCoordinator({
      store: options.store, scope: options.scope, driver: options.driver, resolvePublisher: options.resolvePublisher,
      isCurrentlyTrusted: (release, refs) => this.trusted(release, refs),
      authorizeReview: async ({ installationId, approval, release }) => {
        const record = await this.readIntent(installationId, approval.approvalId);
        if (record?.command.operation !== 'approve' || record.candidateDigest !== release.releaseDigest
          || approval.reviewerId !== `admin:${digest(record.subject)}` || !await options.authorizeAdmin(record.subject)) return false;
        const entry = await this.installation(installationId);
        return approval.restorePlanId === undefined || entry.restorePlans.includes(approval.restorePlanId);
      },
      getConfigurationRevision: async id => String((await this.configuration(id)).activeRevision),
    });
  }

  private async authorize(subject: string) {
    if (!subject || subject.length > 256 || !await this.options.authorizeAdmin(subject)) throw new ManagedPluginInstallerError(403);
  }
  private async catalog(): Promise<ApprovedInstallation[]> {
    const catalog = managedPluginInstallerCatalogSchema.parse(await this.options.readCatalog());
    if (new Set(catalog.map(entry => entry.id)).size !== catalog.length) throw new ManagedPluginInstallerError();
    return catalog.map(entry => {
      if (new Set(entry.releases.map(item => item.id)).size !== entry.releases.length) throw new ManagedPluginInstallerError();
      const releases = entry.releases.flatMap(item => {
        const publisher = z.object({ publisherId: opaque }).parse(item.envelope).publisherId;
        const approval = this.options.resolvePublisher(publisher);
        // Revoked/removed publishers never admit execution. Retain the
        // installation itself so status and exact candidate cleanup still work.
        if (!approval) return [];
        const verified = verifyPluginRelease(item.envelope, id => {
          const current = this.options.resolvePublisher(id);
          return current ? { ...current, revoked: false } : undefined;
        });
        if (verified.pluginId !== entry.pluginId || item.manifest.id !== entry.pluginId
          || verified.version !== item.manifest.version || verified.manifestDigest !== digest(item.manifest)) throw new ManagedPluginInstallerError();
        if (item.manifest.manifestVersion === 2 && item.manifest.managedState) managedStateValidator(item.manifest.managedState.applicationSchema);
        buildPluginContainerLaunchPolicy(verified, item.launch);
        return approval.revoked ? [] : [{ ...item, verified }];
      });
      if (new Set(releases.map(item => item.verified.releaseDigest)).size !== releases.length) throw new ManagedPluginInstallerError();
      const baselineManifest = entry.releases[0]?.manifest;
      if (!baselineManifest) throw new ManagedPluginInstallerError();
      return { ...entry, releases, baselineManifest };
    });
  }
  private async installation(id: string) {
    opaque.parse(id);
    const entry = (await this.catalog()).find(item => item.id === id);
    if (!entry) throw new ManagedPluginInstallerError(404);
    return entry;
  }
  private async trusted(release: VerifiedPluginRelease, refs: readonly LogicalSecretAssignment[]) {
    const assignments = (values: readonly LogicalSecretAssignment[]) => [...values].sort((a, b) => a.name.localeCompare(b.name));
    const matches = (await this.catalog()).filter(entry => entry.releases.some(item => item.verified.releaseDigest === release.releaseDigest && digest(assignments(item.secretAssignments)) === digest(assignments(refs))));
    // A release may be installed twice. Credential admission is checked for the
    // exact installation again at dispatch and by the driver's resolver.
    return matches.length > 0 && (await Promise.all(matches.map(entry => this.options.secretsAuthorized(entry.id, refs)))).every(Boolean);
  }
  async configuration(id: string, releaseDigest?: string) {
    const entry = await this.installation(id);
    const release = releaseDigest ? entry.releases.find(item => item.verified.releaseDigest === releaseDigest) : entry.releases[0];
    if (releaseDigest && !release) throw new ManagedPluginInstallerError();
    const result = await this.settings.describe(id, release?.manifest ?? entry.baselineManifest, name => release !== undefined && this.options.secretReady(id, name, release.secretAssignments));
    return { ...result, ready: release !== undefined && result.ready };
  }
  private async configurationTarget(id: string) {
    const entry = await this.installation(id);
    const state = await this.coordinator.get(id);
    const target = state.candidate?.releaseDigest ?? state.current?.releaseDigest;
    const release = target ? entry.releases.find(item => item.verified.releaseDigest === target) : entry.releases[0];
    if (!release) throw new ManagedPluginInstallerError();
    return { release, state };
  }
  async describeConfiguration(id: string, subject: string) {
    await this.authorize(subject);
    const { release } = await this.configurationTarget(id);
    const result = await this.configuration(id, release.verified.releaseDigest);
    await this.authorize(subject);
    return result;
  }
  async saveConfigurationDraft(id: string, draft: ManagedPluginConfigurationDraft, subject: string) {
    await this.authorize(subject);
    const { release } = await this.configurationTarget(id);
    await this.authorize(subject);
    const result = await this.settings.saveDraft(id, release.manifest, draft, subject);
    await this.authorize(subject);
    return result;
  }
  async activateConfiguration(id: string, revision: number, subject: string) {
    await this.authorize(subject);
    const { release, state } = await this.configurationTarget(id);
    if ((state.status !== 'empty' && state.status !== 'active') || state.candidate) throw new ManagedPluginInstallerError();
    await this.authorize(subject);
    const result = await this.settings.activate(id, release.manifest, revision, subject, name => this.options.secretReady(id, name, release.secretAssignments));
    await this.options.synchronizeRoute(id, result.activeRevision);
    await this.coordinator.synchronizeConfigurationRevision({ installationId: id, expectedRevision: state.configurationRevision, approvedConfigurationRevision: String(result.activeRevision), configurationCompatible: true });
    await this.authorize(subject);
    return result;
  }
  private key(id: string, commandId: string, kind: 'intent' | 'completion') {
    opaque.parse(id); z.uuid().parse(commandId);
    return `${this.prefix}${digest([id, commandId])}:${kind}`;
  }
  private signed(value: unknown) {
    return { value, signature: sign(null, Buffer.from(`${this.prefix}${digest(value)}`), this.options.privateKey).toString('base64url') };
  }
  private verified(raw: unknown) {
    const envelope = z.strictObject({ value: z.unknown(), signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/u) }).parse(raw);
    if (!verify(null, Buffer.from(`${this.prefix}${digest(envelope.value)}`), this.publicKey, Buffer.from(envelope.signature, 'base64url'))) throw new ManagedPluginInstallerError();
    return envelope.value;
  }
  private async readIntent(id: string, commandId: string) {
    const record = await this.options.store.read(this.key(id, commandId, 'intent'));
    if (!record) return undefined;
    const intent = intentSchema.parse(this.verified(record.value));
    if (intent.installationId !== id || intent.command.commandId !== commandId) throw new ManagedPluginInstallerError();
    return intent;
  }
  /** Idempotent setup by the operator process, never an automatic image install. */
  async initialize() {
    for (const entry of await this.catalog()) {
      let state: PluginDeploymentSnapshot;
      try { state = await this.coordinator.get(entry.id); }
      catch {
        // CAS-null in initialize rejects damaged/existing records; no deletion
        // or replacement is permitted when a read failed for another reason.
        state = await this.coordinator.initialize({ installationId: entry.id, pluginId: entry.pluginId, configurationSchemaVersion: entry.configurationSchemaVersion });
      }
      if (state.pluginId !== entry.pluginId || state.configurationSchemaVersion !== entry.configurationSchemaVersion) throw new ManagedPluginInstallerError();
    }
  }
  private releaseView(release: PluginReleaseIdentity | null, entry: ApprovedInstallation): ManagedPluginView['current'] {
    if (!release) return null;
    const approved = entry.releases.find(item => item.verified.releaseDigest === release.releaseDigest);
    return { id: approved?.id ?? `revoked-${release.releaseDigest}`, version: release.version, publisher: release.publisherId, digest: release.releaseDigest, migration: release.stateMigration,
      license: approved?.verified.provenance.license ?? null, inventoryDigest: approved ? pluginReleaseInventoryDigest(approved.verified.provenance) : null, approved: approved !== undefined };
  }
  private async describe(id: string): Promise<{ view: ManagedPluginView; state: PluginDeploymentSnapshot; entry: ApprovedInstallation }> {
    const entry = await this.installation(id);
    const state = await this.coordinator.get(id);
    const selected = entry.releases.find(item => item.verified.releaseDigest === (state.candidate?.releaseDigest ?? state.current?.releaseDigest)) ?? entry.releases[0];
    const settings = await this.configuration(id, selected?.verified.releaseDigest);
    const catalogIdentity = entry.releases.map(release => ({ id: release.id, digest: release.verified.releaseDigest, launch: release.launch, secrets: release.secretAssignments, inventory: pluginReleaseInventoryDigest(release.verified.provenance), license: release.verified.provenance.license }));
    const view: ManagedPluginView = { id, label: entry.label, stateToken: digest({ state, catalogIdentity, restorePlans: entry.restorePlans, settings: { ...settings, schema: settings.schema ?? null } }), status: state.status,
      configurationRevision: state.configurationRevision, configurationReady: settings.ready, current: this.releaseView(state.current, entry), previous: this.releaseView(state.previous, entry), candidate: this.releaseView(state.candidate, entry),
      releases: entry.releases.flatMap(item => { const view = this.releaseView(item.verified, entry); return view?.approved ? [view] : []; }),
      tools: selected?.manifest.tools.map(tool => ({ name: tool.name, title: tool.title, effect: tool.effect })) ?? [] };
    return { view, state, entry };
  }
  private reviewContract(release: ApprovedRelease): ManagedPluginReview['candidate'] {
    const manifest = release.manifest;
    const policy = buildPluginContainerLaunchPolicy(release.verified, release.launch);
    return {
      tools: manifest.tools.map(tool => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        resultSemantics: 'resultSemantics' in tool
          ? { kind: tool.resultSemantics.kind }
          : null,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        effect: tool.effect,
        requiredPermissions: tool.requiredPermissions,
        visibility: 'visibility' in tool ? [...(tool.visibility ?? ['model'])] : ['model'],
        presentationId: 'presentationId' in tool ? tool.presentationId ?? null : null,
      })),
      configurationSchema: manifest.manifestVersion === 2 ? manifest.configuration ?? null : null,
      identityClaims: manifest.manifestVersion === 2 ? [...(manifest.identity?.claims ?? [])] : [],
      secretRequirements: manifest.manifestVersion === 2 ? (manifest.secrets ?? []).map(secret => ({ name: secret.name, required: secret.required })) : [],
      presentations: manifest.manifestVersion === 2 ? manifest.presentations ?? [] : [],
      network: policy.network.mode === 'none' ? { mode: 'none' } : { mode: 'internal', name: policy.network.name },
      ingress: policy.ingress,
      managedState: manifest.manifestVersion === 2 ? manifest.managedState ?? null : null,
    };
  }
  async describeReview(id: string, subject: string): Promise<ManagedPluginReview> {
    await this.authorize(subject);
    const described = await this.describe(id);
    const candidateDigest = described.state.candidate?.releaseDigest;
    // coordinator.get validates the persisted candidate base against the exact
    // current digest before exposing this snapshot.
    if (described.state.status !== 'review-required' || !described.state.candidate || !candidateDigest) throw new ManagedPluginInstallerError();
    const candidate = described.entry.releases.find(item => item.verified.releaseDigest === candidateDigest);
    if (!candidate) throw new ManagedPluginInstallerError();
    const currentDigest = described.state.current?.releaseDigest ?? null;
    const current = currentDigest === null
      ? null
      : described.entry.releases.find(item => item.verified.releaseDigest === currentDigest);
    if (currentDigest !== null && !current) throw new ManagedPluginInstallerError();
    if (!await this.options.secretsAuthorized(id, candidate.secretAssignments)
      || !await this.trusted(candidate.verified, candidate.secretAssignments)) throw new ManagedPluginInstallerError();

    const review = managedPluginReviewSchema.parse({
      installationId: id,
      stateToken: described.view.stateToken,
      currentDigest,
      candidateDigest,
      current: current ? this.reviewContract(current) : null,
      candidate: this.reviewContract(candidate),
    });
    const latest = await this.describe(id);
    if (latest.view.stateToken !== described.view.stateToken
      || !latest.entry.releases.some(item => item.verified.releaseDigest === candidateDigest)
      || (currentDigest !== null && !latest.entry.releases.some(item => item.verified.releaseDigest === currentDigest))
      || latest.state.candidate?.releaseDigest !== candidateDigest
      || (latest.state.current?.releaseDigest ?? null) !== currentDigest) throw new ManagedPluginInstallerError();
    await this.authorize(subject);
    return review;
  }
  async list(subject: string) {
    await this.authorize(subject);
    const installations = await Promise.all((await this.catalog()).map(entry => this.describe(entry.id).then(result => result.view)));
    await this.authorize(subject);
    return { installations };
  }
  async commandStatus(id: string, commandId: string, subject: string): Promise<ManagedPluginCommandResult> {
    await this.authorize(subject);
    const intent = await this.readIntent(id, commandId);
    if (intent?.subject !== subject) throw new ManagedPluginInstallerError(404);
    const completion = await this.options.store.read(this.key(id, commandId, 'completion'));
    const result = completion ? completionSchema.parse(this.verified(completion.value)) : undefined;
    if (result) { if (result.installationId !== id || result.commandId !== commandId) throw new ManagedPluginInstallerError(); }
    // A durable intent is not proof that its executor is still alive. An
    // interrupted/missing completion remains uncertain, never forever running.
    const status = result?.status ?? 'uncertain';
    const { view } = await this.describe(id);
    await this.authorize(subject);
    return { commandId, status, view };
  }
  async command(id: string, raw: ManagedPluginCommand, subject: string): Promise<ManagedPluginCommandResult> {
    const command = managedPluginCommandSchema.parse(raw);
    await this.authorize(subject);
    const existing = await this.readIntent(id, command.commandId);
    if (existing) {
      if (existing.subject !== subject || digest(existing.command) !== digest(command)) throw new ManagedPluginInstallerError();
      return this.commandStatus(id, command.commandId, subject);
    }
    const { view, state, entry } = await this.describe(id);
    if (view.stateToken !== command.expectedState) throw new ManagedPluginInstallerError();
    const intent = intentSchema.parse({ installationId: id, subject, command, at: new Date().toISOString(), candidateDigest: state.candidate?.releaseDigest ?? null });
    if (!await this.options.store.compareAndSet(this.key(id, command.commandId, 'intent'), null, this.signed(intent))) return this.command(id, command, subject);
    let status: 'completed' | 'uncertain' = 'uncertain';
    try {
      await this.authorize(subject);
      // Recheck catalogue/configuration and state after recording the intent.
      if ((await this.describe(id)).view.stateToken !== command.expectedState) throw new ManagedPluginInstallerError();
      await this.dispatch(entry, state, command, subject);
      status = 'completed';
    } catch {
      // Never infer failure/no side effect from an exception. No automatic
      // dispatch retry, new command ID, container delete or route replay.
    }
    const completion = this.signed({ installationId: id, commandId: command.commandId, status, at: new Date().toISOString() });
    await this.options.store.compareAndSet(this.key(id, command.commandId, 'completion'), null, completion);
    return this.commandStatus(id, command.commandId, subject);
  }
  private async dispatch(entry: ApprovedInstallation, state: PluginDeploymentSnapshot, command: ManagedPluginCommand, subject: string) {
    const id = entry.id;
    const requireRelease = async (releaseDigest: string | undefined) => {
      const release = entry.releases.find(item => item.verified.releaseDigest === releaseDigest);
      if (release?.verified.configSchemaVersion !== state.configurationSchemaVersion || !await this.options.secretsAuthorized(id, release.secretAssignments) || !(await this.configuration(id, releaseDigest)).ready) throw new ManagedPluginInstallerError();
      const current = entry.releases.find(item => item.verified.releaseDigest === state.current?.releaseDigest);
      const stateContract = (manifest: PluginManifest) => manifest.manifestVersion === 2 ? manifest.managedState ?? null : null;
      // This version supports unchanged state contracts only. A release label or
      // restore-plan identifier is not a state migration implementation.
      if (state.current && !current) throw new ManagedPluginInstallerError();
      if (current && (current.manifest.mcpVersion !== release.manifest.mcpVersion
        || digest(stateContract(current.manifest)) !== digest(stateContract(release.manifest)))) throw new ManagedPluginInstallerError();
      return release;
    };
    switch (command.operation) {
      case 'stage': {
        const chosen = entry.releases.find(item => item.id === command.releaseId);
        const release = await requireRelease(chosen?.verified.releaseDigest);
        const result = await this.coordinator.stageCandidate({ installationId: id, release: release.envelope, configurationRevision: state.configurationRevision, configurationCompatible: true,
          effectsExpanded: true, permissionsExpanded: true, secretAssignments: release.secretAssignments, launch: release.launch, baseCurrentDigest: state.current?.releaseDigest ?? null });
        if (result.outcome !== 'candidate-ready' && result.outcome !== 'review-required') throw new ManagedPluginInstallerError();
        break;
      }
      case 'approve': {
        const release = await requireRelease(state.candidate?.releaseDigest);
        if (!await this.options.preflight({ installationId: id, release: release.verified, snapshot: state, manifest: release.manifest })) throw new ManagedPluginInstallerError();
        await this.authorize(subject);
        if (command.restorePlanId && !entry.restorePlans.includes(command.restorePlanId)) throw new ManagedPluginInstallerError();
        if (!state.candidate?.stagingOperationId) throw new ManagedPluginInstallerError();
        await this.coordinator.approveCandidate({ installationId: id, candidateDigest: release.verified.releaseDigest, stagingOperationId: state.candidate.stagingOperationId, approval: { approvalId: command.commandId, reviewerId: `admin:${digest(subject)}`, ...(command.restorePlanId ? { restorePlanId: command.restorePlanId } : {}) } });
        break;
      }
      case 'activate': {
        const release = await requireRelease(state.candidate?.releaseDigest);
        if (!await this.options.preflight({ installationId: id, release: release.verified, snapshot: state, manifest: release.manifest })) throw new ManagedPluginInstallerError();
        await this.authorize(subject);
        if (!state.candidate?.stagingOperationId) throw new ManagedPluginInstallerError();
        const result = await this.coordinator.activate({ installationId: id, candidateDigest: release.verified.releaseDigest, stagingOperationId: state.candidate.stagingOperationId, baseCurrentDigest: state.current?.releaseDigest ?? null, configurationRevision: state.configurationRevision });
        if (result.outcome !== 'activated') throw new ManagedPluginInstallerError();
        break;
      }
      case 'cancel':
        if (!state.candidate?.stagingOperationId) throw new ManagedPluginInstallerError();
        if ((await this.coordinator.discardCandidate({ installationId: id, candidateDigest: state.candidate.releaseDigest, stagingOperationId: state.candidate.stagingOperationId, configurationRevision: state.configurationRevision })).candidate) throw new ManagedPluginInstallerError();
        break;
      case 'rollback': {
        const release = await requireRelease(state.previous?.releaseDigest);
        const result = await this.coordinator.rollback({ installationId: id, targetDigest: release.verified.releaseDigest, configurationRevision: state.configurationRevision, configurationCompatible: true });
        if (result.outcome !== 'rolled-back') throw new ManagedPluginInstallerError();
        break;
      }
      case 'synchronize': {
        if ((state.status !== 'empty' && state.status !== 'active') || state.candidate) throw new ManagedPluginInstallerError();
        const settings = await this.configuration(id, state.current?.releaseDigest);
        if (!settings.ready) throw new ManagedPluginInstallerError();
        await this.options.synchronizeRoute(id, settings.activeRevision);
        await this.coordinator.synchronizeConfigurationRevision({ installationId: id, expectedRevision: state.configurationRevision, approvedConfigurationRevision: String(settings.activeRevision), configurationCompatible: true });
        break;
      }
      case 'reconcile':
        if ((await this.coordinator.reconcile(id)).outcome !== 'resolved') throw new ManagedPluginInstallerError();
        break;
    }
  }
}
