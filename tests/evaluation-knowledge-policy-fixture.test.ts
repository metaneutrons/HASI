import { afterEach, describe, expect, it } from "vitest";
import {
  createEvaluationKnowledgePolicyFixture,
  type EvaluationKnowledgePolicyFixture,
  type EvaluationKnowledgePolicyRole,
} from "../scripts/evaluation/knowledge-policy-fixture.js";

const activeFixtures: EvaluationKnowledgePolicyFixture[] = [];

async function createFixture(poisoned = false): Promise<EvaluationKnowledgePolicyFixture> {
  const fixture = await createEvaluationKnowledgePolicyFixture({ poisoned });
  activeFixtures.push(fixture);
  return fixture;
}

async function resolveContext(
  fixture: EvaluationKnowledgePolicyFixture,
  role: EvaluationKnowledgePolicyRole,
  contextId: string,
): Promise<{ contexts: { contextId: string; status: string; documents?: Record<string, unknown>[] }[] }> {
  const response = await fixture.coreFetch(new Request(`${fixture.apiOrigin}/api/knowledge/contexts/resolve`, {
    method: "POST",
    headers: {
      origin: fixture.webOrigin,
      cookie: fixture.cookies[role],
      "content-type": "application/json",
    },
    body: JSON.stringify({ contextIds: [contextId] }),
  }));
  expect(response.status).toBe(200);
  return await response.json() as { contexts: { contextId: string; status: string; documents?: Record<string, unknown>[] }[] };
}

afterEach(async () => {
  for (const fixture of activeFixtures.splice(0).reverse()) await fixture.close();
});

describe("operator-owned institutional knowledge evaluation fixture", () => {
  it("uses verified loopback OIDC identities and current signed repository/API receipts", async () => {
    const fixture = await createFixture();
    const session = await fixture.coreFetch(new Request(`${fixture.apiOrigin}/api/session`, {
      headers: { cookie: fixture.cookies.reader },
    }));
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({
      mode: "oidc",
      user: { id: fixture.subjects.reader },
      modelContext: { dataClasses: ["synthetic_demo"] },
    });

    const authorized = await fixture.search("reader", "service_it");
    expect(authorized.documents).toHaveLength(1);
    const authorizedDocument = authorized.documents[0];
    if (!authorizedDocument) throw new Error("Expected one authorized document.");
    expect(authorizedDocument).toMatchObject({
      id: "svc-eval-wlan-allowed",
      title: fixture.sourceMarkers.allowedTitle,
      dataClass: "public",
    });
    expect(authorizedDocument.text).toContain(fixture.sourceMarkers.allowedText);
    expect(JSON.stringify(authorized.documents)).not.toContain(fixture.sourceMarkers.privateTitle);
    expect(JSON.stringify(authorized.documents)).not.toContain(fixture.sourceMarkers.privateText);
    expect(await resolveContext(fixture, "reader", authorized.contextId)).toMatchObject({
      contexts: [{ status: "valid", documents: [{ id: "svc-eval-wlan-allowed" }] }],
    });

    const denied = await fixture.search("outsider", "service_it");
    expect(denied.documents).toEqual([]);
    const replay = await resolveContext(fixture, "outsider", authorized.contextId);
    expect(replay).toMatchObject({ contexts: [{ contextId: authorized.contextId, status: "unavailable" }] });
    expect(JSON.stringify(replay)).not.toContain(fixture.sourceMarkers.allowedTitle);
    expect(JSON.stringify(replay)).not.toContain(fixture.sourceMarkers.allowedText);

    await expect(fixture.coreFetch("https://example.invalid/api/session")).rejects.toThrow("unapproved destination");
    await expect(fixture.coreFetch(`${fixture.apiOrigin}/api/dev/login`)).rejects.toThrow("unapproved destination");
  });

  it("rejects caller-supplied deployment origins", async () => {
    await expect(createEvaluationKnowledgePolicyFixture({ deployment: "http://127.0.0.1:9999" as never }))
      .rejects.toThrow("Invalid evaluation knowledge fixture options");
  });

  it.each(["source grant", "document ACL"] as const)("invalidates old receipts after %s revocation", async mode => {
    const fixture = await createFixture();
    const original = await fixture.search("reader", "service_it");
    expect(original.documents).toHaveLength(1);

    if (mode === "source grant") await fixture.revokeSourceGrant();
    else await fixture.changeDocumentAcl();

    const oldContext = await resolveContext(fixture, "reader", original.contextId);
    expect(oldContext).toMatchObject({ contexts: [{ contextId: original.contextId, status: "unavailable" }] });
    expect(JSON.stringify(oldContext)).not.toContain(fixture.sourceMarkers.allowedTitle);
    expect(JSON.stringify(oldContext)).not.toContain(fixture.sourceMarkers.allowedText);
    expect((await fixture.search("reader", "service_it")).documents).toEqual([]);
  });

  it("inserts the fixed poisoned instruction only when the trusted fixture option enables it", async () => {
    const clean = await createFixture();
    const cleanResult = await clean.search("reader", "service_it");
    expect(JSON.stringify(cleanResult.documents)).not.toContain(clean.sourceMarkers.poisonText);

    const poisoned = await createFixture(true);
    expect(poisoned.sourceMarkers.poisonText).toBe(clean.sourceMarkers.poisonText);
    const poisonedResult = await poisoned.search("reader", "service_it");
    expect(poisonedResult.documents).toHaveLength(1);
    expect(poisonedResult.documents[0]?.text).toContain(poisoned.sourceMarkers.poisonText);
  });

  it("closes its real loopback identity server idempotently", async () => {
    const fixture = await createFixture();
    await fixture.close();
    await fixture.close();
  });
});
