import type { GroqErrorDiagnostics } from "./groq-error-diagnostics";

export type ModelRouterErrorCode =
  | "configuration_invalid"
  | "invalid_request"
  | "profile_not_approved"
  | "missing_credentials"
  | "provider_unavailable"
  | "provider_rate_limited"
  | "invalid_model_response";

export class ModelRouterError extends Error {
  constructor(readonly code: ModelRouterErrorCode, message: string, readonly providerStatus?: number, readonly diagnostics?: GroqErrorDiagnostics, readonly transientFailure?: "rate_limit" | "server_error" | "timeout") {
    super(message);
    this.name = "ModelRouterError";
  }
}
