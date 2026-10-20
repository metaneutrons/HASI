import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "../src/lib/api";

afterEach(() => vi.unstubAllGlobals());

describe("apiRequest cancellation and failures", () => {
  it("preserves the AbortError when the caller cancels the request", async () => {
    const controller = new AbortController();
    const abortError = new DOMException("Request cancelled", "AbortError");
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error("Expected the caller signal");
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(abortError);
        }, { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = apiRequest("/api/plugin-accounts", { signal: controller.signal });
    controller.abort(abortError);

    const error = await request.catch((cause: unknown) => cause);
    expect(error).toBe(abortError);
    expect(error).toBeInstanceOf(DOMException);
    expect(error).toHaveProperty("name", "AbortError");
  });

  it("preserves a custom caller abort reason by identity", async () => {
    const controller = new AbortController();
    const customReason = new Error("Custom cancellation");
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error("Expected the caller signal");
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(customReason);
        }, { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = apiRequest("/api/plugin-accounts", { signal: controller.signal });
    controller.abort(customReason);

    const error = await request.catch((cause: unknown) => cause);
    expect(error).toBe(customReason);
  });

  it("keeps genuine network failures as status 0", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);

    const error = await apiRequest("/api/plugin-accounts").catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      message: "Der HASI-Dienst ist gerade nicht erreichbar.",
      status: 0,
    });
  });

  it("keeps a network rejection as status 0 when it races with abort", async () => {
    const controller = new AbortController();
    const networkError = new TypeError("Failed to fetch");
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(networkError);
    vi.stubGlobal("fetch", fetchMock);

    const request = apiRequest("/api/plugin-accounts", { signal: controller.signal });
    controller.abort();

    const error = await request.catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      message: "Der HASI-Dienst ist gerade nicht erreichbar.",
      status: 0,
    });
    expect(error).not.toBe(networkError);
  });

  it("keeps HTTP status and error message diagnostics", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ error: "Die Berechtigung fehlt." }, { status: 403 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await apiRequest("/api/plugin-accounts").catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      message: "Die Berechtigung fehlt.",
      status: 403,
    });
  });
});
