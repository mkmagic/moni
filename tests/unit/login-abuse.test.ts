import { describe, expect, it } from "vitest";
import { LoginAbuseProtection } from "@/lib/auth/login-abuse";

function testGuard() {
  let now = 1_000;
  return {
    guard: new LoginAbuseProtection({
      now: () => now,
      windowMs: 60_000,
      sourceMaxAttempts: 10,
      globalBurst: 3,
      globalRefillMs: 1_000,
      sourceBackoffAfter: 2,
      backoffBaseMs: 1_000,
      backoffMaxMs: 30_000,
      maxConcurrent: 2,
    }),
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("password-login abuse protection", () => {
  it("backs off one source after repeated failures", () => {
    const { guard, advance } = testGuard();

    guard.begin("192.0.2.1").attempt!.finish(false);
    guard.begin("192.0.2.1").attempt!.finish(false);

    expect(guard.begin("192.0.2.1")).toMatchObject({ allowed: false, reason: "source" });
    expect(guard.begin("192.0.2.2").allowed).toBe(true);

    advance(1_000);
    expect(guard.begin("192.0.2.1").allowed).toBe(true);
  });

  it("uses only a short global retry without escalating family-wide lockout", () => {
    const { guard, advance } = testGuard();

    guard.begin("192.0.2.1").attempt!.finish(false);
    guard.begin("192.0.2.2").attempt!.finish(false);
    guard.begin("192.0.2.3").attempt!.finish(false);

    expect(guard.begin("192.0.2.4")).toMatchObject({
      allowed: false,
      reason: "global",
      retryAfterSeconds: 1,
    });

    advance(1_000);
    const admitted = guard.begin("192.0.2.4");
    expect(admitted.allowed).toBe(true);
    admitted.attempt!.finish(false);

    expect(guard.begin("192.0.2.5")).toMatchObject({
      allowed: false,
      reason: "global",
      retryAfterSeconds: 1,
    });
  });

  it("admits at most two concurrent Argon2 attempts", () => {
    const { guard } = testGuard();
    const first = guard.begin("192.0.2.1");
    const second = guard.begin("192.0.2.2");

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(guard.begin("192.0.2.3")).toMatchObject({ allowed: false, reason: "busy" });

    first.attempt!.finish(true);
    expect(guard.begin("192.0.2.3").allowed).toBe(true);
  });
});
