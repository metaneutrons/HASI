import type { PluginManifest, PluginManifestV2, ToolDefinition, ToolDefinitionV2 } from '@hasi/plugin-sdk';
import { annyAppViewSha256 } from './app-view-metadata.generated.js';

const string = { type: 'string' };
const annyId = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' };
const timestamp = { type: 'string', format: 'date-time' };
const object = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const intervalInput = { resourceId: annyId, serviceId: annyId, startDate: timestamp, endDate: timestamp };
const cancellationInput = { bookingId: annyId, resourceId: annyId, startDate: timestamp, endDate: timestamp };
const resource = object({ id: annyId, name: string, description: string, capacity: { type: ['integer', 'null'], minimum: 1 }, location: string, features: { type: 'array', items: string }, serviceId: annyId, kind: { type: 'string', enum: ['workplace', 'meeting_room', 'lecture_hall', 'room'] }, parentId: { type: ['string', 'null'], pattern: annyId.pattern }, parentName: { type: ['string', 'null'] }, officeWorkplaceCount: { type: ['integer', 'null'], minimum: 1, maximum: 1000 } });
const tools: ToolDefinition[] = [
  { name: 'anny.search_resources', title: 'Räume und Arbeitsplätze suchen', description: 'Find authorized bookable workplaces and rooms. Person capacity applies to rooms; office containers are not booking targets.', effect: 'read', requiredPermissions: ['rooms:read'], inputSchema: object({}), outputSchema: object({ resources: { type: 'array', items: resource } }) },
  { name: 'anny.get_availability', title: 'Verfügbarkeit prüfen', description: 'Read available intervals for an authorized room and service.', effect: 'read', requiredPermissions: ['rooms:read'], inputSchema: object({ resourceId: annyId, serviceId: annyId, startDate: timestamp, durationMinutes: { type: 'integer', minimum: 15, maximum: 1440 } }), outputSchema: object({ intervals: { type: 'array', items: object({ startDate: timestamp, endDate: timestamp, available: { type: 'boolean' } }) } }) },
  { name: 'anny.list_my_bookings', title: 'Eigene Buchungen', description: 'List the authenticated customer’s bookings, never another customer’s.', effect: 'read', requiredPermissions: ['rooms:read'], inputSchema: object({}), outputSchema: object({ bookings: { type: 'array', items: object({ id: string, resourceName: string, startDate: timestamp, endDate: timestamp, status: string }) } }) },
  { name: 'anny.propose_booking', title: 'Buchung vorbereiten', description: 'Prepare a proposal only; external booking requires separate authenticated user confirmation.', effect: 'prepare', requiredPermissions: ['rooms:prepare'], inputSchema: object(intervalInput), outputSchema: object({ draft: object({ executionTool: { const: 'anny.execute_booking', type: 'string' }, arguments: object(intervalInput), resourceName: string }) }) },
  { name: 'anny.execute_booking', title: 'Bestätigte Buchung ausführen', description: 'Host-only execution after exact confirmation; never offered as a model tool.', effect: 'execute', requiredPermissions: ['rooms:execute'], inputSchema: object(intervalInput), outputSchema: object({ bookingId: string }) },
  { name: 'anny.propose_cancellation', title: 'Stornierung vorbereiten', description: 'Prepare cancellation of an owned future booking. Does not cancel; separate authenticated confirmation is required.', effect: 'prepare', requiredPermissions: ['rooms:prepare'], inputSchema: object({ bookingId: annyId }), outputSchema: object({ draft: object({ executionTool: { const: 'anny.execute_cancellation', type: 'string' }, arguments: object(cancellationInput), resourceName: string }) }) },
  { name: 'anny.execute_cancellation', title: 'Bestätigte Stornierung ausführen', description: 'Host-only cancellation after exact confirmation; rechecks ownership and booking snapshot. Never a model tool.', effect: 'execute', requiredPermissions: ['rooms:execute'], inputSchema: object(cancellationInput), outputSchema: object({ bookingId: string, status: { type: 'string', const: 'cancelled' } }) }
];

