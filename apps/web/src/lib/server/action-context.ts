import "server-only";

import { z } from "zod";
import { canonicalDemoRequest, getDemoRuntime } from "./demo-runtime";
import { protectedCoreRequest } from "./core-api";

const MAX_ACTION_IDS = 8;
const MAX_ACTION_RESPONSE_BYTES = 32 * 1024;
const MAX_ACTION_ID_CANDIDATES = 128;
const ACTION_CONTEXT_TIMEOUT_MS = 3_000;
const actionIdSchema = z.uuid();
const actionStatusSchema = z.enum(["pending", "confirmed", "executing", "outcome_unknown", "failed", "invalidated"]);
const actionExpirySchema = z.iso.datetime({ offset: true });

export type ActionContextStatus = z.infer<typeof actionStatusSchema> | "unavailable";

export interface ActionContextEntry {
  readonly id: string;
  readonly status: ActionContextStatus;
}

export type ActionContext = readonly ActionContextEntry[];

export type ActionContextReader = (id: string, signal: AbortSignal) => Promise<Response>;

export interface ActionContextOptions {
  /** Test seam for bounded offline tests. Production callers should omit it. */
  readonly reader?: ActionContextReader;
  /** Test seam for deterministic expiry checks. Defaults to Date.now. */
  readonly now?: () => number;
}

const actionResponseSchema = z.object({
  proposal: z.object({
    id: actionIdSchema,
    status: actionStatusSchema,
    expiresAt: actionExpirySchema,
  }),
});

function cookieHeaders(request: Request): Headers {
  const headers = new Headers();
  const cookie = request.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  return headers;
}

function proposalPath(id: string): `/api/proposals/${string}` {
  return `/api/proposals/${encodeURIComponent(id)}`;
}

async function readCurrentProposal(request: Request, id: string, signal: AbortSignal): Promise<Response> {
  const path = proposalPath(id);
  if (process.env.HASI_APP_MODE === "production" || process.env.HASI_LOCAL_TEST_IDP === "1") {
    const authenticated = new Request(request.url, { method: "GET", headers: cookieHeaders(request), signal });
    return protectedCoreRequest(path, authenticated, "GET");
  }

  if (process.env.HASI_DEMO_MODE === "1") {
    // Use the incoming Host only to validate the canonical demo host. The core
    // request below receives the session cookie and no other client headers.
    const host = request.headers.get("host");
    const hostCheck = new Request(request.url, { method: "GET", headers: host ? { host } : {} });
    const canonical = canonicalDemoRequest(hostCheck);
    if (!canonical) throw new Error("Action status unavailable");
    return (await getDemoRuntime()).handleCore(new Request(new URL(path, canonical.url), {
      method: "GET",
      headers: cookieHeaders(request),
      signal,
    }));
  }

  return fetch(new URL(path, "http://127.0.0.1:4100"), {
    method: "GET",
    headers: cookieHeaders(request),
    cache: "no-store",
    redirect: "error",
    signal,
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Action status read aborted", "AbortError");
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal, onAbort?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => { signal.removeEventListener("abort", handleAbort); };
    const handleAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      onAbort?.();
      reject(abortReason(signal));
    };
    if (signal.aborted) {
      handleAbort();
      return;
    }
    signal.addEventListener("abort", handleAbort, { once: true });
    promise.then(value => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }, (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error("Action status read failed"));
    });
  });
}

async function readResponse(read: ActionContextReader, id: string, signal: AbortSignal): Promise<Response> {
  const pending = read(id, signal);
  try {
    return await withAbort(pending, signal);
  } catch (error) {
    if (signal.aborted) {
      void pending.then(response => response.body?.cancel().catch(() => undefined), () => undefined);
    }
    throw error;
  }
}

async function readJsonBounded(response: Response, signal: AbortSignal): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_ACTION_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("Action status unavailable");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Action status unavailable");
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reading = (async () => {
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > MAX_ACTION_RESPONSE_BYTES) throw new Error("Action status unavailable");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  })();
  await withAbort(reading, signal, () => { void reader.cancel().catch(() => undefined); });
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

function requestedActionIds(ids: readonly string[]): string[] {
  if (!Array.isArray(ids)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of ids.slice(0, MAX_ACTION_ID_CANDIDATES)) {
    if (typeof candidate !== "string" || !actionIdSchema.safeParse(candidate).success) continue;
    const id = candidate.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    if (result.length === MAX_ACTION_IDS) break;
  }
  return result;
}

async function readActionStatus(id: string, read: ActionContextReader, now: () => number, signal: AbortSignal): Promise<ActionContextEntry> {
  try {
    if (signal.aborted) return { id, status: "unavailable" };
    const response = await readResponse(read, id, signal);
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return { id, status: "unavailable" };
    }
    const parsed = actionResponseSchema.safeParse(await readJsonBounded(response, signal));
    if (!parsed.success || parsed.data.proposal.id.toLowerCase() !== id) return { id, status: "unavailable" };
    const { status, expiresAt } = parsed.data.proposal;
    const nowMs = now();
    if (!Number.isFinite(nowMs)) return { id, status: "unavailable" };
    return { id, status: status === "pending" && Date.parse(expiresAt) <= nowMs ? "invalidated" : status };
  } catch {
    return { id, status: "unavailable" };
  }
}

/** Read only the current, owner-authorized status of up to eight action IDs. */
export async function loadActionContext(
  request: Request,
  ids: readonly string[],
  options: ActionContextOptions = {},
): Promise<ActionContext> {
  const requestedIds = requestedActionIds(ids);
  if (requestedIds.length === 0) return [];
  const reader = options.reader ?? ((id: string, signal: AbortSignal) => readCurrentProposal(request, id, signal));
  const now = options.now ?? Date.now;
  const deadline = new AbortController();
  const timeout = setTimeout(() => { deadline.abort(new DOMException("Action status read timed out", "TimeoutError")); }, ACTION_CONTEXT_TIMEOUT_MS);
  const signal = AbortSignal.any([request.signal, deadline.signal]);
  try {
    return await Promise.all(requestedIds.map(id => readActionStatus(id, reader, now, signal)));
  } finally {
    clearTimeout(timeout);
  }
}

/** Compare status snapshots independently of the order in which IDs were supplied. */
export function sameActionContext(left: readonly ActionContextEntry[], right: readonly ActionContextEntry[]): boolean {
  if (left.length !== right.length) return false;
  const leftById = new Map(left.map(entry => [entry.id, entry.status]));
  const rightById = new Map(right.map(entry => [entry.id, entry.status]));
  return leftById.size === left.length && rightById.size === right.length
    && left.every(entry => rightById.get(entry.id) === entry.status);
}
