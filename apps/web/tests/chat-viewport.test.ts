import { describe, expect, it } from "vitest";
import { chatViewport } from "../src/lib/chat-viewport";

describe("chat viewport", () => {
  it("fits the visible viewport above an overlay keyboard, including Safari pan", () => {
    expect(chatViewport(800, { height: 420, offsetTop: 35, scale: 1 }, true, true)).toEqual({ height: 420, top: 35, keyboard: true });
  });
  it("keeps navigation on short screens, unfocused pages and desktop", () => {
    expect(chatViewport(568, { height: 568, offsetTop: 0, scale: 1 }, true, true)?.keyboard).toBe(false);
    expect(chatViewport(800, { height: 420, offsetTop: 0, scale: 1 }, true, false)?.keyboard).toBe(false);
    expect(chatViewport(800, { height: 420, offsetTop: 0, scale: 1 }, false, true)?.keyboard).toBe(false);
  });
  it("leaves unsupported or transient invalid viewports to CSS", () => {
    expect(chatViewport(800, null, true, true)).toBeNull();
    for (const height of [0, -1, NaN]) expect(chatViewport(800, { height, offsetTop: 0, scale: 1 }, true, true)).toBeNull();
    expect(chatViewport(800, { height: 400, offsetTop: 0, scale: 2 }, true, true)).toEqual({ height: 800, top: 0, keyboard: false });
  });
  it("preserves the keyboard layout through pinch zoom and browser panning", () => {
    expect(chatViewport(800, { height: 210, offsetTop: 90, scale: 2 }, true, true)).toEqual({ height: 420, top: 0, keyboard: true });
    expect(chatViewport(390, { height: 150, offsetTop: 20, scale: 1 }, true, true)).toEqual({ height: 150, top: 20, keyboard: true });
  });
  it("clamps transient oversize and negative offsets during rotation", () => {
    expect(chatViewport(390, { height: 844, offsetTop: -20, scale: 1 }, true, false)).toEqual({ height: 390, top: 0, keyboard: false });
    expect(chatViewport(390, { height: 390, offsetTop: 30, scale: 1 }, true, false)).toEqual({ height: 360, top: 30, keyboard: false });
  });
});
