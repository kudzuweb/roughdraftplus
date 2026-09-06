import { describe, expect, it } from "vitest";
import { diskChangeStateAfterServerGone } from "../src/App";

describe("disk state after a refused write from a replaced server", () => {
  it("moves a clean document to server-gone", () => {
    expect(diskChangeStateAfterServerGone("clean")).toBe("server-gone");
  });

  it("keeps server-gone", () => {
    expect(diskChangeStateAfterServerGone("server-gone")).toBe("server-gone");
  });

  it.each([
    "paused",
    "changed",
    "conflict",
  ] as const)("leaves the reviewer's %s decision in place", (state) => {
    expect(diskChangeStateAfterServerGone(state)).toBe(state);
  });
});
