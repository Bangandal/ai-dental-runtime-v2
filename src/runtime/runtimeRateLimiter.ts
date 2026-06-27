export interface RateLimiter {
  check(key: string): boolean;
}

export interface RateLimiterConfig {
  maxRequests: number;
  windowMs: number;
}

export function createRateLimiter(config: RateLimiterConfig): RateLimiter {
  const store = new Map<string, { count: number; windowStart: number }>();

  return {
    check(key: string): boolean {
      const now = Date.now();
      const entry = store.get(key);

      if (!entry || now - entry.windowStart >= config.windowMs) {
        store.set(key, { count: 1, windowStart: now });
        return true;
      }

      if (entry.count >= config.maxRequests) return false;
      entry.count++;
      return true;
    },
  };
}

export function createNoopRateLimiter(): RateLimiter {
  return { check: () => true };
}
