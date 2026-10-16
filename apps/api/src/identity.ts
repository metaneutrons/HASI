import { randomBytes } from 'node:crypto';
import type { ActorContext } from '@hasi/plugin-sdk';
import { RequestError } from './registry.js';

export interface Persona { id: string; displayName: string; role: 'student' | 'employee' | 'admin'; actor: ActorContext }
export interface IdentityProvider {
  login(id: string): { token: string; user: Persona } | Promise<{ token: string; user: Persona }>;
  resolve(token: string | undefined): Persona | undefined | Promise<Persona | undefined>;
  logout(token: string | undefined): void | Promise<void>;
}

const resource = (suffix: number) => `00000000-0000-4000-8000-000000000${String(suffix)}`;
export const personas: Persona[] = [
  { id: 'student', displayName: 'Lea · Studentin', role: 'student', actor: { subject: 'fixture-student', customerId: resource(301), resourceIds: [resource(101), resource(102)], permissions: ['knowledge:read', 'knowledge:audience:student', 'rooms:read', 'rooms:prepare', 'rooms:execute'] } },
  { id: 'employee', displayName: 'Alex · Beschäftigter', role: 'employee', actor: { subject: 'fixture-employee', customerId: resource(302), resourceIds: [101,102,103,104].map(resource), permissions: ['knowledge:read', 'knowledge:audience:employee', 'rooms:read', 'rooms:prepare', 'rooms:execute'] } },
  { id: 'admin', displayName: 'Fabian · Administration', role: 'admin', actor: { subject: 'fixture-admin', customerId: resource(303), resourceIds: [101,102,103,104].map(resource), permissions: ['knowledge:read', 'knowledge:audience:admin', 'rooms:read', 'rooms:prepare', 'rooms:execute', 'plugins:manage'] } }
];

export function assertMockMode(mode: string): void { if (mode !== 'development' && mode !== 'test') throw new Error('Mock identity is available only in explicit development/test mode.'); }

export class MockIdentityProvider {
  private readonly sessions = new Map<string, { persona: Persona; expires: number }>();
  constructor(mode: string, private readonly resourceIds?: readonly string[]) { assertMockMode(mode); }
  login(id: string): { token: string; user: Persona } {
    const template = personas.find(persona => persona.id === id);
    const user = template ? structuredClone(template) : undefined;
    if (!user) throw new RequestError(400, 'Unbekanntes Testkonto.');
    if (this.resourceIds) user.actor.resourceIds = [...this.resourceIds];
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, { persona: user, expires: Date.now() + 3600000 });
    return { token, user };
  }
  resolve(token: string | undefined): Persona | undefined {
    if (!token) return undefined;
    const session = this.sessions.get(token);
    if (!session || session.expires <= Date.now()) { this.sessions.delete(token); return undefined; }
    return session.persona;
  }
  logout(token: string | undefined): void { if (token) this.sessions.delete(token); }
}
