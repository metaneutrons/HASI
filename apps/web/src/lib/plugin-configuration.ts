export type ConfigurationScalar = string | number | boolean;
export type ConfigurationJson = null | ConfigurationScalar | ConfigurationJson[] | { [key: string]: ConfigurationJson };
export type ConfigurationValues = Record<string, ConfigurationJson>;

export interface PluginConfigurationFieldPresentation {
  name: string;
  label: string;
  help?: string;
  group?: string;
}

export interface PluginConfigurationDefinition {
  schema: Record<string, unknown>;
  fields?: PluginConfigurationFieldPresentation[];
}

export interface PluginConfigurationSecret {
  name: string;
  required: boolean;
  configured: boolean;
}

export interface PluginConfigurationAuditEntry {
  operation: 'draft' | 'activate';
  subject: string;
  at: string;
}

export interface PluginConfigurationDetails {
  revision: number;
  activeRevision: number;
  configuration: ConfigurationValues;
  draft: ConfigurationValues;
  disabledTools: string[];
  draftDisabledTools: string[];
  schema?: PluginConfigurationDefinition;
  secrets: PluginConfigurationSecret[];
  ready: boolean;
  audit: PluginConfigurationAuditEntry[];
}

export interface ConfigurationRevisionResult {
  revision: number;
  activeRevision: number;
}

export interface PluginConnectionTestRemedy {
  code: 'secret_missing' | 'configuration_incomplete' | 'disabled' | 'authentication_rejected' | 'contract_changed' | 'connection_failed';
  message: string;
  /** Declared logical secret slot; values and secret references are never returned. */
  field?: string;
}

export interface PluginConnectionTestResult {
  instanceId: string;
  checkedAt: string;
  configured: 'ready' | 'incomplete';
  reachable: 'verified' | 'failed';
  authenticated: 'not_verified' | 'rejected';
  authorized: 'not_assessed';
  userReady: 'blocked' | 'not_assessed';
  remedies: PluginConnectionTestRemedy[];
}

export type ConfigurationFieldControl =
  | {
    kind: 'string';
    minLength?: number;
    maxLength?: number;
    pattern?: RegExp;
  }
  | {
    kind: 'number';
    minimum?: number;
    maximum?: number;
    exclusiveMinimum?: number;
    exclusiveMaximum?: number;
    multipleOf?: number;
  }
  | {
    kind: 'integer';
    minimum?: number;
    maximum?: number;
    exclusiveMinimum?: number;
    exclusiveMaximum?: number;
    multipleOf?: number;
  }
  | { kind: 'boolean' }
  | { kind: 'enum'; values: ConfigurationScalar[] };

export type ConfigurationSchemaNode =
  | { kind: 'scalar'; control: ConfigurationFieldControl; defaultValue?: ConfigurationJson; constant?: ConfigurationScalar }
  | {
    kind: 'object';
    title?: string;
    description?: string;
    properties: ConfigurationFieldDescriptor[];
    required: string[];
    strict: boolean;
    minProperties?: number;
    maxProperties?: number;
    conditional?: {
      condition: ConfigurationCondition;
      thenNode?: ConfigurationSchemaNode;
      elseNode?: ConfigurationSchemaNode;
    };
  }
  | {
    kind: 'array';
    title?: string;
    description?: string;
    items: ConfigurationSchemaNode;
    minItems?: number;
    maxItems?: number;
    uniqueItems?: boolean;
    defaultValue?: ConfigurationJson;
  }
  | {
    kind: 'union';
    combinator: 'oneOf' | 'anyOf';
    title?: string;
    description?: string;
    discriminator: string;
    branches: { label: string; value: ConfigurationScalar; schema: Extract<ConfigurationSchemaNode, { kind: 'object' }> }[];
  }
  | { kind: 'unsupported'; reason: string };

export interface ConfigurationCondition {
  required: string[];
  properties: Record<string, { type?: string; constant?: ConfigurationJson; values?: ConfigurationScalar[] }>;
  additionalProperties?: boolean;
}

export interface ConfigurationFieldDescriptor {
  name: string;
  label: string;
  help?: string;
  group: string;
  required: boolean;
  node: ConfigurationSchemaNode;
  defaultValue?: ConfigurationJson;
  /** Present for an unsupported property or a server-managed secret slot. */
  unsupported?: string;
}

export interface ConfigurationFieldSet {
  supported: boolean;
  reason?: string;
  fields: ConfigurationFieldDescriptor[];
  root?: ConfigurationSchemaNode;
}

export interface ConfigurationToolOption {
  name: string;
  title: string;
  effect: 'read' | 'prepare' | 'execute';
}

export interface ConfigurationDraftPayload {
  values: ConfigurationValues;
  disabledTools: string[];
}

export interface ConfigurationDraftValidation {
  valid: boolean;
  errors: Record<string, string>;
  payload?: ConfigurationDraftPayload;
  unsupportedFields: string[];
}

const maxResponseBytes = 256 * 1_024;
const maxConfigurationBytes = 64 * 1_024;
const secretReferenceKeys = new Set([
  'secretref',
  'secretreference',
  'credentialref',
  'credentialreference',
]);
const prototypeKeys = new Set(['__proto__', 'prototype', 'constructor']);
const schemaKeys = new Set([
  'type', 'title', 'description', 'default', 'enum', 'const', 'minimum', 'maximum', 'exclusiveMinimum',
  'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'properties', 'required',
  'additionalProperties', 'items', 'minItems', 'maxItems', 'uniqueItems', 'minProperties',
  'maxProperties', 'if', 'then', 'else', 'oneOf', 'anyOf', '$schema',
]);

export function parsePluginConfigurationResponse(value: unknown): PluginConfigurationDetails {
  if (!isBoundedJson(value, maxResponseBytes, 32, 12_000) || !isPlainRecord(value)) {
    throw new TypeError('Invalid plugin configuration response');
  }
  const revision = parseRevision(value.revision);
  const activeRevision = parseRevision(value.activeRevision);
  if (activeRevision > revision) throw new TypeError('Invalid plugin configuration response');
  const rawConfiguration = parseConfigurationValues(value.configuration);
  const rawDraft = parseConfigurationValues(value.draft);
  const disabledTools = parseNameList(value.disabledTools, 64);
  const draftDisabledTools = parseNameList(value.draftDisabledTools, 64);
  const schema = value.schema === undefined ? undefined : parseConfigurationDefinition(value.schema);
  const secrets = parseSecrets(value.secrets);
  const audit = parseAudit(value.audit);
  if (typeof value.ready !== 'boolean') throw new TypeError('Invalid plugin configuration response');

  const publicKeys = getPublicConfigurationKeys(schema, secrets);
  const configuration = filterPublicValues(rawConfiguration, publicKeys, secrets);
  const draft = filterPublicValues(rawDraft, publicKeys, secrets);
  return {
    revision,
    activeRevision,
    configuration,
    draft,
    disabledTools,
    draftDisabledTools,
    ...(schema === undefined ? {} : { schema }),
    secrets,
    ready: value.ready,
    audit,
  };
}

export function parseConfigurationRevisionResult(value: unknown): ConfigurationRevisionResult {
  if (!isPlainRecord(value)) throw new TypeError('Invalid plugin configuration response');
  const revision = parseRevision(value.revision);
  const activeRevision = parseRevision(value.activeRevision);
  if (activeRevision > revision) throw new TypeError('Invalid plugin configuration response');
  return { revision, activeRevision };
}

