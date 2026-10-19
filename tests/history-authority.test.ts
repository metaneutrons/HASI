import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createPluginServer, digest, type ActorContext, type PluginManifestV2 } from "@hasi/plugin-sdk";
import { MemoryJsonStore } from "../packages/state/src/index.js";
import { createApi, PluginAccountError, PluginRegistry } from "../apps/api/src/index.js";
import type { IdentityProvider } from "../apps/api/src/identity.js";
import type { PluginAccountAuthority, PluginAccountService } from "../apps/api/src/plugin-accounts.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const pluginId = "history.reference";
const serviceToken = "synthetic-history-authority-token";
const empty = { type: "object", properties: {}, additionalProperties: false };
const manifest: PluginManifestV2 = {
  manifestVersion: 2,
  apiVersion: "2.0.0",
  mcpVersion: "2026-07-28",
  id: pluginId,
  name: "History fixture",
  description: "Synthetic history authority fixture",
  version: "1.0.0",
  configuration: {
    schema: { type: "object", properties: { label: { type: "string", minLength: 1, maxLength: 40 } }, required: ["label"], additionalProperties: false },
    fields: [{ name: "label", label: "Label" }],
  },
  tools: [{
    name: "history.read",
    title: "Read fixture",
    description: "Read a synthetic fixture.",
    inputSchema: empty,
    outputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    effect: "read",
    requiredPermissions: ["history:read"],
    visibility: ["model", "app"],
  }],
};
const cleanup: (() => Promise<void>)[] = [];
const requestHeaders = { host: "127.0.0.1", cookie: "hasi-session=history-authority-session" };

afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

describe("authenticated retained-history authority endpoint", () => {
  it("returns only a digest that changes with actor, plugin configuration, and lifecycle authority", async () => {
    let actor: ActorContext = { subject: "history-subject", permissions: ["history:read"] };
    let accountDenial: PluginAccountError | undefined = new PluginAccountError(403, "account_not_linked", "synthetic denial");
    let accountAuthority: PluginAccountAuthority = {
      installationId: pluginId,
      authorityRevision: 1,
      expiresAt: null,
      projection: { permissions: ["history:read"], customerId: "synthetic-private-customer", resourceIds: ["desk"] },
    };
    let businessCalls = 0;
    const identity: IdentityProvider = {
      login: () => ({ token: "history-authority-session", user: { id: actor.subject, displayName: "Private test identity", role: "employee", actor } }),
      resolve: token => token === "history-authority-session" ? { id: actor.subject, displayName: "Private test identity", role: "employee", actor } : undefined,
      logout: () => undefined,
    };
    const account = {
      resolveAuthority: () => accountDenial ? Promise.reject(accountDenial) : Promise.resolve(accountAuthority),
    } as unknown as PluginAccountService;
    const server = createPluginServer({ manifest, publicKey, serviceToken, handlers: {
      "history.read": () => { businessCalls += 1; return Promise.resolve({ value: "unused" }); },
    } });
    await server.listen({ host: "127.0.0.1", port: 0 });
    cleanup.push(() => server.close());
    const address = server.server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture plugin address");
    const store = new MemoryJsonStore("history-authority-api");
    const registry = new PluginRegistry(privateKey, {
      store,
      resolveActor: subject => Promise.resolve(subject === actor.subject ? actor : undefined),
      accounts: new Map([[pluginId, account]]),
    });
    await registry.install({ endpoint: `http://127.0.0.1:${String(address.port)}/mcp`, serviceToken, expectedManifestDigest: digest(manifest), allowLoopback: true });
    cleanup.push(() => registry.close());
    const api = await createApi({ mode: "test", registry, identity, store, allowedHosts: ["127.0.0.1"] });
    cleanup.push(() => api.close());

    expect((await api.inject({ url: "/api/history/authority", headers: { host: "127.0.0.1" } })).statusCode).toBe(401);
    const readAuthority = async () => {
      const response = await api.inject({ url: "/api/history/authority", headers: requestHeaders });
      return { response, body: response.json<{ authorityDigest: string }>() };
    };
    const first = await readAuthority();
    expect(first.response.statusCode).toBe(200);
    expect(Object.keys(first.body)).toEqual(["authorityDigest"]);
    expect(first.body.authorityDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(first.body)).not.toContain("history-subject");
    expect(JSON.stringify(first.body)).not.toContain("Private test identity");
    expect(businessCalls).toBe(0);

    actor = { ...actor, permissions: ["history:read", "history:review"] };
    const rightsChanged = await readAuthority();
    expect(rightsChanged.response.statusCode).toBe(200);
    expect(rightsChanged.body.authorityDigest).not.toBe(first.body.authorityDigest);

    await registry.settings.saveDraft(pluginId, manifest, { revision: 0, values: { label: "first" }, disabledTools: [] }, "synthetic-operator");
    await registry.settings.activate(pluginId, manifest, 1, "synthetic-operator");
    const configured = await readAuthority();
    expect(configured.response.statusCode).toBe(200);
    expect(configured.body.authorityDigest).not.toBe(rightsChanged.body.authorityDigest);

    accountDenial = new PluginAccountError(503, "account_authority_unavailable", "synthetic outage");
    expect((await readAuthority()).response.statusCode).toBe(503);
    accountDenial = new PluginAccountError(403, "account_not_linked", "synthetic denial");
    const inaccessibleAccount = await readAuthority();
    expect(inaccessibleAccount.response.statusCode).toBe(200);

    accountDenial = undefined;
    const linkedAccount = await readAuthority();
    expect(linkedAccount.response.statusCode).toBe(200);
    expect(linkedAccount.body.authorityDigest).not.toBe(inaccessibleAccount.body.authorityDigest);
    expect(JSON.stringify(linkedAccount.body)).not.toContain("synthetic-private-customer");
    expect(JSON.stringify(linkedAccount.body)).not.toContain("desk");
    expect(JSON.stringify(linkedAccount.body)).not.toContain("history-subject");
    accountAuthority = { ...accountAuthority, authorityRevision: 2, projection: { ...accountAuthority.projection, resourceIds: ["room-17"] } };
    const renewedAccount = await readAuthority();
    expect(renewedAccount.response.statusCode).toBe(200);
    expect(renewedAccount.body.authorityDigest).not.toBe(linkedAccount.body.authorityDigest);
    expect(JSON.stringify(renewedAccount.body)).not.toContain("room-17");

    await registry.setEnabled(pluginId, false);
    const disabled = await readAuthority();
    expect(disabled.response.statusCode).toBe(200);
    expect(disabled.body.authorityDigest).not.toBe(renewedAccount.body.authorityDigest);
    expect(businessCalls).toBe(0);
  });
});
