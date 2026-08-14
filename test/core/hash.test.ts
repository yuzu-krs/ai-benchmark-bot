import { describe, expect, it } from "vitest";
import { fingerprint, stableJson } from "../../src/core/hash.js";

describe("stableJson", () => {
  it("sorts object keys recursively", () => {
    expect(stableJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
  });
});
