import snapshot from './anny-hsh-rooms-v1.json' with { type: 'json' };

/** Explicit simulation policy: all catalog rooms use their first linked service.
 * It does not infer production eligibility or a preferred institutional service. */
export const hshDemoCatalog = {
  resources: snapshot.resources.map(resource => {
    const serviceId = resource.serviceIds[0];
    if (!serviceId || !snapshot.services.some(service => service.id === serviceId)) throw new Error('Room snapshot has no valid demo service mapping.');
    return { id: resource.id, name: resource.name, description: resource.description, capacity: resource.capacity, location: resource.location || 'Standort nicht hinterlegt', features: resource.features, serviceId };
  }),
  services: snapshot.services.map(service => ({ id: service.id, name: service.name })),
};
export const hshDemoPresentation = Object.fromEntries(hshDemoCatalog.resources.map(({ id, capacity, location, features, serviceId }) => [id, { capacity, location, features, serviceId }]));
