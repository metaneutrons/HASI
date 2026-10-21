import type { GroqRateLimitDiagnostics } from "./provider-rate-limits";
import type { GroqErrorDiagnostics } from "./groq-error-diagnostics";

export type ModelRouterErrorCode =
  | "configuration_invalid"
  | "invalid_request"
  | "profile_not_approved"
  | "missing_credentials"
  | "tools_unavailable"
  | "required_tools_unavailable"
  | "context_unavailable"
  | "action_context_changed"
  | "budget_exhausted"
  | "budget_unavailable"
  | "budget_unpriced"
  | "budget_usage_invalid"
  | "request_cancelled"
  | "provider_unavailable"
  | "provider_rate_limited"
  | "invalid_model_response";

export class ModelRouterError extends Error {
  constructor(readonly code: ModelRouterErrorCode, message: string, readonly providerStatus?: number, readonly diagnostics?: GroqErrorDiagnostics, readonly transientFailure?: "rate_limit" | "server_error" | "timeout", readonly rateLimits?: GroqRateLimitDiagnostics) {
    super(message);
    this.name = "ModelRouterError";
  }
}
