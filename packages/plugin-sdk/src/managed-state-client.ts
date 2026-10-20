import {
  MANAGED_STATE_METHODS,
  managedStateCasParams,
  managedStateCasResult,
  managedStateConsumeParams,
  managedStateConsumeResult,
  managedStateReadParams,
  managedStateReadResult,
} from './managed-state-contract.js';
import type { ExecutionStore } from './execution-journal.js';

export type ManagedStateRequestSender = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

export interface ManagedStateClient {
  readonly applicationStore: ExecutionStore;
  readonly journalStore: ExecutionStore;
  consumeInvocation(): Promise<boolean>;
}

/**
 * Creates immutable stores bound to one verified invocation nonce. The host
 * remains responsible for actor, installation, tool-effect, quota and expiry
 * checks; this client only speaks the fixed reverse-channel protocol.
 */
export function createManagedStateClient(
  send: ManagedStateRequestSender,
  invocationId: string,
): ManagedStateClient {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(invocationId)) {
    throw new TypeError('Managed state requires a verified invocation identifier');
  }

  const createStore = (area: 'application' | 'journal'): ExecutionStore => Object.freeze({
    async read(key: string) {
      const params = managedStateReadParams.parse({ invocationId, area, key });
      const result = managedStateReadResult.parse(await send(
        MANAGED_STATE_METHODS.read,
        params,
      ));
      return result.entry ?? undefined;
    },
    async compareAndSet(key: string, revision: string | null, value: unknown, expiresAt?: number) {
      if (expiresAt !== undefined) {
        throw new TypeError('Managed state expiry is controlled by the host');
      }
      const params = managedStateCasParams.parse({ invocationId, area, key, revision, value });
      const result = managedStateCasResult.parse(await send(
        MANAGED_STATE_METHODS.compareAndSet,
        params,
      ));
      return result.updated;
    },
  });

  const applicationStore = createStore('application');
  const journalStore = createStore('journal');
  return Object.freeze({
    applicationStore,
    journalStore,
    async consumeInvocation() {
      const params = managedStateConsumeParams.parse({ invocationId });
      const result = managedStateConsumeResult.parse(await send(
        MANAGED_STATE_METHODS.consumeInvocation,
        params,
      ));
      return result.consumed;
    },
  });
}
