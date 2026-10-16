export type ModelRouterErrorCode =
  | "invalid_request"
  | "profile_not_approved"
  | "missing_credentials"
  | "provider_unavailable"
  | "provider_rate_limited"
  | "invalid_model_response";

export class ModelRouterError extends Error {
  constructor(readonly code: ModelRouterErrorCode, message: string, readonly providerStatus?: number) {
    super(message);
    this.name = "ModelRouterError";
  }
}
