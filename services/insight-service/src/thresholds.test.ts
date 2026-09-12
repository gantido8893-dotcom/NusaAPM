// Feature: personal-ai-apm-system
// Example-based unit tests for thresholds.ts edge cases (task 3.5).
//
// Validates:
//   Requirement 3.3 — value outside all bands / missing config -> unknown,
//                      last known band retained by the store.
//   Requirement 3.4 — invalid threshold config rejected, prior config retained.
//   Requirement 3.5 — accepted config changes apply immediately (hot-reload).
//
// Focus: half-open [min, max) boundary behavior (value == min is in-band,
// value == max belongs to the next band up), out-of-range handling, missing
// config, and invalid-config rejection retaining the prior config.

import { describe, it, expect, beforeEach } from "vitest";
import {
  validateThreshold,
  classify,
  percentOfCritical,
  ThresholdStore,
} from "./thresholds.js";
import type { MetricThreshold, ThresholdConfig } from "./types.js";

// A canonical contiguous, gap-free, non-overlapping config:
//   green=[0,10)  yellow=[10,20)  red=[20,30)
const validThreshold: MetricThreshold = {
  metric: "latency",
  green: { min: 0, max: 10 },
  yellow: { min: 10, max: 20 },
  red: { min: 20, max: 30 },
};

const validConfig: ThresholdConfig = { metrics: { latency: validThreshold } };

describe("classify — half-open [min, max) boundary behavior", () => {
  it("value == a band's min is IN that band", () => {
    expect(classify(validConfig, "latency", 0)).toBe("green"); // green.min
    expect(classify(validConfig, "latency", 10)).toBe("yellow"); // yellow.min
    expect(classify(validConfig, "latency", 20)).toBe("red"); // red.min
  });

  it("value == a band's max belongs to the NEXT band up (max is exclusive)", () => {
    // 10 is green.max but yellow.min -> yellow, not green.
    expect(classify(validConfig, "latency", 10)).toBe("yellow");
    // 20 is yellow.max but red.min -> red, not yellow.
    expect(classify(validConfig, "latency", 20)).toBe("red");
  });

  it("value just below a boundary stays in the lower band", () => {
    expect(classify(validConfig, "latency", 9.999)).toBe("green");
    expect(classify(validConfig, "latency", 19.999)).toBe("yellow");
    expect(classify(validConfig, "latency", 29.999)).toBe("red");
  });

  it("value strictly inside each band classifies to that band", () => {
    expect(classify(validConfig, "latency", 5)).toBe("green");
    expect(classify(validConfig, "latency", 15)).toBe("yellow");
    expect(classify(validConfig, "latency", 25)).toBe("red");
  });
});

describe("classify — value outside all bands (Requirement 3.3)", () => {
  it("value at the overall upper bound (== red.max) is outside -> unknown", () => {
    // 30 == red.max, which is exclusive, so it is covered by no band.
    expect(classify(validConfig, "latency", 30)).toBe("unknown");
  });

  it("value below the lowest band -> unknown", () => {
    expect(classify(validConfig, "latency", -1)).toBe("unknown");
  });

  it("value above the highest band -> unknown", () => {
    expect(classify(validConfig, "latency", 1000)).toBe("unknown");
  });

  it("non-finite values -> unknown", () => {
    expect(classify(validConfig, "latency", NaN)).toBe("unknown");
    expect(classify(validConfig, "latency", Infinity)).toBe("unknown");
    expect(classify(validConfig, "latency", -Infinity)).toBe("unknown");
  });
});

