import { describe, expect, it } from "vitest";
import { localDateKey, localHourMinute } from "../../src/core/time.js";

describe("timezone helpers", () => {
  it("uses Asia/Tokyo rather than the host timezone", () => {
    const instant = new Date("2026-08-13T22:00:00.000Z");
    expect(localDateKey(instant, "Asia/Tokyo")).toBe("2026-08-14");
    expect(localHourMinute(instant, "Asia/Tokyo")).toEqual({ hour: 7, minute: 0 });
  });
});
