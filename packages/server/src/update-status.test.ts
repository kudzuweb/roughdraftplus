import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareVersions,
  FORK_UPDATE_COMMAND,
  resolveUpdateStatus,
} from "./update-status";

describe("compareVersions", () => {
  it("orders numeric versions correctly", () => {
    expect(compareVersions("0.1.0", "0.2.0")).toBeLessThan(0);
    expect(compareVersions("1.4.0", "1.4.0")).toBe(0);
    expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
  });

  it("treats prereleases as older than stable releases", () => {
    expect(compareVersions("0.2.0-beta.1", "0.2.0")).toBeLessThan(0);
    expect(compareVersions("0.2.0-beta.2", "0.2.0-beta.1")).toBeGreaterThan(0);
  });
});

describe("resolveUpdateStatus", () => {
  const tempPaths: string[] = [];

  afterEach(() => {
    tempPaths.forEach((tempPath) => {
      fs.rmSync(tempPath, { recursive: true, force: true });
    });
    tempPaths.length = 0;
  });

  it("never consults the registry and never reports an update", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-pkg-"));
    const packageJsonPath = path.join(tempDir, "package.json");
    tempPaths.push(tempDir);
    fs.writeFileSync(
      packageJsonPath,
      JSON.stringify({ name: "roughdraft", version: "0.1.0" }),
    );

    // The registry's `roughdraft` package is the unmaintained upstream
    // lineage; even a newer version there must never surface as an update.
    const status = await resolveUpdateStatus({
      packageJsonPath,
      fetchImpl: async () => {
        throw new Error("resolveUpdateStatus must not touch the network");
      },
    });

    expect(status).toEqual({
      packageName: "roughdraft",
      currentVersion: "0.1.0",
      latestVersion: null,
      updateAvailable: false,
      updateCommand: FORK_UPDATE_COMMAND,
    });
  });
});
