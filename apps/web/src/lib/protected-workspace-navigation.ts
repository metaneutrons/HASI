import type { ChatWorkspaceStore } from "./chat-workspace-store";

/** Protect unacknowledged changes without caching protected content in the browser. */
export function protectWorkspaceNavigation(
  store: ChatWorkspaceStore,
  page: EventTarget,
  visibility: EventTarget & Pick<Document, "visibilityState">,
): () => void {
  let listening = false;
  const flush = () => { store.flushPendingWrites(); };
  const beforeUnload = (event: Event) => {
    if (!store.needsNavigationConfirmation()) return;
    event.preventDefault();
    flush();
  };
  const synchronize = () => {
    const required = store.needsNavigationConfirmation();
    if (required === listening) return;
    listening = required;
    if (required) page.addEventListener("beforeunload", beforeUnload);
    else page.removeEventListener("beforeunload", beforeUnload);
  };
  const onVisibilityChange = () => { if (visibility.visibilityState === "hidden") flush(); };
  const unsubscribe = store.subscribe(synchronize);
  page.addEventListener("pagehide", flush);
  visibility.addEventListener("visibilitychange", onVisibilityChange);
  synchronize();
  return () => {
    unsubscribe();
    page.removeEventListener("beforeunload", beforeUnload);
    page.removeEventListener("pagehide", flush);
    visibility.removeEventListener("visibilitychange", onVisibilityChange);
    // Account/logout disposal is not a browser leave event. Do not start a
    // request from the previous account under a potentially changed session.
  };
}
