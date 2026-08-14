import { describe, expect, it } from "vitest";
import {
  isSupportedNodeVersion,
  MINIMUM_NODE_VERSION,
  requireSupportedNodeVersion
} from "../../src/core/runtime.js";

describe("Node.js runtime requirement", () => {
  it.each([
    ["24.16.0", false],
    ["24.17.0", true],
    ["25.0.0", true]
  ])("evaluates Node.js %s", (version, expected) => {
    expect(isSupportedNodeVersion(version)).toBe(expected);
  });

  it("rejects malformed and minimum-version prerelease strings", () => {
    expect(isSupportedNodeVersion("24.17")).toBe(false);
    expect(isSupportedNodeVersion("24.17.0-rc.1")).toBe(false);
  });

  it("throws an actionable error for an unsupported runtime", () => {
    expect(() => requireSupportedNodeVersion("24.16.9")).toThrow(
      `Node.js ${MINIMUM_NODE_VERSION} or newer is required`
    );
  });
});
