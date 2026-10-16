/** Compensate for zoom rather than shrinking the layout again on every pinch. */
export function chatViewport(layoutHeight: number, viewport: { height: number; offsetTop: number; scale: number } | null, mobile: boolean, editing: boolean) {
  if (!viewport || !Number.isFinite(viewport.scale) || viewport.scale <= 0 || !Number.isFinite(viewport.height) || viewport.height <= 0 || !Number.isFinite(viewport.offsetTop)) return null;
  const zoomed = Math.abs(viewport.scale - 1) > 0.01;
  // Leave zoom panning to the browser; offsetTop then includes the user's pan.
  const top = zoomed ? 0 : Math.min(Math.max(0, viewport.offsetTop), Math.max(0, layoutHeight - 1));
  const height = Math.min(layoutHeight - top, viewport.height * viewport.scale);
  return { height, top, keyboard: mobile && editing && layoutHeight - viewport.height * viewport.scale > 120 };
}
