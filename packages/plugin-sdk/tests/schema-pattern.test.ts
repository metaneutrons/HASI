import { describe, expect, it } from 'vitest';
import { inspectJsonSchema, validateConfiguration } from '../src/configuration.js';
import { manifestSchema } from '../src/manifest.js';
import {
  compileSafeJsonSchemaPattern,
  isSafeJsonSchemaPattern,
  testSafeJsonSchemaPattern,
} from '../src/schema-pattern.js';

const annyIdentifier = '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$';

describe('safe JSON Schema pattern subset', () => {
  it('accepts bounded literal, escape, class, and repetition forms', () => {
    expect(isSafeJsonSchemaPattern(annyIdentifier)).toBe(true);
    expect(isSafeJsonSchemaPattern('^\\d{1,3}$')).toBe(true);
    expect(isSafeJsonSchemaPattern('^\\.\\*$')).toBe(true);
    expect(isSafeJsonSchemaPattern('^a{3}b{4096}$')).toBe(true);
    expect(isSafeJsonSchemaPattern('^[a-z]+$')).toBe(true);
    expect(isSafeJsonSchemaPattern('^(svc|int)-[0-9]{3}$')).toBe(true);
    expect(testSafeJsonSchemaPattern('^(svc|int)-[0-9]{3}$', 'svc-123')).toBe(true);
    expect(testSafeJsonSchemaPattern('^(svc|int)-[0-9]{3}$', 'int-001')).toBe(true);
    expect(testSafeJsonSchemaPattern('^(svc|int)-[0-9]{3}$', 'xyz-001')).toBe(false);
    expect(testSafeJsonSchemaPattern(annyIdentifier, 'Linden-2')).toBe(true);
    expect(testSafeJsonSchemaPattern(annyIdentifier, '-Linden')).toBe(false);
    expect(testSafeJsonSchemaPattern('^\\.\\*$', '.*')).toBe(true);
    expect(compileSafeJsonSchemaPattern(annyIdentifier)).toBeInstanceOf(RegExp);

    expect(isSafeJsonSchemaPattern(`^${'a'.repeat(254)}$`)).toBe(true);
    expect(isSafeJsonSchemaPattern(`^${'a'.repeat(255)}$`)).toBe(false);
  });

  it('rejects groups, alternation, backreferences, malformed classes, and excessive variable repetition', () => {
    for (const pattern of [
      '^(a+)+$',
      '^(a|aa)+$',
      '^(a|b){100}$',
      '^(a|b)(c|d)$',
      '^(a|b|c|d|e|f|g|h|i)$',
      '^a+a+a+$',
      '^a{0,127}b*$',
      '^(?:a)$',
      '^(?=a)a$',
      '^a|b$',
      '^\\1$',
      '^a{2,}$',
      '^a{0,5000}$',
      '^a{0,3}b{1,4}$',
      '^[z-a]$',
      '^[a-\\d]$',
      '^[abc$',
      'a+$',
      '^a+$x',
    ]) {
      expect(isSafeJsonSchemaPattern(pattern), pattern).toBe(false);
      expect(compileSafeJsonSchemaPattern(pattern), pattern).toBeUndefined();
    }

    expect(isSafeJsonSchemaPattern('^(a+)+$')).toBe(false);
    expect(testSafeJsonSchemaPattern('^(a+)+$', `${'a'.repeat(24)}!`)).toBe(false);
  });

  it('applies the subset during generic schema inspection and configuration validation', () => {
    const unsafeSchema = {
      type: 'object',
      properties: { identifier: { type: 'string', pattern: '^(a+)+$' } },
      required: ['identifier'],
      additionalProperties: false,
    };

    expect(inspectJsonSchema(unsafeSchema)).toContainEqual(expect.objectContaining({
      path: '/properties/identifier/pattern',
    }));
    expect(validateConfiguration(unsafeSchema, { identifier: `${'a'.repeat(24)}!` }).valid).toBe(false);
  });

  it('rejects unsafe patterns in manifest schemas before a plugin validator can compile them', () => {
    const manifest = {
      manifestVersion: 2,
      id: 'de.example.pattern',
      name: 'Pattern test',
      description: 'Pattern parser test plugin.',
      version: '1.0.0',
      apiVersion: '2.0.0',
      mcpVersion: '2026-07-28',
      tools: [{
        name: 'search',
        title: 'Search',
        description: 'Search entries.',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string', pattern: '^(a+)+$' } },
          required: ['value'],
          additionalProperties: false,
        },
        outputSchema: { type: 'object', properties: {}, additionalProperties: false },
        effect: 'read',
        requiredPermissions: [],
      }],
    };

    expect(manifestSchema.safeParse(manifest).success).toBe(false);
  });
});
