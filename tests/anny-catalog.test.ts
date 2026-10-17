import { describe, expect, it } from 'vitest';
import snapshot from '../fixtures/anny-hsh-rooms-v1.json' with { type: 'json' };
import { hshDemoCatalog, hshDemoPresentation } from '../fixtures/catalog.js';

describe('curated Anny resource catalog', () => {
  const byId = new Map(snapshot.resources.map(resource => [resource.id, resource]));

  it('keeps the full sanitized catalog and distinguishes containers from bookable leaves', () => {
    expect(snapshot.resources).toHaveLength(61);
    expect(snapshot.services).toHaveLength(9);
    expect(snapshot.resources.map(resource => resource.id).length).toBe(byId.size);
    expect(snapshot.resources.reduce<Record<string, number>>((counts, resource) => {
      counts[resource.kind] = (counts[resource.kind] ?? 0) + 1;
      return counts;
    }, {})).toEqual({ office: 18, workplace: 37, meeting_room: 6 });

    const childIds = new Set(snapshot.resources.filter(resource => resource.parentId !== null).map(resource => resource.id));
    expect(childIds.size).toBe(31);
    for (const resource of snapshot.resources) {
      if (resource.categoryId === '60') expect(resource.kind).toBe(resource.hasChildren ? 'office' : 'workplace');
      else if (resource.categoryId === '6') expect(resource.kind).toBe('meeting_room');
      else expect(resource.kind).toBe('room');
      const children = snapshot.resources.filter(child => child.parentId === resource.id);
      expect(resource.hasChildren).toBe(children.length > 0);
      expect(resource.hasChildren).toBe(resource.kind === 'office');
      if (resource.parentId !== null) {
        const parent = byId.get(resource.parentId);
        expect(parent).toBeDefined();
        expect(parent?.kind).toBe('office');
      }
    }

    for (const resource of snapshot.resources) {
      const seen = new Set([resource.id]);
      let parentId = resource.parentId;
      while (parentId !== null) {
        expect(seen.has(parentId)).toBe(false);
        seen.add(parentId);
        const parent = byId.get(parentId);
        expect(parent).toBeDefined();
        parentId = parent?.parentId ?? null;
      }
    }
  });

  it('keeps source quantity separate from person capacity', () => {
    expect(snapshot.resources.filter(resource => resource.capacity !== null)).toHaveLength(6);
    expect(snapshot.resources.filter(resource => resource.capacity !== null).every(resource => resource.kind === 'meeting_room')).toBe(true);
    expect(snapshot.resources.filter(resource => resource.kind === 'workplace').every(resource => resource.capacity === null)).toBe(true);
    expect(snapshot.resources.filter(resource => resource.kind === 'office').every(resource => resource.capacity === null)).toBe(true);
    expect(snapshot.resources.filter(resource => resource.kind === 'workplace' || resource.kind === 'meeting_room').every(resource => resource.quantity === 1)).toBe(true);
    expect(snapshot.resources.filter(resource => resource.kind === 'office').map(resource => resource.quantity).sort()).toEqual([
      1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3,
    ]);
    expect(snapshot.resources.every(resource => resource.capacity === null || Number.isInteger(resource.capacity) && resource.capacity > 0)).toBe(true);
  });

  it('derives office desk counts from the complete hierarchy and verifies the parent quantity', () => {
    const offices = snapshot.resources.filter(resource => resource.kind === 'office');
    expect(offices.filter(office => office.quantity === 1)).toHaveLength(8);
    expect(offices.filter(office => office.quantity === 2)).toHaveLength(7);
    expect(offices.filter(office => office.quantity === 3)).toHaveLength(3);
    for (const resource of hshDemoCatalog.resources) {
      const parent = resource.parentId ? byId.get(resource.parentId) : undefined;
      const children = parent ? snapshot.resources.filter(child => child.parentId === parent.id) : [];
      expect(resource.officeWorkplaceCount).toBe(parent ? children.length : null);
      if (parent) expect(children.length).toBe(parent.quantity);
      expect(hshDemoPresentation[resource.id]?.officeWorkplaceCount).toBe(resource.officeWorkplaceCount);
    }
    expect(hshDemoCatalog.resources.filter(resource => resource.kind === 'workplace' && resource.officeWorkplaceCount === null)).toHaveLength(6);
  });

  it('composes only individual bookable leaves and derives names from actual parent links', () => {
    const expectedLeaves = snapshot.resources.filter(resource => !resource.hasChildren && resource.kind !== 'office');
    expect(hshDemoCatalog.resources).toHaveLength(43);
    expect(hshDemoCatalog.resources.map(resource => resource.id)).toEqual(expectedLeaves.map(resource => resource.id));

    const containerIds = new Set(snapshot.resources.filter(resource => resource.hasChildren).map(resource => resource.id));
    const catalogIds = new Set(hshDemoCatalog.resources.map(resource => resource.id));
    expect([...containerIds].some(id => catalogIds.has(id))).toBe(false);
    for (const resource of hshDemoCatalog.resources) {
      const source = byId.get(resource.id);
      expect(source).toBeDefined();
      expect(resource.name).toBe(source?.name);
      expect(resource).not.toHaveProperty('quantity');
      expect(source?.hasChildren).toBe(false);
      if (source?.parentId === null) {
        expect(resource.parentId).toBeNull();
        expect(resource.parentName).toBeNull();
      } else if (source?.parentId) {
        const parent = byId.get(source.parentId);
        expect(resource.parentId).toBe(source.parentId);
        expect(resource.parentName).toBe(parent?.name);
      }
    }
  });

  it('uses the explicit workplace service preference and preserves all linked services', () => {
    const serviceIds = new Set(snapshot.services.map(service => service.id));
    expect(hshDemoCatalog.services).toEqual(snapshot.services.map(({ id, name }) => ({ id, name })));
    expect(snapshot.resources.filter(resource => resource.serviceId !== null)).toHaveLength(9);
    expect(snapshot.resources.filter(resource => resource.serviceId === null)).toHaveLength(52);
    expect(snapshot.resources.every(resource => resource.serviceId === (resource.serviceIds.length === 1 ? resource.serviceIds[0] : null))).toBe(true);
    expect(snapshot.resources.every(resource => resource.serviceIds.every(id => serviceIds.has(id)))).toBe(true);

    const workplacesWithoutPreferredService = hshDemoCatalog.resources.filter(resource => resource.kind === 'workplace' && !byId.get(resource.id)?.serviceIds.includes('76878'));
    expect(workplacesWithoutPreferredService.length).toBeGreaterThan(0);
    for (const resource of hshDemoCatalog.resources) {
      const source = byId.get(resource.id)!;
      const expectedServiceId = resource.kind === 'workplace' && source.serviceIds.includes('76878')
        ? '76878'
        : source.serviceIds[0];
      expect(resource.serviceId).toBe(expectedServiceId);
      expect(serviceIds.has(resource.serviceId)).toBe(true);
    }
  });

  it('keeps the fixture field allowlist and presentation metadata sanitized', () => {
    expect(Object.keys(snapshot).sort()).toEqual(['availability', 'bookings', 'datasetId', 'origin', 'resources', 'schemaVersion', 'services', 'snapshotAt'].sort());
    const resourceFields = ['capacity', 'categoryId', 'categoryName', 'description', 'features', 'hasChildren', 'id', 'kind', 'location', 'name', 'parentId', 'quantity', 'serviceId', 'serviceIds'].sort();
    const featureAllowlist = ['Beamer', 'Docking Station', 'Flip-Chart', 'Hybride Besprechungstechnik', 'Höhenverstellbarer Schreibtisch', 'Kinderspielzeug', 'Metaplanwand', 'Monitor', 'Whiteboard (Wand)', 'XL-Monitor'];
    expect(snapshot.resources.every(resource => Object.keys(resource).sort().join('|') === resourceFields.join('|'))).toBe(true);
    expect(snapshot.resources.every(resource => resource.description === '')).toBe(true);
    expect(snapshot.resources.every(resource => resource.features.every(feature => featureAllowlist.includes(feature)))).toBe(true);
    expect(snapshot.services.every(service => Object.keys(service).sort().join('|') === 'id|name')).toBe(true);
    expect(new Set(snapshot.services.map(service => service.id)).size).toBe(9);
    expect(snapshot.resources.every(resource => new Set(resource.serviceIds).size === resource.serviceIds.length)).toBe(true);

    expect(Object.keys(hshDemoPresentation).sort()).toEqual([...hshDemoCatalog.resources.map(resource => resource.id)].sort());
    for (const resource of hshDemoCatalog.resources) {
      const presentation = hshDemoPresentation[resource.id as keyof typeof hshDemoPresentation];
      expect(presentation).toMatchObject({
        kind: resource.kind,
        parentId: resource.parentId,
        parentName: resource.parentName,
        capacity: resource.capacity,
        location: resource.location,
        features: resource.features,
        serviceId: resource.serviceId,
      });
      expect(presentation).not.toHaveProperty('quantity');
    }
  });
});
