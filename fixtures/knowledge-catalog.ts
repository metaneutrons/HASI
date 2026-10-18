import legacy from './knowledge-demo-v1.json' with { type: 'json' };
import serviceIt from './service-it-synthetic-v1.json' with { type: 'json' };

export const SERVICE_IT_DEMO_ORIGIN = 'https://service-it.hasi.metaneutrons.cc';

export interface KnowledgeDemoDocument {
  id: string;
  sourceSystem: 'service_it' | 'intranet';
  synthetic: true;
  language: 'de' | 'en';
  title: string;
  revision: number;
  demoAudience: ('student' | 'employee' | 'admin')[];
  tags: string[];
  text: string;
  citationId: string;
  publicationStatus: string;
}

const rawDocuments = [...legacy.documents, ...serviceIt.documents];
if (new Set(rawDocuments.map(document => document.id)).size !== rawDocuments.length
  || rawDocuments.some(document => !document.synthetic)) {
  throw new Error('Invalid synthetic knowledge inventory.');
}
/** Local reviewed metadata and body approvals; never institutional source ACLs. */
export const knowledgeDocuments: readonly KnowledgeDemoDocument[] = Object.freeze(
  rawDocuments as KnowledgeDemoDocument[],
);
export const knowledgeCreatedAt = serviceIt.createdAt;
