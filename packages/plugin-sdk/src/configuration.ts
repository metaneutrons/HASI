import { Ajv2020 } from 'ajv/dist/2020.js';
import type { AnySchema, ErrorObject, ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { z } from 'zod';
import { isSafeJsonSchemaPattern } from './schema-pattern.js';

const MAX_SCHEMA_BYTES = 32 * 1_024;
const MAX_SCHEMA_DEPTH = 20;
const MAX_SCHEMA_NODES = 2_048;
const MAX_CONFIGURATION_BYTES = 64 * 1_024;
const MAX_CONFIGURATION_DEPTH = 20;
const MAX_CONFIGURATION_NODES = 4_096;
const MAX_DIAGNOSTICS = 32;
const PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SECRET_REFERENCE_KEYS = new Set([
  '$secretRef',
  'secretRef',
  'secretReference',
  'secret_reference',
  'credentialRef',
  'credentialReference',
  'credential_reference',
]);

export interface ConfigurationFieldPresentation {
  name: string;
  label: string;
  help?: string;
  group?: string;
}

export interface PluginConfigurationDefinition {
  schema: Record<string, unknown>;
  fields?: ConfigurationFieldPresentation[];
}

export interface JsonSchemaDiagnostic {
  path: string;
  message: string;
}

export interface ConfigurationDiagnostic {
  path: string;
  code: string;
  message: string;
}

export type ConfigurationValidationResult =
  | { valid: true; data: Record<string, unknown>; diagnostics: [] }
  | { valid: false; diagnostics: ConfigurationDiagnostic[] };

const boundedText = (max: number) => z.string().trim().min(1).max(max);

const configurationFieldPresentationSchema = z
  .object({
    name: z.string().min(1).max(128).regex(/^[A-Za-z][A-Za-z0-9_.-]*$/),
    label: boundedText(128),
    help: z.string().max(1_024).optional(),
    group: boundedText(128).optional(),
  })
  .strict();

const jsonSchemaObjectSchema = z.record(z.string(), z.unknown()).superRefine((schema, context) => {
  for (const issue of inspectJsonSchema(schema)) {
    context.addIssue({ code: 'custom', path: issue.path ? issue.path.split('/').filter(Boolean) : [], message: issue.message });
  }
});

const configurationDefinitionObjectSchema = z
  .object({
    schema: jsonSchemaObjectSchema,
    fields: z.array(configurationFieldPresentationSchema).max(128).optional(),
  })
  .strict()
  .superRefine((configuration, context) => {
    const schema = configuration.schema;
    if (schema.type !== 'object' || !isPlainRecord(schema.properties) || schema.additionalProperties !== false) {
      context.addIssue({
        code: 'custom',
        path: ['schema'],
        message: 'public configuration schema must be an object with declared properties and additionalProperties:false',
      });
    }

    for (const issue of inspectPublicConfigurationSchema(schema)) {
      context.addIssue({
        code: 'custom',
        path: issue.path ? ['schema', ...issue.path.split('/').filter(Boolean)] : ['schema'],
        message: issue.message,
      });
    }

    const fields = configuration.fields ?? [];
    const fieldNames = new Set<string>();
    fields.forEach((field, index) => {
      if (fieldNames.has(field.name)) {
        context.addIssue({
          code: 'custom',
          path: ['fields', index, 'name'],
          message: `duplicate configuration field metadata: ${field.name}`,
        });
      }
      fieldNames.add(field.name);
      if (isPlainRecord(schema.properties) && !Object.hasOwn(schema.properties, field.name)) {
        context.addIssue({
          code: 'custom',
          path: ['fields', index, 'name'],
          message: `unknown configuration field: ${field.name}`,
        });
      }
    });
  });

export const configurationDefinitionSchema = z
  .unknown()
  .superRefine((value, context) => {
    const issue = inspectBoundedJson(value, { maxBytes: 256 * 1_024, maxDepth: 24, maxNodes: 8_192 });
    if (issue) context.addIssue({ code: 'custom', message: 'configuration definition is not bounded JSON data' });
  })
  .pipe(configurationDefinitionObjectSchema) as unknown as z.ZodType<PluginConfigurationDefinition>;

export function inspectJsonSchema(value: unknown): JsonSchemaDiagnostic[] {
  const diagnostics: JsonSchemaDiagnostic[] = [];
  const boundsIssue = inspectBoundedJson(value, {
    maxBytes: MAX_SCHEMA_BYTES,
    maxDepth: MAX_SCHEMA_DEPTH,
    maxNodes: MAX_SCHEMA_NODES,
  });
  if (boundsIssue) return [{ path: '', message: boundsIssue }];
  if (!isPlainRecord(value)) return [{ path: '', message: 'JSON Schema must be an object' }];

  const references: { path: string; reference: string }[] = [];
  const visit = (current: unknown, path: string, depth: number): void => {
    if (diagnostics.length >= 32 || depth > MAX_SCHEMA_DEPTH || current === null || typeof current !== 'object') return;
    const entries = Array.isArray(current)
      ? current.map((entry, index) => [String(index), entry] as const)
      : Object.entries(current);
    for (const [key, child] of entries) {
      const childPath = `${path}/${escapePointer(key)}`;
      if (PROTOTYPE_KEYS.has(key)) {
        diagnostics.push({ path: childPath, message: 'prototype-related keys are not allowed' });
      }
      if (key === '$ref') {
        if (typeof child !== 'string' || !child.startsWith('#')) {
          diagnostics.push({ path: childPath, message: 'only local JSON Schema references are allowed' });
        } else {
          references.push({ path: childPath, reference: child });
        }
      } else if (key === '$dynamicRef' || key === '$recursiveRef') {
        diagnostics.push({ path: childPath, message: 'dynamic and recursive JSON Schema references are not supported' });
      } else if (key === '$id' && (typeof child !== 'string' || (child !== '#' && !child.startsWith('#/')))) {
        diagnostics.push({ path: childPath, message: 'external JSON Schema identifiers are not allowed' });
      } else if (key === 'pattern' && !isSafeJsonSchemaPattern(child)) {
        diagnostics.push({ path: childPath, message: 'JSON Schema pattern is outside the supported safe subset' });
      }
      visit(child, childPath, depth + 1);
      if (diagnostics.length >= 32) return;
    }
  };
  visit(value, '', 0);

  for (const { path, reference } of references) {
    if (!resolvesLocalReference(value, reference)) {
      diagnostics.push({ path, message: 'JSON Schema reference does not resolve within this schema' });
    }
    if (diagnostics.length >= 32) break;
  }
  return diagnostics;
}

export function inspectPublicConfigurationSchema(schema: Record<string, unknown>): JsonSchemaDiagnostic[] {
  const diagnostics: JsonSchemaDiagnostic[] = [];
  const visit = (current: unknown, path: string): void => {
    if (diagnostics.length >= 32 || current === null || typeof current !== 'object') return;
    if (isPlainRecord(current)) {
      const declaredType = current.type;
      const hasObjectType = declaredType === 'object' || (Array.isArray(declaredType) && declaredType.includes('object'));
      if (hasObjectType) {
        if (!isPlainRecord(current.properties) || current.additionalProperties !== false) {
          diagnostics.push({ path, message: 'public configuration objects must declare properties and set additionalProperties:false' });
        } else if (Object.keys(current.properties).length > 128) {
          diagnostics.push({ path: `${path}/properties`, message: 'public configuration objects are limited to 128 fields' });
        }
      }
      if (Object.hasOwn(current, 'patternProperties') || Object.hasOwn(current, 'propertyNames')) {
        diagnostics.push({ path, message: 'dynamic public configuration fields are not allowed' });
      }
      if (Object.hasOwn(current, 'unevaluatedProperties') && current.unevaluatedProperties !== false) {
        diagnostics.push({ path: `${path}/unevaluatedProperties`, message: 'public configuration must not allow unevaluated fields' });
      }
    }
    const entries = Array.isArray(current)
      ? current.map((entry, index) => [String(index), entry] as const)
      : Object.entries(current);
    for (const [key, child] of entries) {
      const childPath = `${path}/${escapePointer(key)}`;
      if (PROTOTYPE_KEYS.has(key)) diagnostics.push({ path: childPath, message: 'prototype-related keys are not allowed' });
      if (SECRET_REFERENCE_KEYS.has(key)) diagnostics.push({ path: childPath, message: 'secret references are not allowed in public configuration' });
      if (key === 'writeOnly' && child === true) diagnostics.push({ path: childPath, message: 'secret fields are not allowed in public configuration' });
      if (key === 'properties' && isPlainRecord(child)) {
        for (const propertyName of Object.keys(child)) {
          if (SECRET_REFERENCE_KEYS.has(propertyName)) {
            diagnostics.push({
              path: `${childPath}/${escapePointer(propertyName)}`,
              message: 'secret reference fields are not allowed in public configuration',
            });
          }
        }
      }
      visit(child, childPath);
      if (diagnostics.length >= 32) return;
    }
  };
  visit(schema, '');
  return diagnostics;
}

export function inspectBoundedJson(
  value: unknown,
  limits: { maxBytes: number; maxDepth: number; maxNodes: number },
): string | undefined {
  let nodes = 0;
  const seen = new WeakSet();
  const visit = (current: unknown, depth: number): string | undefined => {
    nodes += 1;
    if (nodes > limits.maxNodes) return `JSON value exceeds ${String(limits.maxNodes)} nodes`;
    if (depth > limits.maxDepth) return `JSON value exceeds depth ${String(limits.maxDepth)}`;
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return undefined;
    if (typeof current === 'number') return Number.isFinite(current) ? undefined : 'JSON numbers must be finite';
    if (typeof current !== 'object') return 'value must contain only JSON data';
    if (seen.has(current)) return 'JSON values must not contain cycles';
    seen.add(current);

    if (Array.isArray(current)) {
      if (Object.getPrototypeOf(current) !== Array.prototype || Object.keys(current).length !== current.length) {
        return 'JSON arrays must be dense and have no custom properties';
      }
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return 'JSON arrays must contain plain data values';
        const issue = visit(descriptor.value, depth + 1);
        if (issue) return issue;
      }
      seen.delete(current);
      return undefined;
    }

    if (!isPlainRecord(current)) return 'JSON objects must be plain objects';
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key !== 'string') return 'JSON objects must not contain symbol keys';
      if (PROTOTYPE_KEYS.has(key)) return 'prototype-related keys are not allowed';
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return 'JSON objects must contain plain data values';
      const issue = visit(descriptor.value, depth + 1);
      if (issue) return issue;
    }
    seen.delete(current);
    return undefined;
  };

  let issue: string | undefined;
  try {
    issue = visit(value, 0);
  } catch {
    return 'JSON value must be plain data';
  }
  if (issue) return issue;
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== 'string') return 'value must be JSON serializable';
    if (new TextEncoder().encode(encoded).byteLength > limits.maxBytes) return `JSON value exceeds ${String(limits.maxBytes)} bytes`;
  } catch {
    return 'value must be JSON serializable';
  }
  return undefined;
}

