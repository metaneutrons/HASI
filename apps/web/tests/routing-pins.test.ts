import { describe, expect, it } from "vitest";
import { createRoutingPins, type RoutingPinInput } from "../src/lib/server/routing-pins";
import { required } from "./test-utils";

const NOW = new Date("2026-10-17T11:22:33.456Z");
const SECRET = "fake-routing-pin-key-for-tests";
const SCOPE = "workspace:4af8ef2c-1edc-4ee5-b55a-30aaff667788:account:student";

const input: RoutingPinInput = {
  requestedProfileId: "gwdg-qwen3-30b",
  actualProfileId: "groq-oss-120b",
  turnId: "6fda45a1-3924-4220-8f17-95e6d74ed79c",
  turnHash: "a".repeat(64),
  revision: "b".repeat(64),
  attemptedProfileIds: ["gwdg-qwen3-30b", "groq-oss-120b"],
};

const expected = {
  turnId: input.turnId,
  turnHash: input.turnHash,
  revision: input.revision,
  requestedProfileId: input.requestedProfileId,
};

function makeToken(overrides: Partial<RoutingPinInput> = {}, clock = () => NOW) {
  return createRoutingPins(SECRET, SCOPE, clock).issue({ ...input, ...overrides });
}

function decodePayload(token: string): Record<string, unknown> {
  const [encoded] = token.split(".");
  return JSON.parse(Buffer.from(required(encoded), "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("server-owned model routing pins", () => {
  it("verifies across a fresh clock instance and includes a canonical five-minute expiry", () => {
    const token = makeToken();
    const verifier = createRoutingPins(SECRET, SCOPE, () => new Date(NOW));

    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    expect(token.length).toBeLessThanOrEqual(2048);
    expect(verifier.verify(token, expected)).toEqual({
      ...input,
      expiresAt: "2026-10-17T11:27:33.456Z",
    });
  });

  it("rejects expired pins and pins whose signed expiry is more than five minutes ahead", () => {
    const token = makeToken();
    const afterExpiry = new Date(NOW.getTime() + 5 * 60 * 1000 + 1);
    expect(createRoutingPins(SECRET, SCOPE, () => afterExpiry).verify(token, expected)).toBeNull();

    const futureToken = makeToken({}, () => new Date(NOW.getTime() + 60_000));
    expect(createRoutingPins(SECRET, SCOPE, () => NOW).verify(futureToken, expected)).toBeNull();
  });

  it("rejects a payload mutation even when the token structure remains valid", () => {
    const token = makeToken();
    const [encodedPayload, signature] = token.split(".");
    const changed = decodePayload(token);
    changed.actualProfileId = "groq-qwen-3.8-27b";
    changed.attemptedProfileIds = ["gwdg-qwen3-30b", "groq-qwen-3.8-27b"];
    const mutated = `${Buffer.from(JSON.stringify(changed), "utf8").toString("base64url")}.${required(signature)}`;

    expect(encodedPayload).toBeTruthy();
    expect(createRoutingPins(SECRET, SCOPE, () => NOW).verify(mutated, expected)).toBeNull();
  });

  it("rejects malformed, overlong, and multi-segment tokens without throwing", () => {
    const verifier = createRoutingPins(SECRET, SCOPE, () => NOW);
    for (const token of ["", ".", "a.b.c", "not-a-token", "e30.invalid", "x".repeat(2049)]) {
      expect(verifier.verify(token, expected)).toBeNull();
    }
  });

  it("binds pins to both the secret and the complete account/workspace scope", () => {
    const token = makeToken();
    const otherScopes = [
      "workspace:another:account:student",
      "workspace:4af8ef2c-1edc-4ee5-b55a-30aaff667788:account:employee",
    ];
    for (const scope of otherScopes) {
      expect(createRoutingPins(SECRET, scope, () => NOW).verify(token, expected)).toBeNull();
    }
    expect(createRoutingPins("different-fake-key", SCOPE, () => NOW).verify(token, expected)).toBeNull();
  });

  it.each([
    ["turn ID", { ...expected, turnId: "0c41a632-d8b1-4f54-b629-8091ab6bbbf1" }],
    ["turn hash", { ...expected, turnHash: "c".repeat(64) }],
    ["requested profile", { ...expected, requestedProfileId: "groq-oss-20b" }],
    ["revision", { ...expected, revision: "d".repeat(64) }],
  ])("rejects a changed expected %s", (_label, changedExpected) => {
    expect(createRoutingPins(SECRET, SCOPE, () => NOW).verify(makeToken(), changedExpected)).toBeNull();
  });

  it("rejects invalid attempts, profile IDs, and hashes when issuing", () => {
    const pins = createRoutingPins(SECRET, SCOPE, () => NOW);
    expect(() => pins.issue({ ...input, requestedProfileId: "offline" })).toThrow();
    expect(() => pins.issue({ ...input, attemptedProfileIds: ["groq-oss-20b", "groq-oss-120b"] })).toThrow();
    expect(() => pins.issue({ ...input, actualProfileId: "gwdg-qwen3-30b" })).toThrow();
    expect(() => pins.issue({ ...input, attemptedProfileIds: ["gwdg-qwen3-30b", "gwdg-qwen3-30b"] })).toThrow();
    expect(() => pins.issue({ ...input, attemptedProfileIds: ["gwdg-qwen3-30b", "groq-oss-20b", "groq-oss-20b", "groq-oss-120b"] })).toThrow();
    expect(() => pins.issue({ ...input, turnHash: "not-a-hash" })).toThrow();
    expect(() => pins.issue({ ...input, revision: "A".repeat(64) })).toThrow();
  });
});