export const annyManifest: PluginManifest = { manifestVersion: 1, id: 'de.hsh.hasi.anny', name: 'anny', description: 'Räume und Arbeitsplätze finden, buchen und eigene Buchungen stornieren.', version: '0.4.0', apiVersion: '1.0.0', mcpVersion: '2026-07-28', tools };

export const annyAppPresentationId = 'resources';
export const annyAppResourceUri = 'ui://de.hsh.hasi.anny/resources.html';

const viewResourcesTool: ToolDefinitionV2 = {
  name: 'anny.view_resources',
  title: 'Räume und Arbeitsplätze filtern',
  description: 'Filter and page through resources the authenticated actor is authorized to book. This does not check availability.',
  effect: 'read',
  requiredPermissions: ['rooms:read'],
  inputSchema: object({
    query: { type: 'string', maxLength: 100 },
    kind: { type: 'string', enum: ['workplace', 'meeting_room', 'lecture_hall', 'room'] },
    page: { type: 'integer', minimum: 0, maximum: 100 },
    pageSize: { type: 'integer', minimum: 1, maximum: 6 },
    requestedStartDate: timestamp,
    requestedEndDate: timestamp,
  }, ['page', 'pageSize']),
  outputSchema: object({
    resources: { type: 'array', items: resource },
    total: { type: 'integer', minimum: 0 },
    page: { type: 'integer', minimum: 0, maximum: 100 },
    pageSize: { type: 'integer', minimum: 1, maximum: 6 },
    availabilityChecked: { type: 'boolean', const: false },
    requestedStartDate: timestamp,
    requestedEndDate: timestamp,
  }, ['resources', 'total', 'page', 'pageSize', 'availabilityChecked']),
  visibility: ['app'],
  presentationId: annyAppPresentationId,
  resultSemantics: { kind: 'resources' },
};

const appTools: ToolDefinitionV2[] = tools.map((tool) => ({
  ...tool,
  visibility: ['model'],
  ...(tool.name === 'anny.search_resources' ? { resultSemantics: { kind: 'resources' as const } } : {}),
}));
appTools.push(viewResourcesTool);

/** Explicit opt-in contract for the sandboxed, read-only MCP App resource view. */
export const annyAppManifest: PluginManifestV2 = {
  manifestVersion: 2,
  id: annyManifest.id,
  name: annyManifest.name,
  description: annyManifest.description,
  version: '0.5.0',
  apiVersion: '2.0.0',
  mcpVersion: annyManifest.mcpVersion,
  tools: appTools,
  identity: { claims: ['anny.customerId', 'anny.resourceIds'] },
  presentations: [{
    id: annyAppPresentationId,
    resourceUri: annyAppResourceUri,
    mimeType: 'text/html;profile=mcp-app',
    sha256: annyAppViewSha256,
    csp: { connectDomains: [], resourceDomains: [] },
  }],
};

// Explicit synthetic presentation metadata, not inferred anny API attributes.
export const demoPresentation: Record<string, { capacity: number | null; location: string; features: string[]; serviceId: string }> = {
  '00000000-0000-4000-8000-000000000101': { capacity: 12, location: 'Campus Linden · Gebäude 1', features: ['Display', 'Whiteboard'], serviceId: '00000000-0000-4000-8000-000000000201' },
  '00000000-0000-4000-8000-000000000102': { capacity: 6, location: 'Campus Linden · Gebäude 2', features: ['Videokonferenz', 'Whiteboard'], serviceId: '00000000-0000-4000-8000-000000000201' },
  '00000000-0000-4000-8000-000000000103': { capacity: 4, location: 'Campus Expo Plaza · Studio', features: ['Audio', 'Produktion'], serviceId: '00000000-0000-4000-8000-000000000202' },
  '00000000-0000-4000-8000-000000000104': { capacity: 24, location: 'Campus Linden · Lab', features: ['Arbeitsplätze', 'Display'], serviceId: '00000000-0000-4000-8000-000000000203' }
};
