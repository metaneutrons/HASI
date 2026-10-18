/** Operator-only credential custody. Public schemas declare logical slots, never these references. */
export interface PluginSecretCustody {
  status(slot: string): { configured: boolean; revision: string | null };
  use<T>(slot: string, operation: (credential: string) => Promise<T>): Promise<T>;
}

export interface EnvironmentPluginSecretSlot {
  environmentName: string;
  /** Operator-assigned version, independent of credential bytes. Change on replacement/revocation. */
  revision: string;
}

export class EnvironmentPluginSecretCustody implements PluginSecretCustody {
  private readonly slots: Readonly<Record<string, EnvironmentPluginSecretSlot>>;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  constructor(slots: Readonly<Record<string, EnvironmentPluginSecretSlot>>, environment: Readonly<Record<string, string | undefined>>) {
    if (Object.keys(slots).length > 32) throw new TypeError('Too many plugin credential slots');
    for (const [name, slot] of Object.entries(slots)) {
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(name) || !/^HASI_PLUGIN_SECRET_[A-Z0-9_]{1,80}$/.test(slot.environmentName) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(slot.revision)) throw new TypeError('Invalid operator credential binding');
    }
    this.slots = structuredClone(slots);
    this.#environment = environment;
  }
  status(slot: string) {
    const binding = Object.hasOwn(this.slots, slot) ? this.slots[slot] : undefined;
    const value = binding ? this.#environment[binding.environmentName] : undefined;
    const configured = typeof value === 'string' && value.trim().length > 0;
    return { configured, revision: binding && configured ? binding.revision : null };
  }
  async use<T>(slot: string, operation: (credential: string) => Promise<T>): Promise<T> {
    const binding = Object.hasOwn(this.slots, slot) ? this.slots[slot] : undefined;
    const value = binding ? this.#environment[binding.environmentName] : undefined;
    if (!value?.trim()) throw new Error('Approved plugin credential unavailable');
    return operation(value);
  }
}
