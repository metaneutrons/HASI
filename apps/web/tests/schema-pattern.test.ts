import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { parsePluginTools, type PluginToolDescriptor } from '../src/lib/plugin-tools';

vi.mock('server-only', () => ({}));
vi.mock('../src/lib/server/demo-runtime', () => ({ canonicalDemoRequest: vi.fn(), getDemoRuntime: vi.fn() }));

import { validatePluginToolArguments } from '../src/lib/server/authorized-tools';

const annyIdentifier = '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$';

function tool(inputSchema: Record<string, unknown>): PluginToolDescriptor {
  const pluginId = 'de.example.pattern';
  const name = 'catalog.search';
  const modelName = `hasi_${createHash('sha256').update(pluginId).update('\u0000').update(name).digest('hex').slice(0, 24)}`;
  return {
    pluginId,
    name,
    title: 'Search',
    description: 'Search catalog entries.',
    inputSchema,
    outputSchema: { type: 'object', properties: {}, additionalProperties: false },
    effect: 'read',
    requiredPermissions: ['catalog:read'],
    modelName,
  };
}

describe('plugin tool schema patterns', () => {
  it('rejects unsafe expressions at descriptor parsing and argument validation', () => {
    const unsafe = tool({
      type: 'object',
      properties: { value: { type: 'string', pattern: '^(a+)+$' } },
      required: ['value'],
      additionalProperties: false,
    });

    expect(parsePluginTools({ tools: [unsafe] })).toBeNull();
    expect(validatePluginToolArguments(unsafe, { value: `${'a'.repeat(24)}!` })).toBe(false);
  });

  it('keeps the bounded Anny identifier pattern usable for parsed and runtime schemas', () => {
    const safe = tool({
      type: 'object',
      properties: { resourceId: { type: 'string', pattern: annyIdentifier } },
      required: ['resourceId'],
      additionalProperties: false,
    });

    expect(parsePluginTools({ tools: [safe] })).toEqual([safe]);
    expect(validatePluginToolArguments(safe, { resourceId: 'resource_17-2' })).toBe(true);
    expect(validatePluginToolArguments(safe, { resourceId: '-resource_17' })).toBe(false);
  });
});
