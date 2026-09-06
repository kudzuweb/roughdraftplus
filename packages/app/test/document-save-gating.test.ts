import { describe, expect, it } from "vitest";
import { isDocumentSaveBlocked } from "../src/DocumentWorkspace";

describe("document save gating", () => {
  it.each([
    [{ documentDiskChangeState: "clean", reviewHandoffState: "idle" }, false],
    [{ documentDiskChangeState: "clean", reviewHandoffState: "notifying" }, false],
    [{ documentDiskChangeState: "clean", reviewHandoffState: "undelivered" }, false],
    [{ documentDiskChangeState: "clean", reviewHandoffState: "error" }, false],
    [{ documentDiskChangeState: "clean", reviewHandoffState: "notified" }, true],
    [{ documentDiskChangeState: "changed", reviewHandoffState: "idle" }, true],
    [{ documentDiskChangeState: "conflict", reviewHandoffState: "idle" }, true],
    [{ documentDiskChangeState: "paused", reviewHandoffState: "idle" }, true],
    [{ documentDiskChangeState: "server-gone", reviewHandoffState: "idle" }, true],
  ] as const)("returns %s for %o", (input, expected) => {
    expect(isDocumentSaveBlocked(input)).toBe(expected);
  });
});
