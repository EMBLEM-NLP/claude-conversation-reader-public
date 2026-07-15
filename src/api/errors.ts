export class AuthError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Authentication failed (${status}). Run \`ccr login\` to re-authenticate.`);
    this.name = 'AuthError';
    this.status = status;
  }
}

export class RateLimitError extends Error {
  readonly retryAfter: number;
  constructor(retryAfter: number) {
    super(`Rate limited by Claude.ai. Retry after ${retryAfter}s.`);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, statusText: string) {
    super(`Claude.ai API error: ${status} ${statusText}`);
    this.name = 'ApiError';
    this.status = status;
  }
}