describe("classify — missing config (Requirement 3.3)", () => {
  it("unknown metric -> unknown", () => {
    expect(classify(validConfig, "not-configured", 5)).toBe("unknown");
  });

  it("empty config -> unknown", () => {
    expect(classify({ metrics: {} }, "latency", 5)).toBe("unknown");
  });

  it("invalid (e.g. overlapping) config for a metric -> unknown", () => {
    const overlapping: ThresholdConfig = {
      metrics: {
        latency: {
          metric: "latency",
          green: { min: 0, max: 15 }, // overlaps yellow
          yellow: { min: 10, max: 20 },
          red: { min: 20, max: 30 },
        },
      },
    };
    expect(classify(overlapping, "latency", 5)).toBe("unknown");
  });
});

describe("validateThreshold — accept/reject rules (Requirements 3.4)", () => {
  it("accepts a contiguous, gap-free, non-overlapping config", () => {
    const res = validateThreshold(validThreshold);
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it("accepts bands declared in non-ascending label order (order-independent)", () => {
    // red is the lowest range, green the highest — still contiguous.
    const reversed: MetricThreshold = {
      metric: "headroom",
      red: { min: 0, max: 10 },
      yellow: { min: 10, max: 20 },
      green: { min: 20, max: 30 },
    };
    expect(validateThreshold(reversed).valid).toBe(true);
  });

  it("rejects overlapping bands", () => {
    const overlapping: MetricThreshold = {
      metric: "latency",
      green: { min: 0, max: 12 },
      yellow: { min: 10, max: 20 },
      red: { min: 20, max: 30 },
    };
    const res = validateThreshold(overlapping);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => /overlap/i.test(e))).toBe(true);
  });

  it("rejects configs with a gap between bands", () => {
    const gapped: MetricThreshold = {
      metric: "latency",
      green: { min: 0, max: 10 },
      yellow: { min: 12, max: 20 }, // gap [10,12)
      red: { min: 20, max: 30 },
    };
    const res = validateThreshold(gapped);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => /gap/i.test(e))).toBe(true);
  });

  it("rejects a missing band", () => {
    const missing = {
      metric: "latency",
      green: { min: 0, max: 10 },
      yellow: { min: 10, max: 20 },
      // red missing
    } as unknown as MetricThreshold;
    const res = validateThreshold(missing);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => /missing red/i.test(e))).toBe(true);
  });

  it("rejects a malformed range where min >= max", () => {
    const malformed: MetricThreshold = {
      metric: "latency",
      green: { min: 10, max: 10 }, // empty range
      yellow: { min: 10, max: 20 },
      red: { min: 20, max: 30 },
    };
    expect(validateThreshold(malformed).valid).toBe(false);
  });
});

describe("ThresholdStore — invalid-config rejection retains prior config (Requirement 3.4)", () => {
  let store: ThresholdStore;

  beforeEach(() => {
    store = new ThresholdStore(validConfig);
  });

  it("setConfig with an invalid entry is rejected and prior config is retained", () => {
    const prior = store.getConfig();
    const bad: ThresholdConfig = {
      metrics: {
        latency: {
          metric: "latency",
          green: { min: 0, max: 15 }, // overlaps yellow
          yellow: { min: 10, max: 20 },
          red: { min: 20, max: 30 },
        },
      },
    };
    const res = store.setConfig(bad);
    expect(res.valid).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
    // Prior config unchanged.
    expect(store.getConfig()).toBe(prior);
    expect(store.classify("latency", 5)).toBe("green");
  });

  it("setMetricThreshold with an invalid threshold is rejected and prior retained", () => {
    const gapped: MetricThreshold = {
      metric: "latency",
      green: { min: 0, max: 10 },
      yellow: { min: 12, max: 20 }, // gap
      red: { min: 20, max: 30 },
    };
    const res = store.setMetricThreshold("latency", gapped);
    expect(res.valid).toBe(false);
    // Still classifies with the original valid config.
    expect(store.classify("latency", 15)).toBe("yellow");
  });

  it("setConfig missing the metrics map is rejected", () => {
    const res = store.setConfig({} as unknown as ThresholdConfig);
    expect(res.valid).toBe(false);
    expect(store.getConfig()).toEqual(validConfig);
  });
});