export function parsePluginConnectionTestResult(
  value: unknown,
  secrets: readonly PluginConfigurationSecret[] = [],
): PluginConnectionTestResult {
  if (!isBoundedJson(value, 32 * 1_024, 8, 512) || !isPlainRecord(value)) {
    throw new TypeError('Invalid plugin connection test response');
  }
  if (
    typeof value.instanceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.instanceId) ||
    typeof value.checkedAt !== 'string' || value.checkedAt.length > 64 || !Number.isFinite(Date.parse(value.checkedAt)) ||
    (value.configured !== 'ready' && value.configured !== 'incomplete') ||
    (value.reachable !== 'verified' && value.reachable !== 'failed') ||
    (value.authenticated !== 'not_verified' && value.authenticated !== 'rejected') ||
    value.authorized !== 'not_assessed' ||
    (value.userReady !== 'blocked' && value.userReady !== 'not_assessed') ||
    !Array.isArray(value.remedies) || value.remedies.length > 16
  ) {
    throw new TypeError('Invalid plugin connection test response');
  }

  const secretNames = new Set(secrets.map((secret) => secret.name));
  const remedyCodes = new Set<PluginConnectionTestRemedy['code']>([
    'secret_missing',
    'configuration_incomplete',
    'disabled',
    'authentication_rejected',
    'contract_changed',
    'connection_failed',
  ]);
  const remedies = value.remedies.map((remedy): PluginConnectionTestRemedy => {
    if (
      !isPlainRecord(remedy) ||
      typeof remedy.code !== 'string' || !remedyCodes.has(remedy.code as PluginConnectionTestRemedy['code']) ||
      typeof remedy.message !== 'string' || remedy.message.trim().length === 0 || remedy.message.length > 320 ||
      (remedy.field !== undefined && (typeof remedy.field !== 'string' || remedy.field.length > 128))
    ) {
      throw new TypeError('Invalid plugin connection test response');
    }
    if (remedy.code === 'secret_missing') {
      if (
        typeof remedy.field !== 'string' ||
        !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(remedy.field) ||
        !secretNames.has(remedy.field)
      ) {
        throw new TypeError('Invalid plugin connection test response');
      }
      return { code: remedy.code, message: remedy.message, field: remedy.field };
    }
    if (remedy.field !== undefined) throw new TypeError('Invalid plugin connection test response');
    return { code: remedy.code as PluginConnectionTestRemedy['code'], message: remedy.message };
  });

  return {
    instanceId: value.instanceId,
    checkedAt: value.checkedAt,
    configured: value.configured,
    reachable: value.reachable,
    authenticated: value.authenticated,
    authorized: 'not_assessed',
    userReady: value.userReady,
    remedies,
  };
}

export function getConfigurationFieldSet(
  definition: PluginConfigurationDefinition | undefined,
  secrets: readonly PluginConfigurationSecret[] = [],
): ConfigurationFieldSet {
  if (!definition) return { supported: true, fields: [] };
  if (!isBoundedJson(definition.schema, maxResponseBytes, 16, 4_096)) {
    return unsupportedFieldSet('Das Konfigurationsschema ist ungültig oder überschreitet die unterstützte Größe.');
  }

  const metadata = new Map((definition.fields ?? []).map((field) => [field.name, field]));
  const secretNames = new Set(secrets.map((secret) => secret.name));
  const root = parseSchemaNode(definition.schema, {
    depth: 0,
    root: true,
    partial: false,
    metadata,
    secretNames,
  });
  if (root.kind === 'unsupported') return unsupportedFieldSet(root.reason, root);
  if (root.kind !== 'object' && root.kind !== 'union') {
    return unsupportedFieldSet('Das oberste Konfigurationsschema muss ein Objekt oder eine eindeutig auswählbare Objektvariante sein.', root);
  }
  return { supported: true, fields: getRootFields(root), root };
}

export function validateConfigurationDraft(
  definition: PluginConfigurationDefinition | undefined,
  rawValues: Record<string, unknown>,
  disabledTools: readonly string[],
  tools: readonly ConfigurationToolOption[],
  secrets: readonly PluginConfigurationSecret[] = [],
): ConfigurationDraftValidation {
  const errors: Record<string, string> = {};
  const rawValuesSafe = isPlainRecord(rawValues) && isBoundedJson(rawValues, maxConfigurationBytes, 20, 4_096);
  if (!rawValuesSafe) {
    errors._configuration = 'Die Konfiguration enthält ungültige oder zu große Daten.';
  }
  const fieldSet = getConfigurationFieldSet(definition, secrets);
  const unsupportedFields = fieldSet.root ? findUnsupportedFields(fieldSet.root) : [];
  if (!fieldSet.supported) errors._schema = fieldSet.reason ?? 'Das Konfigurationsschema wird nicht unterstützt.';

  let values: ConfigurationValues = {};
  if (definition && fieldSet.supported && fieldSet.root && rawValuesSafe) {
    const allowedKeys = getPublicConfigurationKeys(definition, secrets);
    const safeValues = filterPublicValues(rawValues as ConfigurationValues, allowedKeys, secrets);
    const normalized = normalizeConfigurationNode(fieldSet.root, safeValues, true, '', errors);
    if (isPlainRecord(normalized)) values = normalized;
  }

  const validToolNames = new Set(tools.map((tool) => tool.name));
  const filteredDisabledTools = [...new Set(disabledTools.filter((name) => validToolNames.has(name)))];
  if (containsSecretReference(values)) errors._configuration = 'Geheime Zugangsdaten dürfen nicht Teil der öffentlichen Konfiguration sein.';
  const valid = Object.keys(errors).length === 0;
  return {
    valid,
    errors,
    unsupportedFields,
    ...(valid ? { payload: { values, disabledTools: filteredDisabledTools } } : {}),
  };
}

export function hasPendingConfiguration(
  activeValues: Record<string, unknown>,
  draftValues: Record<string, unknown>,
  activeDisabledTools: readonly string[],
  draftDisabledTools: readonly string[],
): boolean {
  return stableJson(activeValues) !== stableJson(draftValues) || !sameNames(activeDisabledTools, draftDisabledTools);
}

export function configurationRequestError(status: number | undefined): string {
  if (status === 0) return 'Der Verwaltungsdienst ist derzeit nicht erreichbar.';
  if (status === 400) return 'Die Eingaben entsprechen nicht dem freigegebenen Konfigurationsschema.';
  if (status === 401 || status === 403) return 'Du bist nicht berechtigt, diese Plug-in-Konfiguration zu ändern.';
  if (status === 404) return 'Dieses Plug-in ist nicht mehr verfügbar.';
  if (status === 409) return 'Die Serverkonfiguration wurde zwischenzeitlich geändert. Deine lokalen Eingaben sind erhalten; lade den Serverstand bewusst neu, bevor du fortfährst.';
  return 'Die Konfiguration konnte nicht verarbeitet werden. Bitte versuche es erneut.';
}

function parseConfigurationDefinition(value: unknown): PluginConfigurationDefinition {
  if (!isPlainRecord(value) || !isPlainRecord(value.schema)) throw new TypeError('Invalid plugin configuration response');
  let fields: PluginConfigurationFieldPresentation[] | undefined;
  if (value.fields !== undefined) {
    if (!Array.isArray(value.fields) || value.fields.length > 128) throw new TypeError('Invalid plugin configuration response');
    const fieldNames = new Set<string>();
    const properties = getSchemaPropertyNames(value.schema);
    fields = value.fields.map((field) => {
      if (!isPlainRecord(field) || typeof field.name !== 'string' || typeof field.label !== 'string') {
        throw new TypeError('Invalid plugin configuration response');
      }
      if ((field.help !== undefined && typeof field.help !== 'string') || (field.group !== undefined && typeof field.group !== 'string')) {
        throw new TypeError('Invalid plugin configuration response');
      }
      if (field.name.length > 128 || field.label.trim().length === 0 || field.label.length > 128 || fieldNames.has(field.name) || !properties.has(field.name)) {
        throw new TypeError('Invalid plugin configuration response');
      }
      fieldNames.add(field.name);
      return {
        name: field.name.slice(0, 128),
        label: field.label.slice(0, 128),
        ...(typeof field.help === 'string' ? { help: field.help.slice(0, 1_024) } : {}),
        ...(typeof field.group === 'string' ? { group: field.group.slice(0, 128) } : {}),
      };
    });
  }
  return { schema: value.schema, ...(fields === undefined ? {} : { fields }) };
}

