import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActionPreviewDetails } from "../src/components/action-status";

const preview = { instance: "Synthetic anny", account: "Alex", effect: "Execute confirmed booking",
  consequences: ["Create reservation after confirmation"], costs: "Test data only" };

describe("action preview wording follows current status", () => {
  it("retains effects and consequences before explicit confirmation", () => {
    const html = renderToStaticMarkup(createElement(ActionPreviewDetails, { preview, status: "pending" }));
    expect(html).toContain(preview.effect);
    expect(html).toContain(preview.consequences[0]);
  });
  it.each(["confirmed", "executing", "outcome_unknown", "failed", "invalidated"] as const)("does not invite another execution for %s", status => {
    const html = renderToStaticMarkup(createElement(ActionPreviewDetails, { preview, status }));
    expect(html).not.toContain(preview.effect);
    expect(html).not.toContain(preview.consequences[0]);
    expect(html).toContain(preview.instance);
    expect(html).toContain(preview.account);
    expect(html).toContain(preview.costs);
  });
});
