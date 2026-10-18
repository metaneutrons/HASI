import { z } from "zod";

const label = z.string().trim().min(1).max(512).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
export const actionPreviewSchema = z.strictObject({
  instance: label, account: label, effect: label,
  consequences: z.array(label).min(1).max(8), costs: label,
});
export type ActionPreview = z.infer<typeof actionPreviewSchema>;

export function sameActionPreview(left: ActionPreview | undefined, right: ActionPreview | undefined): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}
