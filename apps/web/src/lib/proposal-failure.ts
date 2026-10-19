interface ProposalFailureDetails {
  status?: number;
  code?: unknown;
}

export type ProposalFailureDisposition =
  | "invalidated"
  | "retry_preflight"
  | "outcome_unknown"
  | "not_retryable";

function failureDetails(cause: unknown): ProposalFailureDetails {
  if (!(cause instanceof Error)) return {};
  const details = cause as Error & { status?: unknown; code?: unknown };
  return {
    ...(typeof details.status === "number" && Number.isInteger(details.status) ? { status: details.status } : {}),
    ...(typeof details.code === "string" ? { code: details.code } : {}),
  };
}

/**
 * Classify an API failure without retrying an action. Only a pre-dispatch
 * availability failure is safe to retry; a dispatched confirmation is
 * ambiguous unless the server explicitly reports proposal invalidation.
 */
export function classifyProposalFailure(
  cause: unknown,
  executionAttempted: boolean,
): ProposalFailureDisposition {
  const { status, code } = failureDetails(cause);

  if (status === 409 && code === "proposal_invalidated") return "invalidated";
  if (executionAttempted) return "outcome_unknown";
  if (status === 0 || status === 502 || status === 503 || status === 504) return "retry_preflight";
  return "not_retryable";
}