export function validateConfiguration(
  schema: Record<string, unknown>,
  value: unknown,
): ConfigurationValidationResult {
  const schemaDiagnostics = inspectJsonSchema(schema);
  if (schemaDiagnostics.length > 0) {
    return {
      valid: false,
      diagnostics: [{ path: '$schema', code: 'invalid_schema', message: 'Configuration schema is invalid.' }],
    };
  }
  const publicSchemaDiagnostics = inspectPublicConfigurationSchema(schema);
  if (
    schema.type !== 'object' ||
    !isPlainRecord(schema.properties) ||
    schema.additionalProperties !== false ||
    publicSchemaDiagnostics.length > 0
  ) {
    return {
      valid: false,
      diagnostics: [{ path: '$schema', code: 'invalid_schema', message: 'Configuration schema is invalid.' }],
    };
  }

  const valueIssue = inspectBoundedJson(value, {
    maxBytes: MAX_CONFIGURATION_BYTES,
    maxDepth: MAX_CONFIGURATION_DEPTH,
    maxNodes: MAX_CONFIGURATION_NODES,
  });
  if (valueIssue) {
    return {
      valid: false,
      diagnostics: [{ path: '/', code: 'invalid_value', message: 'Configuration value is invalid or exceeds the allowed size.' }],
    };
  }
  const valueDiagnostics = inspectPublicConfigurationValue(value);
  if (valueDiagnostics.length > 0) return { valid: false, diagnostics: valueDiagnostics };
  if (!isPlainRecord(value)) {
    return { valid: false, diagnostics: [{ path: '/', code: 'type', message: 'Configuration must be an object.' }] };
  }

  try {
    const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
    addFormats.default(ajv);
    const validate: ValidateFunction = ajv.compile(schema as AnySchema);
    if (validate(value)) return { valid: true, data: value, diagnostics: [] };
    return { valid: false, diagnostics: safeAjvDiagnostics(validate.errors ?? []) };
  } catch {
    return {
      valid: false,
      diagnostics: [{ path: '$schema', code: 'invalid_schema', message: 'Configuration schema is invalid.' }],
    };
  }
}

