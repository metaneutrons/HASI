import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { productionCoreRequest, productionWebConfiguration } from "../src/lib/server/core-api";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function configure() {
  vi.stubEnv("HASI_APP_MODE", "production");
  vi.stubEnv("HASI_DEMO_MODE", "");
  vi.stubEnv("HASI_WEB_ORIGIN", "https://hasi.example.edu");
  vi.stubEnv("HASI_API_ORIGIN", "https://api.example.edu");
  vi.stubEnv("HASI_CHAT_SIGNING_SECRET", "s".repeat(43));
}
describe("separate production API boundary", () => {
  it("pins the target and forwards only session/content headers, with redirects kept local to the caller", async () => {
    configure();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    await productionCoreRequest("/api/tools", new Request("https://hasi.example.edu/api/chat", { headers: { cookie: "synthetic-cookie", authorization: "do-not-forward", "x-forwarded-host": "evil.invalid" } }), "GET");
    const call = fetcher.mock.calls[0];
    expect(call?.[0] instanceof URL ? call[0].href : call?.[0]).toBe("https://api.example.edu/api/tools");
    const headers = new Headers(call?.[1]?.headers);
    expect(headers.get("cookie")).toBe("synthetic-cookie");
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("x-forwarded-host")).toBe(false);
    expect(call?.[1]?.redirect).toBe("manual");
    await expect(productionCoreRequest("https://evil.invalid/api/tools", new Request("https://hasi.example.edu/"))).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("defaults to the conservative full-context classes and rejects mixed demo mode and recursive origins", () => {
    configure();
    expect(productionWebConfiguration().dataClasses).toEqual(["public", "internal", "confidential"]);
    vi.stubEnv("HASI_API_ORIGIN", "https://hasi.example.edu");
    expect(() => productionWebConfiguration()).toThrow("separate origins");
    vi.stubEnv("HASI_API_ORIGIN", "https://api.example.edu");
    vi.stubEnv("HASI_DEMO_MODE", "1");
    expect(() => productionWebConfiguration()).toThrow();
  });
});
