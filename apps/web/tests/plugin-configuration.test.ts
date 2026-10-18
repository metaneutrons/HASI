import { describe, expect, it } from 'vitest';
import {
  configurationRequestError,
  getConfigurationFieldSet,
  getDeclaredConfigurationFieldNames,
  hasPendingConfiguration,
  getVisibleConfigurationErrorPaths,
  parsePluginConfigurationResponse,
  parsePluginConnectionTestResult,
  parseConfigurationServerErrors,
  getVisibleConfigurationFields,
  getUnmappedConfigurationServerErrors,
  selectConfigurationUnionBranch,
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
      '/maxResults': 'Bitte gib eine ganze Zahl ein.',
      '/mode': 'Bitte wähle einen der vorgegebenen Werte.',
      '/label': 'Mindestens 2 Zeichen eingeben.',
    });

    const missingRequired = validateConfigurationDraft(configuration, { mode: 'rooms', enabled: true }, [], [], []);
    expect(missingRequired.errors['/maxResults']).toBe('Dieses Feld ist erforderlich.');
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
    const advanced = fields.fields.find((field) => field.name === 'advanced');
    expect(advanced?.node.kind).toBe('object');
    expect(advanced && 'unsupported' in advanced ? advanced.unsupported : undefined).toBeUndefined();
    if (advanced?.node.kind === 'object') {
      expect(advanced.node.properties.find((field) => field.name === 'flags')?.unsupported).toContain('Array');
    }
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

  it('renders and validates bounded nested objects, arrays, and conditional fields', () => {
    const definition: PluginConfigurationDefinition = {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['mode', 'settings', 'targets'],
        properties: {
          mode: { type: 'string', enum: ['local', 'remote'] },
          localPath: { type: 'string', minLength: 1 },
          remoteUrl: { type: 'string', minLength: 8 },
          settings: {
            type: 'object',
            additionalProperties: false,
            required: ['timeout', 'note'],
            properties: { timeout: { type: 'integer', minimum: 1, maximum: 60 }, note: { type: 'string' } },
          },
          targets: {
            type: 'array',
            minItems: 1,
            maxItems: 4,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'weight'],
              properties: { name: { type: 'string', minLength: 1 }, weight: { type: 'number', minimum: 0 } },
            },
          },
        },
        if: { properties: { mode: { const: 'remote' } }, required: ['mode'] },
        then: { type: 'object', properties: { remoteUrl: { type: 'string', minLength: 8 } }, required: ['remoteUrl'] },
        else: { type: 'object', properties: { localPath: { type: 'string', minLength: 1 } }, required: ['localPath'] },
      },
    };
    const fieldSet = getConfigurationFieldSet(definition);
    expect(fieldSet.supported).toBe(true);
    const root = fieldSet.root;
    expect(root?.kind).toBe('object');
    if (root?.kind !== 'object') return;
    expect(getVisibleConfigurationFields(root, { mode: 'remote' }).map((field) => field.name)).toEqual(['mode', 'remoteUrl', 'settings', 'targets']);
    expect(getDeclaredConfigurationFieldNames(root)).toEqual(new Set(['mode', 'localPath', 'remoteUrl', 'settings', 'targets']));

    const valid = validateConfigurationDraft(definition, {
      mode: 'remote',
      remoteUrl: 'https://example.test',
      localPath: '/old-value-preserved-in-editor',
      settings: { timeout: '15', note: 'quiet' },
      targets: [{ name: 'one', weight: '1.5' }],
    }, [], [], []);
    expect(valid.valid).toBe(true);
    expect(valid.payload?.values).toEqual({
      mode: 'remote',
      remoteUrl: 'https://example.test',
      settings: { timeout: 15, note: 'quiet' },
      targets: [{ name: 'one', weight: 1.5 }],
    });

    const invalid = validateConfigurationDraft(definition, {
      mode: 'remote',
      remoteUrl: 'x',
      settings: { timeout: '0' },
      targets: [{ name: '', weight: '-2' }],
    }, [], [], []);
    expect(invalid.valid).toBe(false);
    expect(invalid.errors).toMatchObject({
      '/remoteUrl': 'Mindestens 8 Zeichen eingeben.',
      '/settings/timeout': 'Der Wert muss mindestens 1 sein.',
      '/settings/note': 'Dieses Feld ist erforderlich.',
      '/targets/0/name': 'Mindestens 1 Zeichen eingeben.',
      '/targets/0/weight': 'Der Wert muss mindestens 0 sein.',
    });
  });

  it('keeps base required fields visible when a conditional branch only refines them', () => {
    const definition: PluginConfigurationDefinition = {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['mode', 'endpoint'],
        properties: {
          mode: { type: 'string', enum: ['local', 'remote'] },
          endpoint: { type: 'string' },
        },
        if: { properties: { mode: { const: 'remote' } }, required: ['mode'] },
        then: {
          type: 'object',
          properties: { endpoint: { type: 'string', minLength: 8 } },
          required: ['endpoint'],
        },
      },
    };
    const fieldSet = getConfigurationFieldSet(definition);
    expect(fieldSet.supported).toBe(true);
    if (fieldSet.root?.kind !== 'object') return;

    const localFields = getVisibleConfigurationFields(fieldSet.root, { mode: 'local' });
    expect(localFields.map((field) => field.name)).toEqual(['mode', 'endpoint']);
    expect(localFields.find((field) => field.name === 'endpoint')?.required).toBe(true);
    expect(getVisibleConfigurationErrorPaths(fieldSet.root, { mode: 'local' }).has('/endpoint')).toBe(true);
    expect(validateConfigurationDraft(definition, { mode: 'local' }, [], [], []).errors['/endpoint'])
      .toBe('Dieses Feld ist erforderlich.');
    expect(validateConfigurationDraft(definition, { mode: 'local', endpoint: 'http://local' }, [], [], []).valid)
      .toBe(true);
    expect(validateConfigurationDraft(definition, { mode: 'remote', endpoint: 'short' }, [], [], []).errors['/endpoint'])
      .toBe('Mindestens 8 Zeichen eingeben.');
  });

  it('supports oneOf and anyOf object branches only when a required const discriminator is unique', () => {
    const branches: Record<string, unknown>[] = [
      {
        type: 'object', additionalProperties: false, required: ['kind', 'host'],
        properties: { kind: { type: 'string', const: 'remote' }, host: { type: 'string', minLength: 1 } },
      },
      {
        type: 'object', additionalProperties: false, required: ['kind', 'folder'],
        properties: { kind: { type: 'string', const: 'local' }, folder: { type: 'string', minLength: 1 } },
      },
    ];
    const definition: PluginConfigurationDefinition = {
      schema: {
        oneOf: branches,
      },
    };
    const valid = validateConfigurationDraft(definition, { kind: 'remote', host: 'service.internal' }, [], [], []);
    expect(valid.valid).toBe(true);
    expect(valid.payload?.values).toEqual({ kind: 'remote', host: 'service.internal' });
    expect(validateConfigurationDraft(definition, { kind: 'other', host: 'x' }, [], [], []).errors['/kind']).toContain('Variante');
    const anyOfDefinition: PluginConfigurationDefinition = { schema: { anyOf: branches } };
    expect(validateConfigurationDraft(anyOfDefinition, { kind: 'local', folder: '/srv/hasi' }, [], [], []).payload?.values)
      .toEqual({ kind: 'local', folder: '/srv/hasi' });

    const ambiguous: PluginConfigurationDefinition = {
      schema: { oneOf: [{ type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } }, { type: 'object', additionalProperties: false, properties: { b: { type: 'string' } } }] },
    };
    expect(getConfigurationFieldSet(ambiguous).supported).toBe(false);
  });

  it('retains union branch drafts while omitting inactive branch values from each submission', () => {
    const branches: Record<string, unknown>[] = [
      {
        type: 'object', additionalProperties: false, required: ['kind', 'host'],
        properties: { kind: { type: 'string', const: 'remote' }, host: { type: 'string', minLength: 1 } },
      },
      {
        type: 'object', additionalProperties: false, required: ['kind', 'folder'],
        properties: { kind: { type: 'string', const: 'local' }, folder: { type: 'string', minLength: 1 } },
      },
    ];
    const definition: PluginConfigurationDefinition = { schema: { oneOf: branches } };
    const root = getConfigurationFieldSet(definition).root;
    expect(root?.kind).toBe('union');
    if (root?.kind !== 'union') return;

    const remoteDraft = { kind: 'remote', host: 'service.internal' };
    const localDraft = selectConfigurationUnionBranch(root, remoteDraft, 1);
    expect(localDraft).toEqual({ kind: 'local', host: 'service.internal' });
    if (!localDraft) return;
    const editedLocalDraft = { ...localDraft, folder: '/srv/hasi' };
    expect(validateConfigurationDraft(definition, editedLocalDraft, [], [], []).payload?.values)
      .toEqual({ kind: 'local', folder: '/srv/hasi' });

    const restoredRemoteDraft = selectConfigurationUnionBranch(root, editedLocalDraft, 0);
    expect(restoredRemoteDraft).toEqual({ kind: 'remote', host: 'service.internal', folder: '/srv/hasi' });
    if (!restoredRemoteDraft) return;
    expect(validateConfigurationDraft(definition, restoredRemoteDraft, [], [], []).payload?.values)
      .toEqual({ kind: 'remote', host: 'service.internal' });
    expect(getVisibleConfigurationErrorPaths(root, restoredRemoteDraft).has('/host')).toBe(true);
    expect(getVisibleConfigurationErrorPaths(root, restoredRemoteDraft).has('/folder')).toBe(false);
  });

  it('accepts bounded API field diagnostics and ignores malformed entries', () => {
    const apiError = Object.assign(new Error('Invalid configuration.'), {
      code: 'configuration_invalid',
      errors: [
        { path: '/settings/timeout', message: 'Wert muss größer sein.' },
        { path: '/bad~2pointer', message: 'Ignored.' },
        { path: '/secret', message: 'x'.repeat(321) },
      ],
    });
    expect(parseConfigurationServerErrors(apiError)).toEqual({ '/settings/timeout': 'Wert muss größer sein.' });
    expect(parseConfigurationServerErrors({ code: 'other', errors: [] })).toEqual({});
    expect(getUnmappedConfigurationServerErrors(
      { '/settings/timeout': 'Wert muss größer sein.', '/hiddenEndpoint': 'Bitte prüfen.' },
      new Set(['/settings/timeout']),
    )).toEqual({ '/hiddenEndpoint': 'Bitte prüfen.' });
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
      secrets: [{ name: 'API_TOKEN', required: true, configured: false, revision: 7 }],
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