export class ConfigurationValidationError extends Error {
  readonly diagnostics: ConfigurationDiagnostic[];

  constructor(diagnostics: ConfigurationDiagnostic[]) {
    super('Configuration is invalid.');
    this.name = 'ConfigurationValidationError';
    this.diagnostics = diagnostics;
  }
}

export function parseConfiguration(schema: Record<string, unknown>, value: unknown): Record<string, unknown> {
  const result = validateConfiguration(schema, value);
  if (!result.valid) throw new ConfigurationValidationError(result.diagnostics);
  return result.data;
}

function inspectPublicConfigurationValue(value: unknown): ConfigurationDiagnostic[] {
  const diagnostics: ConfigurationDiagnostic[] = [];
  const visit = (current: unknown, path: string): void => {
    if (diagnostics.length >= MAX_DIAGNOSTICS) return;
    if (typeof current === 'string' && /^secret(?:\+[^:]+)?:/i.test(current)) {
      diagnostics.push({ path: path || '/', code: 'secret_reference', message: 'Secret references are not allowed in public configuration.' });
      return;
    }
    if (current === null || typeof current !== 'object') return;
    const entries = Array.isArray(current)
      ? current.map((entry, index) => [String(index), entry] as const)
      : Object.entries(current);
    for (const [key, child] of entries) {
      const childPath = `${path}/${escapePointer(key)}`;
      if (SECRET_REFERENCE_KEYS.has(key)) {
        diagnostics.push({ path: childPath, code: 'secret_reference', message: 'Secret references are not allowed in public configuration.' });
      } else {
        visit(child, childPath);
      }
      if (diagnostics.length >= MAX_DIAGNOSTICS) return;
    }
  };
  visit(value, '');
  return diagnostics;
}

function safeAjvDiagnostics(errors: ErrorObject[]): ConfigurationDiagnostic[] {
  return errors.slice(0, MAX_DIAGNOSTICS).map((error) => ({
    path: (error.instancePath || '/').slice(0, 256),
    code: error.keyword.slice(0, 64),
    message: (error.message ?? 'Configuration value is invalid.').slice(0, 180),
  }));
}

function resolvesLocalReference(schema: Record<string, unknown>, reference: string): boolean {
  if (reference === '#') return true;
  if (!reference.startsWith('#/')) return false;
  const segments = reference.slice(2).split('/');
  let current: unknown = schema;
  for (const rawSegment of segments) {
    if (/~(?![01])/.test(rawSegment)) return false;
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(segment) || Number(segment) >= current.length) return false;
      current = current[Number(segment)];
    } else if (isPlainRecord(current) && Object.hasOwn(current, segment)) {
      current = current[segment];
    } else {
      return false;
    }
  }
  return typeof current === 'boolean' || isPlainRecord(current);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function escapePointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}
