import { z } from 'zod';
import {
  configurationDefinitionSchema,
  inspectBoundedJson,
  inspectJsonSchema,
  type ConfigurationFieldPresentation,
  type PluginConfigurationDefinition,
} from './configuration.js';
import { presentationSchema, type PluginPresentation } from './presentation.js';

export type ActorClaimScalar = string | number | boolean | null;
export type ActorClaimValue = ActorClaimScalar | string[];

export interface ActorContext {
  subject: string;
  permissions: string[];
  customerId?: string;
  resourceIds?: string[];
  claims?: Record<string, ActorClaimValue>;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  effect: 'read' | 'prepare' | 'execute';
  requiredPermissions: string[];
}

export type ToolVisibility = 'model' | 'app';
export type ToolResultKind = 'generic' | 'resources' | 'bookings' | 'knowledge' | 'proposal';

export interface ToolDefinitionV2 extends ToolDefinition {
  visibility?: ToolVisibility[];
  presentationId?: string;
  resultSemantics?: { kind: ToolResultKind };
}

export interface PluginSecretRequirement {
  name: string;
  required: boolean;
}

export interface PluginIdentityDeclaration {
  claims: string[];
}

export interface PluginManifestV1 {
  manifestVersion: 1;
  id: string;
  name: string;
  description: string;
  version: string;
  apiVersion: '1.0.0';
  mcpVersion: '2026-07-28';
  tools: ToolDefinition[];
}

export interface PluginManifestV2 {
  manifestVersion: 2;
  id: string;
  name: string;
  description: string;
  version: string;
  apiVersion: '2.0.0';
  mcpVersion: '2026-07-28';
  tools: ToolDefinitionV2[];
  configuration?: PluginConfigurationDefinition;
  secrets?: PluginSecretRequirement[];
  identity?: PluginIdentityDeclaration;
  presentations?: PluginPresentation[];
}

export type PluginManifest = PluginManifestV1 | PluginManifestV2;

const nonEmptyString = z.string().trim().min(1).max(256);
const permissionSchema = nonEmptyString;
const actorClaimName = z.string().min(1).max(128).regex(/^[A-Za-z][A-Za-z0-9._:-]*$/);
const boundedManifestInputSchema = z.unknown().superRefine((value, context) => {
  const issue = inspectBoundedJson(value, { maxBytes: 256 * 1_024, maxDepth: 32, maxNodes: 8_192 });
  if (issue) context.addIssue({ code: 'custom', message: 'manifest input is not bounded JSON data' });
});
const boundedActorInputSchema = z.unknown().superRefine((value, context) => {
  const issue = inspectBoundedJson(value, { maxBytes: 32 * 1_024, maxDepth: 8, maxNodes: 1_024 });
  if (issue) context.addIssue({ code: 'custom', message: 'actor context is not bounded JSON data' });
});
const jsonSchemaObject = z.record(z.string(), z.unknown()).superRefine((schema, context) => {
  for (const issue of inspectJsonSchema(schema)) {
    context.addIssue({
      code: 'custom',
      path: issue.path ? issue.path.split('/').filter(Boolean) : [],
      message: issue.message,
    });
  }
});

const scalarClaimSchema = z.union([
  z.string().max(1_024),
  z.number().min(-1_000_000_000_000_000).max(1_000_000_000_000_000),
  z.boolean(),
  z.null(),
]);
const claimValueSchema = z.union([
  scalarClaimSchema,
  z.array(z.string().max(256)).max(256).superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message: 'claim string arrays must not contain duplicates' });
    }
  }),
]);
const actorClaimsSchema = z.record(actorClaimName, claimValueSchema).superRefine((claims, context) => {
  if (Object.keys(claims).length > 64) {
    context.addIssue({ code: 'custom', message: 'claims must not contain more than 64 entries' });
  }
});

