import "server-only";

import { z } from "zod";
import { protectedCoreRequest } from "./core-api";
import { ModelRouterError } from "./model-router-error";

const authorityResponseSchema = z.strictObject({ authorityDigest: z.string().regex(/^[a-f0-9]{64}$/u) });
const MAX_RESPONSE_BYTES = 1_024;

/** Read only the opaque, current server authority used to fence retained model history. */
export async function productionHistoryAuthority(request: Request): Promise<string> {
  try {
    const headers = new Headers(request.headers);
    headers.set("origin", new URL(request.url).origin);
    const response = await protectedCoreRequest("/api/history/authority", new Request(request.url, { method: "GET", headers }), "GET");
    if (response.status !== 200 || response.redirected || response.headers.has("location")) throw new Error("History authority unavailable");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("History authority body missing");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw new Error("History authority response too large");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    return authorityResponseSchema.parse(payload).authorityDigest;
  } catch {
    throw new ModelRouterError("context_unavailable", "Current conversation authority could not be verified");
  }
}