function parseConfigurationValues(value: unknown): ConfigurationValues {
  if (!isPlainRecord(value)) throw new TypeError('Invalid plugin configuration response');
  return value as ConfigurationValues;
}

function parseSecrets(value: unknown): PluginConfigurationSecret[] {
  if (!Array.isArray(value) || value.length > 32) throw new TypeError('Invalid plugin configuration response');
  const names = new Set<string>();
  return value.map((secret) => {
    if (
      !isPlainRecord(secret) ||
      typeof secret.name !== 'string' || secret.name.length === 0 || secret.name.length > 128 ||
      typeof secret.required !== 'boolean' || typeof secret.configured !== 'boolean' || names.has(secret.name)
    ) {
      throw new TypeError('Invalid plugin configuration response');
    }
    names.add(secret.name);
    return { name: secret.name, required: secret.required, configured: secret.configured };
  });
}

function parseAudit(value: unknown): PluginConfigurationAuditEntry[] {
  if (!Array.isArray(value) || value.length > 100) throw new TypeError('Invalid plugin configuration response');
  return value.map((entry) => {
    if (
      !isPlainRecord(entry) ||
      (entry.operation !== 'draft' && entry.operation !== 'activate') ||
      typeof entry.subject !== 'string' ||
      typeof entry.at !== 'string'
    ) {
      throw new TypeError('Invalid plugin configuration response');
    }
    return { operation: entry.operation, subject: entry.subject.slice(0, 256), at: entry.at.slice(0, 64) };
  });
}

function parseNameList(value: unknown, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxLength || value.some((item) => typeof item !== 'string' || item.length > 128)) {
    throw new TypeError('Invalid plugin configuration response');
  }
  const names = value as string[];
  if (new Set(names).size !== names.length) throw new TypeError('Invalid plugin configuration response');
  return [...names];
}

function parseRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Invalid plugin configuration response');
  }
  return value;
}

interface SchemaParseOptions {
  depth: number;
  root: boolean;
  partial: boolean;
  metadata: ReadonlyMap<string, PluginConfigurationFieldPresentation>;
  secretNames: ReadonlySet<string>;
}

function unsupportedFieldSet(reason: string, root?: ConfigurationSchemaNode): ConfigurationFieldSet {
  return {
    supported: false,
    reason: `${reason} Die Konfigurationswerte bleiben erhalten.`,
    fields: [],
    ...(root === undefined ? {} : { root }),
  };
}

