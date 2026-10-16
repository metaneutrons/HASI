import type { PluginManifest, ToolDefinition } from '@hasi/plugin-sdk';

const string = { type: 'string' };
const annyId = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' };
const timestamp = { type: 'string', format: 'date-time' };
const object = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const intervalInput = { resourceId: annyId, serviceId: annyId, startDate: timestamp, endDate: timestamp };
const resource = object({ id: annyId, name: string, description: string, capacity: { type: ['integer', 'null'], minimum: 1 }, location: string, features: { type: 'array', items: string }, serviceId: annyId });
const tools: ToolDefinition[] = [
  { name: 'anny.search_resources', title: 'Räume suchen', description: 'Find rooms the authenticated user may access.', effect: 'read', requiredPermissions: ['rooms:read'], inputSchema: object({}), outputSchema: object({ resources: { type: 'array', items: resource } }) },
  { name: 'anny.get_availability', title: 'Verfügbarkeit prüfen', description: 'Read available intervals for an authorized room and service.', effect: 'read', requiredPermissions: ['rooms:read'], inputSchema: object({ resourceId: annyId, serviceId: annyId, startDate: timestamp, durationMinutes: { type: 'integer', minimum: 15, maximum: 1440 } }), outputSchema: object({ intervals: { type: 'array', items: object({ startDate: timestamp, endDate: timestamp, available: { type: 'boolean' } }) } }) },
  { name: 'anny.list_my_bookings', title: 'Eigene Buchungen', description: 'List the authenticated customer’s bookings, never another customer’s.', effect: 'read', requiredPermissions: ['rooms:read'], inputSchema: object({}), outputSchema: object({ bookings: { type: 'array', items: object({ id: string, resourceName: string, startDate: timestamp, endDate: timestamp, status: string }) } }) },
  { name: 'anny.propose_booking', title: 'Buchung vorbereiten', description: 'Prepare a proposal only; external booking requires separate authenticated user confirmation.', effect: 'prepare', requiredPermissions: ['rooms:prepare'], inputSchema: object(intervalInput), outputSchema: object({ draft: object({ executionTool: { const: 'anny.execute_booking', type: 'string' }, arguments: object(intervalInput), resourceName: string }) }) },
  { name: 'anny.execute_booking', title: 'Bestätigte Buchung ausführen', description: 'Host-only execution after exact confirmation; never offered as a model tool.', effect: 'execute', requiredPermissions: ['rooms:execute'], inputSchema: object(intervalInput), outputSchema: object({ bookingId: string }) }
];

export const annyManifest: PluginManifest = { manifestVersion: 1, id: 'de.hsh.hasi.anny', name: 'anny', description: 'Räume finden und Buchungen sicher vorbereiten.', version: '0.2.0', apiVersion: '1.0.0', mcpVersion: '2026-07-28', tools };

// Explicit synthetic presentation metadata, not inferred anny API attributes.
export const demoPresentation: Record<string, { capacity: number | null; location: string; features: string[]; serviceId: string }> = {
  '00000000-0000-4000-8000-000000000101': { capacity: 12, location: 'Campus Linden · Gebäude 1', features: ['Display', 'Whiteboard'], serviceId: '00000000-0000-4000-8000-000000000201' },
  '00000000-0000-4000-8000-000000000102': { capacity: 6, location: 'Campus Linden · Gebäude 2', features: ['Videokonferenz', 'Whiteboard'], serviceId: '00000000-0000-4000-8000-000000000201' },
  '00000000-0000-4000-8000-000000000103': { capacity: 4, location: 'Campus Expo Plaza · Studio', features: ['Audio', 'Produktion'], serviceId: '00000000-0000-4000-8000-000000000202' },
  '00000000-0000-4000-8000-000000000104': { capacity: 24, location: 'Campus Linden · Lab', features: ['Arbeitsplätze', 'Display'], serviceId: '00000000-0000-4000-8000-000000000203' }
};
