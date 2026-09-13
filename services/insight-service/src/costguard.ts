// costguard.ts — zero-cost guardrail (cross-cutting) (task 7.4).
//
// The single-user APM system runs on a strict $0/month budget (AGENTS.md hard
// constraint, Requirement 13). Whenever a component would require a paid tier
// or exceed a documented free-tier limit, it must NOT silently proceed: it
// raises a user-visible notification here and halts itself. The notification
// persists until the user acknowledges it, so no paid-tier or free-tier-limit
// excess ever proceeds without an acknowledged notification.
//
// Design contract (design.md "costguard.ts — zero-cost guardrail"):
//
//   raise(n: Omit<CostNotification, "acknowledged" | "raisedAtMs">): void
//   active(): CostNotification[]   // unacknowledged, persisted
//   acknowledge(id: string): void
//
// The api.ts JSON layer already defines a CostNotificationStore seam
//   { active(): CostNotification[]; acknowledge(id: string): boolean }
// used by GET /api/cost-notifications and POST /api/cost-notifications/:id/ack.
// This module provides a `CostGuard` class that IS such a store (its
// `acknowledge` additionally returns whether a match was found, which is a
// superset of the design's `void` signature) plus a process-wide default
// instance and the module-level `raise` / `active` / `acknowledge` functions
// from the design. So any component can import and call the functions, while
// the API can be wired with the same shared instance to expose them.
//
// Requirements: 13.1, 13.2, 13.3

import type { CostNotification } from "./types.js";

// ---------------------------------------------------------------------------
// CostGuard — the persistent notification store
// ---------------------------------------------------------------------------

/**
 * Input to {@link CostGuard.raise}: a {@link CostNotification} without the
 * fields the guard fills in itself. The caller supplies the identity and the
 * cost detail; the guard stamps `acknowledged: false` and `raisedAtMs`.
 */
export type RaiseInput = Omit<CostNotification, "acknowledged" | "raisedAtMs">;

/**
 * A persistent store of zero-cost-guardrail notifications. Notifications are
 * retained until acknowledged (Requirement 13.3), so a raised paid-tier or
 * free-tier-limit concern stays visible across API polls until the user acts.
 *
 * This class satisfies the `CostNotificationStore` seam consumed by api.ts
 * (`active()` / `acknowledge(id)`), so a single shared instance can both
 * receive `raise(...)` calls from components and back the JSON API endpoints.
 */
export class CostGuard {
  /** Keyed by notification id so a re-raise of the same id updates in place. */
  private readonly notifications = new Map<string, CostNotification>();

  /** Clock seam for deterministic tests; defaults to `Date.now`. */
  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Record a notification that a component would incur cost. The component is
   * expected to halt itself after calling this (Requirement 13.1, 13.2). The
   * notification is stored unacknowledged and persists until acknowledged.
   *
   * Re-raising with an id that already exists overwrites the prior entry
   * (refreshing its detail and timestamp) but does NOT resurrect an
   * already-acknowledged notification unless the detail changed — a repeated,
   * identical concern stays acknowledged so it is not surfaced again.
   */
  raise(n: RaiseInput): void {
    const existing = this.notifications.get(n.id);
    const acknowledged =
      existing?.acknowledged === true &&
      existing.component === n.component &&
      existing.kind === n.kind &&
      existing.detail === n.detail;
    this.notifications.set(n.id, {
      ...n,
      acknowledged,
      raisedAtMs: existing && acknowledged ? existing.raisedAtMs : this.now(),
    });
  }

  /**
   * The currently active (unacknowledged) notifications, persisted across
   * calls. The API exposes these for the Simple View to display until the user
   * acknowledges them (Requirement 13.3). Ordered oldest-raised first.
   */
  active(): CostNotification[] {
    return [...this.notifications.values()]
      .filter((n) => !n.acknowledged)
      .sort((a, b) => a.raisedAtMs - b.raisedAtMs);
  }

  /**
   * Acknowledge a notification by id. Returns `true` if a matching
   * notification existed (whether or not it was already acknowledged), `false`
   * if the id is unknown. The acknowledged notification is retained but no
   * longer reported by {@link active} (Requirement 13.3).
   */
  acknowledge(id: string): boolean {
    const existing = this.notifications.get(id);
    if (!existing) return false;
    if (!existing.acknowledged) {
      this.notifications.set(id, { ...existing, acknowledged: true });
    }
    return true;
  }

  /**
   * All notifications, acknowledged or not, oldest-raised first. Useful for
   * diagnostics/tests; the API uses {@link active} only.
   */
  all(): CostNotification[] {
    return [...this.notifications.values()].sort(
      (a, b) => a.raisedAtMs - b.raisedAtMs,
    );
  }
}

// ---------------------------------------------------------------------------
// Process-wide default guard + module-level functions (design signatures)
// ---------------------------------------------------------------------------

/**
 * The shared, process-wide {@link CostGuard}. Components import the module-level
 * {@link raise} / {@link active} / {@link acknowledge} which delegate here, and
 * `index.ts` wires this same instance into the API's `CostNotificationStore`
 * seam so raised notifications appear on `GET /api/cost-notifications`.
 */
export const defaultCostGuard = new CostGuard();

/**
 * Raise a cost notification on the shared guard and (by contract) halt the
 * calling component. Matches design.md's `raise` signature.
 */
export function raise(n: RaiseInput): void {
  defaultCostGuard.raise(n);
}

/** Active (unacknowledged) notifications from the shared guard. */
export function active(): CostNotification[] {
  return defaultCostGuard.active();
}

/**
 * Acknowledge a notification on the shared guard by id. Matches design.md's
 * `void` signature (the underlying {@link CostGuard.acknowledge} returns a
 * found/not-found boolean, which the API uses directly).
 */
export function acknowledge(id: string): void {
  defaultCostGuard.acknowledge(id);
}
