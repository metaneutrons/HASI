import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { MemoryJsonStore } from '@hasi/state';
import { MANAGED_STATE_MCP_VERSION, digest, type PluginManifest } from '@hasi/plugin-sdk';
import { managedPluginReviewSchema } from '@hasi/plugin-sdk/deployment-admin';
import { describe, expect, it } from 'vitest';
import { ManagedPluginInstaller } from '../apps/api/src/managed-plugin-installer.js';
import { pluginReleaseSigningBytes, type DeploymentDriver, type UnsignedPluginRelease } from '../apps/api/src/plugin-artifacts.js';
import { TEST_PLUGIN_PROVENANCE } from './plugin-release-fixtures.js';

const installationId = 'calendar-installation';
const subject = 'review-admin';
const signingKeys = generateKeyPairSync('ed25519');
const oldConfiguration = {
  schema: {
    type: 'object',
    properties: { calendarLabel: { type: 'string', maxLength: 64 } },
    additionalProperties: false,
  },
  fields: [{ name: 'calendarLabel', label: 'Calendar label' }],
};
const newConfiguration = {
  schema: {
    type: 'object',
    properties: {
      calendarLabel: { type: 'string', maxLength: 64 },
      includeCancelled: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  fields: [
    { name: 'calendarLabel', label: 'Calendar label' },
    { name: 'includeCancelled', label: 'Include cancelled events' },
  ],
};
const managedState = {
  schemaVersion: 1,
  accountIdentity: { kind: 'claim' as const, name: 'departmentCode' },
  applicationSchema: {
    type: 'object',
    properties: { favouriteCalendar: { type: 'string' } },
    additionalProperties: false,
  },
};

function manifest(version: string, candidate: boolean): PluginManifest {
  const presentation = {
    id: 'calendar-app',
    resourceUri: 'ui://calendar/app.html',
    mimeType: 'text/html;profile=mcp-app' as const,
    sha256: 'c'.repeat(64),
    csp: { connectDomains: ['calendar.example'], resourceDomains: ['assets.example'] },
  };
  return {
    manifestVersion: 2,
    id: 'calendar',
    name: 'Calendar',
    description: 'Synthetic review fixture',
    version,
    apiVersion: '2.0.0',
    mcpVersion: MANAGED_STATE_MCP_VERSION,
    tools: [{
      name: 'calendar.events',
      title: candidate ? 'Write calendar events' : 'Read calendar events',
      description: candidate ? 'Writes approved calendar events.' : 'Reads calendar events.',
      ...(candidate ? { resultSemantics: { kind: 'bookings' as const } } : {}),
      inputSchema: candidate
        ? { type: 'object', properties: { eventId: { type: 'string' }, force: { type: 'boolean' } }, additionalProperties: false }
        : { type: 'object', properties: { eventId: { type: 'string' } }, additionalProperties: false },
      outputSchema: { type: 'object', properties: { accepted: { type: 'boolean' } }, additionalProperties: false },
      effect: candidate ? 'execute' : 'read',
      requiredPermissions: candidate ? ['calendar:write'] : ['calendar:read'],
      ...(candidate ? { visibility: ['app' as const], presentationId: presentation.id } : {}),
    }],
    configuration: candidate ? newConfiguration : oldConfiguration,
    secrets: [{ name: 'calendarApi', required: true }],
    identity: { claims: ['departmentCode'] },
    presentations: candidate ? [presentation] : [],
    managedState,
  };
}

function metadataManifest(version: string, title: string, description: string, kind: 'generic' | 'resources' | 'bookings' | 'knowledge' | 'proposal'): PluginManifest {
  const base = manifest(version, false);
  if (base.manifestVersion !== 2) throw new Error('Expected a v2 manifest');
  return {
    ...base,
    tools: base.tools.map(tool => ({
      ...tool,
      title,
      description,
      visibility: ['app' as const],
      presentationId: 'calendar-app',
      resultSemantics: { kind },
    })),
    presentations: [{
      id: 'calendar-app',
      resourceUri: 'ui://calendar/metadata.html',
      mimeType: 'text/html;profile=mcp-app',
      sha256: 'c'.repeat(64),
      csp: { connectDomains: ['calendar.example'], resourceDomains: ['assets.example'] },
    }],
  };
}

function release(id: string, version: string, candidate: boolean, pluginManifest = manifest(version, candidate)) {
  const unsigned: UnsignedPluginRelease = {
    schemaVersion: 2,
    pluginId: pluginManifest.id,
    version,
    manifestDigest: digest(pluginManifest),
    publisherId: 'calendar-publisher',
    image: `registry.example.test/hasi/calendar@sha256:${id.repeat(64)}`,
    configSchemaVersion: 1,
    stateMigration: 'none',
    provenance: TEST_PLUGIN_PROVENANCE,
  };
  return {
    id,
    manifest: pluginManifest,
    envelope: { ...unsigned, signature: sign(null, pluginReleaseSigningBytes(unsigned), signingKeys.privateKey).toString('base64url') },
    launch: candidate
      ? { network: { mode: 'internal' as const, name: 'calendar-isolated' }, hostPort: 41238, containerPort: 3141 }
      : { network: { mode: 'none' as const } },
    secretAssignments: [{ name: 'calendarApi', secretRef: 'logical-ref-private-value' }],
  };
}

async function createFixture(releases = [release('a', '1.0.0', false), release('b', '2.0.0', true)]) {
  const catalog = [{
    id: installationId,
    label: 'Calendar',
    pluginId: 'calendar',
    configurationSchemaVersion: 1,
    releases,
    restorePlans: [] as string[],
  }];
  let sequence = 0;
  let adminAuthorized = true;
  let publisherRevoked = false;
  let secretsHook: (() => Promise<void>) | undefined;
  const driver: DeploymentDriver = {
    stage: ({ operationId }) => Promise.resolve({ deploymentId: `deployment-${operationId}` }),
    check: () => Promise.resolve(true),
    discard: () => Promise.resolve(),
    activate: () => Promise.resolve(),
    rollback: () => Promise.resolve(),
    reconcile: () => Promise.resolve({ activeDeploymentId: null, stagedDeploymentId: null, routeOperationOutcome: 'unknown' }),
  };
  const service = new ManagedPluginInstaller({
    store: new MemoryJsonStore('managed-plugin-review'),
    scope: `review-test-${String(++sequence)}`,
    privateKey: signingKeys.privateKey,
    driver,
    readCatalog: () => Promise.resolve(catalog),
    resolvePublisher: publisherId => publisherId === 'calendar-publisher'
      ? { publisherId, publicKey: signingKeys.publicKey, sourceRegistryPrefix: 'registry.example.test/hasi', allowedPluginIds: ['calendar'], revoked: publisherRevoked }
      : undefined,
    authorizeAdmin: caller => Promise.resolve(adminAuthorized && caller === subject),
    secretsAuthorized: async () => {
      const hook = secretsHook;
      secretsHook = undefined;
      await hook?.();
      return true;
    },
    secretReady: () => true,
    preflight: () => Promise.resolve(true),
    synchronizeRoute: () => Promise.resolve(),
  });
  await service.initialize();

  async function view() {
    return (await service.list(subject)).installations.find(item => item.id === installationId)!;
  }
  async function command(operation: 'stage' | 'approve' | 'activate' | 'cancel', extra: Record<string, unknown> = {}) {
    return service.command(installationId, {
      commandId: randomUUID(), expectedState: (await view()).stateToken, operation, ...extra,
    } as never, subject);
  }
  return {
    service,
    catalog,
    view,
    command,
    denyAdmin: () => { adminAuthorized = false; },
    revokePublisher: () => { publisherRevoked = true; },
    setSecretsHook: (hook: () => Promise<void>) => { secretsHook = hook; },
  };
}

describe('managed plugin approval review', () => {
  it('projects initial install and full old/new contract changes without runtime configuration, secret references, or image data', async () => {
    const fixture = await createFixture();
    await fixture.command('stage', { releaseId: 'a' });
    const initial = await fixture.service.describeReview(installationId, subject);
    expect(initial.current).toBeNull();
    expect(initial.currentDigest).toBeNull();
    expect(initial.candidateDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(initial.candidate.network).toEqual({ mode: 'none' });
    expect(initial.candidate.ingress).toBeNull();

    await fixture.command('approve');
    await fixture.command('activate');
    await fixture.command('stage', { releaseId: 'b' });
    const configuration = await fixture.service.describeConfiguration(installationId, subject);
    await fixture.service.saveConfigurationDraft(installationId, {
      revision: configuration.revision,
      values: { calendarLabel: 'private-runtime-config-value', includeCancelled: true },
      disabledTools: [],
    }, subject);

    const review = await fixture.service.describeReview(installationId, subject);
    expect(review.installationId).toBe(installationId);
    expect(review.stateToken).toBe((await fixture.view()).stateToken);
    expect(review.currentDigest).toBe((await fixture.view()).current?.digest);
    expect(review.candidateDigest).toBe((await fixture.view()).candidate?.digest);
    expect(review.current).toMatchObject({
      tools: [{
        title: 'Read calendar events', description: 'Reads calendar events.', resultSemantics: null,
        effect: 'read', requiredPermissions: ['calendar:read'], visibility: ['model'], presentationId: null,
      }],
      configurationSchema: oldConfiguration,
      identityClaims: ['departmentCode'],
      secretRequirements: [{ name: 'calendarApi', required: true }],
      presentations: [],
      network: { mode: 'none' },
      ingress: null,
      managedState,
    });
    expect(review.candidate).toMatchObject({
      tools: [{
        name: 'calendar.events',
        title: 'Write calendar events', description: 'Writes approved calendar events.', resultSemantics: { kind: 'bookings' },
        effect: 'execute', requiredPermissions: ['calendar:write'],
        visibility: ['app'], presentationId: 'calendar-app',
        inputSchema: { properties: { eventId: { type: 'string' }, force: { type: 'boolean' } } },
      }],
      configurationSchema: newConfiguration,
      identityClaims: ['departmentCode'],
      secretRequirements: [{ name: 'calendarApi', required: true }],
      presentations: [{
        id: 'calendar-app', resourceUri: 'ui://calendar/app.html', sha256: 'c'.repeat(64),
        csp: { connectDomains: ['calendar.example'], resourceDomains: ['assets.example'] },
      }],
      network: { mode: 'internal', name: 'calendar-isolated' },
      ingress: { hostAddress: '127.0.0.1', hostPort: 41238, containerPort: 3141, protocol: 'tcp' },
      managedState,
    });
    expect(review.candidate.tools[0]?.outputSchema).toEqual({
      type: 'object', properties: { accepted: { type: 'boolean' } }, additionalProperties: false,
    });
    expect(managedPluginReviewSchema.parse(review)).toEqual(review);
    const serialized = JSON.stringify(review);
    expect(serialized).not.toContain('private-runtime-config-value');
    expect(serialized).not.toContain('logical-ref-private-value');
    expect(serialized).not.toContain('registry.example.test');
  });

  it('exposes title, description, result semantics, and approved UI metadata as strings when only tool metadata changes', async () => {
    const fixture = await createFixture([
      release('a', '1.0.0', false, metadataManifest(
        '1.0.0', 'Calendar data', '<b>Reads the calendar</b>', 'resources',
      )),
      release('b', '2.0.0', false, metadataManifest(
        '2.0.0', 'Booking proposal', 'See https://calendar.example/events?view=compact', 'proposal',
      )),
    ]);
    await fixture.command('stage', { releaseId: 'a' });
    await fixture.command('approve');
    await fixture.command('activate');
    await fixture.command('stage', { releaseId: 'b' });

    const review = await fixture.service.describeReview(installationId, subject);
    const oldTool = review.current?.tools[0];
    const candidateTool = review.candidate.tools[0];
    expect(oldTool).toMatchObject({
      title: 'Calendar data', description: '<b>Reads the calendar</b>', resultSemantics: { kind: 'resources' },
    });
    expect(candidateTool).toMatchObject({
      title: 'Booking proposal', description: 'See https://calendar.example/events?view=compact',
      resultSemantics: { kind: 'proposal' },
    });
    expect(review.current?.presentations[0]?.resourceUri).toBe('ui://calendar/metadata.html');
    expect(review.candidate.presentations[0]?.csp.connectDomains).toEqual(['calendar.example']);

    const withoutToolMetadata = (contract: NonNullable<typeof review.current>) => ({
      ...contract,
      tools: contract.tools.map(({ title: _title, description: _description, resultSemantics: _resultSemantics, ...tool }) => tool),
    });
    expect(withoutToolMetadata(review.current!)).toEqual(withoutToolMetadata(review.candidate));
    expect(JSON.stringify(review)).toContain('<b>Reads the calendar</b>');
    expect(JSON.stringify(review)).toContain('https://calendar.example/events?view=compact');
  });

  it('rejects removed or revoked candidates and a removed current release instead of treating it as a first install', async () => {
    const missingCandidate = await createFixture();
    await missingCandidate.command('stage', { releaseId: 'a' });
    missingCandidate.catalog[0]!.releases.splice(0, 1);
    await expect(missingCandidate.service.describeReview(installationId, subject)).rejects.toThrow();

    const revokedCandidate = await createFixture();
    await revokedCandidate.command('stage', { releaseId: 'a' });
    revokedCandidate.revokePublisher();
    await expect(revokedCandidate.service.describeReview(installationId, subject)).rejects.toThrow();

    const missingCurrent = await createFixture();
    await missingCurrent.command('stage', { releaseId: 'a' });
    await missingCurrent.command('approve');
    await missingCurrent.command('activate');
    await missingCurrent.command('stage', { releaseId: 'b' });
    missingCurrent.catalog[0]!.releases.splice(0, 1);
    await expect(missingCurrent.service.describeReview(installationId, subject)).rejects.toThrow();
  });

  it('rechecks state and catalogue tokens after contract reads and reauthorizes the administrator', async () => {
    const staleState = await createFixture();
    await staleState.command('stage', { releaseId: 'a' });
    staleState.setSecretsHook(async () => { await staleState.command('cancel'); });
    await expect(staleState.service.describeReview(installationId, subject)).rejects.toThrow();

    const staleCatalog = await createFixture();
    await staleCatalog.command('stage', { releaseId: 'a' });
    staleCatalog.setSecretsHook(() => {
      staleCatalog.catalog[0]!.restorePlans.push('new-restore-plan');
      return Promise.resolve();
    });
    await expect(staleCatalog.service.describeReview(installationId, subject)).rejects.toThrow();

    const staleConfiguration = await createFixture();
    await staleConfiguration.command('stage', { releaseId: 'a' });
    staleConfiguration.setSecretsHook(async () => {
      const configuration = await staleConfiguration.service.describeConfiguration(installationId, subject);
      await staleConfiguration.service.saveConfigurationDraft(installationId, {
        revision: configuration.revision, values: { calendarLabel: 'changed-during-review' }, disabledTools: [],
      }, subject);
    });
    await expect(staleConfiguration.service.describeReview(installationId, subject)).rejects.toThrow();

    const denied = await createFixture();
    denied.denyAdmin();
    await expect(denied.service.describeReview(installationId, subject)).rejects.toThrow();

    const revokedDuringRead = await createFixture();
    await revokedDuringRead.command('stage', { releaseId: 'a' });
    revokedDuringRead.setSecretsHook(() => {
      revokedDuringRead.denyAdmin();
      return Promise.resolve();
    });
    await expect(revokedDuringRead.service.describeReview(installationId, subject)).rejects.toThrow();
  });

  it('rejects unexpected fields, unbounded JSON, prototype keys, and non-finite schema values', () => {
    const contract = {
      tools: [], configurationSchema: null, identityClaims: [], secretRequirements: [], presentations: [],
      network: { mode: 'none' }, ingress: null, managedState: null,
    };
    const base = {
      installationId, stateToken: 'a'.repeat(64), currentDigest: null, candidateDigest: 'b'.repeat(64),
      current: null, candidate: contract,
    };
    expect(managedPluginReviewSchema.safeParse(base).success).toBe(true);
    expect(managedPluginReviewSchema.safeParse({ ...base, candidate: { ...contract, image: 'registry.example/image' } }).success).toBe(false);
    expect(managedPluginReviewSchema.safeParse({ ...base, candidate: { ...contract, extra: 'x'.repeat(800 * 1_024) } }).success).toBe(false);
    expect(managedPluginReviewSchema.safeParse({ ...base, currentDigest: 'c'.repeat(64) }).success).toBe(false);
    const prototypeKey = JSON.parse('{"type":"object","__proto__":{"admin":true}}') as Record<string, unknown>;
    const invalidSchema = { ...base, candidate: { ...contract, tools: [{
      name: 'tool', title: 'Tool', description: 'Tool description', resultSemantics: null,
      inputSchema: prototypeKey, outputSchema: { type: 'object' }, effect: 'read',
      requiredPermissions: [], visibility: ['model'], presentationId: null,
    }] } };
    expect(managedPluginReviewSchema.safeParse(invalidSchema).success).toBe(false);
    const nonFiniteSchema = { ...base, candidate: { ...contract, tools: [{
      name: 'tool', title: 'Tool', description: 'Tool description', resultSemantics: null,
      inputSchema: { type: 'object', minimum: Number.NaN }, outputSchema: { type: 'object' }, effect: 'read',
      requiredPermissions: [], visibility: ['model'], presentationId: null,
    }] } };
    expect(managedPluginReviewSchema.safeParse(nonFiniteSchema).success).toBe(false);
  });
});