describe("ThresholdStore — hot-reload applies accepted changes immediately (Requirement 3.5)", () => {
  it("a newly accepted config classifies subsequent values without restart", () => {
    const store = new ThresholdStore(validConfig);
    expect(store.classify("latency", 25)).toBe("red");

    // Widen green so 25 now falls in green.
    const next: ThresholdConfig = {
      metrics: {
        latency: {
          metric: "latency",
          green: { min: 0, max: 30 },
          yellow: { min: 30, max: 40 },
          red: { min: 40, max: 50 },
        },
      },
    };
    expect(store.setConfig(next).valid).toBe(true);
    expect(store.classify("latency", 25)).toBe("green");
  });

  it("setMetricThreshold adds a new metric without disturbing existing ones", () => {
    const store = new ThresholdStore(validConfig);
    const mem: MetricThreshold = {
      metric: "memory",
      green: { min: 0, max: 100 },
      yellow: { min: 100, max: 200 },
      red: { min: 200, max: 300 },
    };
    expect(store.setMetricThreshold("memory", mem).valid).toBe(true);
    expect(store.classify("memory", 150)).toBe("yellow");
    expect(store.classify("latency", 5)).toBe("green");
  });
});

describe("ThresholdStore — last-known-band retention (Requirement 3.3)", () => {
  it("retains the last definite band when the value later falls outside all bands", () => {
    const store = new ThresholdStore(validConfig);
    expect(store.classify("latency", 5)).toBe("green"); // establishes last-known
    // Now out of range -> retains green rather than reporting unknown.
    expect(store.classify("latency", 1000)).toBe("green");
  });

  it("retains the last definite band when the config later becomes missing/invalid", () => {
    const store = new ThresholdStore(validConfig);
    expect(store.classify("latency", 25)).toBe("red"); // establishes last-known

    // Replace whole config with one that no longer has the metric.
    store.setConfig({ metrics: { other: validThreshold } });
    // 'latency' now unconfigured -> retains last-known red.
    expect(store.classify("latency", 25)).toBe("red");
  });

  it("returns unknown when there is no last-known band and no valid classification", () => {
    const store = new ThresholdStore({ metrics: {} });
    expect(store.classify("latency", 5)).toBe("unknown");
  });

  it("updates the last-known band as the value moves between bands", () => {
    const store = new ThresholdStore(validConfig);
    expect(store.classify("latency", 5)).toBe("green");
    expect(store.classify("latency", 15)).toBe("yellow");
    expect(store.classify("latency", 1000)).toBe("yellow"); // retains latest known
  });
});

describe("percentOfCritical — edge cases (Requirements 2.6, 2.8)", () => {
  it("returns undefined when there is no well-formed red band", () => {
    const noRed = {
      metric: "latency",
      green: { min: 0, max: 10 },
      yellow: { min: 10, max: 20 },
      red: { min: 20, max: 10 }, // malformed (min > max)
    } as MetricThreshold;
    expect(percentOfCritical(noRed, 15)).toBeUndefined();
  });

  it("returns 100 when value equals the critical start (red.min)", () => {
    expect(percentOfCritical(validThreshold, 20)).toBe(100);
  });

  it("returns a proportional percentage below the critical start", () => {
    // value 10 against red.min 20 -> 50%
    expect(percentOfCritical(validThreshold, 10)).toBe(50);
  });

  it("returns undefined for non-finite values", () => {
    expect(percentOfCritical(validThreshold, NaN)).toBeUndefined();
  });

  it("treats a zero critical start as reached for non-negative values", () => {
    const zeroCritical: MetricThreshold = {
      metric: "x",
      green: { min: -20, max: -10 },
      yellow: { min: -10, max: 0 },
      red: { min: 0, max: 10 },
    };
    expect(percentOfCritical(zeroCritical, 5)).toBe(100);
    expect(percentOfCritical(zeroCritical, -5)).toBe(0);
  });
});
