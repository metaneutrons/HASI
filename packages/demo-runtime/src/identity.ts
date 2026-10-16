import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { JsonStore } from '@hasi/state';
import { personas, type IdentityProvider, type Persona } from '@hasi/api';
import { RequestError } from '@hasi/api';

const sessionSchema = z.strictObject({ workspaceId: z.uuid(), personaId: z.enum(['student', 'employee', 'admin']) });
const tokenKey = (token: string) => `session:${createHash('sha256').update(token).digest('hex')}`;

/** Selectable fixtures, restricted to one server-issued synthetic workspace. */
export class DurableDemoIdentity implements IdentityProvider {
  constructor(private readonly store: JsonStore, private readonly workspaceId: string, private readonly resourceIds?: readonly string[]) { z.uuid().parse(workspaceId); }

  private persona(id: string): Persona {
    const template = personas.find(persona => persona.id === id);
    if (!template) throw new RequestError(400, 'Unbekanntes Testkonto.');
    return { ...structuredClone(template), id: `${this.workspaceId}:${id}`, actor: { ...structuredClone(template.actor), subject: `demo:${this.workspaceId}:${id}`, ...(this.resourceIds ? { resourceIds: [...this.resourceIds] } : {}) } };
  }

  async login(id: string): Promise<{ token: string; user: Persona }> {
    const user = this.persona(id);
    const token = randomBytes(32).toString('base64url');
    if (!await this.store.compareAndSet(tokenKey(token), null, { workspaceId: this.workspaceId, personaId: id }, Date.now() + 3600000)) throw new RequestError(503, 'Die Testsitzung konnte nicht gespeichert werden.');
    return { token, user };
  }

  async resolve(token: string | undefined): Promise<Persona | undefined> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const record = await this.store.read(tokenKey(token));
    const session = sessionSchema.safeParse(record?.value);
    if (!session.success || session.data.workspaceId !== this.workspaceId) return undefined;
    return this.persona(session.data.personaId);
  }

  async logout(token: string | undefined): Promise<void> {
    if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) await this.store.delete(tokenKey(token));
  }
}
