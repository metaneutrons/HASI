import snapshot from './anny-hsh-rooms-v1.json' with { type: 'json' };

type BookableResourceKind = 'workplace' | 'meeting_room' | 'lecture_hall' | 'room';

const preferredWorkplaceServiceId = '76878';
const resourcesById = new Map(snapshot.resources.map(resource => [resource.id, resource]));
const serviceIds = new Set(snapshot.services.map(service => service.id));
const officeWorkplaceCounts = new Map(snapshot.resources.filter(resource => resource.kind === 'office').map(office => {
  const children = snapshot.resources.filter(resource => resource.parentId === office.id);
  if (!children.length || children.some(child => child.kind !== 'workplace' || child.hasChildren) || office.quantity !== children.length) throw new Error(`Office ${office.id} has an incomplete or inconsistent workplace hierarchy.`);
  return [office.id, children.length];
}));
const leafResources = snapshot.resources.filter(resource => !resource.hasChildren && resource.kind !== 'office');

/** Explicit simulation mapping. This does not establish live booking eligibility. */
export const hshDemoCatalog = {
  resources: leafResources.map(resource => {
    if (resource.quantity !== 1) throw new Error(`Leaf resource ${resource.id} has quantity other than one.`);
    const parent = resource.parentId === null ? null : resourcesById.get(resource.parentId);
    if (resource.parentId !== null && parent?.kind !== 'office') {
      throw new Error(`Leaf resource ${resource.id} has no valid office parent.`);
    }

    const serviceId = resource.kind === 'workplace' && resource.serviceIds.includes(preferredWorkplaceServiceId)
      ? preferredWorkplaceServiceId
      : resource.serviceIds[0];
    if (!serviceId || !serviceIds.has(serviceId)) throw new Error('Room snapshot has no valid demo service mapping.');

    return {
      id: resource.id,
      name: resource.name,
      description: resource.description,
      capacity: resource.capacity,
      location: resource.location || 'Standort nicht hinterlegt',
      features: resource.features,
      serviceId,
      kind: resource.kind as BookableResourceKind,
      parentId: resource.parentId,
      parentName: parent?.name ?? null,
      officeWorkplaceCount: parent ? officeWorkplaceCounts.get(parent.id) ?? null : null,
    };
  }),
  services: snapshot.services.map(service => ({ id: service.id, name: service.name })),
};

export const hshDemoPresentation = Object.fromEntries(hshDemoCatalog.resources.map(({
  id,
  capacity,
  location,
  features,
  serviceId,
  kind,
  parentId,
  parentName,
  officeWorkplaceCount,
}) => [id, { capacity, location, features, serviceId, kind, parentId, parentName, officeWorkplaceCount }]));
