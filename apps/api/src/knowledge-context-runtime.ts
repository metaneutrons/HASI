import { digest, type ActorContext } from '@hasi/plugin-sdk';
import type { JsonStore } from '@hasi/state';
import type { KeyObject } from 'node:crypto';
import { KnowledgeContextStore } from './knowledge-context.js';
import type { PluginRegistry } from './registry.js';

const installationId = 'de.hsh.hasi.knowledge';

/** The identity resolver is operator-owned; browser subjects or role labels never establish source authority. */
export function createRegistryKnowledgeContexts(options: {
  registry: PluginRegistry;
  store: JsonStore;
  privateKey: KeyObject;
  scope: string;
  resolveActor: (subject: string) => Promise<ActorContext | undefined>;
}) {
  const actor = async (subject: string) => {
    const current = await options.resolveActor(subject);
    if (current?.subject !== subject) throw new Error('Current source authority unavailable');
    return current;
  };
  return new KnowledgeContextStore({
    store: options.store, privateKey: options.privateKey, scope: options.scope,
    authorityFence: async subject => {
      const current = await actor(subject);
      const binding = await options.registry.binding(installationId);
      const authority = await options.registry.authorityBinding(installationId, current);
      const corpus = (await options.registry.invoke(installationId, 'knowledge.authority_fence', {}, current, false, 'app')).fence;
      if (typeof corpus !== 'string') throw new Error('Source fence unavailable');
      return digest({ binding, authority, corpus });
    },
    resolveDocument: async (subject, reference) => {
      const current = await actor(subject);
      const response = await options.registry.invoke(installationId, 'knowledge.get_document', {
        documentId: reference.documentId, revision: reference.revision,
      }, current, false, 'app');
      const document = response.document;
      if (typeof document !== 'object' || document === null || Array.isArray(document)) return undefined;
      const value = document as Record<string, unknown>;
      return value.revision === reference.revision && value.sourceSystem === reference.sourceSystem ? value : undefined;
    },
  });
}
