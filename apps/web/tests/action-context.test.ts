import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../src/lib/server/core-api", () => ({ protectedCoreRequest: vi.fn() }));
vi.mock("../src/lib/server/demo-runtime", () => ({ canonicalDemoRequest: vi.fn(), getDemoRuntime: vi.fn() }));

import { protectedCoreRequest } from "../src/lib/server/core-api";
import { canonicalDemoRequest, getDemoRuntime } from "../src/lib/server/demo-runtime";
import { loadActionContext, sameActionContext } from "../src/lib/server/action-context";

const id = (number: number) => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const pendingExpiry = "2099-10-20T09:00:00.000Z";
const request = (headers: HeadersInit = {}) => new Request("https://web.example.test/api/chat", { headers });

function statusResponse(actionId: string, status = "pending", expiresAt = pendingExpiry): Response {
  return Response.json({
    proposal: {
      id: actionId,
      status,
      expiresAt,
      preview: { title: "Private preview text" },
      resourceName: "Private room name",
      action: "book",
      arguments: { externalSecret: "must not enter model context" },
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("read-only action status context", () => {
  it("uses the fixed local API destination and forwards only the session cookie", async () => {
    vi.stubEnv("HASI_DEMO_MODE", "0");
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(statusResponse(id(1))));
    vi.stubGlobal("fetch", fetchMock);
    const original = request({
      cookie: "hasi_session=opaque",
      authorization: "Bearer client-secret",
      origin: "https://attacker.example",
      "x-provider-origin": "https://attacker.example",
    });

    await expect(loadActionContext(original, [id(1)], { now: () => Date.parse("2026-10-20T08:00:00.000Z") }))
      .resolves.toEqual([{ id: id(1), status: "pending" }]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [target, init] = fetchMock.mock.calls[0] ?? [];
    expect(target).toEqual(new URL(`http://127.0.0.1:4100/api/proposals/${id(1)}`));
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("error");
    expect(init?.cache).toBe("no-store");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const sentHeaders = new Headers(init?.headers);
    expect(sentHeaders.get("cookie")).toBe("hasi_session=opaque");
    expect(sentHeaders.has("authorization")).toBe(false);
    expect(sentHeaders.has("origin")).toBe(false);
    expect(sentHeaders.has("x-provider-origin")).toBe(false);
  });

  it.each([
    ["production", { HASI_APP_MODE: "production", HASI_LOCAL_TEST_IDP: "0" }],
    ["local TestIdP", { HASI_APP_MODE: "", HASI_LOCAL_TEST_IDP: "1" }],
  ])("uses protectedCoreRequest for %s with a fixed GET path", async (_mode, environment) => {
    for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value);
    vi.mocked(protectedCoreRequest).mockResolvedValueOnce(statusResponse(id(2), "confirmed"));
    const original = request({
      cookie: "hasi_session=protected",
      authorization: "Bearer never-forward",
      origin: "https://untrusted.example",
    });

    await expect(loadActionContext(original, [id(2)])).resolves.toEqual([{ id: id(2), status: "confirmed" }]);
    expect(protectedCoreRequest).toHaveBeenCalledOnce();
    const call = vi.mocked(protectedCoreRequest).mock.calls[0];
    if (!call) throw new Error("Expected one protected proposal read");
    const [path, authenticated, method] = call;
    expect(path).toBe(`/api/proposals/${id(2)}`);
    expect(method).toBe("GET");
    expect(authenticated.method).toBe("GET");
    expect(authenticated.headers.get("cookie")).toBe("hasi_session=protected");
    expect(authenticated.headers.has("authorization")).toBe(false);
    expect(authenticated.headers.has("origin")).toBe(false);
    expect(authenticated.signal).toBeInstanceOf(AbortSignal);
    expect(vi.mocked(protectedCoreRequest).mock.calls.every(([, , verb]) => verb === "GET")).toBe(true);
  });

  it("validates the canonical demo host and calls only the in-process core GET", async () => {
    vi.stubEnv("HASI_DEMO_MODE", "1");
    vi.mocked(canonicalDemoRequest).mockImplementationOnce(hostCheck => new Request("https://demo.example.test/api/chat", hostCheck));
    const handleCore = vi.fn((_coreRequest: Request) => Promise.resolve(statusResponse(id(3), "executing")));
    vi.mocked(getDemoRuntime).mockResolvedValueOnce({ handleCore } as never);
    const original = new Request("http://internal/api/chat", {
      headers: {
        host: "demo.example.test",
        cookie: "hasi_session=demo",
        authorization: "Bearer never-forward",
        origin: "https://untrusted.example",
      },
    });

    await expect(loadActionContext(original, [id(3)])).resolves.toEqual([{ id: id(3), status: "executing" }]);
    expect(canonicalDemoRequest).toHaveBeenCalledOnce();
    const hostCheck = vi.mocked(canonicalDemoRequest).mock.calls[0]?.[0];
    expect(hostCheck?.headers.get("host")).toBe("demo.example.test");
    expect(hostCheck?.headers.has("cookie")).toBe(false);
    expect(hostCheck?.headers.has("authorization")).toBe(false);
    expect(hostCheck?.headers.has("origin")).toBe(false);
    expect(handleCore).toHaveBeenCalledOnce();
    const coreRequest = handleCore.mock.calls[0]?.[0];
    expect(coreRequest?.url).toBe(`https://demo.example.test/api/proposals/${id(3)}`);
    expect(coreRequest?.method).toBe("GET");
    expect(coreRequest?.headers.get("cookie")).toBe("hasi_session=demo");
    expect(coreRequest?.headers.has("authorization")).toBe(false);
    expect(coreRequest?.headers.has("origin")).toBe(false);
    expect(coreRequest?.signal).toBeInstanceOf(AbortSignal);
  });

  it("maps denied, missing, malformed and unknown responses to the same unavailable status", async () => {
    const outcomes = [
      new Response(null, { status: 401 }),
      new Response(null, { status: 403 }),
      new Response(null, { status: 404 }),
      Response.json({ error: "owner denial detail" }, { status: 404 }),
      Response.json({ proposal: { id: id(4), status: "unknown", expiresAt: pendingExpiry } }),
      Response.json({ proposal: { id: id(5), status: "pending", expiresAt: "yesterday" } }),
      Response.json({ proposal: { id: id(6), status: "pending", expiresAt: pendingExpiry } }),
      new Response("not JSON"),
    ];
    const reader = vi.fn((_actionId: string) => Promise.resolve(outcomes.shift() ?? new Response(null, { status: 404 })));
    const requested = [id(4), id(5), id(6), id(7), id(8), id(9), id(10), id(11)];

    const result = await loadActionContext(request(), requested, { reader });
    expect(result).toEqual(requested.map(actionId => ({ id: actionId, status: "unavailable" })));
    expect(reader).toHaveBeenCalledTimes(requested.length);

    await expect(loadActionContext(request(), [id(12)], {
      reader: () => Promise.reject(new Error("private network details")),
    })).resolves.toEqual([{ id: id(12), status: "unavailable" }]);
  });

  it("returns only validated identity and status, and expires pending actions locally", async () => {
    const reader = vi.fn((actionId: string) => Promise.resolve(statusResponse(actionId, "pending", "2026-10-20T08:00:00.000Z")));
    const result = await loadActionContext(request(), [id(12)], { reader, now: () => Date.parse("2026-10-20T08:00:00.000Z") });

    expect(result).toEqual([{ id: id(12), status: "invalidated" }]);
    expect(JSON.stringify(result)).not.toMatch(/preview|Private|arguments|externalSecret|resourceName|book/u);

    const confirmed = await loadActionContext(request(), [id(13)], {
      reader: actionId => Promise.resolve(statusResponse(actionId, "confirmed", "2000-01-01T00:00:00.000Z")),
      now: () => Date.parse("2026-10-20T08:00:00.000Z"),
    });
    expect(confirmed).toEqual([{ id: id(13), status: "confirmed" }]);
  });

  it("deduplicates UUID handles, ignores malformed handles, and reads no more than eight actions", async () => {
    const reader = vi.fn((actionId: string) => Promise.resolve(statusResponse(actionId)));
    const handles = ["bad-id", id(20), id(20), id(21).toUpperCase(), id(22), id(23), id(24), id(25), id(26), id(27), id(28), id(29)];

    const result = await loadActionContext(request(), handles, { reader });
    expect(result.map(entry => entry.id)).toEqual([id(20), id(21), id(22), id(23), id(24), id(25), id(26), id(27)]);
    expect(reader).toHaveBeenCalledTimes(8);
    expect(reader.mock.calls.map(([actionId]) => actionId)).toEqual(result.map(entry => entry.id));
  });

  it("treats an oversized response as unavailable and compares snapshots independent of input order", async () => {
    const oversizedReader = vi.fn(() => Promise.resolve(new Response("x".repeat(32 * 1024 + 1))));
    await expect(loadActionContext(request(), [id(30)], { reader: oversizedReader }))
      .resolves.toEqual([{ id: id(30), status: "unavailable" }]);

    expect(sameActionContext([
      { id: id(31), status: "confirmed" },
      { id: id(32), status: "pending" },
    ], [
      { id: id(32), status: "pending" },
      { id: id(31), status: "confirmed" },
    ])).toBe(true);
    expect(sameActionContext([{ id: id(31), status: "pending" }], [{ id: id(31), status: "confirmed" }])).toBe(false);
    expect(sameActionContext([
      { id: id(31), status: "confirmed" },
      { id: id(31), status: "confirmed" },
    ], [
      { id: id(31), status: "confirmed" },
      { id: id(32), status: "pending" },
    ])).toBe(false);
    expect(sameActionContext([
      { id: id(31), status: "confirmed" },
      { id: id(32), status: "pending" },
    ], [
      { id: id(31), status: "confirmed" },
      { id: id(31), status: "confirmed" },
    ])).toBe(false);
  });

  it("uses one three-second deadline for the load and aborts every pending reader", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const reader = vi.fn((_actionId: string, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<Response>(() => undefined);
    });
    const pending = loadActionContext(request(), [id(40), id(41)], { reader });

    await vi.advanceTimersByTimeAsync(2_999);
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(signals[1]);
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual([
      { id: id(40), status: "unavailable" },
      { id: id(41), status: "unavailable" },
    ]);
    expect(signals[0]?.aborted).toBe(true);
  });

  it("does not wait for non-success or oversized body cancellation", async () => {
    vi.useFakeTimers();
    const neverSettlingCancel = () => new Promise<void>(() => undefined);
    const responses = [
      new Response(new ReadableStream({ cancel: neverSettlingCancel }), { status: 403 }),
      new Response(new ReadableStream({ cancel: neverSettlingCancel }), {
        status: 200,
        headers: { "content-length": String(32 * 1024 + 1) },
      }),
    ];

    for (const response of responses) {
      const pending = loadActionContext(request(), [id(44)], { reader: () => Promise.resolve(response) });
      const timeout = new Promise<"still-pending">(resolve => { setTimeout(() => { resolve("still-pending"); }, 0); });
      await vi.advanceTimersByTimeAsync(0);
      await expect(Promise.race([pending, timeout])).resolves.toEqual([{ id: id(44), status: "unavailable" }]);
    }
  });

  it("propagates caller cancellation to the reader", async () => {
    const caller = new AbortController();
    const signals: AbortSignal[] = [];
    const reader = vi.fn((_actionId: string, signal: AbortSignal) => new Promise<Response>((_resolve, reject) => {
      signals.push(signal);
      signal.addEventListener("abort", () => {
        reject(signal.reason instanceof Error ? signal.reason : new Error("Request cancelled"));
      }, { once: true });
    }));
    const pending = loadActionContext(new Request("https://web.example.test/api/chat", { signal: caller.signal }), [id(42)], { reader });

    caller.abort(new DOMException("Request cancelled", "AbortError"));
    await expect(pending).resolves.toEqual([{ id: id(42), status: "unavailable" }]);
    expect(signals[0]?.aborted).toBe(true);
  });

  it("bounds a demo handler that ignores cancellation and cancels its late response body", async () => {
    vi.useFakeTimers();
    vi.stubEnv("HASI_DEMO_MODE", "1");
    vi.mocked(canonicalDemoRequest).mockImplementationOnce(hostCheck => new Request("https://demo.example.test/api/chat", hostCheck));
    let demoRequest: Request | undefined;
    let resolveHandler: ((response: Response) => void) | undefined;
    const handleCore = vi.fn((coreRequest: Request) => {
      demoRequest = coreRequest;
      return new Promise<Response>(resolve => { resolveHandler = resolve; });
    });
    vi.mocked(getDemoRuntime).mockResolvedValueOnce({ handleCore } as never);
    const original = new Request("http://internal/api/chat", { headers: { host: "demo.example.test" } });
    const pending = loadActionContext(original, [id(43)]);

    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toEqual([{ id: id(43), status: "unavailable" }]);
    expect(demoRequest?.signal.aborted).toBe(true);

    const cancelBody = vi.fn();
    resolveHandler?.(new Response(new ReadableStream({ cancel: cancelBody })));
    await Promise.resolve();
    await Promise.resolve();
    expect(cancelBody).toHaveBeenCalledOnce();
  });
});
