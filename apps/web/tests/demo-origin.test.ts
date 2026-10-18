import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { canonicalDemoRequest } from "../src/lib/server/demo-runtime";
import { handleChatPost } from "../src/lib/server/chat-http";
import { required } from "./test-utils";

afterEach(() => vi.unstubAllEnvs());

describe("configured demo origin", () => {
  it("canonicalizes internal Next URLs to the configured container port and preserves the body", async () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("HASI_DEMO_ORIGIN", "http://127.0.0.1:3187");
    const canonical = canonicalDemoRequest(new Request("http://0.0.0.0:3187/api/chat?test=1", {
      method: "POST", headers: { host: "127.0.0.1:3187", origin: "http://127.0.0.1:3187" }, body: "payload",
    }));
    expect(canonical?.url).toBe("http://127.0.0.1:3187/api/chat?test=1");
    expect(canonical?.headers.get("origin")).toBe("http://127.0.0.1:3187");
    expect(await canonical?.text()).toBe("payload");
  });

  it("rejects a foreign Host even with a forged forwarded host", () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("HASI_DEMO_ORIGIN", "http://127.0.0.1:3187");
    expect(canonicalDemoRequest(new Request("http://0.0.0.0:3187/api/chat", {
      headers: { host: "attacker.invalid", "x-forwarded-host": "127.0.0.1:3187" },
    }))).toBeNull();
  });

  it("keeps production pinned to the custom domain despite a local-origin override", () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("HASI_DEMO_ORIGIN", "https://attacker.invalid");
    expect(canonicalDemoRequest(new Request("http://internal/api/chat", {
      headers: { host: "hasi.metaneutrons.cc" },
    }))?.url).toBe("https://hasi.metaneutrons.cc/api/chat");
    expect(canonicalDemoRequest(new Request("https://attacker.invalid/api/chat", {
      headers: { host: "attacker.invalid" },
    }))).toBeNull();
  });

  it.each(["http://127.0.0.1:3187", "https://attacker.invalid"])("applies the existing Origin guard to %s after canonicalization", async origin => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("HASI_DEMO_ORIGIN", "http://127.0.0.1:3187");
    const canonical = canonicalDemoRequest(new Request("http://0.0.0.0:3187/api/chat", {
      method: "POST", headers: { host: "127.0.0.1:3187", origin, "content-type": "application/json" },
      body: JSON.stringify({ profileId: "groq-oss-120b", messages: [{ role: "user", content: "Hallo" }] }),
    }));
    expect(canonical).not.toBeNull();
    const run = vi.fn().mockResolvedValue({ message: { role: "assistant", content: "Hallo" } });
    const result = await handleChatPost(required(canonical), { run, admit: () => Promise.resolve(true), allowedOrigins: ["http://127.0.0.1:3187"] });
    const allowed = origin === "http://127.0.0.1:3187";
    expect(result.status).toBe(allowed ? 200 : 403);
    expect(run).toHaveBeenCalledTimes(allowed ? 1 : 0);
  });
});
