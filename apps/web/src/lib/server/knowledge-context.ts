import "server-only";
import { z } from "zod";
import { knowledgeDocumentSchema } from "../knowledge";
import { productionCoreRequest } from "./core-api";
import { ModelRouterError } from "./model-router-error";
import type { KnowledgeContextResolver } from "./knowledge-evidence";

const responseSchema = z.strictObject({ contexts: z.array(z.discriminatedUnion("status", [
  z.strictObject({ contextId: z.uuid(), status: z.literal("unavailable") }),
  z.strictObject({ contextId: z.uuid(), status: z.literal("valid"), documents: z.array(knowledgeDocumentSchema).max(5), dataClasses: z.array(z.enum(["synthetic_demo", "public", "internal", "confidential"])).max(4) }),
])).max(32) });

export function productionKnowledgeResolver(request: Request): KnowledgeContextResolver {
  return async contextIds => {
    if (!contextIds.length) return [];
    const headers = new Headers(request.headers);
    headers.set("content-type", "application/json");
    // Workspace GETs have no browser Origin header. This server POST uses the
    // canonical, authenticated web origin, never a caller-selected destination.
    headers.set("origin", new URL(request.url).origin);
    const response = await productionCoreRequest("/api/knowledge/contexts/resolve", new Request(request.url, {
      method: "POST", headers, body: JSON.stringify({ contextIds }),
    }));
    if (!response.ok) throw new ModelRouterError("context_unavailable", "Source context validation failed");
    // Bound before parsing, even though the core destination is pinned.
    const reader = response.body?.getReader();
    if (!reader) throw new ModelRouterError("context_unavailable", "Missing source validation body");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > 2_200_000) throw new ModelRouterError("context_unavailable", "Oversized source validation body");
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    const parsed = responseSchema.parse(payload);
    if (parsed.contexts.length !== contextIds.length || new Set(parsed.contexts.map(item => item.contextId)).size !== contextIds.length || parsed.contexts.some(item => !contextIds.includes(item.contextId))) throw new ModelRouterError("context_unavailable", "Source context identities changed");
    return parsed.contexts;
  };
}
