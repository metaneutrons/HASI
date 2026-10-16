import snapshot from './anny-hsh-rooms-v1.json' with { type: 'json' };

type BookableResourceKind = 'workplace' | 'meeting_room' | 'lecture_hall' | 'room';

const preferredWorkplaceServiceId = '76878';
const resourcesById = new Map(snapshot.resources.map(resource => [resource.id, resource]));
const serviceIds = new Set(snapshot.services.map(service => service.id));
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
}) => [id, { capacity, location, features, serviceId, kind, parentId, parentName }]));
