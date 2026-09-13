// Feature: personal-ai-apm-system
// Example-based unit tests for costguard.ts (task 7.5).
//
// Validates:
//   Requirement 13.1 — a component that would require a paid tier raises a
//                       user-visible notification (kind "paid-tier-required").
//   Requirement 13.2 — a component that would exceed a documented free-tier
//                       limit raises a notification (kind "free-tier-limit-exceeded").
//   Requirement 13.3 — raised notifications persist (are surfaced) until the
//                       user acknowledges them.
//
// Focus: raise/persist/acknowledge lifecycle, `active()` returning only
// unacknowledged notifications (oldest-first), `all()` retaining acknowledged
// ones, acknowledge of an unknown id, both notification kinds, and the
// re-raise semantics (identical re-raise of an acknowledged id stays
// acknowledged; a changed detail re-raises it).

import { describe, it, expect } from "vitest";
import { CostGuard, type RaiseInput } from "./costguard.js";

// A controllable clock so `raisedAtMs` is deterministic and ordering is
// exercised precisely. Each tick advances the returned time.
function makeClock(start = 1_000): { now: () => number; set: (t: number) => void } {
  let t = start;
  return {
    now: () => t,
    set: (next: number) => {
      t = next;
    },
  };
}

const paidTier: RaiseInput = {
  id: "llm-gemini",
  component: "llm.ts",
  kind: "paid-tier-required",
  detail: "Gemini fallback requires a paid tier",
};

const freeTierLimit: RaiseInput = {
  id: "llm-groq",
  component: "llm.ts",
  kind: "free-tier-limit-exceeded",
  detail: "Groq daily free-tier limit exceeded",
};

describe("CostGuard", () => {
  it("raise then active shows the notification unacknowledged with a stamped raisedAtMs (Req 13.1)", () => {
    const clock = makeClock(5_000);
    const guard = new CostGuard(clock.now);

    guard.raise(paidTier);

    const active = guard.active();
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      id: "llm-gemini",
      component: "llm.ts",
      kind: "paid-tier-required",
      detail: "Gemini fallback requires a paid tier",
      acknowledged: false,
      raisedAtMs: 5_000,
    });
  });

  it("supports both paid-tier-required and free-tier-limit-exceeded kinds (Req 13.1, 13.2)", () => {
    const clock = makeClock();
    const guard = new CostGuard(clock.now);

    clock.set(100);
    guard.raise(paidTier);
    clock.set(200);
    guard.raise(freeTierLimit);

    const kinds = guard.active().map((n) => n.kind);
    expect(kinds).toContain("paid-tier-required");
    expect(kinds).toContain("free-tier-limit-exceeded");
    expect(guard.active()).toHaveLength(2);
  });

  it("acknowledge removes a notification from active() but all() still lists it (Req 13.3)", () => {
    const clock = makeClock(1_000);
    const guard = new CostGuard(clock.now);

    guard.raise(paidTier);
    expect(guard.active()).toHaveLength(1);

    const found = guard.acknowledge("llm-gemini");
    expect(found).toBe(true);

    // No longer surfaced as active...
    expect(guard.active()).toHaveLength(0);
    // ...but retained in the full list, now acknowledged.
    const all = guard.all();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: "llm-gemini", acknowledged: true });
  });

  it("acknowledge of an unknown id returns false and changes nothing", () => {
    const clock = makeClock();
    const guard = new CostGuard(clock.now);

    guard.raise(paidTier);
    expect(guard.acknowledge("does-not-exist")).toBe(false);

    // The real notification is untouched and still active.
    expect(guard.active()).toHaveLength(1);
    expect(guard.active()[0].id).toBe("llm-gemini");
  });

  it("persists an unacknowledged notification across repeated active() polls until acknowledged (Req 13.3)", () => {
    const clock = makeClock(2_000);
    const guard = new CostGuard(clock.now);

    guard.raise(freeTierLimit);

    // Polled repeatedly (as the API would): it keeps being surfaced.
    expect(guard.active()).toHaveLength(1);
    expect(guard.active()).toHaveLength(1);
    expect(guard.active()[0].id).toBe("llm-groq");

    // Only after acknowledgement does it stop being active.
    expect(guard.acknowledge("llm-groq")).toBe(true);
    expect(guard.active()).toHaveLength(0);
  });

  it("active() returns notifications oldest-raised first", () => {
    const clock = makeClock();
    const guard = new CostGuard(clock.now);

    clock.set(300);
    guard.raise({ ...paidTier, id: "c" });
    clock.set(100);
    guard.raise({ ...paidTier, id: "a" });
    clock.set(200);
    guard.raise({ ...paidTier, id: "b" });

    const orderedIds = guard.active().map((n) => n.id);
    expect(orderedIds).toEqual(["a", "b", "c"]);
    const stamps = guard.active().map((n) => n.raisedAtMs);
    expect(stamps).toEqual([100, 200, 300]);
  });

  it("re-raising an identical acknowledged notification keeps it acknowledged (not re-surfaced)", () => {
    const clock = makeClock(1_000);
    const guard = new CostGuard(clock.now);

    guard.raise(paidTier);
    expect(guard.acknowledge("llm-gemini")).toBe(true);
    expect(guard.active()).toHaveLength(0);

    // Same id/component/kind/detail raised again at a later time: it should
    // stay acknowledged and retain its original raisedAtMs.
    clock.set(9_999);
    guard.raise(paidTier);

    expect(guard.active()).toHaveLength(0);
    const all = guard.all();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ acknowledged: true, raisedAtMs: 1_000 });
  });

  it("re-raising an acknowledged notification with a changed detail re-raises it (Req 13.3)", () => {
    const clock = makeClock(1_000);
    const guard = new CostGuard(clock.now);

    guard.raise(paidTier);
    expect(guard.acknowledge("llm-gemini")).toBe(true);
    expect(guard.active()).toHaveLength(0);

    // A materially different concern under the same id must surface again.
    clock.set(4_000);
    guard.raise({ ...paidTier, detail: "Gemini quota changed — now paid only" });

    const active = guard.active();
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      id: "llm-gemini",
      acknowledged: false,
      raisedAtMs: 4_000,
      detail: "Gemini quota changed — now paid only",
    });
  });
});