function parseSchemaNode(raw: unknown, options: SchemaParseOptions): ConfigurationSchemaNode {
  if (!isPlainRecord(raw) || options.depth > 12) {
    return { kind: 'unsupported', reason: 'Dieses Schema ist ungültig oder zu tief verschachtelt.' };
  }
  if (Object.keys(raw).some((key) => !schemaKeys.has(key))) {
    return { kind: 'unsupported', reason: 'Dieses Feld verwendet nicht unterstützte JSON-Schema-Regeln.' };
  }
  const title = typeof raw.title === 'string' && raw.title.trim().length > 0 ? raw.title.slice(0, 128) : undefined;
  const description = typeof raw.description === 'string' && raw.description.length > 0 ? raw.description.slice(0, 1_024) : undefined;
  const metadata = (name: string, property: Record<string, unknown>) => {
    const presentation = options.metadata.get(name);
    const label = presentation?.label ?? (typeof property.title === 'string' ? property.title.slice(0, 128) : name);
    const help = presentation?.help ?? (typeof property.description === 'string' ? property.description.slice(0, 1_024) : undefined);
    return { label, ...(help === undefined ? {} : { help }), group: presentation?.group ?? 'Einstellungen' };
  };
  const defaultValue = raw.default !== undefined && isBoundedJson(raw.default, maxConfigurationBytes, 20, 4_096)
    ? raw.default as ConfigurationJson
    : undefined;
  if (raw.default !== undefined && defaultValue === undefined) {
    return { kind: 'unsupported', reason: 'Der Standardwert dieses Feldes ist ungültig oder zu groß.' };
  }

  const combinatorKey = Object.hasOwn(raw, 'oneOf') ? 'oneOf' : Object.hasOwn(raw, 'anyOf') ? 'anyOf' : undefined;
  if (combinatorKey) {
    const allowed = new Set([combinatorKey, 'title', 'description']);
    if (Object.keys(raw).some((key) => !allowed.has(key)) || (combinatorKey === 'oneOf' && Object.hasOwn(raw, 'anyOf'))) {
      return { kind: 'unsupported', reason: 'Die Variantenregel lässt sich nicht sicher als Auswahl darstellen.' };
    }
    const rawBranches = raw[combinatorKey];
    if (!Array.isArray(rawBranches) || rawBranches.length < 2 || rawBranches.length > 16) {
      return { kind: 'unsupported', reason: 'Die Variantenregel muss zwei bis sechzehn Möglichkeiten enthalten.' };
    }
    const discriminator = findUnionDiscriminator(rawBranches);
    if (!discriminator) {
      return { kind: 'unsupported', reason: 'Diese Variantenregel benötigt ein eindeutiges, konstantes Auswahlfeld.' };
    }
    const branches: { label: string; value: ConfigurationScalar; schema: Extract<ConfigurationSchemaNode, { kind: 'object' }> }[] = [];
    for (let index = 0; index < rawBranches.length; index += 1) {
      const branchRaw: unknown = rawBranches[index];
      const branch = parseSchemaNode(branchRaw, { ...options, depth: options.depth + 1, root: false, partial: false });
      if (branch.kind !== 'object' || branch.properties.some((field) => field.node.kind === 'unsupported')) {
        return { kind: 'unsupported', reason: 'Eine Variantenregel enthält ein nicht unterstütztes Objektfeld.' };
      }
      const branchValue = getDeclaredConstant(branch, discriminator.name);
      if (branchValue === undefined || stableJson(branchValue) !== stableJson(discriminator.values[index])) {
        return { kind: 'unsupported', reason: 'Die Variantenregel verwendet keine eindeutigen Auswahlwerte.' };
      }
      branches.push({
        label: typeof (branchRaw as Record<string, unknown>).title === 'string'
          ? String((branchRaw as Record<string, unknown>).title).slice(0, 128)
          : `Variante ${String(index + 1)}`,
        value: branchValue,
        schema: branch,
      });
    }
    return { kind: 'union', combinator: combinatorKey, ...(title ? { title } : {}), ...(description ? { description } : {}), discriminator: discriminator.name, branches };
  }

  if (raw.type === 'object' || (options.partial && raw.type === undefined && ['properties', 'required', 'additionalProperties', 'minProperties', 'maxProperties'].some((key) => Object.hasOwn(raw, key)))) {
    const objectKeys = new Set([
      'type', 'title', 'description', 'default', 'properties', 'required', 'additionalProperties',
      'minProperties', 'maxProperties', 'if', 'then', 'else', '$schema',
    ]);
    if (Object.keys(raw).some((key) => !objectKeys.has(key))) {
      return { kind: 'unsupported', reason: 'Dieses Objekt verwendet nicht unterstützte Validierungsregeln.' };
    }
    const properties = raw.properties === undefined && options.partial ? {} : raw.properties;
    if (!isPlainRecord(properties) || Object.keys(properties).length > 128) {
      return { kind: 'unsupported', reason: 'Dieses Objekt enthält zu viele oder ungültige Eigenschaften.' };
    }
    if (!options.partial && raw.additionalProperties !== false) {
      return { kind: 'unsupported', reason: 'Dieses Objekt muss zusätzliche Eigenschaften ausdrücklich ablehnen.' };
    }
    if (raw.additionalProperties !== undefined && typeof raw.additionalProperties !== 'boolean') {
      return { kind: 'unsupported', reason: 'Zusätzliche Objekteigenschaften lassen sich nicht sicher bearbeiten.' };
    }
    const required = parseRequiredNames(raw.required, options.partial ? undefined : new Set(Object.keys(properties)));
    if (!required) return { kind: 'unsupported', reason: 'Die Pflichtfelder im Schema sind ungültig.' };
    const minProperties = optionalNonNegativeInteger(raw.minProperties);
    const maxProperties = optionalNonNegativeInteger(raw.maxProperties);
    if (
      (raw.minProperties !== undefined && minProperties === undefined) ||
      (raw.maxProperties !== undefined && maxProperties === undefined) ||
      (minProperties !== undefined && maxProperties !== undefined && minProperties > maxProperties) ||
      (minProperties !== undefined && minProperties > 128) ||
      (maxProperties !== undefined && maxProperties > 128)
    ) return { kind: 'unsupported', reason: 'Die Anzahl der Objekteigenschaften ist ungültig.' };

    const fields: ConfigurationFieldDescriptor[] = [];
    for (const [name, propertyRaw] of Object.entries(properties)) {
      if (name.length === 0 || name.length > 128 || prototypeKeys.has(name)) {
        return { kind: 'unsupported', reason: 'Ein Feldname im Schema ist ungültig.' };
      }
      const property = isPlainRecord(propertyRaw) ? propertyRaw : {};
      const presentation = metadata(name, property);
      const secret = options.secretNames.has(name) || isSecretReferenceKey(name);
      const childNode = secret
        ? { kind: 'unsupported', reason: 'Zugangsdaten werden ausschließlich serverseitig verwaltet.' } as const
        : parseSchemaNode(propertyRaw, { ...options, depth: options.depth + 1, root: false, partial: false });
      fields.push({
        name,
        ...presentation,
        required: required.includes(name),
        node: childNode,
        ...(secret ? { unsupported: 'Zugangsdaten werden ausschließlich serverseitig verwaltet.' } : childNode.kind === 'unsupported' ? { unsupported: childNode.reason } : {}),
        ...('defaultValue' in childNode
          ? { defaultValue: childNode.defaultValue }
          : {}),
      });
    }

    const conditionalKeys = ['if', 'then', 'else'].filter((key) => Object.hasOwn(raw, key));
    let conditional: Extract<ConfigurationSchemaNode, { kind: 'object' }>['conditional'];
    if (conditionalKeys.length > 0) {
      if (!Object.hasOwn(raw, 'if') || conditionalKeys.some((key) => key === 'then' || key === 'else' ? !Object.hasOwn(raw, 'if') : false)) {
        return { kind: 'unsupported', reason: 'Die Bedingung benötigt ein if-Schema.' };
      }
      const condition = parseCondition(raw.if);
      if (!condition) return { kind: 'unsupported', reason: 'Die if-Bedingung verwendet nicht unterstützte Regeln.' };
      const thenNode = raw.then === undefined ? undefined : parseSchemaNode(raw.then, { ...options, depth: options.depth + 1, root: false, partial: true });
      const elseNode = raw.else === undefined ? undefined : parseSchemaNode(raw.else, { ...options, depth: options.depth + 1, root: false, partial: true });
      if ((thenNode && thenNode.kind !== 'object') || (elseNode && elseNode.kind !== 'object')) {
        return { kind: 'unsupported', reason: 'then und else müssen Objektregeln enthalten.' };
      }
      if ((thenNode && findUnsupportedFields(thenNode).length > 0) || (elseNode && findUnsupportedFields(elseNode).length > 0)) {
        return { kind: 'unsupported', reason: 'Eine Bedingung enthält nicht unterstützte Feldregeln.' };
      }
      conditional = {
        condition,
        ...(thenNode ? { thenNode } : {}),
        ...(elseNode ? { elseNode } : {}),
      };
    }
    return {
      kind: 'object',
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      properties: fields,
      required,
      strict: raw.additionalProperties === false,
      ...(minProperties === undefined ? {} : { minProperties }),
      ...(maxProperties === undefined ? {} : { maxProperties }),
      ...(conditional ? { conditional } : {}),
    };
  }

  if (raw.type === 'array') {
    const arrayKeys = new Set(['type', 'title', 'description', 'default', 'items', 'minItems', 'maxItems', 'uniqueItems']);
    if (Object.keys(raw).some((key) => !arrayKeys.has(key)) || !Object.hasOwn(raw, 'items')) {
      return { kind: 'unsupported', reason: 'Dieses Array verwendet nicht unterstützte Regeln.' };
    }
    const items = parseSchemaNode(raw.items, { ...options, depth: options.depth + 1, root: false, partial: false });
    if (items.kind === 'unsupported') return { kind: 'unsupported', reason: `Arrayelemente: ${items.reason}` };
    const minItems = optionalNonNegativeInteger(raw.minItems);
    const maxItems = optionalNonNegativeInteger(raw.maxItems);
    if (
      (raw.minItems !== undefined && minItems === undefined) ||
      (raw.maxItems !== undefined && maxItems === undefined) ||
      (minItems !== undefined && maxItems !== undefined && minItems > maxItems) ||
      (minItems !== undefined && minItems > 64) ||
      (maxItems !== undefined && maxItems > 64) ||
      (raw.uniqueItems !== undefined && typeof raw.uniqueItems !== 'boolean')
    ) return { kind: 'unsupported', reason: 'Die Arraygrenzen im Schema sind ungültig.' };
    return {
      kind: 'array',
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      items,
      ...(minItems === undefined ? {} : { minItems }),
      ...(maxItems === undefined ? {} : { maxItems }),
      ...(raw.uniqueItems === true ? { uniqueItems: true } : {}),
      ...(defaultValue === undefined ? {} : { defaultValue }),
    };
  }

  const scalarKeys = new Set([
    'type', 'title', 'description', 'default', 'enum', 'const', 'minimum', 'maximum', 'exclusiveMinimum',
    'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern',
  ]);
  if (Object.keys(raw).some((key) => !scalarKeys.has(key))) {
    return { kind: 'unsupported', reason: 'Dieses Feld verwendet eine nicht unterstützte Schemastruktur.' };
  }
  const control = parseFieldControl(raw);
  if (!control) return { kind: 'unsupported', reason: 'Dieses Feld verwendet nicht unterstützte Validierungsregeln.' };
  const constant = Object.hasOwn(raw, 'const') && isScalar(raw.const) ? raw.const : undefined;
  if (Object.hasOwn(raw, 'const') && constant === undefined) {
    return { kind: 'unsupported', reason: 'Dieses Feld hat einen nicht unterstützten festen Wert.' };
  }
  if (defaultValue !== undefined && !isScalar(defaultValue)) {
    return { kind: 'unsupported', reason: 'Der Standardwert dieses Feldes ist kein einfacher Wert.' };
  }
  return {
    kind: 'scalar',
    control,
    ...(defaultValue === undefined ? {} : { defaultValue }),
    ...(constant === undefined ? {} : { constant }),
  };
}

