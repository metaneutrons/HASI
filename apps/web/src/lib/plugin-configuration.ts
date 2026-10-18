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

export type ConfigurationFieldDescriptor = {
  name: string;
  label: string;
  help?: string;
  group: string;
  required: boolean;
  control: ConfigurationFieldControl;
} | {
  name: string;
  label: string;
  help?: string;
  group: string;
  required: boolean;
  unsupported: string;
};

export interface ConfigurationFieldSet {
  supported: boolean;
  reason?: string;
  fields: ConfigurationFieldDescriptor[];
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
const rootSchemaKeys = new Set(['type', 'properties', 'required', 'additionalProperties', 'title', 'description', '$schema']);
const propertySchemaKeys = new Set([
  'type', 'title', 'description', 'default', 'enum', 'minimum', 'maximum', 'exclusiveMinimum',
  'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern',
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
  const configuration = filterPublicValues(rawConfiguration, publicKeys);
  const draft = filterPublicValues(rawDraft, publicKeys);
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
  const schema = definition.schema;
  if (
    !isPlainRecord(schema) ||
    schema.type !== 'object' ||
    !isPlainRecord(schema.properties) ||
    schema.additionalProperties !== false ||
    Object.keys(schema.properties).length > 128 ||
    Object.keys(schema.properties).some((name) => name.length === 0 || name.length > 128)
  ) {
    return {
      supported: false,
      reason: 'Dieses Plug-in verwendet ein Konfigurationsschema, das diese Ansicht nicht bearbeiten kann. Die Werte bleiben unverändert.',
      fields: [],
    };
  }

  const unknownRootKeys = Object.keys(schema).filter((key) => !rootSchemaKeys.has(key));
  if (unknownRootKeys.length > 0) {
    return {
      supported: false,
      reason: 'Das Konfigurationsschema enthält nicht unterstützte Regeln. Die Werte bleiben unverändert.',
      fields: [],
    };
  }

  const requiredNames: string[] = [];
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required)) {
      return {
        supported: false,
        reason: 'Die Pflichtfelder im Konfigurationsschema sind ungültig. Die Werte bleiben unverändert.',
        fields: [],
      };
    }
    const rawRequiredNames: unknown[] = schema.required;
    for (const name of rawRequiredNames) {
      if (typeof name !== 'string' || !Object.hasOwn(schema.properties, name)) {
        return {
          supported: false,
          reason: 'Die Pflichtfelder im Konfigurationsschema sind ungültig. Die Werte bleiben unverändert.',
          fields: [],
        };
      }
      requiredNames.push(name);
    }
    if (new Set(requiredNames).size !== requiredNames.length) {
      return {
        supported: false,
        reason: 'Die Pflichtfelder im Konfigurationsschema sind ungültig. Die Werte bleiben unverändert.',
        fields: [],
      };
    }
  }

  const required = new Set(requiredNames);
  const metadata = new Map((definition.fields ?? []).map((field) => [field.name, field]));
  const secretNames = new Set(secrets.map((secret) => secret.name));
  const fields: ConfigurationFieldDescriptor[] = [];

  for (const [name, rawPropertySchema] of Object.entries(schema.properties)) {
    const property = isPlainRecord(rawPropertySchema) ? rawPropertySchema : null;
    const fieldMetadata = metadata.get(name);
    const label = fieldMetadata?.label ?? (property && typeof property.title === 'string' ? property.title.slice(0, 128) : name);
    const help = fieldMetadata?.help ?? (property && typeof property.description === 'string' ? property.description.slice(0, 1_024) : undefined);
    const group = fieldMetadata?.group ?? 'Einstellungen';
    const isRequired = required.has(name);
    const common = {
      name,
      label,
      ...(help === undefined ? {} : { help }),
      group,
      required: isRequired,
    };

    if (secretNames.has(name) || isSecretReferenceKey(name)) {
      fields.push({ ...common, unsupported: 'Zugangsdaten werden ausschließlich serverseitig verwaltet.' });
      continue;
    }
    if (!property) {
      fields.push({ ...common, unsupported: 'Das Feldschema kann hier nicht bearbeitet werden.' });
      continue;
    }

    const unknownKeys = Object.keys(property).filter((key) => !propertySchemaKeys.has(key));
    if (unknownKeys.length > 0) {
      fields.push({ ...common, unsupported: 'Dieses Feld verwendet nicht unterstützte Validierungsregeln und bleibt unverändert.' });
      continue;
    }
    if (Object.hasOwn(property, 'default') && !isScalar(property.default)) {
      fields.push({ ...common, unsupported: 'Der Standardwert dieses Feldes ist kein unterstützter einfacher Wert.' });
      continue;
    }
    const control = parseFieldControl(property);
    if (!control) {
      fields.push({ ...common, unsupported: 'Dieses Feld verwendet ein nicht unterstütztes Schema und bleibt unverändert.' });
      continue;
    }
    fields.push({ ...common, control });
  }

  return { supported: true, fields };
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
  const unsupportedFields = fieldSet.fields.filter((field) => 'unsupported' in field).map((field) => field.name);
  if (!fieldSet.supported) errors._schema = fieldSet.reason ?? 'Das Konfigurationsschema wird nicht unterstützt.';

  let values: ConfigurationValues = {};
  if (definition && fieldSet.supported && rawValuesSafe) {
    const allowedKeys = getPublicConfigurationKeys(definition, secrets);
    for (const [key, value] of Object.entries(rawValues)) {
      if (!allowedKeys.has(key) || !isBoundedJson(value, maxConfigurationBytes, 20, 4_096) || containsSecretReference(value)) continue;
      values[key] = value as ConfigurationJson;
    }

    for (const field of fieldSet.fields) {
      if ('unsupported' in field) {
        if (field.required && !Object.hasOwn(values, field.name)) {
          errors[field.name] = 'Dieses Pflichtfeld kann in dieser Ansicht nicht bearbeitet werden.';
        }
        continue;
      }

      const present = Object.hasOwn(rawValues, field.name);
      const raw = rawValues[field.name];
      const parsed = parseFieldValue(field, raw, present);
      if ('error' in parsed) {
        errors[field.name] = parsed.error;
      } else if ('value' in parsed) {
        values[field.name] = parsed.value;
      } else {
        values = omitConfigurationKey(values, field.name);
      }
    }
  }

  const validToolNames = new Set(tools.map((tool) => tool.name));
  const filteredDisabledTools = [...new Set(disabledTools.filter((name) => validToolNames.has(name)))];
  if (Object.keys(values).some(isSecretReferenceKey)) {
    errors._configuration = 'Geheime Zugangsdaten dürfen nicht Teil der öffentlichen Konfiguration sein.';
  }
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
    const properties = isPlainRecord(value.schema.properties) ? value.schema.properties : {};
    fields = value.fields.map((field) => {
      if (!isPlainRecord(field) || typeof field.name !== 'string' || typeof field.label !== 'string') {
        throw new TypeError('Invalid plugin configuration response');
      }
      if ((field.help !== undefined && typeof field.help !== 'string') || (field.group !== undefined && typeof field.group !== 'string')) {
        throw new TypeError('Invalid plugin configuration response');
      }
      if (field.name.length > 128 || field.label.trim().length === 0 || field.label.length > 128 || fieldNames.has(field.name) || !Object.hasOwn(properties, field.name)) {
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

function parseFieldControl(property: Record<string, unknown>): ConfigurationFieldControl | undefined {
  if (Object.hasOwn(property, 'const')) return undefined;
  if (Object.hasOwn(property, 'enum')) {
    if (Object.keys(property).some((key) => !['type', 'title', 'description', 'default', 'enum'].includes(key))) return undefined;
    const rawValues: unknown = property.enum;
    if (!isScalarArray(rawValues) || rawValues.length === 0 || rawValues.length > 64) return undefined;
    const values = rawValues;
    const type = property.type;
    if (type !== undefined && typeof type !== 'string') return undefined;
    if (typeof type === 'string' && values.some((value) => !matchesType(value, type))) return undefined;
    const unique = new Set(values.map((value) => stableJson(value)));
    if (unique.size !== values.length) return undefined;
    return { kind: 'enum', values: [...values] };
  }

  if (property.type === 'string') {
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

  if (property.type === 'number' || property.type === 'integer') {
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
      kind: property.type,
      ...(minimum === undefined ? {} : { minimum }),
      ...(maximum === undefined ? {} : { maximum }),
      ...(exclusiveMinimum === undefined ? {} : { exclusiveMinimum }),
      ...(exclusiveMaximum === undefined ? {} : { exclusiveMaximum }),
      ...(multipleOf === undefined ? {} : { multipleOf }),
    };
  }

  if (property.type === 'boolean') return { kind: 'boolean' };
  return undefined;
}

function parseFieldValue(
  field: Extract<ConfigurationFieldDescriptor, { control: ConfigurationFieldControl }>,
  rawValue: unknown,
  present: boolean,
): { present: true; value: ConfigurationJson } | { present: false } | { error: string } {
  const { control } = field;
  if (!present) {
    return field.required ? { error: 'Dieses Feld ist erforderlich.' } : { present: false };
  }

  if (control.kind === 'string') {
    if (typeof rawValue !== 'string') return { error: 'Bitte gib einen Text ein.' };
    if (control.minLength !== undefined && rawValue.length < control.minLength) return { error: `Mindestens ${String(control.minLength)} Zeichen eingeben.` };
    if (control.maxLength !== undefined && rawValue.length > control.maxLength) return { error: `Höchstens ${String(control.maxLength)} Zeichen eingeben.` };
    if (control.pattern && !control.pattern.test(rawValue)) return { error: 'Der Text entspricht nicht dem vorgegebenen Muster.' };
    return { present: true, value: rawValue };
  }

  if (control.kind === 'enum') {
    const value = control.values.find((candidate) => candidate === rawValue);
    return value === undefined
      ? { error: 'Bitte wähle einen der vorgegebenen Werte.' }
      : { present: true, value };
  }

  if (control.kind === 'boolean') {
    return typeof rawValue === 'boolean'
      ? { present: true, value: rawValue }
      : { error: 'Bitte wähle Ja oder Nein.' };
  }

  if (rawValue === '') return field.required ? { error: 'Dieses Feld ist erforderlich.' } : { present: false };
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
  return { present: true, value: number };
}

function filterPublicValues(values: ConfigurationValues, allowedKeys: ReadonlySet<string>): ConfigurationValues {
  const result: ConfigurationValues = {};
  for (const [key, value] of Object.entries(values)) {
    if (allowedKeys.has(key) && !containsSecretReference(value) && !isSecretReferenceKey(key)) result[key] = value;
  }
  return result;
}

function getPublicConfigurationKeys(
  definition: PluginConfigurationDefinition | undefined,
  secrets: readonly PluginConfigurationSecret[],
): Set<string> {
  const properties = definition?.schema.properties;
  if (!isPlainRecord(properties)) return new Set();
  const secretNames = new Set(secrets.map((secret) => secret.name));
  return new Set(Object.keys(properties).filter((key) => !secretNames.has(key) && !isSecretReferenceKey(key)));
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

function omitConfigurationKey<T extends Record<string, unknown>>(values: T, key: string): T {
  return Object.fromEntries(Object.entries(values).filter(([name]) => name !== key)) as T;
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
