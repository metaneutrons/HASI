import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const KEY_INFO = "hasi-model-routing-pin-v1";
const PIN_LIFETIME_MS = 5 * 60 * 1000;
const MAX_TOKEN_LENGTH = 2048;
const PROFILE_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;

const profileIdSchema = z.string().regex(PROFILE_ID_PATTERN).refine((value) => value !== "offline");
const turnIdSchema = z.uuid();
const hashSchema = z.string().regex(HASH_PATTERN);

const routingPinFields = {
  requestedProfileId: profileIdSchema,
  actualProfileId: profileIdSchema,
  turnId: turnIdSchema,
  turnHash: hashSchema,
  revision: hashSchema,
  attemptedProfileIds: z.array(profileIdSchema).min(1).max(3),
};

function addAttemptIssues(
  value: Pick<RoutingPinInput, "requestedProfileId" | "actualProfileId" | "attemptedProfileIds">,
  context: z.RefinementCtx,
) {
  const attempts = value.attemptedProfileIds;
  if (new Set(attempts).size !== attempts.length) {
    context.addIssue({ code: "custom", path: ["attemptedProfileIds"], message: "Attempted profiles must be unique." });
  }
  if (attempts[0] !== value.requestedProfileId) {
    context.addIssue({ code: "custom", path: ["attemptedProfileIds", 0], message: "The requested profile must be the first attempt." });
  }
  if (attempts.at(-1) !== value.actualProfileId) {
    context.addIssue({ code: "custom", path: ["actualProfileId"], message: "The actual profile must be the final attempt." });
  }
}

const routingPinInputSchema = z.strictObject(routingPinFields).superRefine(addAttemptIssues);

const canonicalUtcTimestampSchema = z.string().refine((value) => {
  try {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === value;
  } catch {
    return false;
  }
});

const routingPinSchema = z.strictObject({
  ...routingPinFields,
  expiresAt: canonicalUtcTimestampSchema,
}).superRefine(addAttemptIssues);

const expectedSchema = z.strictObject({
  turnId: turnIdSchema,
  turnHash: hashSchema,
  revision: hashSchema,
  requestedProfileId: profileIdSchema,
});

export type RoutingPinInput = z.infer<typeof routingPinInputSchema>;
export type RoutingPin = z.infer<typeof routingPinSchema>;
export type ExpectedRoutingPin = z.infer<typeof expectedSchema>;

function serializePin(pin: RoutingPin): string {
  // Keep an explicit property order so every token has one canonical encoding.
  return JSON.stringify({
    requestedProfileId: pin.requestedProfileId,
    actualProfileId: pin.actualProfileId,
    turnId: pin.turnId,
    turnHash: pin.turnHash,
    revision: pin.revision,
    attemptedProfileIds: [...pin.attemptedProfileIds],
    expiresAt: pin.expiresAt,
  });
}

function decodeCanonicalBase64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length > 0 && decoded.toString("base64url") === value ? decoded : null;
}

function validNow(value: Date): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

export function createRoutingPins(
  secret: string,
  scope: string,
  now: () => Date = () => new Date(),
): {
  issue(input: RoutingPinInput): string;
  verify(token: string, expected: ExpectedRoutingPin): RoutingPin | null;
} {
  if (typeof secret !== "string" || secret.length === 0) throw new TypeError("Routing pin secret is required.");
  if (typeof scope !== "string" || scope.length === 0) throw new TypeError("Routing pin scope is required.");

  const key = Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(secret, "utf8"),
    Buffer.alloc(0),
    Buffer.from(KEY_INFO, "utf8"),
    32,
  ));

  function currentTime(): Date {
    const value = now();
    if (!validNow(value)) throw new TypeError("Routing pin clock returned an invalid date.");
    return new Date(value.getTime());
  }

  function signatureFor(encodedPayload: string): Buffer {
    return createHmac("sha256", key)
      .update(JSON.stringify([scope, encodedPayload]), "utf8")
      .digest();
  }

  return {
    issue(input) {
      const parsed = routingPinInputSchema.parse(input);
      const issuedAt = currentTime();
      const pin = routingPinSchema.parse({
        ...parsed,
        attemptedProfileIds: [...parsed.attemptedProfileIds],
        expiresAt: new Date(issuedAt.getTime() + PIN_LIFETIME_MS).toISOString(),
      });
      const encodedPayload = Buffer.from(serializePin(pin), "utf8").toString("base64url");
      const token = `${encodedPayload}.${signatureFor(encodedPayload).toString("base64url")}`;
      if (token.length > MAX_TOKEN_LENGTH) throw new TypeError("Routing pin exceeds the size limit.");
      return token;
    },

    verify(token, expected) {
      try {
        if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
        const segments = token.split(".");
        if (segments.length !== 2) return null;
        const [encodedPayload, encodedSignature] = segments;
        if (!encodedPayload || !encodedSignature) return null;

        const payloadBytes = decodeCanonicalBase64Url(encodedPayload);
        const signature = decodeCanonicalBase64Url(encodedSignature);
        if (!payloadBytes || !signature || signature.length !== 32) return null;
        const payloadText = payloadBytes.toString("utf8");
        if (!Buffer.from(payloadText, "utf8").equals(payloadBytes)) return null;

        const rawPayload: unknown = JSON.parse(payloadText);
        const parsed = routingPinSchema.safeParse(rawPayload);
        if (!parsed.success || serializePin(parsed.data) !== payloadText) return null;

        const expectedValue = expectedSchema.safeParse(expected);
        if (!expectedValue.success) return null;
        const pin = parsed.data;
        if (
          pin.turnId !== expectedValue.data.turnId ||
          pin.turnHash !== expectedValue.data.turnHash ||
          pin.revision !== expectedValue.data.revision ||
          pin.requestedProfileId !== expectedValue.data.requestedProfileId
        ) return null;

        const expectedSignature = signatureFor(encodedPayload);
        if (signature.length !== expectedSignature.length || !timingSafeEqual(signature, expectedSignature)) return null;

        const current = currentTime();
        const expiresAt = Date.parse(pin.expiresAt);
        if (expiresAt < current.getTime() || expiresAt > current.getTime() + PIN_LIFETIME_MS) return null;

        return { ...pin, attemptedProfileIds: [...pin.attemptedProfileIds] };
      } catch {
        return null;
      }
    },
  };
}
