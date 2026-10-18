import { describe, expect, it } from 'vitest';
import {
  configurationRequestError,
  getConfigurationFieldSet,
  hasPendingConfiguration,
  parsePluginConfigurationResponse,
  parsePluginConnectionTestResult,
  validateConfigurationDraft,
  type PluginConfigurationDefinition,
} from '../src/lib/plugin-configuration';

const configuration: PluginConfigurationDefinition = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['maxResults', 'mode', 'enabled'],
    properties: {
      maxResults: { type: 'integer', minimum: 1, maximum: 20 },
      mode: { type: 'string', enum: ['rooms', 'workplaces'] },
      enabled: { type: 'boolean' },
      label: { type: 'string', minLength: 2, maxLength: 20 },
    },
  },
  fields: [
    { name: 'maxResults', label: 'Maximale Trefferzahl', help: 'Begrenzt die Suchergebnisse.', group: 'Suche' },
    { name: 'mode', label: 'Ressourcentyp', group: 'Suche' },
    { name: 'enabled', label: 'Aktiviert' },
    { name: 'label', label: 'Bezeichnung' },
  ],
};

describe('plugin configuration helpers', () => {
  it('treats an empty required string or enum member as present when the schema permits it', () => {
    const definition: PluginConfigurationDefinition = {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['emptyText', 'emptyChoice'],
        properties: {
          emptyText: { type: 'string' },
          emptyChoice: { type: 'string', enum: ['', 'available'] },
        },
      },
    };
    const result = validateConfigurationDraft(definition, { emptyText: '', emptyChoice: '' }, [], [], []);
    expect(result.valid).toBe(true);
    expect(result.payload?.values).toEqual({ emptyText: '', emptyChoice: '' });
  });

  it('builds typed scalar payloads and reports required, integer, and enum errors', () => {
    const valid = validateConfigurationDraft(configuration, {
      maxResults: '8',
      mode: 'rooms',
      enabled: false,
      label: 'Anny',
    }, [], [], []);
    expect(valid.valid).toBe(true);
    expect(valid.payload?.values).toEqual({ maxResults: 8, mode: 'rooms', enabled: false, label: 'Anny' });

    const invalid = validateConfigurationDraft(configuration, {
      maxResults: '2.5',
      mode: 'anything',
      enabled: true,
      label: 'X',
    }, [], [], []);
    expect(invalid.valid).toBe(false);
    expect(invalid.errors).toMatchObject({
      maxResults: 'Bitte gib eine ganze Zahl ein.',
      mode: 'Bitte wähle einen der vorgegebenen Werte.',
      label: 'Mindestens 2 Zeichen eingeben.',
    });

    const missingRequired = validateConfigurationDraft(configuration, { mode: 'rooms', enabled: true }, [], [], []);
    expect(missingRequired.errors.maxResults).toBe('Dieses Feld ist erforderlich.');
  });

  it('marks nested configuration fields non-editable and preserves only safe declared values', () => {
    const nestedDefinition: PluginConfigurationDefinition = {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string' },
          advanced: { type: 'object', properties: { flags: { type: 'array' } }, additionalProperties: false },
          unsafePattern: { type: 'string', pattern: '^(a+)+$' },
        },
      },
    };
    const fields = getConfigurationFieldSet(nestedDefinition);
    expect(fields.supported).toBe(true);
    expect(fields.fields.find((field) => field.name === 'advanced')).toMatchObject({
      unsupported: 'Dieses Feld verwendet nicht unterstützte Validierungsregeln und bleibt unverändert.',
    });
    expect(fields.fields.find((field) => field.name === 'unsafePattern')).toHaveProperty('unsupported');

    const draft = validateConfigurationDraft(nestedDefinition, {
      label: 'Desk search',
      advanced: { flags: ['quiet'] },
      unsafePattern: 'aaa',
      unlisted: 'discard this',
    }, [], [], []);
    expect(draft.valid).toBe(true);
    expect(draft.payload?.values).toEqual({ label: 'Desk search', advanced: { flags: ['quiet'] }, unsafePattern: 'aaa' });
  });

  it('does not emit secret refs or tool names outside the supplied contract', () => {
    const definition: PluginConfigurationDefinition = {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          API_TOKEN: { type: 'string' },
          secretRef: { type: 'string' },
        },
      },
    };
    const draft = validateConfigurationDraft(definition, {
      title: 'HASI',
      API_TOKEN: 'never echo secret values',
      secretRef: 'credential://provider/token',
      nested: { credentialReference: 'credential://other' },
    }, ['anny.search_resources', 'unlisted.execute', 'anny.search_resources'], [
      { name: 'anny.search_resources', title: 'Ressourcen suchen', effect: 'read' },
    ], [{ name: 'API_TOKEN', required: true, configured: false }]);

    expect(draft.valid).toBe(true);
    expect(draft.payload).toEqual({ values: { title: 'HASI' }, disabledTools: ['anny.search_resources'] });
  });

  it('parses safe response metadata and filters undeclared or secret-reference config keys', () => {
    const parsed = parsePluginConfigurationResponse({
      revision: 3,
      activeRevision: 1,
      configuration: { title: 'HASI', unknown: 'drop', apiKey: 'public but undeclared' },
      draft: { title: 'Current draft', secretRef: 'credential://private', API_TOKEN: 'private' },
      disabledTools: [],
      draftDisabledTools: ['anny.search_resources'],
      schema: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { title: { type: 'string' }, secretRef: { type: 'string' }, API_TOKEN: { type: 'string' } },
        },
        fields: [{ name: 'title', label: 'Titel' }],
      },
      secrets: [{ name: 'API_TOKEN', required: true, configured: false }],
      ready: false,
      audit: [{ operation: 'draft', subject: 'admin-1', at: '2026-10-18T10:00:00.000Z' }],
    });
    expect(parsed.configuration).toEqual({ title: 'HASI' });
    expect(parsed.draft).toEqual({ title: 'Current draft' });
    expect(parsed.secrets).toEqual([{ name: 'API_TOKEN', required: true, configured: false }]);
    expect(parsed.ready).toBe(false);
  });

  it('keeps connection diagnostics separate and never upgrades MCP reachability to authentication or user authorization', () => {
    const parsed = parsePluginConnectionTestResult({
      instanceId: 'de.hsh.hasi.anny',
      checkedAt: '2026-10-18T10:00:00.000Z',
      configured: 'ready',
      reachable: 'verified',
      authenticated: 'not_verified',
      authorized: 'not_assessed',
      userReady: 'not_assessed',
      remedies: [],
    });

    expect(parsed).toMatchObject({
      configured: 'ready',
      reachable: 'verified',
      authenticated: 'not_verified',
      authorized: 'not_assessed',
      userReady: 'not_assessed',
    });
    expect(() => parsePluginConnectionTestResult({
      instanceId: 'de.hsh.hasi.anny',
      checkedAt: '2026-10-18T10:00:00.000Z',
      configured: 'ready',
      reachable: 'verified',
      authenticated: 'verified',
      authorized: 'not_assessed',
      userReady: 'not_assessed',
      remedies: [],
    })).toThrow();
    expect(() => parsePluginConnectionTestResult({
      instanceId: 'de.hsh.hasi.anny',
      checkedAt: '2026-10-18T10:00:00.000Z',
      configured: 'ready',
      reachable: 'verified',
      authenticated: 'not_verified',
      authorized: 'verified',
      userReady: 'not_assessed',
      remedies: [],
    })).toThrow();
  });

  it('accepts only allowlisted, declared logical-secret remedies and never returns secret values', () => {
    const secrets = [{ name: 'API_TOKEN', required: true, configured: false }];
    const parsed = parsePluginConnectionTestResult({
      instanceId: 'plugin-1',
      checkedAt: '2026-10-18T10:00:00.000Z',
      configured: 'incomplete',
      reachable: 'failed',
      authenticated: 'not_verified',
      authorized: 'not_assessed',
      userReady: 'blocked',
      remedies: [{ code: 'secret_missing', field: 'API_TOKEN', message: 'Erforderliche Zugangsdaten müssen serverseitig eingerichtet werden.' }],
    }, secrets);

    expect(parsed.remedies[0]).toMatchObject({ code: 'secret_missing', field: 'API_TOKEN' });
    expect(JSON.stringify(parsed)).not.toContain('credential://');
    expect(() => parsePluginConnectionTestResult({
      instanceId: 'plugin-1',
      checkedAt: '2026-10-18T10:00:00.000Z',
      configured: 'incomplete',
      reachable: 'failed',
      authenticated: 'not_verified',
      authorized: 'not_assessed',
      userReady: 'blocked',
      remedies: [{ code: 'secret_missing', field: 'OTHER_TOKEN', message: 'Missing.' }],
    }, secrets)).toThrow();
    expect(() => parsePluginConnectionTestResult({
      instanceId: 'plugin-1',
      checkedAt: '2026-10-18T10:00:00.000Z',
      configured: 'incomplete',
      reachable: 'failed',
      authenticated: 'not_verified',
      authorized: 'not_assessed',
      userReady: 'blocked',
      remedies: [{ code: 'unknown', message: 'Raw upstream error' }],
    }, secrets)).toThrow();
  });

  it('compares drafts independent of object key order and uses a sanitized conflict message', () => {
    expect(hasPendingConfiguration(
      { second: 'b', first: 'a' },
      { first: 'a', second: 'b' },
      ['tool-a'],
      ['tool-a'],
    )).toBe(false);
    expect(hasPendingConfiguration({}, {}, [], ['tool-a'])).toBe(true);
    expect(configurationRequestError(409)).toContain('Deine lokalen Eingaben sind erhalten');
    expect(configurationRequestError(409)).not.toContain('credential');
  });
});