const actorContextObjectSchema = z
  .object({
    subject: nonEmptyString,
    permissions: z.array(permissionSchema).max(128),
    customerId: nonEmptyString.optional(),
    resourceIds: z.array(nonEmptyString).max(256).optional(),
    claims: actorClaimsSchema.optional(),
  })
  .strict()
  .superRefine((actor, context) => {
    if (new Set(actor.permissions).size !== actor.permissions.length) {
      context.addIssue({ code: 'custom', path: ['permissions'], message: 'permissions must not contain duplicates' });
    }
    if (actor.resourceIds && new Set(actor.resourceIds).size !== actor.resourceIds.length) {
      context.addIssue({ code: 'custom', path: ['resourceIds'], message: 'resourceIds must not contain duplicates' });
    }
    for (const key of Object.keys(actor.claims ?? {})) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        context.addIssue({ code: 'custom', path: ['claims', key], message: 'prototype-related claim names are not allowed' });
      }
    }
  });

const toolShape = {
  name: nonEmptyString,
  title: nonEmptyString,
  description: z.string().max(4_096),
  inputSchema: jsonSchemaObject,
  outputSchema: jsonSchemaObject,
  effect: z.enum(['read', 'prepare', 'execute']),
  requiredPermissions: z.array(permissionSchema).max(128),
};

function withToolValidation<T extends { requiredPermissions: string[] }>(schema: z.ZodType<T>) {
  return schema.superRefine((tool, context) => {
    if (new Set(tool.requiredPermissions).size !== tool.requiredPermissions.length) {
      context.addIssue({
        code: 'custom',
        path: ['requiredPermissions'],
        message: 'requiredPermissions must not contain duplicates',
      });
    }
  });
}

const toolDefinitionV1Schema = withToolValidation(z.object(toolShape).strict());
const toolDefinitionV2Schema = withToolValidation(
  z
    .object({
      ...toolShape,
      visibility: z.array(z.enum(['model', 'app'])).min(1).max(2).optional(),
      presentationId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).optional(),
      resultSemantics: z.object({ kind: z.enum(['generic', 'resources', 'bookings', 'knowledge', 'proposal']) }).strict().optional(),
    })
    .strict()
    .superRefine((tool, context) => {
      if (tool.visibility && new Set(tool.visibility).size !== tool.visibility.length) {
        context.addIssue({ code: 'custom', path: ['visibility'], message: 'visibility must not contain duplicates' });
      }
      if (tool.presentationId && tool.visibility && !tool.visibility.includes('app')) {
        context.addIssue({ code: 'custom', path: ['presentationId'], message: 'presentationId requires app visibility' });
      }
    }),
);

const identitySchema = z
  .object({ claims: z.array(actorClaimName).max(64) })
  .strict()
  .superRefine((identity, context) => {
    if (new Set(identity.claims).size !== identity.claims.length) {
      context.addIssue({ code: 'custom', path: ['claims'], message: 'identity claims must not contain duplicates' });
    }
  });

const secretRequirementSchema = z
  .object({
    name: z.string().min(1).max(128).regex(/^[A-Za-z][A-Za-z0-9._-]*$/),
    required: z.boolean(),
  })
  .strict();

const commonManifestShape = {
  id: nonEmptyString.regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  name: nonEmptyString,
  description: z.string().max(4_096),
  version: nonEmptyString,
  mcpVersion: z.literal('2026-07-28'),
};

const manifestVersion1ObjectSchema = z
  .object({
    manifestVersion: z.literal(1),
    ...commonManifestShape,
    apiVersion: z.literal('1.0.0'),
    tools: z.array(toolDefinitionV1Schema).max(64),
  })
  .strict()
  .superRefine((manifest, context) => {
    addUniqueToolNameIssues(manifest.tools, context);
  });

