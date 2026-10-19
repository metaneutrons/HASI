import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "../src/lib/api";
import { createChatWorkspace, parseChatWorkspace } from "../src/lib/chat-sessions";
import { classifyProposalFailure } from "../src/lib/proposal-failure";

function apiFailure(status: number, code?: string) {
  return Object.assign(new Error("request failed"), { status, ...(code === undefined ? {} : { code }) });
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("proposal failure classification", () => {
  it("retries a transient preflight failure but treats the same dispatched failure as ambiguous", () => {
    const unavailable = apiFailure(503);
    expect(classifyProposalFailure(unavailable, false)).toBe("retry_preflight");
    expect(classifyProposalFailure(unavailable, true)).toBe("outcome_unknown");
  });

  it("recognizes only the explicit proposal invalidation response after dispatch", () => {
    expect(classifyProposalFailure(apiFailure(409, "proposal_invalidated"), true)).toBe("invalidated");
    expect(classifyProposalFailure(apiFailure(409, "foreign_code"), false)).toBe("not_retryable");
  });

  it("does not retry foreign not-found responses or ordinary errors", () => {
    expect(classifyProposalFailure(apiFailure(404), false)).toBe("not_retryable");
    expect(classifyProposalFailure(new Error("unknown failure"), false)).toBe("not_retryable");
    expect(classifyProposalFailure(apiFailure(0), false)).toBe("retry_preflight");
  });

  it("passes through only the fixed invalidation code from a 409 response", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "invalid", code: "proposal_invalidated" }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "other", code: "foreign_code" }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "other", code: "proposal_invalidated" }), { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiRequest("/api/proposals/p-1")).rejects.toMatchObject({ status: 409, code: "proposal_invalidated" });
    const foreignCode = await apiRequest("/api/proposals/p-2").catch((error: unknown) => error);
    const wrongStatus = await apiRequest("/api/proposals/p-3").catch((error: unknown) => error);
    expect(foreignCode).toMatchObject({ status: 409 });
    expect(foreignCode).not.toHaveProperty("code");
    expect(wrongStatus).toMatchObject({ status: 503 });
    expect(wrongStatus).not.toHaveProperty("code");
  });

  it("persists invalidated status for both Anny and plugin proposal cards", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T06:00:00Z"));
    const workspace = createChatWorkspace("user-1");
    const session = workspace.sessions[0];
    if (!session) throw new Error("Expected initial session");
    const invalidatedAt = "2026-10-20T09:00:00+02:00";
    const invalidatedMessages = [
      {
        id: "anny-card",
        role: "assistant" as const,
        text: "Proposal",
        proposal: {
          id: "proposal-1",
          resourceName: "Seminarraum",
          startDate: "2026-10-20T10:00:00+02:00",
          endDate: "2026-10-20T11:00:00+02:00",
          status: "invalidated" as const,
          expiresAt: invalidatedAt,
        },
      },
      {
        id: "plugin-card",
        role: "assistant" as const,
        text: "Proposal",
        proposal: {
          action: "execute_tool" as const,
          id: "43df207e-1852-4c5e-8fd9-82cb1857c826",
          pluginId: "plugin.test",
          executionTool: "prepare",
          toolName: "propose",
          title: "Test tool",
          arguments: {},
          resourceName: "Seminarraum",
          startDate: "2026-10-20T10:00:00+02:00",
          endDate: "2026-10-20T11:00:00+02:00",
          status: "invalidated" as const,
          expiresAt: invalidatedAt,
        },
      },
    ];
    const candidate = {
      ...workspace,
      sessions: [{ ...session, snapshot: { ...session.snapshot, messages: invalidatedMessages, activeProposal: "proposal-1" } }],
    };

    const restored = parseChatWorkspace(candidate, "user-1");
    expect(restored.sessions[0]?.snapshot.messages.map(({ proposal }) => proposal?.status)).toEqual(["invalidated", "invalidated"]);
    expect(restored.sessions[0]?.snapshot.activeProposal).toBeNull();

    const pendingCandidate = {
      ...workspace,
      sessions: [{ ...session, snapshot: { ...session.snapshot, activeProposal: "proposal-1",
        messages: invalidatedMessages.map((message) => ({ ...message, proposal: { ...message.proposal, status: "pending" as const } })),
      } }],
    };
    expect(parseChatWorkspace(pendingCandidate, "user-1").sessions[0]?.snapshot.activeProposal).toBe("proposal-1");
  });
});
