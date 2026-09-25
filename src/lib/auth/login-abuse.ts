interface Limits {
  now: () => number;
  windowMs: number;
  sourceMaxAttempts: number;
  globalBurst: number;
  globalRefillMs: number;
  sourceBackoffAfter: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  maxConcurrent: number;
}

interface Bucket {
  windowStartedAt: number;
  attempts: number;
  failures: number;
  blockedUntil: number;
  lastSeenAt: number;
}

interface GlobalBucket {
  tokens: number;
  lastRefillAt: number;
}

export interface LoginAttempt {
  finish(success: boolean): void;
}

export interface LoginAdmission {
  allowed: boolean;
  reason?: "source" | "global" | "busy";
  retryAfterSeconds?: number;
  attempt?: LoginAttempt;
}

const PRODUCTION_LIMITS: Limits = {
  now: Date.now,
  windowMs: 60_000,
  sourceMaxAttempts: 10,
  globalBurst: 10,
  globalRefillMs: 1_000,
  sourceBackoffAfter: 5,
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  maxConcurrent: 2,
};

/**
 * Small, in-memory login gate for Moni's single-instance deployment. It caps
 * concurrent Argon2 work and applies both per-source and process-wide limits.
 * A multi-instance deployment would need a shared atomic store instead.
 */
export class LoginAbuseProtection {
  private readonly sources = new Map<string, Bucket>();
  private readonly global: GlobalBucket;
  private active = 0;

  constructor(private readonly limits: Limits = PRODUCTION_LIMITS) {
    this.global = { tokens: this.limits.globalBurst, lastRefillAt: this.limits.now() };
  }

  begin(source: string): LoginAdmission {
    const now = this.limits.now();
    this.refillGlobal(now);
    this.pruneSources(now);

    if (this.global.tokens < 1) {
      return { allowed: false, reason: "global", retryAfterSeconds: 1 };
    }

    const sourceBucket = this.sources.get(source) ?? this.freshBucket(now);
    this.sources.set(source, sourceBucket);
    this.refresh(sourceBucket, now);
    sourceBucket.lastSeenAt = now;

    const sourceRejection = this.rejection(
      sourceBucket,
      now,
      this.limits.sourceMaxAttempts,
      "source",
    );
    if (sourceRejection) return sourceRejection;

    if (this.active >= this.limits.maxConcurrent) {
      return { allowed: false, reason: "busy", retryAfterSeconds: 1 };
    }

    this.global.tokens -= 1;
    sourceBucket.attempts += 1;
    this.active += 1;
    let finished = false;

    return {
      allowed: true,
      attempt: {
        finish: (success) => {
          if (finished) return;
          finished = true;
          this.active -= 1;
          if (success) {
            sourceBucket.failures = 0;
            sourceBucket.blockedUntil = 0;
            return;
          }
          this.recordFailure(sourceBucket, this.limits.sourceBackoffAfter, this.limits.now());
        },
      },
    };
  }

  private freshBucket(now: number): Bucket {
    return { windowStartedAt: now, attempts: 0, failures: 0, blockedUntil: 0, lastSeenAt: now };
  }

  private refresh(bucket: Bucket, now: number): void {
    if (now - bucket.windowStartedAt < this.limits.windowMs) return;
    bucket.windowStartedAt = now;
    bucket.attempts = 0;
    bucket.failures = 0;
    bucket.blockedUntil = 0;
  }

  private refillGlobal(now: number): void {
    const elapsed = now - this.global.lastRefillAt;
    if (elapsed < this.limits.globalRefillMs) return;
    const refill = Math.floor(elapsed / this.limits.globalRefillMs);
    this.global.tokens = Math.min(this.limits.globalBurst, this.global.tokens + refill);
    this.global.lastRefillAt += refill * this.limits.globalRefillMs;
  }

  private rejection(
    bucket: Bucket,
    now: number,
    maxAttempts: number,
    reason: "source" | "global",
  ): LoginAdmission | null {
    if (bucket.blockedUntil > now) {
      return {
        allowed: false,
        reason,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.blockedUntil - now) / 1_000)),
      };
    }
    if (bucket.attempts >= maxAttempts) {
      return {
        allowed: false,
        reason,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((bucket.windowStartedAt + this.limits.windowMs - now) / 1_000),
        ),
      };
    }
    return null;
  }

  private recordFailure(bucket: Bucket, backoffAfter: number, now: number): void {
    bucket.failures += 1;
    if (bucket.failures < backoffAfter) return;
    const delay = Math.min(
      this.limits.backoffBaseMs * 2 ** (bucket.failures - backoffAfter),
      this.limits.backoffMaxMs,
    );
    bucket.blockedUntil = Math.max(bucket.blockedUntil, now + delay);
  }

  private pruneSources(now: number): void {
    for (const [source, bucket] of this.sources) {
      if (now - bucket.lastSeenAt >= this.limits.windowMs * 2) this.sources.delete(source);
    }
  }
}

export const passwordLoginProtection = new LoginAbuseProtection();