function parseFieldControl(property: Record<string, unknown>): ConfigurationFieldControl | undefined {
  const type = property.type;
  if (type !== undefined && typeof type !== 'string') return undefined;
  if (Object.hasOwn(property, 'const')) {
    if (Object.keys(property).some((key) => !['type', 'title', 'description', 'default', 'const', 'enum'].includes(key))) return undefined;
    if (!isScalar(property.const) || (typeof type === 'string' && !matchesType(property.const, type))) return undefined;
    if (property.enum !== undefined && (!isScalarArray(property.enum) || !property.enum.includes(property.const))) return undefined;
    return { kind: 'enum', values: [property.const] };
  }
  if (Object.hasOwn(property, 'enum')) {
    if (Object.keys(property).some((key) => !['type', 'title', 'description', 'default', 'enum'].includes(key))) return undefined;
    const rawValues: unknown = property.enum;
    if (!isScalarArray(rawValues) || rawValues.length === 0 || rawValues.length > 64) return undefined;
    const values = rawValues;
    if (typeof type === 'string' && values.some((value) => !matchesType(value, type))) return undefined;
    const unique = new Set(values.map((value) => stableJson(value)));
    if (unique.size !== values.length) return undefined;
    return { kind: 'enum', values: [...values] };
  }

  if (type === 'string') {
    const minLength = optionalNonNegativeInteger(property.minLength);
    const maxLength = optionalNonNegativeInteger(property.maxLength);
    if ((property.minLength !== undefined && minLength === undefined) || (property.maxLength !== undefined && maxLength === undefined)) return undefined;
    if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) return undefined;
    let pattern: RegExp | undefined;
    if (property.pattern !== undefined) {
      if (typeof property.pattern !== 'string' || property.pattern.length > 256 || !isSafePattern(property.pattern)) return undefined;
      try {
        pattern = new RegExp(property.pattern, 'u');
      } catch {
        return undefined;
      }
    }
    return { kind: 'string', ...(minLength === undefined ? {} : { minLength }), ...(maxLength === undefined ? {} : { maxLength }), ...(pattern === undefined ? {} : { pattern }) };
  }

  if (type === 'number' || type === 'integer') {
    const minimum = optionalFiniteNumber(property.minimum);
    const maximum = optionalFiniteNumber(property.maximum);
    const exclusiveMinimum = optionalFiniteNumber(property.exclusiveMinimum);
    const exclusiveMaximum = optionalFiniteNumber(property.exclusiveMaximum);
    const multipleOf = optionalFiniteNumber(property.multipleOf);
    if (
      (property.minimum !== undefined && minimum === undefined) ||
      (property.maximum !== undefined && maximum === undefined) ||
      (property.exclusiveMinimum !== undefined && exclusiveMinimum === undefined) ||
      (property.exclusiveMaximum !== undefined && exclusiveMaximum === undefined) ||
      (property.multipleOf !== undefined && (multipleOf === undefined || multipleOf <= 0))
    ) return undefined;
    return {
      kind: type,
      ...(minimum === undefined ? {} : { minimum }),
      ...(maximum === undefined ? {} : { maximum }),
      ...(exclusiveMinimum === undefined ? {} : { exclusiveMinimum }),
      ...(exclusiveMaximum === undefined ? {} : { exclusiveMaximum }),
      ...(multipleOf === undefined ? {} : { multipleOf }),
    };
  }
  if (type === 'boolean') return { kind: 'boolean' };
  return undefined;
}

function parseRequiredNames(value: unknown, allowed?: ReadonlySet<string>): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128) return undefined;
  const names: string[] = [];
  for (const name of value as unknown[]) {
    if (typeof name !== 'string' || name.length === 0 || name.length > 128 || prototypeKeys.has(name) || (allowed && !allowed.has(name))) return undefined;
    names.push(name);
  }
  return new Set(names).size === names.length ? names : undefined;
}

function parseCondition(value: unknown): ConfigurationCondition | undefined {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !['type', 'properties', 'required', 'additionalProperties', 'title', 'description'].includes(key))) return undefined;
  if (value.type !== undefined && value.type !== 'object') return undefined;
  if (value.additionalProperties !== undefined && typeof value.additionalProperties !== 'boolean') return undefined;
  const properties = value.properties === undefined ? {} : value.properties;
  if (!isPlainRecord(properties) || Object.keys(properties).length > 64) return undefined;
    const required = parseRequiredNames(value.required);
  if (!required) return undefined;
  const parsedProperties: ConfigurationCondition['properties'] = {};
  for (const [name, rawPredicate] of Object.entries(properties)) {
    if (name.length === 0 || name.length > 128 || prototypeKeys.has(name) || !isPlainRecord(rawPredicate)) return undefined;
    if (Object.keys(rawPredicate).some((key) => !['type', 'const', 'enum'].includes(key))) return undefined;
    const type = rawPredicate.type;
    if (type !== undefined && (typeof type !== 'string' || !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type))) return undefined;
    const constant = rawPredicate.const;
    const values = rawPredicate.enum;
    if (constant !== undefined && !isBoundedJson(constant, 1_024, 4, 32)) return undefined;
    if (values !== undefined && (!isScalarArray(values) || values.length === 0 || values.length > 32)) return undefined;
    if (constant !== undefined && values !== undefined && !values.some((item) => stableJson(item) === stableJson(constant))) return undefined;
    parsedProperties[name] = {
      ...(typeof type === 'string' ? { type } : {}),
      ...(constant === undefined ? {} : { constant: constant as ConfigurationJson }),
      ...(Array.isArray(values) ? { values: [...values] as ConfigurationScalar[] } : {}),
    };
  }
  return { required, properties: parsedProperties, ...(typeof value.additionalProperties === 'boolean' ? { additionalProperties: value.additionalProperties } : {}) };
}

function findUnionDiscriminator(branches: unknown[]): { name: string; values: ConfigurationScalar[] } | undefined {
  if (branches.some((branch) => !isPlainRecord(branch) || branch.type !== 'object' || !isPlainRecord(branch.properties))) return undefined;
  const candidates = new Map<string, ConfigurationScalar[]>();
  for (const branchValue of branches) {
    const branch = branchValue as Record<string, unknown>;
    const required = parseRequiredNames(branch.required, new Set(Object.keys(branch.properties as Record<string, unknown>)));
    if (!required) return undefined;
    for (const name of required) {
      const property = (branch.properties as Record<string, unknown>)[name];
      if (!isPlainRecord(property)) continue;
      const candidate = isScalar(property.const)
        ? property.const
        : isScalarArray(property.enum) && property.enum.length === 1
          ? property.enum[0]
          : undefined;
      if (candidate === undefined) continue;
      const current = candidates.get(name) ?? [];
      current.push(candidate);
      candidates.set(name, current);
    }
  }
  for (const [name, values] of candidates) {
    if (values.length !== branches.length || new Set(values.map(stableJson)).size !== branches.length) continue;
    return { name, values };
  }
  return undefined;
}

function getDeclaredConstant(node: Extract<ConfigurationSchemaNode, { kind: 'object' }>, name: string): ConfigurationScalar | undefined {
  const property = node.properties.find((field) => field.name === name)?.node;
  if (property?.kind !== 'scalar') return undefined;
  return property.constant ?? (property.control.kind === 'enum' && property.control.values.length === 1 ? property.control.values[0] : undefined);
}

