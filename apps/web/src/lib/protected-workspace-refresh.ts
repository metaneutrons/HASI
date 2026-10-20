import { parseChatWorkspace } from "./chat-sessions";
import type { ChatWorkspaceStore, ProtectedWorkspaceResult } from "./chat-workspace-store";

interface ProtectedWorkspaceRefreshOptions {
  readonly recover?: boolean;
  readonly failureMessage: string;
}

function isNormalRefreshAllowed(store: ChatWorkspaceStore): boolean {
  const persistence = store.getSnapshot().protectedPersistence;
  return persistence?.state === "saved"
    && !store.hasPendingWrites()
    && !store.hasBusyChats();
}

function isSameAuthority(
  store: ChatWorkspaceStore,
  ownerId: string,
  authorityVersion: string,
): boolean {
  const snapshot = store.getSnapshot();
  return snapshot.protectedPersistence !== null
    && snapshot.workspace.ownerId === ownerId
    && store.getAuthorityVersion() === authorityVersion
    && !store.hasAuthorityChange();
}

/** Reads protected workspace data only while the mounted store still owns the authority under which the read began. */
export async function refreshProtectedWorkspace(
  store: ChatWorkspaceStore,
  read: () => Promise<ProtectedWorkspaceResult>,
  options: ProtectedWorkspaceRefreshOptions,
): Promise<boolean> {
  const recover = options.recover ?? false;
  const before = store.getSnapshot();
  if (before.protectedPersistence === null || store.hasAuthorityChange()) return false;
  if (!recover && !isNormalRefreshAllowed(store)) return false;

  const ownerId = before.workspace.ownerId;
  const authorityVersion = store.getAuthorityVersion();
  try {
    const remote = await read();
    if (!isSameAuthority(store, ownerId, authorityVersion)) return false;

    parseChatWorkspace(remote.workspace, ownerId);
    if (!isSameAuthority(store, ownerId, authorityVersion)) return false;
    if (!recover && !isNormalRefreshAllowed(store)) return false;

    if (recover) store.retryWithRemoteWorkspace(remote.workspace, remote.revision);
    else store.applyRemoteWorkspace(remote.workspace, remote.revision);
    return true;
  } catch {
    // A late failure must not revoke content authorized by a newer store generation.
    if (!isSameAuthority(store, ownerId, authorityVersion)) return false;
    store.redactProtectedContent(options.failureMessage);
    return false;
  }
}