const manifestVersion2ObjectSchema = z
  .object({
    manifestVersion: z.literal(2),
    ...commonManifestShape,
    apiVersion: z.literal('2.0.0'),
    tools: z.array(toolDefinitionV2Schema).max(64),
    configuration: configurationDefinitionSchema.optional(),
    secrets: z.array(secretRequirementSchema).max(32).optional(),
    identity: identitySchema.optional(),
    presentations: z.array(presentationSchema).max(32).optional(),
  })
  .strict()
  .superRefine((manifest, context) => {
    addUniqueToolNameIssues(manifest.tools, context);

    const secrets = manifest.secrets ?? [];
    const secretNames = new Set<string>();
    secrets.forEach((secret, index) => {
      if (secretNames.has(secret.name)) {
        context.addIssue({ code: 'custom', path: ['secrets', index, 'name'], message: `duplicate logical secret name: ${secret.name}` });
      }
      secretNames.add(secret.name);
      const properties = manifest.configuration?.schema.properties;
      if (isRecord(properties) && Object.hasOwn(properties, secret.name)) {
        context.addIssue({ code: 'custom', path: ['secrets', index, 'name'], message: `secret must not be a public configuration field: ${secret.name}` });
      }
    });

    const presentations = manifest.presentations ?? [];
    const presentationIds = new Set<string>();
    const resourceUris = new Set<string>();
    presentations.forEach((presentation, index) => {
      if (presentationIds.has(presentation.id)) {
        context.addIssue({ code: 'custom', path: ['presentations', index, 'id'], message: `duplicate presentation id: ${presentation.id}` });
      }
      if (resourceUris.has(presentation.resourceUri)) {
        context.addIssue({ code: 'custom', path: ['presentations', index, 'resourceUri'], message: `duplicate presentation resource URI: ${presentation.resourceUri}` });
      }
      presentationIds.add(presentation.id);
      resourceUris.add(presentation.resourceUri);
    });

    manifest.tools.forEach((tool, index) => {
      if (tool.presentationId && !presentationIds.has(tool.presentationId)) {
        context.addIssue({ code: 'custom', path: ['tools', index, 'presentationId'], message: `unknown presentation id: ${tool.presentationId}` });
      }
    });
  });

export const actorContextSchema = boundedActorInputSchema.pipe(actorContextObjectSchema) as unknown as z.ZodType<ActorContext>;
export const manifestVersion1Schema = boundedManifestInputSchema.pipe(manifestVersion1ObjectSchema) as unknown as z.ZodType<PluginManifestV1>;
export const manifestVersion2Schema = boundedManifestInputSchema.pipe(manifestVersion2ObjectSchema) as unknown as z.ZodType<PluginManifestV2>;
export const manifestSchema = z.union([manifestVersion1Schema, manifestVersion2Schema]) as unknown as z.ZodType<PluginManifest>;

export function parseActorContext(value: unknown): ActorContext {
  return actorContextSchema.parse(value);
}

export function parsePluginManifest(value: unknown): PluginManifest {
  return manifestSchema.parse(value);
}

export function projectActorContext(actor: ActorContext, manifest: PluginManifest): ActorContext {
  const requiredPermissions = new Set(manifest.tools.flatMap((tool) => tool.requiredPermissions));
  const projected: ActorContext = {
    subject: actor.subject,
    permissions: actor.permissions.filter((permission) => requiredPermissions.has(permission)),
  };

  if (manifest.manifestVersion === 1 && manifest.id === 'de.hsh.hasi.anny') {
    if (actor.customerId !== undefined) projected.customerId = actor.customerId;
    if (actor.resourceIds !== undefined) projected.resourceIds = [...actor.resourceIds];
  }

  if (manifest.manifestVersion === 2 && actor.claims && manifest.identity) {
    const claims: Record<string, ActorClaimValue> = {};
    for (const claimName of manifest.identity.claims) {
      const claimValue = actor.claims[claimName];
      if (claimValue !== undefined) claims[claimName] = Array.isArray(claimValue) ? [...claimValue] : claimValue;
    }
    if (Object.keys(claims).length > 0) projected.claims = claims;
  }

  return projected;
}

function addUniqueToolNameIssues(
  tools: { name: string }[],
  context: z.RefinementCtx,
): void {
  const names = new Set<string>();
  for (const [index, tool] of tools.entries()) {
    if (names.has(tool.name)) {
      context.addIssue({ code: 'custom', path: ['tools', index, 'name'], message: `duplicate tool name: ${tool.name}` });
    }
    names.add(tool.name);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export type { ConfigurationFieldPresentation, PluginConfigurationDefinition };
