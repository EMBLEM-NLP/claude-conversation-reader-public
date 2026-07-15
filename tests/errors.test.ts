import { describe, it, expect } from 'vitest';
import { AuthError, RateLimitError, ApiError } from '../src/api/errors.js';

describe('AuthError', () => {
  it('has name AuthError', () => {
    expect(new AuthError(401).name).toBe('AuthError');
  });

  it('message includes status code', () => {
    expect(new AuthError(403).message).toContain('403');
  });

  it('exposes status property', () => {
    expect(new AuthError(401).status).toBe(401);
  });

  it('is instanceof Error', () => {
    expect(new AuthError(401)).toBeInstanceOf(Error);
  });
});

describe('RateLimitError', () => {
  it('has name RateLimitError', () => {
    expect(new RateLimitError(60).name).toBe('RateLimitError');
  });

  it('exposes retryAfter', () => {
    expect(new RateLimitError(30).retryAfter).toBe(30);
  });

  it('message mentions retry seconds', () => {
    expect(new RateLimitError(45).message).toContain('45');
  });
});

describe('ApiError', () => {
  it('has name ApiError', () => {
    expect(new ApiError(500, 'Internal Server Error').name).toBe('ApiError');
  });

  it('exposes status', () => {
    expect(new ApiError(404, 'Not Found').status).toBe(404);
  });

  it('message includes status and text', () => {
    const err = new ApiError(503, 'Service Unavailable');
    expect(err.message).toContain('503');
    expect(err.message).toContain('Service Unavailable');
  });
});
