import { describe, expect, it } from "vitest";
import { mergeRoomRequest } from "../src/lib/chat-demo";
import { assertRequestedRoomTime, requestedRoomInterval, RoomTimeMismatchError, RoomTimeUnresolvedError } from "../src/lib/chat-room-time";

const original = mergeRoomRequest("Ich brauche am kommenden Montag ein Büro im Gebäude 1J von 8-16 Uhr.", {}, new Date("2026-10-17T15:00:00.000Z"));
const preference = mergeRoomRequest("Ein Einzelbüro bitte.", original, new Date("2026-10-17T15:01:00.000Z"));
const args = { resourceId: "190449", date: "2026-10-19", time: "08:00", durationMinutes: 480 };

describe("requested room time binding", () => {
  it("retains the server-anchored Monday interval across an office preference", () => {
    expect(preference).toMatchObject({ date: "2026-10-19", time: "08:00", durationMinutes: 480, location: "1J", officeType: "single" });
    expect(requestedRoomInterval(preference)).toEqual({ startDate: "2026-10-19T06:00:00.000Z", endDate: "2026-10-19T14:00:00.000Z" });
  });
  it("accepts only the requested day and duration for automatic availability", () => {
    expect(() => assertRequestedRoomTime("anny_get_availability", args, preference)).not.toThrow();
    expect(() => assertRequestedRoomTime("anny_get_availability", { ...args, date: "2026-10-21" }, preference)).toThrow(RoomTimeMismatchError);
    expect(() => assertRequestedRoomTime("anny_get_availability", { ...args, time: "09:00" }, preference)).toThrow(RoomTimeMismatchError);
    expect(() => assertRequestedRoomTime("anny_get_availability", { ...args, durationMinutes: 60 }, preference)).toThrow(RoomTimeMismatchError);
  });
  it("binds automatic proposals to the same interval, allowing equivalent offsets", () => {
    const proposal = { resourceId: args.resourceId, startDate: "2026-10-19T08:00:00+02:00", endDate: "2026-10-19T16:00:00+02:00" };
    expect(() => assertRequestedRoomTime("anny_propose_booking", proposal, preference)).not.toThrow();
    expect(() => assertRequestedRoomTime("anny_propose_booking", { ...proposal, endDate: "2026-10-19T17:00:00+02:00" }, preference)).toThrow(RoomTimeMismatchError);
  });
  it("does not invent incomplete time constraints or restrict unrelated tools", () => {
    expect(requestedRoomInterval({ kind: "workplace", time: "08:00" })).toBeNull();
    expect(() => assertRequestedRoomTime("anny_get_availability", args, {})).not.toThrow();
    expect(() => assertRequestedRoomTime("anny_propose_cancellation", { bookingId: "own-booking" }, preference)).not.toThrow();
  });
  it.each(["2026-03-29", "2026-10-25"])("rejects complete nonexistent or repeated Berlin times on %s instead of substituting a model time", date => {
    const ambiguous = { kind: "workplace" as const, date, time: "02:30", durationMinutes: 60 };
    expect(() => requestedRoomInterval(ambiguous)).toThrow(RoomTimeUnresolvedError);
    expect(() => assertRequestedRoomTime("anny_get_availability", { ...args, date, time: "03:30", durationMinutes: 60 }, ambiguous)).toThrow(RoomTimeUnresolvedError);
    expect(() => assertRequestedRoomTime("anny_propose_booking", { resourceId: args.resourceId, startDate: `${date}T08:00:00Z`, endDate: `${date}T09:00:00Z` }, ambiguous)).toThrow(RoomTimeUnresolvedError);
    expect(() => assertRequestedRoomTime("anny_propose_cancellation", { bookingId: "own-booking" }, ambiguous)).not.toThrow();
  });
});
