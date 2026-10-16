import { z } from 'zod';

export interface ActorContext {
  subject: string;
  customerId: string;
  resourceIds: string[];
  permissions: string[];
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

export interface PluginManifest {
  manifestVersion: 1;
  id: string;
  name: string;
  description: string;
  version: string;
  apiVersion: '1.0.0';
  mcpVersion: '2026-07-28';
  tools: ToolDefinition[];
}

const nonEmptyString = z.string().trim().min(1).max(256);
const permissionSchema = nonEmptyString;
const jsonSchemaObject = z.record(z.string(), z.unknown());

export const actorContextSchema = z
  .object({
    subject: nonEmptyString,
    customerId: nonEmptyString,
    resourceIds: z.array(nonEmptyString),
    permissions: z.array(permissionSchema),
  })
  .strict();

const toolDefinitionSchema = z
  .object({
    name: nonEmptyString,
    title: nonEmptyString,
    description: z.string().max(4_096),
    inputSchema: jsonSchemaObject,
    outputSchema: jsonSchemaObject,
    effect: z.enum(['read', 'prepare', 'execute']),
    requiredPermissions: z.array(permissionSchema),
  })
  .strict()
  .superRefine((tool, context) => {
    if (new Set(tool.requiredPermissions).size !== tool.requiredPermissions.length) {
      context.addIssue({
        code: 'custom',
        path: ['requiredPermissions'],
        message: 'requiredPermissions must not contain duplicates',
      });
    }
  });

export const manifestSchema = z
  .object({
    manifestVersion: z.literal(1),
    id: nonEmptyString.regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
    name: nonEmptyString,
    description: z.string().max(4_096),
    version: nonEmptyString,
    apiVersion: z.literal('1.0.0'),
    mcpVersion: z.literal('2026-07-28'),
    tools: z.array(toolDefinitionSchema),
  })
  .strict()
  .superRefine((manifest, context) => {
    const names = new Set<string>();
    for (const [index, tool] of manifest.tools.entries()) {
      if (names.has(tool.name)) {
        context.addIssue({
          code: 'custom',
          path: ['tools', index, 'name'],
          message: `duplicate tool name: ${tool.name}`,
        });
      }
      names.add(tool.name);
    }
  });

export function parseActorContext(value: unknown): ActorContext {
  return actorContextSchema.parse(value);
}

export function parsePluginManifest(value: unknown): PluginManifest {
  return manifestSchema.parse(value);
}
