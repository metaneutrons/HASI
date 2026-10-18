import { z } from 'zod';
import type { ActorContext } from '@hasi/plugin-sdk';

const text = z.string().trim().min(1).max(512).refine(value => Array.from(value).every(character => { const point = character.codePointAt(0) ?? 0; return point >= 32 && point !== 127; }));
export const actionPreviewSchema = z.strictObject({
  instance: text,
  account: text,
  effect: text,
  consequences: z.array(text).min(1).max(8),
  costs: text,
});
export type ActionPreview = z.infer<typeof actionPreviewSchema>;
export interface ActionInput {
  actor: ActorContext;
  executionTool: string;
  arguments: Readonly<Record<string, unknown>>;
}
export type ActionResolution =
  | { status: 'confirmed'; result: Record<string, unknown> }
  | { status: 'failed' }
  | { status: 'outcome_unknown' };
export const actionResolutionSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('confirmed'), result: z.record(z.string(), z.unknown()) }),
  z.strictObject({ status: z.literal('failed') }),
  z.strictObject({ status: z.literal('outcome_unknown') }),
]);

/** Operator-owned policy; neither a manifest nor a browser can register these callbacks. */
export interface ActionPolicy {
  revision: string;
  preview(input: ActionInput): Promise<ActionPreview>;
  /** Authoritative receipt/status reads only. Must never replay the business write. */
  reconcile(input: ActionInput & { executionId: string }): Promise<ActionResolution>;
}
