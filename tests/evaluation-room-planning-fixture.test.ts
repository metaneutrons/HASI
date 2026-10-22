import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEvaluationRoomPlanningFixture,
  type EvaluationRoomPlanningFixtureOptions,
  type EvaluationRoomPlanningFixture,
} from "../scripts/evaluation/room-planning-fixture.js";

const activeFixtures: EvaluationRoomPlanningFixture[] = [];

async function createFixture(options?: EvaluationRoomPlanningFixtureOptions): Promise<EvaluationRoomPlanningFixture> {
  const fixture = await createEvaluationRoomPlanningFixture(options);
  activeFixtures.push(fixture);
  return fixture;
}

function request(
  fixture: EvaluationRoomPlanningFixture,
  path: string,
  method = "GET",
  body?: unknown,
): Request {
  const headers = new Headers({ cookie: fixture.cookie });
  if (method !== "GET") {
    headers.set("origin", fixture.webOrigin);
    headers.set("content-type", "application/json");
  }
  return new Request(`${fixture.apiOrigin}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

interface AnnyChatToolBridge {
  run(name: string, args: unknown): Promise<{
    rooms?: { resource: { id: string }; intervals: { available: boolean; startDate: string; endDate: string }[] }[];
    proposal?: { status: string };
  }>;
}

type CreateAnnyChatTools = (request: <T>(path: string, init?: RequestInit) => Promise<T>) => AnnyChatToolBridge;

afterEach(async () => {
  for (const fixture of activeFixtures.splice(0).reverse()) await fixture.close();
});

describe("authenticated Anny room-planning evaluation fixture", () => {
  it("uses the code-owned 1J employee mapping through actual API, signed MCP and Anny contract routes", async () => {
    const fixture = await createFixture();
    expect(fixture.webOrigin).toBe("http://127.0.0.1:3001");
    expect(fixture.apiOrigin).toBe("http://127.0.0.1:4100");
    expect(fixture.localScope).toMatch(/^[0-9a-f-]{36}$/u);
    expect(fixture.signingSecret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(fixture.resourceIds).toEqual(["180116", "180117"]);
    expect(fixture.mode).toBe("preparation");
    expect(fixture.actor.resourceIds).toBeUndefined();
    expect(fixture.actor.customerId).toBeUndefined();
    expect(fixture.actor.permissions).toEqual(["rooms:read", "rooms:prepare", "rooms:execute"]);
    expect(Object.keys(fixture)).not.toContain("serviceToken");
    expect(Object.keys(fixture)).not.toContain("mockToken");

    const session = await fixture.coreFetch(request(fixture, "/api/session"));
    expect(session.status).toBe(200);
    expect(await json(session)).toMatchObject({
      mode: "oidc",
      user: { id: fixture.actor.subject, role: "employee" },
      modelContext: { dataClasses: ["synthetic_demo"] },
    });

    const resourcesResponse = await fixture.coreFetch(request(fixture, "/api/resources"));
    expect(resourcesResponse.status).toBe(200);
    const resources = await json<{ resources: { id: string; location: string; kind: string; serviceId: string }[] }>(resourcesResponse);
    expect(resources.resources.map(resource => resource.id)).toEqual(["180116", "180117"]);
    expect(resources.resources.every(resource => resource.location === "1J" && resource.kind === "workplace")).toBe(true);

    const start = new Date(Date.now() + 7 * 86_400_000);
    start.setUTCHours(9, 0, 0, 0);
    const startDate = start.toISOString();
    const endDate = new Date(start.getTime() + 60 * 60_000).toISOString();
    const availabilityResponse = await fixture.coreFetch(request(fixture, "/api/tools/call", "POST", {
      pluginId: "de.hsh.hasi.anny",
      name: "anny.get_availability",
      arguments: { resourceId: "180116", serviceId: "76878", startDate, durationMinutes: 60 },
    }));
    expect(availabilityResponse.status).toBe(200);
    const availability = await json<{ intervals: { startDate: string; endDate: string; available: boolean }[] }>(availabilityResponse);
    expect(availability.intervals).toContainEqual({ startDate, endDate, available: true });

    const proposalResponse = await fixture.coreFetch(request(fixture, "/api/tools/call", "POST", {
      pluginId: "de.hsh.hasi.anny",
      name: "anny.propose_booking",
      arguments: { resourceId: "180116", serviceId: "76878", startDate, endDate },
    }));
    expect(proposalResponse.status).toBe(200);
    const proposalBody = await json<{ proposal: { id: string; status: string; executionTool: string } }>(proposalResponse);
    expect(proposalBody.proposal).toMatchObject({ status: "pending", executionTool: "anny.execute_booking" });

    const readBack = await fixture.coreFetch(request(fixture, `/api/proposals/${proposalBody.proposal.id}`));
    expect(readBack.status).toBe(200);
    expect(await json<{ proposal: { id: string; status: string; arguments: Record<string, unknown> } }>(readBack)).toMatchObject({
      proposal: {
        id: proposalBody.proposal.id,
        status: "pending",
        arguments: { resourceId: "180116", serviceId: "76878", startDate, endDate },
      },
    });
    expect(fixture.preparedProposals()).toEqual([{
      id: proposalBody.proposal.id,
      subject: fixture.actor.subject,
      executionTool: "anny.execute_booking",
      resourceId: "180116",
      serviceId: "76878",
      startDate,
      endDate,
      status: "pending",
    }]);

    const diagnostics = fixture.diagnostics();
    expect(diagnostics.transport).toBe("fastify-inject-to-signed-mcp-and-anny-contract-mock");
    expect(diagnostics.authorityScope).toBe("test-idp-and-process-local-memory");
    expect(diagnostics.sourceWriteAttempts).toBe(0);
    expect(diagnostics.sourceWriteEffects).toBe(0);
    expect(diagnostics.blockedWriteAttempts).toBe(0);
    expect(diagnostics.annyClientWritesEnabled).toBe(true);
    expect(diagnostics.accountInspections).toBeGreaterThan(0);
    expect(diagnostics.sourceObservations.some(observation => observation.path === "/api/v1/availability/upcoming-intervals" && observation.method === "GET")).toBe(true);
    expect(diagnostics.apiObservations.some(observation => observation.path === "/api/tools/call" && observation.status === 200)).toBe(true);
  });

  it("starts and serves reads with production NODE_ENV while the read-only mode denies writes", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    vi.stubEnv("NODE_ENV", "production");
    try {
      const fixture = await createFixture({ mode: "read_only" });

      const session = await fixture.coreFetch(request(fixture, "/api/session"));
      const resources = await fixture.coreFetch(request(fixture, "/api/resources"));
      expect(session.status).toBe(200);
      expect(resources.status).toBe(200);
      expect(await json<{ mode: string }>(session)).toMatchObject({ mode: "oidc" });
      expect((await json<{ resources: { id: string }[] }>(resources)).resources.map(resource => resource.id))
        .toEqual(fixture.resourceIds);

      const proposal = await fixture.coreFetch(request(fixture, "/api/proposals", "POST", {
        resourceId: fixture.resourceIds[0],
        serviceId: "76878",
        startDate: "2099-03-10T09:00:00.000Z",
        endDate: "2099-03-10T10:00:00.000Z",
      }));
      const execution = await fixture.coreFetch(request(fixture, "/api/tools/call", "POST", {
        pluginId: "de.hsh.hasi.anny",
        name: "anny.execute_booking",
        arguments: { resourceId: fixture.resourceIds[0], serviceId: "76878" },
      }));
      expect(proposal.status).toBe(403);
      expect(execution.status).toBe(403);
      expect(fixture.diagnostics()).toMatchObject({
        mode: "read_only",
        annyClientWritesEnabled: false,
        blockedWriteAttempts: 2,
        sourceWriteAttempts: 0,
        sourceWriteEffects: 0,
      });
      expect(fixture.preparedProposals()).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      expect(process.env.NODE_ENV).toBe(originalNodeEnv);
    }
  });

  it("keeps resource and availability reads on the authenticated path with read-only synthetic authority", async () => {
    const fixture = await createFixture({ mode: "read_only" });
    expect(fixture.mode).toBe("read_only");
    expect(fixture.actor.permissions).toEqual(["rooms:read"]);
    expect(fixture.diagnostics()).toMatchObject({ mode: "read_only", annyClientWritesEnabled: false });

    const session = await fixture.coreFetch(request(fixture, "/api/session"));
    expect(session.status).toBe(200);
    expect(await json(session)).toMatchObject({ mode: "oidc", user: { id: fixture.actor.subject, role: "employee" } });

    const authorizedToolsResponse = await fixture.coreFetch(request(fixture, "/api/tools"));
    expect(authorizedToolsResponse.status).toBe(200);
    const authorizedTools = await json<{ tools: { name: string; effect: string }[] }>(authorizedToolsResponse);
    expect(authorizedTools.tools.map(tool => tool.name)).toContain("anny.search_resources");
    expect(authorizedTools.tools.some(tool => tool.effect === "execute")).toBe(false);
    expect(authorizedTools.tools.map(tool => tool.name)).not.toContain("anny.propose_booking");
    expect(authorizedTools.tools.map(tool => tool.name)).not.toContain("anny.propose_cancellation");

    const { createAnnyChatTools } = await vi.importActual<{ createAnnyChatTools: CreateAnnyChatTools }>("../apps/web/src/lib/anny-chat-tools.js");
    const bridge = createAnnyChatTools(async <T>(path: string, init?: RequestInit): Promise<T> => {
      const headers = new Headers(init?.headers);
      headers.set("cookie", fixture.cookie);
      headers.set("accept", "application/json");
      if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
      if ((init?.method ?? "GET").toUpperCase() !== "GET") headers.set("origin", fixture.webOrigin);
      const response = await fixture.coreFetch(new Request(`${fixture.apiOrigin}${path}`, { ...init, headers }));
      if (!response.ok) throw new Error(`HASI core request failed at ${path} (${String(response.status)}): ${await response.text()}`);
      return await json<T>(response);
    });
    const search = await bridge.run("anny_search_resources", { kind: "workplace", location: "1J" });
    expect(search.rooms?.map(room => room.resource.id)).toEqual(fixture.resourceIds);
    const availability = await bridge.run("anny_get_availability", {
      resourceId: fixture.resourceIds[0], date: "2099-03-10", time: "09:00", durationMinutes: 60,
    });
    expect(availability.rooms?.[0]?.intervals.some(interval => interval.available)).toBe(true);

    const diagnostics = fixture.diagnostics();
    expect(diagnostics.apiObservations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "request", method: "GET", path: "/api/resources", status: 200 }),
      expect.objectContaining({ kind: "request", method: "POST", path: "/api/availability", status: 200 }),
    ]));
    expect(diagnostics.sourceObservations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "request", method: "GET", path: "/api/v1/resources", status: 200 }),
      expect.objectContaining({ kind: "request", method: "GET", path: "/api/v1/availability/upcoming-intervals", status: 200 }),
    ]));
    expect(diagnostics.blockedWriteAttempts).toBe(0);
    expect(diagnostics.sourceWriteAttempts).toBe(0);
    expect(diagnostics.sourceWriteEffects).toBe(0);
    expect(fixture.preparedProposals()).toEqual([]);
  });

  it("counts and denies direct proposal, confirmation, execution and cancellation attempts before effects", async () => {
    const fixture = await createFixture({ mode: "read_only" });
    const proposalId = "00000000-0000-4000-8000-000000000077";
    const interval = {
      resourceId: fixture.resourceIds[0], serviceId: "76878",
      startDate: "2099-03-10T09:00:00.000Z", endDate: "2099-03-10T10:00:00.000Z",
    };
    const directMutationRequests = [
      request(fixture, "/api/proposals", "POST", interval),
      request(fixture, "/api/cancellations", "POST", { bookingId: "fixture-booking-01" }),
      request(fixture, `/api/proposals/${proposalId}/confirm`, "POST", {}),
      request(fixture, `/api/proposals/${proposalId}/reconcile`, "POST", {}),
      ...[
        "anny.propose_booking", "anny.propose_cancellation", "anny.execute_booking", "anny.execute_cancellation",
      ].map(name => request(fixture, "/api/tools/call", "POST", { pluginId: "de.hsh.hasi.anny", name, arguments: interval })),
    ];

    for (const mutation of directMutationRequests) {
      const response = await fixture.coreFetch(mutation);
      expect(response.status).toBe(403);
    }

    const diagnostics = fixture.diagnostics();
    expect(diagnostics.blockedWriteAttempts).toBe(directMutationRequests.length);
    expect(diagnostics.apiObservations.filter(observation => observation.kind === "write_denied")).toHaveLength(directMutationRequests.length);
    expect(diagnostics.apiObservations).toContainEqual(expect.objectContaining({
      kind: "write_denied", method: "POST", path: "/api/tools/call", status: 403, toolName: "anny.execute_cancellation",
    }));
    expect(diagnostics.apiObservations.some(observation => observation.kind === "request"
      && observation.path?.endsWith("/confirm"))).toBe(false);
    expect(diagnostics.sourceObservations.some(observation => observation.path?.endsWith("/cancel"))).toBe(false);
    expect(diagnostics.sourceWriteAttempts).toBe(0);
    expect(diagnostics.sourceWriteEffects).toBe(0);
    expect(fixture.preparedProposals()).toEqual([]);
  });

  it("denies foreign and forged scope and keeps proposal confirmation outside the fixture transport", async () => {
    const fixture = await createFixture();
    const start = new Date(Date.now() + 7 * 86_400_000);
    start.setUTCHours(13, 0, 0, 0);
    const startDate = start.toISOString();

    const { createAnnyChatTools } = await vi.importActual<{ createAnnyChatTools: CreateAnnyChatTools }>("../apps/web/src/lib/anny-chat-tools.js");
    const currentChatBridge = createAnnyChatTools(async <T>(path: string, init?: RequestInit): Promise<T> => {
      const headers = new Headers(init?.headers);
      headers.set("cookie", fixture.cookie);
      headers.set("accept", "application/json");
      if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
      if ((init?.method ?? "GET").toUpperCase() !== "GET") headers.set("origin", fixture.webOrigin);
      const response = await fixture.coreFetch(new Request(`${fixture.apiOrigin}${path}`, { ...init, headers }));
      if (!response.ok) throw new Error(`HASI core request failed at ${path} (${String(response.status)}): ${await response.text()}`);
      return await json<T>(response);
    });
    const bridgeSearch = await currentChatBridge.run("anny_search_resources", { kind: "workplace", location: "1J" });
    expect(bridgeSearch.rooms?.map(room => room.resource.id)).toEqual(["180116", "180117"]);
    const bridgeAvailability = await currentChatBridge.run("anny_get_availability", {
      resourceId: "180116",
      date: "2099-03-10",
      time: "09:00",
      durationMinutes: 60,
    });
    const bridgeInterval = bridgeAvailability.rooms?.[0]?.intervals[0];
    expect(bridgeInterval?.available).toBe(true);
    if (!bridgeInterval) throw new Error("The authenticated Anny chat bridge returned no available interval.");
    const bridgeProposal = await currentChatBridge.run("anny_propose_booking", {
      resourceId: "180116",
      startDate: bridgeInterval.startDate,
      endDate: bridgeInterval.endDate,
    });
    expect(bridgeProposal.proposal?.status).toBe("pending");
    expect(fixture.diagnostics().apiObservations.some(observation => observation.method === "POST" && observation.path === "/api/proposals" && observation.status === 200)).toBe(true);
    expect(fixture.diagnostics().sourceWriteAttempts).toBe(0);
    expect(fixture.diagnostics().sourceWriteEffects).toBe(0);
    const availabilitySourceRequests = fixture.diagnostics().sourceObservations.filter(observation => observation.path?.includes("availability/upcoming-intervals")).length;

    const foreignAvailability = await fixture.coreFetch(request(fixture, "/api/tools/call", "POST", {
      pluginId: "de.hsh.hasi.anny",
      name: "anny.get_availability",
      arguments: {
        resourceId: "00000000-0000-4000-8000-000000000101",
        serviceId: "00000000-0000-4000-8000-000000000201",
        startDate,
        durationMinutes: 60,
      },
    }));
    expect(foreignAvailability.status).toBe(502);

    const forgedActor = await fixture.coreFetch(request(fixture, "/api/tools/call", "POST", {
      pluginId: "de.hsh.hasi.anny",
      name: "anny.search_resources",
      arguments: {},
      actor: { subject: "another-employee", resourceIds: ["00000000-0000-4000-8000-000000000101"] },
    }));
    expect(forgedActor.status).toBe(400);

    const forgedArguments = await fixture.coreFetch(request(fixture, "/api/tools/call", "POST", {
      pluginId: "de.hsh.hasi.anny",
      name: "anny.get_availability",
      arguments: {
        resourceId: "00000000-0000-4000-8000-000000000101",
        serviceId: "00000000-0000-4000-8000-000000000201",
        startDate,
        durationMinutes: 60,
      },
    }));
    expect(forgedArguments.status).toBe(502);
    expect(fixture.diagnostics().sourceObservations.filter(observation => observation.path?.includes("availability/upcoming-intervals"))).toHaveLength(availabilitySourceRequests);

    await expect(fixture.coreFetch("https://example.invalid/api/session")).rejects.toThrow("unapproved API destination");
    await expect(fixture.coreFetch(`${fixture.apiOrigin}/api/proposals/00000000-0000-4000-8000-000000000001/confirm`)).rejects.toThrow("unapproved API destination");
    const executeAttempt = await fixture.coreFetch(request(fixture, "/api/tools/call", "POST", {
      pluginId: "de.hsh.hasi.anny",
      name: "anny.execute_booking",
      arguments: {
        resourceId: "180116",
        serviceId: "76878",
        startDate,
        endDate: new Date(Date.parse(startDate) + 60 * 60_000).toISOString(),
      },
    }));
    expect(executeAttempt.status).toBe(403);
    expect(fixture.diagnostics().sourceWriteAttempts).toBe(0);
    expect(fixture.diagnostics().sourceWriteEffects).toBe(0);
  });

  it("closes its owned TestIdP/API resources idempotently", async () => {
    const fixture = await createFixture();
    await fixture.close();
    await fixture.close();
    await expect(fixture.coreFetch(request(fixture, "/api/session"))).rejects.toThrow("fixture is closed");
  });
});