export function getVisibleConfigurationFields(
  node: Extract<ConfigurationSchemaNode, { kind: 'object' }>,
  value: unknown,
): ConfigurationFieldDescriptor[] {
  const conditional = node.conditional;
  const activeBranch = conditional
    ? conditionMatches(conditional.condition, value) ? conditional.thenNode : conditional.elseNode
    : undefined;
  const branchProperties = activeBranch?.kind === 'object' ? activeBranch.properties : [];
  const conditionalNames = new Set([
    ...(conditional?.thenNode?.kind === 'object' ? conditional.thenNode.properties.map((field) => field.name) : []),
    ...(conditional?.elseNode?.kind === 'object' ? conditional.elseNode.properties.map((field) => field.name) : []),
  ]);
  const activeByName = new Map(branchProperties.map((field) => [field.name, field]));
  const result = new Map<string, ConfigurationFieldDescriptor>();
  for (const base of node.properties) {
    if (conditionalNames.has(base.name) && !activeByName.has(base.name) && !base.required) continue;
    const field = activeByName.get(base.name) ?? base;
    const branchRequired = activeBranch?.kind === 'object' && activeBranch.required.includes(field.name);
    result.set(field.name, {
      ...base,
      ...(field !== base ? { node: field.node } : {}),
      required: base.required || field.required || branchRequired,
    });
  }
  for (const field of branchProperties) {
    if (result.has(field.name)) continue;
    const branchRequired = activeBranch?.kind === 'object' && activeBranch.required.includes(field.name);
    result.set(field.name, { ...field, required: field.required || branchRequired });
  }
  return [...result.values()];
}

export function getDeclaredConfigurationFieldNames(
  node: Extract<ConfigurationSchemaNode, { kind: 'object' }>,
): Set<string> {
  return new Set([
    ...node.properties.map((field) => field.name),
    ...(node.conditional?.thenNode?.kind === 'object' ? node.conditional.thenNode.properties.map((field) => field.name) : []),
    ...(node.conditional?.elseNode?.kind === 'object' ? node.conditional.elseNode.properties.map((field) => field.name) : []),
  ]);
}

export function getSelectedConfigurationUnionBranch(
  node: Extract<ConfigurationSchemaNode, { kind: 'union' }>,
  value: unknown,
): Extract<ConfigurationSchemaNode, { kind: 'union' }>['branches'][number] | undefined {
  if (!isPlainRecord(value)) return undefined;
  return node.branches.find((branch) => stableJson(value[node.discriminator]) === stableJson(branch.value));
}

/** Changes a union discriminator without deleting values entered for other branches. */
export function selectConfigurationUnionBranch(
  node: Extract<ConfigurationSchemaNode, { kind: 'union' }>,
  value: unknown,
  branchIndex: number,
): ConfigurationValues | undefined {
  const branch = node.branches[branchIndex];
  if (!branch) return undefined;
  const current = isPlainRecord(value) ? value : {};
  return { ...current, [node.discriminator]: branch.value } as ConfigurationValues;
}

/** Paths rendered by the field component, including container-level diagnostics. */
export function getVisibleConfigurationErrorPaths(root: ConfigurationSchemaNode, value: unknown): Set<string> {
  const paths = new Set<string>();
  let remaining = 512;
  const visit = (node: ConfigurationSchemaNode, current: unknown, path: string) => {
    if (remaining <= 0) return;
    remaining -= 1;
    paths.add(path);
    if (node.kind === 'object') {
      const objectValue = isPlainRecord(current) ? current : {};
      for (const field of getVisibleConfigurationFields(node, objectValue)) {
        visit(field.node, objectValue[field.name], configurationPointerChild(path, field.name));
      }
      return;
    }
    if (node.kind === 'array') {
      if (Array.isArray(current)) {
        for (const [index, item] of current.slice(0, 64).entries()) {
          visit(node.items, item, configurationPointerChild(path, index));
        }
      }
      return;
    }
    if (node.kind === 'union') {
      const objectValue = isPlainRecord(current) ? current : {};
      paths.add(configurationPointerChild(path, node.discriminator));
      const branch = getSelectedConfigurationUnionBranch(node, objectValue);
      if (branch) {
        for (const field of getVisibleConfigurationFields(branch.schema, objectValue)) {
          if (field.name !== node.discriminator) visit(field.node, objectValue[field.name], configurationPointerChild(path, field.name));
        }
      }
    }
  };
  visit(root, value, '');
  return paths;
}

export function makeConfigurationDefault(node: ConfigurationSchemaNode): ConfigurationJson {
  if (node.kind === 'scalar') {
    if (node.defaultValue !== undefined) return node.defaultValue;
    if (node.control.kind === 'enum') return node.control.values[0] ?? '';
    if (node.control.kind === 'boolean') return false;
    if (node.control.kind === 'number' || node.control.kind === 'integer') return '';
    return '';
  }
  if (node.kind === 'array') return node.defaultValue ?? [];
  if (node.kind === 'object') {
    const value: ConfigurationValues = {};
    for (const field of node.properties) {
      if (field.required) value[field.name] = field.defaultValue ?? makeConfigurationDefault(field.node);
    }
    return value;
  }
  if (node.kind === 'union') {
    const first = node.branches[0];
    return first ? { ...makeConfigurationDefault(first.schema) as ConfigurationValues, [node.discriminator]: first.value } : {};
  }
  return null;
}

export function configurationPointerChild(parent: string, segment: string | number): string {
  const escaped = String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
  return `${parent}/${escaped}`;
}

export function readConfigurationPointer(value: unknown, pointer: string): unknown {
  if (!pointer) return value;
  let current: unknown = value;
  for (const rawSegment of pointer.split('/').slice(1)) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current) && /^(?:0|[1-9]\d*)$/u.test(segment)) current = current[Number(segment)];
    else if (isPlainRecord(current) && Object.hasOwn(current, segment)) current = current[segment];
    else return undefined;
  }
  return current;
}

export function setConfigurationPointer(
  value: ConfigurationValues,
  pointer: string,
  nextValue: ConfigurationJson | undefined,
): ConfigurationValues {
  if (!pointer) return isPlainRecord(nextValue) ? nextValue : {};
  const segments = pointer.split('/').slice(1).map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
  const update = (current: unknown, depth: number): unknown => {
    const key = segments[depth];
    if (key === undefined) return nextValue;
    if (Array.isArray(current)) {
      const currentItems: unknown[] = current;
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index < 0 || index >= current.length) return current;
      const copy = [...currentItems];
      if (depth === segments.length - 1 && nextValue === undefined) copy.splice(index, 1);
      else copy[index] = update(copy[index], depth + 1);
      return copy;
    }
    const record = isPlainRecord(current) ? current : {};
    const copy: Record<string, unknown> = depth === segments.length - 1 && nextValue === undefined
      ? Object.fromEntries(Object.entries(record).filter(([name]) => name !== key))
      : { ...record };
    if (!(depth === segments.length - 1 && nextValue === undefined)) copy[key] = update(copy[key], depth + 1);
    return copy;
  };
  return update(value, 0) as ConfigurationValues;
}

export function parseConfigurationServerErrors(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const code = readOwnDataProperty(value, 'code');
  const rawErrors = readOwnDataProperty(value, 'errors');
  if (code !== 'configuration_invalid' || !Array.isArray(rawErrors) || rawErrors.length > 32) return {};
  const result: Record<string, string> = {};
  for (const entry of rawErrors) {
    if (
      !isPlainRecord(entry) || typeof entry.path !== 'string' || entry.path.length > 512 ||
      !/^(?:\/(?:[^~/]|~0|~1){1,128})*$/u.test(entry.path) ||
      typeof entry.message !== 'string' || entry.message.trim().length === 0 || entry.message.length > 320
    ) continue;
    result[entry.path] = entry.message;
  }
  return result;
}

