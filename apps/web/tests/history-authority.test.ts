import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("../src/lib/server/core-api", () => ({ productionCoreRequest: vi.fn() }));
import { productionCoreRequest } from "../src/lib/server/core-api";
import { productionHistoryAuthority } from "../src/lib/server/history-authority";

const coreRequest = vi.mocked(productionCoreRequest);
const authorityDigest = "a".repeat(64);
const request = () => new Request("https://hasi.example.edu/api/chat", { headers: { cookie: "hasi-session=synthetic-session" } });

afterEach(() => { vi.resetAllMocks(); });

describe("production history authority client", () => {
  it("uses the pinned authenticated GET and accepts only the opaque digest", async () => {
    coreRequest.mockResolvedValueOnce(new Response(JSON.stringify({ authorityDigest }), { status: 200 }));

    await expect(productionHistoryAuthority(request())).resolves.toBe(authorityDigest);
    expect(coreRequest).toHaveBeenCalledOnce();
    const call = coreRequest.mock.calls[0];
    expect(call?.[0]).toBe("/api/history/authority");
    expect(call?.[1].method).toBe("GET");
    expect(call?.[1].headers.get("cookie")).toBe("hasi-session=synthetic-session");
    expect(call?.[1].headers.get("origin")).toBe("https://hasi.example.edu");
    expect(call?.[2]).toBe("GET");
  });

  it("fails closed on redirects and non-success responses", async () => {
    coreRequest.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://attacker.example/" } }));
    await expect(productionHistoryAuthority(request())).rejects.toMatchObject({ code: "context_unavailable" });

    coreRequest.mockResolvedValueOnce(new Response(JSON.stringify({ error: "unauthorized" }), { status: 403 }));
    await expect(productionHistoryAuthority(request())).rejects.toMatchObject({ code: "context_unavailable" });
  });

  it("rejects oversized and extra-field responses", async () => {
    coreRequest.mockResolvedValueOnce(new Response(JSON.stringify({ authorityDigest, padding: "x".repeat(1_024) }), { status: 200 }));
    await expect(productionHistoryAuthority(request())).rejects.toMatchObject({ code: "context_unavailable" });

    coreRequest.mockResolvedValueOnce(new Response(JSON.stringify({ authorityDigest, subject: "private" }), { status: 200 }));
    await expect(productionHistoryAuthority(request())).rejects.toMatchObject({ code: "context_unavailable" });
  });
});
