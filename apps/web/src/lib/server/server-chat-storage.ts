import "server-only";

import { PostgresJsonStore, type JsonStore } from "@hasi/state";

const WORKSPACE_NAMESPACE = "protected-chat-workspaces:v1";
let pending: Promise<PostgresJsonStore> | undefined;

/** Open the durable store only when a protected production request needs it. */
export function getServerChatStorage(): Promise<JsonStore> {
  pending ??= initialize().catch((error: unknown) => {
    pending = undefined;
    throw error;
  });
  return pending;
}

async function initialize(): Promise<PostgresJsonStore> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("Protected chat storage is not configured.");
  const store = new PostgresJsonStore(WORKSPACE_NAMESPACE, {
    poolConfig: {
      connectionString,
      max: 2,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 20000,
      allowExitOnIdle: true,
    },
  });
  try {
    await store.initialize();
    return store;
  } catch (error) {
    await store.close();
    throw error;
  }
}