export function getUnmappedConfigurationServerErrors(
  errors: Readonly<Record<string, string>>,
  visiblePaths: ReadonlySet<string>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(errors).filter(([path]) => !visiblePaths.has(path)));
}

function readOwnDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function normalizeConfigurationNode(
  node: ConfigurationSchemaNode,
  raw: unknown,
  present: boolean,
  path: string,
  errors: Record<string, string>,
  required = false,
): ConfigurationJson | undefined {
  if (node.kind === 'unsupported') {
    if (!present && required) errors[path] = 'Dieses Pflichtfeld wird in dieser Ansicht nicht unterstützt.';
    return present && isBoundedJson(raw, maxConfigurationBytes, 20, 4_096) ? raw as ConfigurationJson : undefined;
  }
  if (!present) {
    if (required) errors[path] = 'Dieses Feld ist erforderlich.';
    return undefined;
  }
  if (node.kind === 'scalar') {
    const parsed = parseFieldValue(node.control, raw, required);
    if ('error' in parsed) errors[path] = parsed.error;
    return 'value' in parsed ? parsed.value : undefined;
  }
  if (node.kind === 'array') {
    if (!Array.isArray(raw)) {
      errors[path] = 'Bitte gib eine Liste ein.';
      return raw as ConfigurationJson;
    }
    if (raw.length > 64) {
      errors[path] = 'Diese Liste überschreitet die Grenze von 64 Einträgen für die Bearbeitung.';
      return raw as ConfigurationJson;
    }
    if (raw.length < (node.minItems ?? 0)) errors[path] = `Mindestens ${String(node.minItems)} Einträge erforderlich.`;
    if (node.maxItems !== undefined && raw.length > node.maxItems) errors[path] = `Höchstens ${String(node.maxItems)} Einträge zulässig.`;
    const result: ConfigurationJson[] = [];
    for (let index = 0; index < raw.length; index += 1) {
      const item = normalizeConfigurationNode(node.items, raw[index], true, configurationPointerChild(path, index), errors, true);
      result.push(item ?? null);
    }
    if (node.uniqueItems && new Set(result.map(stableJson)).size !== result.length) errors[path] = 'Alle Listeneinträge müssen eindeutig sein.';
    return result;
  }
  if (node.kind === 'union') {
    if (!isPlainRecord(raw)) {
      errors[path] = 'Bitte wähle eine Objektvariante.';
      return raw as ConfigurationJson;
    }
    const branch = getSelectedConfigurationUnionBranch(node, raw);
    if (!branch) {
      errors[configurationPointerChild(path, node.discriminator)] = 'Bitte wähle eine gültige Variante.';
      return raw as ConfigurationJson;
    }
    const allBranchNames = new Set(node.branches.flatMap((candidate) => candidate.schema.properties.map((field) => field.name)));
    const activeBranchNames = new Set(branch.schema.properties.map((field) => field.name));
    const activeValues = Object.fromEntries(Object.entries(raw).filter(([name]) =>
      name === node.discriminator || activeBranchNames.has(name) || !allBranchNames.has(name),
    ));
    return normalizeConfigurationNode(branch.schema, activeValues, true, path, errors, true);
  }
  if (!isPlainRecord(raw)) {
    errors[path] = 'Bitte gib ein Objekt ein.';
    return raw as ConfigurationJson;
  }

  const visibleFields = getVisibleConfigurationFields(node, raw);
  const visibleNames = new Set(visibleFields.map((field) => field.name));
  const conditionalNames = new Set([
    ...(node.conditional?.thenNode?.kind === 'object' ? node.conditional.thenNode.properties.map((field) => field.name) : []),
    ...(node.conditional?.elseNode?.kind === 'object' ? node.conditional.elseNode.properties.map((field) => field.name) : []),
  ]);
  const result: Record<string, ConfigurationJson> = {};
  for (const field of visibleFields) {
    const childPresent = Object.hasOwn(raw, field.name);
    const childRaw = raw[field.name];
    const childPath = configurationPointerChild(path, field.name);
    const normalized = normalizeConfigurationNode(field.node, childRaw, childPresent, childPath, errors, field.required);
    const baseField = node.properties.find((candidate) => candidate.name === field.name);
    if (baseField && baseField.node !== field.node) {
      normalizeConfigurationNode(baseField.node, childRaw, childPresent, childPath, errors, field.required);
    }
    if (normalized !== undefined) result[field.name] = normalized;
  }

  for (const key of Object.keys(raw)) {
    if (visibleNames.has(key)) continue;
    if (node.conditional && conditionalNames.has(key)) {
      // Inactive conditional values stay in the editor draft but do not leave in the saved payload.
      continue;
    }
    if (node.strict) {
      errors[configurationPointerChild(path, key)] = 'Dieses Feld ist im Konfigurationsschema nicht vorgesehen.';
      if (isBoundedJson(raw[key], maxConfigurationBytes, 20, 4_096)) result[key] = raw[key] as ConfigurationJson;
    } else if (isBoundedJson(raw[key], maxConfigurationBytes, 20, 4_096)) {
      result[key] = raw[key] as ConfigurationJson;
    }
  }

  if (Object.keys(result).length < (node.minProperties ?? 0)) errors[path] = `Mindestens ${String(node.minProperties)} Eigenschaften erforderlich.`;
  if (node.maxProperties !== undefined && Object.keys(result).length > node.maxProperties) errors[path] = `Höchstens ${String(node.maxProperties)} Eigenschaften zulässig.`;
  return result;
}

function parseFieldValue(
  control: ConfigurationFieldControl,
  rawValue: unknown,
  required: boolean,
): { value: ConfigurationJson } | { error: string } | { omitted: true } {
  if (control.kind === 'string') {
    if (typeof rawValue !== 'string') return { error: 'Bitte gib einen Text ein.' };
    if (control.minLength !== undefined && rawValue.length < control.minLength) return { error: `Mindestens ${String(control.minLength)} Zeichen eingeben.` };
    if (control.maxLength !== undefined && rawValue.length > control.maxLength) return { error: `Höchstens ${String(control.maxLength)} Zeichen eingeben.` };
    if (control.pattern && !control.pattern.test(rawValue)) return { error: 'Der Text entspricht nicht dem vorgegebenen Muster.' };
    return { value: rawValue };
  }
  if (control.kind === 'enum') {
    const value = control.values.find((candidate) => candidate === rawValue);
    return value === undefined ? { error: 'Bitte wähle einen der vorgegebenen Werte.' } : { value };
  }
  if (control.kind === 'boolean') {
    return typeof rawValue === 'boolean' ? { value: rawValue } : { error: 'Bitte wähle Ja oder Nein.' };
  }
  if (rawValue === '') return required ? { error: 'Dieses Feld ist erforderlich.' } : { omitted: true };
  const number = parseNumber(rawValue);
  if (number === undefined) return { error: 'Bitte gib eine gültige Zahl ein.' };
  if (control.kind === 'integer' && !Number.isInteger(number)) return { error: 'Bitte gib eine ganze Zahl ein.' };
  if (control.minimum !== undefined && number < control.minimum) return { error: `Der Wert muss mindestens ${String(control.minimum)} sein.` };
  if (control.maximum !== undefined && number > control.maximum) return { error: `Der Wert darf höchstens ${String(control.maximum)} sein.` };
  if (control.exclusiveMinimum !== undefined && number <= control.exclusiveMinimum) return { error: `Der Wert muss größer als ${String(control.exclusiveMinimum)} sein.` };
  if (control.exclusiveMaximum !== undefined && number >= control.exclusiveMaximum) return { error: `Der Wert muss kleiner als ${String(control.exclusiveMaximum)} sein.` };
  if (control.multipleOf !== undefined && Math.abs(number / control.multipleOf - Math.round(number / control.multipleOf)) > 1e-8) {
    return { error: `Der Wert muss ein Vielfaches von ${String(control.multipleOf)} sein.` };
  }
  return { value: number };
}

function conditionMatches(condition: ConfigurationCondition, value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  if (condition.additionalProperties === false && Object.keys(value).some((name) => !Object.hasOwn(condition.properties, name))) return false;
  if (condition.required.some((name) => !Object.hasOwn(value, name))) return false;
  for (const [name, predicate] of Object.entries(condition.properties)) {
    if (!Object.hasOwn(value, name)) continue;
    const actual = value[name];
    if (predicate.constant !== undefined && stableJson(actual) !== stableJson(predicate.constant)) return false;
    if (predicate.values && !predicate.values.some((candidate) => stableJson(candidate) === stableJson(actual))) return false;
    if (predicate.type && !matchesJsonType(actual, predicate.type)) return false;
  }
  return true;
}

function matchesJsonType(value: unknown, type: string): boolean {
  if (type === 'null') return value === null;
  if (type === 'object') return isPlainRecord(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function getRootFields(root: ConfigurationSchemaNode): ConfigurationFieldDescriptor[] {
  if (root.kind === 'object') {
    const branchFields = [root.conditional?.thenNode, root.conditional?.elseNode]
      .flatMap((branch) => branch?.kind === 'object' ? branch.properties : []);
    const all = new Map<string, ConfigurationFieldDescriptor>();
    for (const field of [...root.properties, ...branchFields]) all.set(field.name, field);
    return [...all.values()];
  }
  if (root.kind === 'union') {
    const all = new Map<string, ConfigurationFieldDescriptor>();
    for (const branch of root.branches) for (const field of branch.schema.properties) all.set(field.name, field);
    return [...all.values()];
  }
  return [];
}

function findUnsupportedFields(node: ConfigurationSchemaNode, path = ''): string[] {
  if (node.kind === 'unsupported') return [path || '/'];
  if (node.kind === 'array') return findUnsupportedFields(node.items, configurationPointerChild(path, '*'));
  if (node.kind === 'union') return node.branches.flatMap((branch) => findUnsupportedFields(branch.schema, path));
  if (node.kind !== 'object') return [];
  const fields = node.properties.flatMap((field) => findUnsupportedFields(field.node, configurationPointerChild(path, field.name)));
  const conditional = [node.conditional?.thenNode, node.conditional?.elseNode].flatMap((branch) => branch ? findUnsupportedFields(branch, path) : []);
  return [...fields, ...conditional];
}

function filterPublicValues(
  values: ConfigurationValues,
  allowedKeys: ReadonlySet<string>,
  secrets: readonly PluginConfigurationSecret[] = [],
): ConfigurationValues {
  const result: ConfigurationValues = {};
  const secretNames = new Set(secrets.map((secret) => secret.name));
  for (const [key, value] of Object.entries(values)) {
    if (!allowedKeys.has(key) || secretNames.has(key) || isSecretReferenceKey(key)) continue;
    const sanitized = sanitizePublicValue(value, secretNames);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

function getPublicConfigurationKeys(
  definition: PluginConfigurationDefinition | undefined,
  secrets: readonly PluginConfigurationSecret[],
): Set<string> {
  const secretNames = new Set(secrets.map((secret) => secret.name));
  return new Set([...getSchemaPropertyNames(definition?.schema)].filter((key) => !secretNames.has(key) && !isSecretReferenceKey(key)));
}

function getSchemaPropertyNames(schema: unknown): Set<string> {
  const names = new Set<string>();
  const visit = (current: unknown, atRoot: boolean, depth: number) => {
    if (!isPlainRecord(current) || depth > 12) return;
    if (isPlainRecord(current.properties)) {
      if (atRoot) Object.keys(current.properties).filter((name) => !prototypeKeys.has(name)).forEach((name) => names.add(name));
      for (const child of Object.values(current.properties)) visit(child, false, depth + 1);
    }
    for (const key of ['allOf', 'oneOf', 'anyOf', 'if', 'then', 'else', 'not']) {
      const child = current[key];
      if (Array.isArray(child)) child.forEach((item) => { visit(item, atRoot, depth + 1); });
      else if (child !== undefined) visit(child, atRoot, depth + 1);
    }
  };
  visit(schema, true, 0);
  return names;
}

function sanitizePublicValue(value: unknown, secretNames: ReadonlySet<string>): ConfigurationJson | undefined {
  if (!isBoundedJson(value, maxConfigurationBytes, 20, 4_096)) return undefined;
  if (Array.isArray(value)) {
    return value.map((child) => sanitizePublicValue(child, secretNames) ?? null);
  }
  if (!isPlainRecord(value)) return value as ConfigurationJson;
  const result: ConfigurationValues = {};
  for (const [key, child] of Object.entries(value)) {
    if (secretNames.has(key) || isSecretReferenceKey(key)) continue;
    const sanitized = sanitizePublicValue(child, secretNames);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

function isSecretReferenceKey(key: string): boolean {
  const normalized = key.replace(/[^A-Za-z]/g, '').toLowerCase();
  return secretReferenceKeys.has(normalized);
}

function containsSecretReference(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecretReference);
  if (!isPlainRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => isSecretReferenceKey(key) || containsSecretReference(child));
}

function isBoundedJson(value: unknown, maxBytes: number, maxDepth: number, maxNodes: number): boolean {
  let nodes = 0;
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > maxNodes || depth > maxDepth) return false;
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return true;
    if (typeof current === 'number') return Number.isFinite(current);
    if (typeof current !== 'object' || seen.has(current)) return false;
    seen.add(current);
    if (Array.isArray(current)) {
      if (
        Object.getPrototypeOf(current) !== Array.prototype ||
        current.length > 4_096 ||
        Object.keys(current).length !== current.length ||
        Reflect.ownKeys(current).some((key) => typeof key !== 'string' || (key !== 'length' && !/^(?:0|[1-9]\d*)$/.test(key)))
      ) return false;
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor) || !visit(descriptor.value, depth + 1)) return false;
      }
    } else {
      if (!isPlainRecord(current)) return false;
      for (const key of Reflect.ownKeys(current)) {
        if (typeof key !== 'string' || prototypeKeys.has(key)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor) || !visit(descriptor.value, depth + 1)) return false;
      }
    }
    seen.delete(current);
    return true;
  };
  if (!visit(value, 0)) return false;
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= maxBytes;
  } catch {
    return false;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isScalar(value: unknown): value is ConfigurationScalar {
  return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

function isScalarArray(value: unknown): value is ConfigurationScalar[] {
  if (!Array.isArray(value)) return false;
  const values: unknown[] = value;
  return values.every(isScalar);
}

function isSafePattern(source: string): boolean {
  let inCharacterClass = false;
  let escaped = false;
  let quantifierCount = 0;
  for (const character of source) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '[' && !inCharacterClass) {
      inCharacterClass = true;
      continue;
    }
    if (character === ']' && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }
    if (inCharacterClass) continue;
    if (character === '(' || character === ')' || character === '|') return false;
    if (character === '*' || character === '+' || character === '?' || character === '{') {
      quantifierCount += 1;
      if (quantifierCount > 1) return false;
    }
  }
  return !escaped && !inCharacterClass;
}

function matchesType(value: ConfigurationScalar, type: string): boolean {
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'number') return typeof value === 'number';
  return typeof value === type;
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || !/^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/.test(value.trim())) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === new Set(right).size && left.every((name) => right.includes(name));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isPlainRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
