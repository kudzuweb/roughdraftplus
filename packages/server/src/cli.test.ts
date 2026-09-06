import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateRoughdraftMarkdown } from "@roughdraft/rfm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCliDependencies,
  createDefaultOpenUrl,
  ensureServerRunning,
  getServerStateFilePath,
  runCli,
} from "./cli";
import { createApp } from "./index";
import { ROUGHDRAFT_DEFAULT_PORT, ROUGHDRAFT_PUBLIC_HOST } from "./network";

// tsx compiles the CLI on first import, which is slower than a unit test.
const SUBPROCESS_TEST_TIMEOUT_MS = 60_000;

interface StartedServer {
  close: () => Promise<void>;
}

async function listenOnLoopbackServers(
  port: number,
  app: ReturnType<typeof createApp>["app"],
): Promise<StartedServer> {
  const servers: Server[] = [];

  for (const host of ["127.0.0.1", "::1"]) {
    const server = createHttpServer(app);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "EAFNOSUPPORT" || error.code === "EADDRNOTAVAIL") {
            resolve();
            return;
          }

          reject(error);
        });

        server.listen(port, host, () => resolve());
      });
      if (server.listening) {
        servers.push(server);
      }
    } catch (error) {
      await new Promise((resolve) => server.close(() => resolve(undefined)));
      throw error;
    }
  }

  return {
    close: async () => {
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve, reject) => {
              server.closeAllConnections?.();
              server.close((error) => {
                if (error) {
                  reject(error);
                  return;
                }
                resolve();
              });
            }),
        ),
      );
    },
  };
}

describe("cli", () => {
  let tempDir: string;
  let stateDir: string;
  let projectDir: string;
  let devFrontendStateFile: string;
  let nextPid: number;
  let runningPids: Set<number>;
  let serverByPid: Map<number, StartedServer>;
  let portByPid: Map<number, number>;
  const serverRoot = path.resolve(
    fileURLToPath(new URL("../../..", import.meta.url)),
  );

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-cli-"));
    stateDir = path.join(tempDir, "state");
    projectDir = path.join(tempDir, "project");
    devFrontendStateFile = path.join(tempDir, "dev-frontend.json");
    fs.mkdirSync(projectDir, { recursive: true });
    nextPid = 1000;
    runningPids = new Set<number>();
    serverByPid = new Map<number, StartedServer>();
    portByPid = new Map<number, number>();
  });

  function expectedOpenUrl(
    baseUrl: string,
    documentPath: string,
    sessionLabel?: string,
  ): string {
    const url = new URL(baseUrl);
    url.pathname = "/";
    url.searchParams.set("path", documentPath);
    if (sessionLabel) url.searchParams.set("label", sessionLabel);
    return url.toString();
  }

  function parseOnlyJsonLog<T>(logs: string[]): T {
    expect(logs).toHaveLength(1);
    return JSON.parse(logs[0] ?? "{}") as T;
  }

  function extractHelpExample(
    logs: string[],
    startLine: string,
    stopLine: string,
  ): string {
    const startIndex = logs.indexOf(startLine);
    const stopIndex = logs.indexOf(stopLine);
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(stopIndex).toBeGreaterThan(startIndex);

    return `${logs
      .slice(startIndex + 1, stopIndex)
      .filter((line) => line.length > 0)
      .map((line) => line.replace(/^ {2}/, ""))
      .join("\n")}\n`;
  }

  async function noUpdateStatus() {
    return {
      packageName: "roughdraft",
      currentVersion: "0.1.0",
      latestVersion: "0.1.0",
      updateAvailable: false,
      updateCommand: "npm i -g roughdraft@latest",
    };
  }

  afterEach(async () => {
    await Promise.all(
      Array.from(serverByPid.values(), (server) => server.close()),
    );
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createTestDependencies() {
    const logs: string[] = [];
    const errors: string[] = [];
    let lastOpenedUrl: string | null = null;
    let spawnCount = 0;

    const deps = createCliDependencies({
      env: {
        ...process.env,
        ROUGHDRAFT_STATE_DIR: stateDir,
        ROUGHDRAFT_DEV_FRONTEND_STATE_FILE: devFrontendStateFile,
      },
      cwd: projectDir,
      fetchImpl: async (input, init) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );
        const port = Number.parseInt(url.port || "80", 10);
        const hasActiveServer = Array.from(portByPid.entries()).some(
          ([pid, activePort]) => runningPids.has(pid) && activePort === port,
        );

        if (url.pathname === "/api/status" && !hasActiveServer) {
          throw new Error("connect ECONNREFUSED");
        }

        return fetch(input, init);
      },
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
      openUrl: (url) => {
        lastOpenedUrl = url;
        return "disabled";
      },
      resolveUpdateStatus: noUpdateStatus,
      spawnServerProcess: async ({ port, projectDir: nextProjectDir }) => {
        spawnCount += 1;
        const pid = nextPid;
        nextPid += 1;
        const { app } = createApp({
          port,
          projectDir: nextProjectDir,
          serverRoot,
          staticDirPath: nextProjectDir,
        });
        const started = await listenOnLoopbackServers(port, app);
        runningPids.add(pid);
        serverByPid.set(pid, started);
        portByPid.set(pid, port);
        return { pid };
      },
      isProcessRunning: (pid) => runningPids.has(pid),
      stopProcess: async (pid) => {
        const server = serverByPid.get(pid);
        if (server) {
          await server.close();
        }
        serverByPid.delete(pid);
        portByPid.delete(pid);
        runningPids.delete(pid);
      },
    });

    return {
      deps,
      logs,
      errors,
      getLastOpenedUrl: () => lastOpenedUrl,
      getSpawnCount: () => spawnCount,
    };
  }

  it("writes server state and reuses a running background server", async () => {
    const test = createTestDependencies();

    const first = await ensureServerRunning(test.deps, { projectDir });
    const second = await ensureServerRunning(test.deps, { projectDir });

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(first.server.url).toBe(`http://localhost:${first.server.port}`);
    expect(test.getSpawnCount()).toBe(1);

    const stateFilePath = getServerStateFilePath(test.deps.env);
    const persisted = JSON.parse(fs.readFileSync(stateFilePath, "utf8")) as {
      port: number;
      pid: number;
      startedAt: string;
      url: string;
    };

    expect(persisted).toMatchObject({
      port: first.server.port,
      pid: first.server.pid,
      url: first.server.url,
    });
    expect(typeof persisted.startedAt).toBe("string");
  });

  it("auto-starts from open and opens the requested markdown file URL", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const exitCode = await runCli(
      ["open", documentPath, "--no-watch"],
      test.deps,
    );
    const persisted = JSON.parse(
      fs.readFileSync(getServerStateFilePath(test.deps.env), "utf8"),
    ) as { port: number };

    expect(exitCode).toBe(0);
    expect(test.getSpawnCount()).toBe(1);
    expect(test.getLastOpenedUrl()).toBe(
      expectedOpenUrl(`http://localhost:${persisted.port}`, documentPath),
    );
    expect(fs.existsSync(getServerStateFilePath(test.deps.env))).toBeTruthy();
  });

  it("prints an update notice after a successful human-readable command", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const exitCode = await runCli(["open", documentPath, "--no-watch"], {
      ...test.deps,
      resolveUpdateStatus: async () => ({
        packageName: "roughdraft",
        currentVersion: "0.1.1",
        latestVersion: "0.1.3",
        updateAvailable: true,
        updateCommand: "npm i -g roughdraft@latest",
      }),
    });

    expect(exitCode).toBe(0);
    expect(test.logs.at(-1)).toBe(
      "Roughdraft update available: 0.1.1 -> 0.1.3. Run `npm i -g roughdraft@latest` to update.",
    );
  });

  it("does not add an update notice to JSON command output", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const exitCode = await runCli(
      ["open", documentPath, "--no-watch", "--json"],
      {
        ...test.deps,
        resolveUpdateStatus: async () => ({
          packageName: "roughdraft",
          currentVersion: "0.1.1",
          latestVersion: "0.1.3",
          updateAvailable: true,
          updateCommand: "npm i -g roughdraft@latest",
        }),
      },
    );
    const payload = parseOnlyJsonLog<{ opened: boolean }>(test.logs);

    expect(exitCode).toBe(0);
    expect(payload.opened).toBe(true);
  });

  it("keeps the original command result when the update check fails", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const exitCode = await runCli(["open", documentPath, "--no-watch"], {
      ...test.deps,
      resolveUpdateStatus: async () => {
        throw new Error("registry unavailable");
      },
    });

    expect(exitCode).toBe(0);
    expect(test.logs).not.toContain("registry unavailable");
  });

  it("reuses a connected document window before opening another browser window", async () => {
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    let postedOpenRequest: { path?: string; url?: string } | null = null;
    let lastOpenedUrl: string | null = null;
    const deps = createCliDependencies({
      env: {
        ...process.env,
        ROUGHDRAFT_STATE_DIR: stateDir,
      },
      cwd: projectDir,
      fetchImpl: async (input, init) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );

        if (
          url.pathname === "/api/status" &&
          url.port === String(ROUGHDRAFT_DEFAULT_PORT)
        ) {
          return new Response(
            JSON.stringify({
              backend: "local-files",
              port: ROUGHDRAFT_DEFAULT_PORT,
              projectDir,
              serverRoot,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        if (url.pathname === "/api/open-request" && init?.method === "POST") {
          postedOpenRequest = JSON.parse(String(init.body));
          return new Response(JSON.stringify({ delivered: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        throw new Error("connect ECONNREFUSED");
      },
      isProcessRunning: () => false,
      stopProcess: async () => {},
      spawnServerProcess: async () => {
        throw new Error("should not spawn");
      },
      openUrl: (url) => {
        lastOpenedUrl = url;
        return "browser";
      },
      log: () => {},
      error: () => {},
    });

    const exitCode = await runCli(["open", documentPath, "--no-watch"], deps);

    expect(exitCode).toBe(0);
    expect(postedOpenRequest).toEqual({
      path: documentPath,
      url: expectedOpenUrl(
        `http://localhost:${ROUGHDRAFT_DEFAULT_PORT}`,
        documentPath,
      ),
    });
    expect(lastOpenedUrl).toBeNull();
  });

  it("passes the session label to the existing window and puts it in the document URL", async () => {
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    let postedOpenRequest: Record<string, unknown> | null = null;
    const deps = createCliDependencies({
      env: {
        ...process.env,
        ROUGHDRAFT_STATE_DIR: stateDir,
      },
      cwd: projectDir,
      fetchImpl: async (input, init) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );

        if (
          url.pathname === "/api/status" &&
          url.port === String(ROUGHDRAFT_DEFAULT_PORT)
        ) {
          return new Response(
            JSON.stringify({
              backend: "local-files",
              port: ROUGHDRAFT_DEFAULT_PORT,
              projectDir,
              serverRoot,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        if (url.pathname === "/api/open-request" && init?.method === "POST") {
          postedOpenRequest = JSON.parse(String(init.body));
          return new Response(JSON.stringify({ delivered: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        throw new Error("connect ECONNREFUSED");
      },
      isProcessRunning: () => false,
      stopProcess: async () => {},
      spawnServerProcess: async () => {
        throw new Error("should not spawn");
      },
      openUrl: () => "browser",
      log: () => {},
      error: () => {},
    });

    const exitCode = await runCli(
      ["open", documentPath, "--no-watch", "--label", "build-15 (claude)"],
      deps,
    );

    expect(exitCode).toBe(0);
    expect(postedOpenRequest).toEqual({
      path: documentPath,
      url: expectedOpenUrl(
        `http://localhost:${ROUGHDRAFT_DEFAULT_PORT}`,
        documentPath,
        "build-15 (claude)",
      ),
      label: "build-15 (claude)",
    });
  });

  it("prints the document URL with the session label when asked for the URL only", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const exitCode = await runCli(
      ["open", documentPath, "--print-url", "--label", "build-15"],
      test.deps,
    );
    const persisted = JSON.parse(
      fs.readFileSync(getServerStateFilePath(test.deps.env), "utf8"),
    ) as { port: number };

    expect(exitCode).toBe(0);
    expect(test.logs).toEqual([
      expectedOpenUrl(
        `http://localhost:${persisted.port}`,
        documentPath,
        "build-15",
      ),
    ]);
    expect(test.getLastOpenedUrl()).toBeNull();
  });

  it("rejects a session label flag without a value", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const exitCode = await runCli(
      ["open", documentPath, "--no-watch", "--label"],
      test.deps,
    );

    expect(exitCode).toBe(2);
    expect(test.errors).toEqual(["--label requires a value."]);
    expect(test.getSpawnCount()).toBe(0);
  });

  it("opens the default browser on macOS when Chrome is installed but not the default browser", () => {
    const opened: Array<{ command: string; args: string[] }> = [];
    const openUrl = createDefaultOpenUrl({
      env: {},
      platform: "darwin",
      spawnSyncCommand: (command, args) => {
        if (command === "plutil") {
          expect(args?.join(" ")).toContain(
            "com.apple.launchservices.secure.plist",
          );
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                LSHandlerURLScheme: "http",
                LSHandlerRoleAll: "com.apple.Safari",
              },
            ]),
          } as ReturnType<typeof import("node:child_process").spawnSync>;
        }

        if (command === "open" && args?.[0] === "-Ra") {
          return {
            status: 0,
            stdout: "",
          } as ReturnType<typeof import("node:child_process").spawnSync>;
        }

        throw new Error(`unexpected spawnSync command ${command}`);
      },
      openDetachedCommand: (command, args) => {
        opened.push({ command, args });
      },
    });

    const mode = openUrl("http://localhost:4020/?file=draft.md");

    expect(mode).toBe("browser");
    expect(opened).toEqual([
      { command: "open", args: ["http://localhost:4020/?file=draft.md"] },
    ]);
  });

  it("opens a Chrome app window on macOS when Chrome is the default browser", () => {
    const opened: Array<{ command: string; args: string[] }> = [];
    const openUrl = createDefaultOpenUrl({
      env: {},
      platform: "darwin",
      spawnSyncCommand: (command, args) => {
        if (command === "plutil") {
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                LSHandlerURLScheme: "http",
                LSHandlerRoleAll: "com.google.Chrome",
              },
            ]),
          } as ReturnType<typeof import("node:child_process").spawnSync>;
        }

        if (command === "open" && args?.[0] === "-Ra") {
          return {
            status: 0,
            stdout: "",
          } as ReturnType<typeof import("node:child_process").spawnSync>;
        }

        throw new Error(`unexpected spawnSync command ${command}`);
      },
      openDetachedCommand: (command, args) => {
        opened.push({ command, args });
      },
    });

    const mode = openUrl("http://localhost:4020/?file=draft.md");

    expect(mode).toBe("chrome-app");
    expect(opened).toEqual([
      {
        command: "open",
        args: [
          "-na",
          "Google Chrome",
          "--args",
          "--app=http://localhost:4020/?file=draft.md",
        ],
      },
    ]);
  });

  it("opens the default browser on Windows without macOS browser detection", () => {
    const opened: Array<{ command: string; args: string[] }> = [];
    const openUrl = createDefaultOpenUrl({
      env: {},
      platform: "win32",
      spawnSyncCommand: () => {
        throw new Error("macOS browser detection should not run on Windows");
      },
      openDetachedCommand: (command, args) => {
        opened.push({ command, args });
      },
    });

    const mode = openUrl("http://localhost:4020/?file=draft.md");

    expect(mode).toBe("browser");
    expect(opened).toEqual([
      {
        command: "cmd",
        args: ["/c", "start", "", "http://localhost:4020/?file=draft.md"],
      },
    ]);
  });

  it("opens the default browser on Linux without macOS browser detection", () => {
    const opened: Array<{ command: string; args: string[] }> = [];
    const openUrl = createDefaultOpenUrl({
      env: {},
      platform: "linux",
      spawnSyncCommand: () => {
        throw new Error("macOS browser detection should not run on Linux");
      },
      openDetachedCommand: (command, args) => {
        opened.push({ command, args });
      },
    });

    const mode = openUrl("http://localhost:4020/?file=draft.md");

    expect(mode).toBe("browser");
    expect(opened).toEqual([
      {
        command: "xdg-open",
        args: ["http://localhost:4020/?file=draft.md"],
      },
    ]);
  });

  it("prints only the document URL from open --print-url", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const exitCode = await runCli(
      ["open", documentPath, "--print-url"],
      test.deps,
    );
    const persisted = JSON.parse(
      fs.readFileSync(getServerStateFilePath(test.deps.env), "utf8"),
    ) as { port: number };

    expect(exitCode).toBe(0);
    expect(test.logs).toEqual([
      expectedOpenUrl(`http://localhost:${persisted.port}`, documentPath),
    ]);
    expect(test.getLastOpenedUrl()).toBeNull();
  });

  it("emits JSON from open --no-watch --json without scraping human prose", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const exitCode = await runCli(
      ["open", documentPath, "--no-watch", "--json"],
      test.deps,
    );
    const persisted = JSON.parse(
      fs.readFileSync(getServerStateFilePath(test.deps.env), "utf8"),
    ) as { port: number };
    const payload = parseOnlyJsonLog<{
      opened: boolean;
      url: string;
      serverUrl: string;
      path: string;
      openMode: string;
    }>(test.logs);

    expect(exitCode).toBe(0);
    expect(payload).toEqual({
      opened: true,
      url: expectedOpenUrl(`http://localhost:${persisted.port}`, documentPath),
      serverUrl: `http://localhost:${persisted.port}`,
      path: documentPath,
      openMode: "disabled",
    });
  });

  it("prefers the live dev frontend URL when it matches this checkout", async () => {
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");
    fs.writeFileSync(
      devFrontendStateFile,
      `${JSON.stringify(
        {
          apiPort: 3000,
          appPort: 5173,
          mode: "full-dev",
          repoRoot: serverRoot,
          startedAt: new Date().toISOString(),
          url: "http://localhost:5173",
        },
        null,
        2,
      )}\n`,
    );

    let lastOpenedUrl: string | null = null;
    let spawnCount = 0;

    const deps = createCliDependencies({
      env: {
        ...process.env,
        ROUGHDRAFT_STATE_DIR: stateDir,
        ROUGHDRAFT_DEV_FRONTEND_STATE_FILE: devFrontendStateFile,
      },
      cwd: projectDir,
      fetchImpl: async (input, init) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );

        if (url.pathname === "/api/status" && url.port === "5173") {
          return new Response(
            JSON.stringify({
              backend: "local-files",
              projectDir,
              serverRoot,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        return fetch(input, init);
      },
      spawnServerProcess: async () => {
        spawnCount += 1;
        throw new Error("should not spawn");
      },
      isProcessRunning: (pid) => runningPids.has(pid),
      stopProcess: async (pid) => {
        const server = serverByPid.get(pid);
        if (server) {
          await server.close();
        }
        serverByPid.delete(pid);
        portByPid.delete(pid);
        runningPids.delete(pid);
      },
      openUrl: (url) => {
        lastOpenedUrl = url;
        return "disabled";
      },
      log: () => {},
      error: () => {},
    });

    const exitCode = await runCli(["open", documentPath, "--no-watch"], deps);

    expect(exitCode).toBe(0);
    expect(spawnCount).toBe(0);
    expect(lastOpenedUrl).toBe(
      expectedOpenUrl("http://localhost:5173", documentPath),
    );
  });

  it("posts the default open watcher to the dev API behind the live frontend", async () => {
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");
    fs.writeFileSync(
      devFrontendStateFile,
      `${JSON.stringify(
        {
          apiPort: 3000,
          appPort: 5173,
          mode: "full-dev",
          repoRoot: serverRoot,
          startedAt: new Date().toISOString(),
          url: "http://localhost:5173",
        },
        null,
        2,
      )}\n`,
    );

    let lastOpenedUrl: string | null = null;
    let watchUrl: string | null = null;
    let spawnCount = 0;

    const deps = createCliDependencies({
      env: {
        ...process.env,
        ROUGHDRAFT_STATE_DIR: stateDir,
        ROUGHDRAFT_DEV_FRONTEND_STATE_FILE: devFrontendStateFile,
      },
      cwd: projectDir,
      fetchImpl: async (input, _init) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );

        if (url.pathname === "/api/status" && url.port === "5173") {
          return new Response(
            JSON.stringify({
              backend: "local-files",
              port: 3000,
              projectDir,
              serverRoot,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        if (url.pathname === "/api/review-events/watch") {
          watchUrl = url.toString();
          return new Response(
            JSON.stringify({
              events: [{ documentPath, type: "review.completed" }],
              timedOut: false,
              nextSequence: 2,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        throw new Error(`Unexpected request: ${url.toString()}`);
      },
      spawnServerProcess: async () => {
        spawnCount += 1;
        throw new Error("should not spawn");
      },
      isProcessRunning: () => false,
      stopProcess: async () => {},
      openUrl: (url) => {
        lastOpenedUrl = url;
        return "disabled";
      },
      log: () => {},
      error: () => {},
      resolveUpdateStatus: noUpdateStatus,
    });

    const exitCode = await runCli(
      ["open", documentPath, "--json", "--batch-window", "0"],
      deps,
    );

    expect(exitCode).toBe(0);
    expect(spawnCount).toBe(0);
    expect(lastOpenedUrl).toBe(
      expectedOpenUrl("http://localhost:5173", documentPath),
    );
    expect(watchUrl).toBe("http://localhost:3000/api/review-events/watch");
  });

  it("falls back to the api server URL when the dev frontend hint is stale", async () => {
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");
    fs.writeFileSync(
      devFrontendStateFile,
      `${JSON.stringify(
        {
          apiPort: 3000,
          appPort: 5173,
          mode: "full-dev",
          repoRoot: serverRoot,
          startedAt: new Date().toISOString(),
          url: "http://localhost:5173",
        },
        null,
        2,
      )}\n`,
    );

    const test = createTestDependencies();
    const exitCode = await runCli(
      ["open", documentPath, "--no-watch"],
      test.deps,
    );
    const persisted = JSON.parse(
      fs.readFileSync(getServerStateFilePath(test.deps.env), "utf8"),
    ) as { port: number };

    expect(exitCode).toBe(0);
    expect(test.getSpawnCount()).toBe(1);
    expect(test.getLastOpenedUrl()).toBe(
      expectedOpenUrl(`http://localhost:${persisted.port}`, documentPath),
    );
  });

  it("uses the preview-web frontend URL when that workflow is active", async () => {
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");
    fs.writeFileSync(
      devFrontendStateFile,
      `${JSON.stringify(
        {
          apiPort: null,
          appPort: 5174,
          mode: "preview-web",
          repoRoot: serverRoot,
          startedAt: new Date().toISOString(),
          url: "http://localhost:5174",
        },
        null,
        2,
      )}\n`,
    );

    let lastOpenedUrl: string | null = null;
    let spawnCount = 0;

    const deps = createCliDependencies({
      env: {
        ...process.env,
        ROUGHDRAFT_STATE_DIR: stateDir,
        ROUGHDRAFT_DEV_FRONTEND_STATE_FILE: devFrontendStateFile,
      },
      cwd: projectDir,
      fetchImpl: async (input) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );

        if (url.href === "http://localhost:5174/") {
          return new Response("<!doctype html><html></html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          });
        }

        throw new Error("connect ECONNREFUSED");
      },
      spawnServerProcess: async () => {
        spawnCount += 1;
        throw new Error("should not spawn");
      },
      isProcessRunning: () => false,
      stopProcess: async () => {},
      openUrl: (url) => {
        lastOpenedUrl = url;
        return "disabled";
      },
      log: () => {},
      error: () => {},
    });

    const exitCode = await runCli(["open", documentPath, "--no-watch"], deps);

    expect(exitCode).toBe(0);
    expect(spawnCount).toBe(0);
    expect(lastOpenedUrl).toBe(
      expectedOpenUrl("http://localhost:5174", documentPath),
    );
  });

  it("rejects missing markdown files before opening", async () => {
    const test = createTestDependencies();
    const missingPath = path.join(projectDir, "missing.md");

    const exitCode = await runCli(["open", missingPath], test.deps);

    expect(exitCode).toBe(1);
    expect(test.getSpawnCount()).toBe(0);
    expect(test.errors).toContain(`Path not found: ${missingPath}`);
    expect(test.getLastOpenedUrl()).toBeNull();
  });

  it("stops the running server and removes persisted state", async () => {
    const test = createTestDependencies();

    await ensureServerRunning(test.deps, { projectDir });
    const stopExitCode = await runCli(["stop"], test.deps);
    const statusExitCode = await runCli(["status"], test.deps);

    expect(stopExitCode).toBe(0);
    expect(statusExitCode).toBe(1);
    expect(fs.existsSync(getServerStateFilePath(test.deps.env))).toBeFalsy();
    expect(test.logs).toContain(
      "Roughdraft is not running. Start it with `roughdraft start`.",
    );
  });

  it("returns successful JSON status when Roughdraft is not running", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["status", "--json"], test.deps);
    const payload = parseOnlyJsonLog<{
      running: boolean;
      stateFile: string;
    }>(test.logs);

    expect(exitCode).toBe(0);
    expect(payload).toEqual({
      running: false,
      stateFile: getServerStateFilePath(test.deps.env),
    });
  });

  it("emits JSON from status when Roughdraft is running", async () => {
    const test = createTestDependencies();
    const result = await ensureServerRunning(test.deps, { projectDir });

    const exitCode = await runCli(["status", "--json"], test.deps);
    const payload = parseOnlyJsonLog<{
      running: boolean;
      url: string;
      port: number;
      pid: number;
      startedAt: string;
      stateFile: string;
      managed: boolean;
    }>(test.logs);

    expect(exitCode).toBe(0);
    expect(payload).toEqual({
      running: true,
      url: result.server.url,
      port: result.server.port,
      pid: result.server.pid,
      startedAt: result.server.startedAt,
      stateFile: getServerStateFilePath(test.deps.env),
      managed: true,
      documents: [],
    });
  });

  describe("status naming the document", () => {
    const reviewedMarkdown = [
      "# Draft",
      "",
      'Intro {>>Needs a source<<}{id="c1" by="user" at="2026-09-06T00:00:00Z"}',
      '{>>Added one<<}{id="r1" by="AI" at="2026-09-06T00:01:00Z" re="c1"}',
      'Old {>>Fixed<<}{id="c2" by="user" at="2026-09-06T00:00:00Z" status="resolved"}',
      '{++new text++}{id="s1" by="user" at="2026-09-06T00:00:00Z"}',
      "",
    ].join("\n");

    // The case that split `status <path>` from the `threads-cleared` done
    // signal: the only comment is resolved, but its reply is not.
    const resolvedRootWithOpenReply = [
      "# Draft",
      "",
      'Intro {>>Needs a source<<}{id="c1" by="user" at="2026-09-06T00:00:00Z" status="resolved"}',
      '{>>Still waiting<<}{id="r1" by="AI" at="2026-09-06T00:01:00Z" re="c1"}',
      "",
    ].join("\n");

    // Binds a real port so a child process can reach the server; the CLI reads
    // `serverRoot` from `/api/status`, not the port this app was created with.
    async function startServerForSubprocess(): Promise<{
      port: number;
      close: () => Promise<void>;
    }> {
      const { app } = createApp({
        projectDir,
        serverRoot,
        staticDirPath: projectDir,
      });
      const httpServer = createHttpServer(app);
      await new Promise<void>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(0, "127.0.0.1", () => resolve());
      });
      const address = httpServer.address();
      if (typeof address !== "object" || address === null) {
        throw new Error("server did not report a port");
      }

      return {
        port: address.port,
        close: () =>
          new Promise<void>((resolve, reject) => {
            httpServer.closeAllConnections?.();
            httpServer.close((error) => (error ? reject(error) : resolve()));
          }),
      };
    }

    // Runs the CLI the way `bin/roughdraft.mjs` does — `runCli` in its own
    // process, exiting on its return code — over `src` through tsx, because
    // `pnpm check` runs the tests before `dist` exists. Async on purpose: the
    // server under test lives in this process, so a blocking spawn would
    // deadlock it.
    function runCliSubprocess(
      args: string[],
      env: NodeJS.ProcessEnv,
    ): Promise<{ code: number; stdout: string; stderr: string }> {
      const entryPath = path.join(tempDir, "cli-subprocess-entry.mts");
      fs.writeFileSync(
        entryPath,
        [
          `import { runCli } from ${JSON.stringify(
            pathToFileURL(fileURLToPath(new URL("./cli.ts", import.meta.url)))
              .href,
          )};`,
          "process.exit(await runCli(process.argv.slice(2)));",
          "",
        ].join("\n"),
      );

      return new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", entryPath, ...args],
          { cwd: serverRoot, env, stdio: ["ignore", "pipe", "pipe"] },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.once("error", reject);
        child.once("close", (code) =>
          resolve({ code: code ?? -1, stdout, stderr }),
        );
      });
    }

    // Stands in for a browser tab: the app subscribes to /api/open-requests
    // with the path it has open and the label it was opened with.
    async function subscribeTab(
      port: number,
      documentPath: string,
      sessionLabel?: string,
    ) {
      const url = new URL(`http://127.0.0.1:${port}/api/open-requests`);
      url.searchParams.set("path", documentPath);
      if (sessionLabel) url.searchParams.set("label", sessionLabel);
      const stream = await fetch(url);
      const reader = stream.body?.getReader();
      if (!reader) throw new Error("open-requests stream has no body");
      await reader.read();
      return { cancel: () => reader.cancel() };
    }

    async function saveThroughTab(
      port: number,
      documentPath: string,
      content: string,
    ) {
      const query = new URLSearchParams({
        projectPath: path.dirname(documentPath),
        path: path.basename(documentPath),
      });
      const response = await fetch(
        `http://127.0.0.1:${port}/api/markdown-file?${query}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        },
      );
      expect(response.status).toBe(200);
    }

    it("names each open document and its session, or says no label was given", async () => {
      const test = createTestDependencies();
      const labeledPath = path.join(projectDir, "labeled.md");
      const unlabeledPath = path.join(projectDir, "unlabeled.md");
      fs.writeFileSync(labeledPath, "# Labeled\n");
      fs.writeFileSync(unlabeledPath, "# Unlabeled\n");
      const result = await ensureServerRunning(test.deps, { projectDir });
      const labeledTab = await subscribeTab(
        result.server.port,
        labeledPath,
        "build-16",
      );
      const unlabeledTab = await subscribeTab(
        result.server.port,
        unlabeledPath,
      );

      try {
        const exitCode = await runCli(["status"], test.deps);

        expect(exitCode).toBe(0);
        expect(test.logs).toEqual([
          `Roughdraft is running at ${result.server.url}`,
          `PID: ${result.server.pid}`,
          `Started: ${result.server.startedAt}`,
          `State file: ${getServerStateFilePath(test.deps.env)}`,
          `Document: ${labeledPath}`,
          "Session: build-16",
          `Document: ${unlabeledPath}`,
          "Session: no label given",
        ]);
      } finally {
        await labeledTab.cancel();
        await unlabeledTab.cancel();
      }
    });

    it("says no document is open when no tab has one", async () => {
      const test = createTestDependencies();
      await ensureServerRunning(test.deps, { projectDir });

      const exitCode = await runCli(["status"], test.deps);

      expect(exitCode).toBe(0);
      expect(test.logs).toContain("Document: none open");
      expect(test.logs.some((line) => line.startsWith("Session:"))).toBe(false);
    });

    it("carries the open documents in status --json", async () => {
      const test = createTestDependencies();
      const documentPath = path.join(projectDir, "draft.md");
      fs.writeFileSync(documentPath, "# Draft\n");
      const result = await ensureServerRunning(test.deps, { projectDir });
      const tab = await subscribeTab(
        result.server.port,
        documentPath,
        "build-16",
      );

      try {
        const exitCode = await runCli(["status", "--json"], test.deps);
        const payload = parseOnlyJsonLog<{
          running: boolean;
          documents: unknown[];
        }>(test.logs);

        expect(exitCode).toBe(0);
        expect(payload.running).toBe(true);
        expect(payload.documents).toEqual([
          {
            path: documentPath,
            sessionLabel: "build-16",
            openedAt: expect.any(String),
            lastSavedAt: null,
          },
        ]);
      } finally {
        await tab.cancel();
      }
    });

    it("reports open threads and the last save for an open document", async () => {
      const test = createTestDependencies();
      const documentPath = path.join(projectDir, "draft.md");
      fs.writeFileSync(documentPath, "# Draft\n");
      const result = await ensureServerRunning(test.deps, { projectDir });
      const tab = await subscribeTab(
        result.server.port,
        documentPath,
        "build-16",
      );

      try {
        const before = Date.now();
        await saveThroughTab(
          result.server.port,
          documentPath,
          reviewedMarkdown,
        );

        const exitCode = await runCli(["status", documentPath], test.deps);

        expect(exitCode).toBe(0);
        const lastSaveLine = test.logs.find((line) =>
          line.startsWith("Last save: "),
        );
        expect(lastSaveLine).toBeDefined();
        expect(
          Date.parse(lastSaveLine?.slice("Last save: ".length) ?? ""),
        ).toBeGreaterThanOrEqual(before - 1000);
        expect(test.logs).toEqual([
          `Roughdraft is running at ${result.server.url}`,
          `PID: ${result.server.pid}`,
          `Started: ${result.server.startedAt}`,
          `State file: ${getServerStateFilePath(test.deps.env)}`,
          `Document: ${documentPath}`,
          "Session: build-16",
          expect.stringMatching(/^Opened: \d{4}-/),
          lastSaveLine,
          "Open threads: 3 (c1, r1, s1)",
        ]);
      } finally {
        await tab.cancel();
      }
    });

    it("reports no save since the document was opened and zero open threads", async () => {
      const test = createTestDependencies();
      const documentPath = path.join(projectDir, "draft.md");
      fs.writeFileSync(documentPath, "# Draft\n");
      const result = await ensureServerRunning(test.deps, { projectDir });
      const tab = await subscribeTab(result.server.port, documentPath);

      try {
        const exitCode = await runCli(["status", documentPath], test.deps);

        expect(exitCode).toBe(0);
        expect(test.logs).toContain("Session: no label given");
        expect(test.logs).toContain("Last save: none since opened");
        expect(test.logs).toContain("Open threads: 0");
      } finally {
        await tab.cancel();
      }
    });

    it("carries the document's threads and last save in status <path> --json", async () => {
      const test = createTestDependencies();
      const documentPath = path.join(projectDir, "draft.md");
      fs.writeFileSync(documentPath, "# Draft\n");
      const result = await ensureServerRunning(test.deps, { projectDir });
      const tab = await subscribeTab(
        result.server.port,
        documentPath,
        "build-16",
      );

      try {
        await saveThroughTab(
          result.server.port,
          documentPath,
          reviewedMarkdown,
        );

        const exitCode = await runCli(
          ["status", documentPath, "--json"],
          test.deps,
        );
        const payload = parseOnlyJsonLog<{
          running: boolean;
          url: string;
          document: Record<string, unknown>;
        }>(test.logs);

        expect(exitCode).toBe(0);
        expect(payload).toMatchObject({
          running: true,
          url: result.server.url,
          document: {
            path: documentPath,
            open: true,
            sessionLabel: "build-16",
            openedAt: expect.any(String),
            lastSavedAt: expect.any(String),
            tabs: [{ sessionLabel: "build-16", openedAt: expect.any(String) }],
            openThreads: { count: 3, ids: ["c1", "r1", "s1"] },
            threadsError: null,
          },
        });
        expect(payload).not.toHaveProperty("documents");
      } finally {
        await tab.cancel();
      }
    });

    it("says clearly when the path is not open", async () => {
      const test = createTestDependencies();
      const documentPath = path.join(projectDir, "draft.md");
      const otherPath = path.join(projectDir, "other.md");
      fs.writeFileSync(documentPath, "# Draft\n");
      fs.writeFileSync(otherPath, "# Other\n");
      const result = await ensureServerRunning(test.deps, { projectDir });
      const tab = await subscribeTab(result.server.port, otherPath);

      try {
        const exitCode = await runCli(["status", documentPath], test.deps);

        expect(exitCode).toBe(1);
        expect(test.logs).toContain(
          `${documentPath} is not open in Roughdraft.`,
        );
        expect(test.logs.some((line) => line.startsWith("Open threads"))).toBe(
          false,
        );

        test.logs.length = 0;
        const jsonExitCode = await runCli(
          ["status", documentPath, "--json"],
          test.deps,
        );
        const payload = parseOnlyJsonLog<{
          running: boolean;
          document: Record<string, unknown>;
        }>(test.logs);

        expect(jsonExitCode).toBe(0);
        expect(payload.running).toBe(true);
        expect(payload.document).toEqual({ path: documentPath, open: false });
      } finally {
        await tab.cancel();
      }
    });

    it("reports the path as not open when Roughdraft is not running", async () => {
      const test = createTestDependencies();
      const documentPath = path.join(projectDir, "draft.md");

      const exitCode = await runCli(["status", documentPath], test.deps);
      expect(exitCode).toBe(1);
      expect(test.logs).toContain(
        "Roughdraft is not running. Start it with `roughdraft start`.",
      );

      test.logs.length = 0;
      const jsonExitCode = await runCli(
        ["status", documentPath, "--json"],
        test.deps,
      );
      const payload = parseOnlyJsonLog<Record<string, unknown>>(test.logs);

      expect(jsonExitCode).toBe(0);
      expect(payload).toEqual({
        running: false,
        stateFile: getServerStateFilePath(test.deps.env),
        document: { path: documentPath, open: false },
      });
    });

    it("counts an unresolved reply under a resolved comment, as the review loop does", async () => {
      const test = createTestDependencies();
      const documentPath = path.join(projectDir, "draft.md");
      fs.writeFileSync(documentPath, "# Draft\n");
      const result = await ensureServerRunning(test.deps, { projectDir });
      const tab = await subscribeTab(
        result.server.port,
        documentPath,
        "build-16",
      );

      try {
        await saveThroughTab(
          result.server.port,
          documentPath,
          resolvedRootWithOpenReply,
        );

        const exitCode = await runCli(["status", documentPath], test.deps);
        const query = new URLSearchParams({
          projectPath: path.dirname(documentPath),
          path: path.basename(documentPath),
        });
        const reviewIndexResponse = await fetch(
          `http://127.0.0.1:${result.server.port}/api/review-index?${query}`,
        );
        const reviewIndex = (await reviewIndexResponse.json()) as {
          summary: { unresolved: number };
        };

        expect(exitCode).toBe(0);
        // The number `threads-cleared` reads, so the two must not disagree.
        expect(reviewIndex.summary.unresolved).toBe(1);
        expect(test.logs).toContain("Open threads: 1 (r1)");
      } finally {
        await tab.cancel();
      }
    });

    it("names every tab when several hold the same path", async () => {
      const test = createTestDependencies();
      const documentPath = path.join(projectDir, "draft.md");
      fs.writeFileSync(documentPath, "# Draft\n");
      const result = await ensureServerRunning(test.deps, { projectDir });
      const labeledTab = await subscribeTab(
        result.server.port,
        documentPath,
        "build-16",
      );
      const plainTab = await subscribeTab(result.server.port, documentPath);

      try {
        const exitCode = await runCli(["status", documentPath], test.deps);

        expect(exitCode).toBe(0);
        expect(test.logs).toContain("Session: no label given");
        expect(
          test.logs.some((line) =>
            line.startsWith("Also open in: build-16 (opened "),
          ),
        ).toBe(true);

        test.logs.length = 0;
        const jsonExitCode = await runCli(
          ["status", documentPath, "--json"],
          test.deps,
        );
        const payload = parseOnlyJsonLog<{
          document: { tabs: Array<{ sessionLabel: string | null }> };
        }>(test.logs);

        expect(jsonExitCode).toBe(0);
        expect(payload.document.tabs.map((tab) => tab.sessionLabel)).toEqual([
          "build-16",
          null,
        ]);
      } finally {
        await labeledTab.cancel();
        await plainTab.cancel();
      }
    });

    it("reports a review index it cannot read instead of crashing", async () => {
      const test = createTestDependencies();
      const documentPath = path.join(projectDir, "draft.md");
      fs.writeFileSync(documentPath, "# Draft\n");
      const result = await ensureServerRunning(test.deps, { projectDir });
      const tab = await subscribeTab(
        result.server.port,
        documentPath,
        "build-16",
      );

      try {
        fs.renameSync(documentPath, path.join(projectDir, "renamed.md"));

        const exitCode = await runCli(["status", documentPath], test.deps);

        expect(exitCode).toBe(1);
        expect(test.errors).toContain(
          `Could not read the review index for ${documentPath}: the server answered 404`,
        );
        expect(test.logs.some((line) => line.startsWith("Open threads"))).toBe(
          false,
        );

        test.logs.length = 0;
        const jsonExitCode = await runCli(
          ["status", documentPath, "--json"],
          test.deps,
        );
        const payload = parseOnlyJsonLog<{
          running: boolean;
          document: Record<string, unknown>;
        }>(test.logs);

        expect(jsonExitCode).toBe(1);
        expect(payload.running).toBe(true);
        expect(payload.document).toMatchObject({
          path: documentPath,
          open: true,
          sessionLabel: "build-16",
          openThreads: null,
          threadsError: "the server answered 404",
        });
      } finally {
        await tab.cancel();
      }
    });

    it(
      "prints status and status <path> from the real CLI subprocess",
      async () => {
        const documentPath = path.join(projectDir, "draft.md");
        fs.writeFileSync(documentPath, reviewedMarkdown);
        const server = await startServerForSubprocess();
        const stateEnv = {
          ...process.env,
          ROUGHDRAFT_STATE_DIR: stateDir,
          ROUGHDRAFT_DEV_FRONTEND_STATE_FILE: devFrontendStateFile,
        };
        const stateFilePath = getServerStateFilePath(stateEnv);
        fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
        fs.writeFileSync(
          stateFilePath,
          `${JSON.stringify({
            port: server.port,
            // This process is running, which is what the CLI checks.
            pid: process.pid,
            startedAt: new Date().toISOString(),
            url: `http://${ROUGHDRAFT_PUBLIC_HOST}:${server.port}`,
          })}\n`,
        );
        const tab = await subscribeTab(
          server.port,
          documentPath,
          "subprocess-probe",
        );

        try {
          const status = await runCliSubprocess(["status"], stateEnv);

          expect(status.stderr).toBe("");
          expect(status.code).toBe(0);
          expect(status.stdout.split("\n")).toEqual(
            expect.arrayContaining([
              `Roughdraft is running at http://${ROUGHDRAFT_PUBLIC_HOST}:${server.port}`,
              `PID: ${process.pid}`,
              `Document: ${documentPath}`,
              "Session: subprocess-probe",
            ]),
          );

          const documentStatus = await runCliSubprocess(
            ["status", documentPath],
            stateEnv,
          );

          expect(documentStatus.stderr).toBe("");
          expect(documentStatus.code).toBe(0);
          expect(documentStatus.stdout.split("\n")).toEqual(
            expect.arrayContaining([
              `Document: ${documentPath}`,
              "Session: subprocess-probe",
              "Last save: none since opened",
              "Open threads: 3 (c1, r1, s1)",
            ]),
          );
        } finally {
          await tab.cancel();
          await server.close();
        }
      },
      SUBPROCESS_TEST_TIMEOUT_MS,
    );

    it("rejects more than one path", async () => {
      const test = createTestDependencies();

      const exitCode = await runCli(["status", "a.md", "b.md"], test.deps);

      expect(exitCode).toBe(2);
      expect(test.errors).toEqual([
        "Usage: roughdraft status [<path>] [--json]",
      ]);
    });
  });

  it("prints watch and mcp in top-level help", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["--help"], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs.join("\n")).toContain("watch <path>");
    expect(test.logs.join("\n")).toContain("mcp");
  });

  it("waits for a review completed event from watch --json", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const watchPromise = runCli(
      [
        "watch",
        documentPath,
        "--json",
        "--timeout",
        "2",
        "--batch-window",
        "0",
      ],
      test.deps,
    );

    let persisted: { port: number } | null = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const stateFile = getServerStateFilePath(test.deps.env);
      if (fs.existsSync(stateFile)) {
        persisted = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
          port: number;
        };
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(persisted).not.toBeNull();
    await fetch(`http://localhost:${persisted?.port}/api/review-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectPath: projectDir,
        path: "draft.md",
        overallComment: "Please prioritize the CLI contract.",
      }),
    });

    const exitCode = await watchPromise;
    const payload = parseOnlyJsonLog<{
      timedOut: boolean;
      events: Array<{
        documentPath: string;
        overallComment?: string;
        type: string;
      }>;
    }>(test.logs);

    expect(exitCode).toBe(0);
    expect(payload.timedOut).toBe(false);
    expect(payload.events).toHaveLength(1);
    expect(payload.events[0]).toMatchObject({
      documentPath,
      overallComment: "Please prioritize the CLI contract.",
      type: "review.completed",
    });
  });

  it("opens a document and waits for the next review event by default from open --json", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");
    let watchRequestBody: {
      timeoutSeconds?: number;
      batchWindowSeconds?: number;
    } | null = null;
    const deps = {
      ...test.deps,
      fetchImpl: async (input: Parameters<typeof fetch>[0], init) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );
        if (
          url.pathname === "/api/review-events/watch" &&
          typeof init?.body === "string"
        ) {
          watchRequestBody = JSON.parse(init.body) as {
            timeoutSeconds?: number;
            batchWindowSeconds?: number;
          };
        }
        return test.deps.fetchImpl(input, init);
      },
    };

    const watchPromise = runCli(
      ["open", documentPath, "--json", "--batch-window", "0"],
      deps,
    );

    let persisted: { port: number } | null = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const stateFile = getServerStateFilePath(test.deps.env);
      if (fs.existsSync(stateFile)) {
        persisted = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
          port: number;
        };
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(persisted).not.toBeNull();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (watchRequestBody) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(watchRequestBody).toMatchObject({
      batchWindowSeconds: 0,
    });
    // Watch requests poll in bounded segments (priming poll at 0, then
    // segments capped at 240s); the capture holds whichever arrived last.
    expect(typeof watchRequestBody?.timeoutSeconds).toBe("number");
    expect(watchRequestBody?.timeoutSeconds).toBeLessThanOrEqual(240);
    await fetch(`http://localhost:${persisted?.port}/api/review-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectPath: projectDir, path: "draft.md" }),
    });

    const exitCode = await watchPromise;
    const payload = parseOnlyJsonLog<{
      timedOut: boolean;
      events: Array<{ documentPath: string; type: string }>;
    }>(test.logs);

    expect(exitCode).toBe(0);
    expect(test.getLastOpenedUrl()).toContain(encodeURIComponent(documentPath));
    expect(payload).toMatchObject({
      timedOut: false,
      events: [
        {
          documentPath,
          type: "review.completed",
        },
      ],
    });
  });

  // Resolves once the CLI's watch is registered on the server, not merely once
  // the server is up: a Done Reviewing posted before the priming watch poll is
  // excluded by its fromNow cursor, and the open would then wait forever.
  async function waitForPersistedPort(env: NodeJS.ProcessEnv): Promise<number> {
    let port: number | null = null;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const stateFile = getServerStateFilePath(env);
      if (port === null && fs.existsSync(stateFile)) {
        port = (
          JSON.parse(fs.readFileSync(stateFile, "utf8")) as { port: number }
        ).port;
      }
      if (port !== null) {
        const params = new URLSearchParams({
          projectPath: projectDir,
          path: "draft.md",
        });
        const status = (await (
          await fetch(
            `http://localhost:${port}/api/review-events/status?${params.toString()}`,
          )
        ).json()) as { watching?: boolean };
        if (status.watching) return port;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("the CLI never registered a review watcher");
  }

  async function submitDoneReviewing(
    port: number,
    body: { overallComment?: string },
  ) {
    const response = await fetch(`http://localhost:${port}/api/review-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectPath: projectDir,
        path: "draft.md",
        ...body,
      }),
    });
    expect(response.status).toBe(201);
  }

  interface LoopPayload {
    timedOut: boolean;
    done: boolean;
    doneReason: string | null;
    events: Array<{ done: boolean; doneReason: string | null }>;
  }

  const OPEN_THREAD_DRAFT = [
    "# Draft",
    "",
    'Needs {==support==}{>>Add a source<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}.',
    "",
  ].join("\n");

  it("reports done from open --loop --json when the overall comment says done", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, OPEN_THREAD_DRAFT);

    const openPromise = runCli(
      ["open", documentPath, "--loop", "--json", "--batch-window", "0"],
      test.deps,
    );
    const port = await waitForPersistedPort(test.deps.env);
    await submitDoneReviewing(port, { overallComment: "Done, thanks!" });

    const exitCode = await openPromise;
    const payload = parseOnlyJsonLog<LoopPayload>(test.logs);

    expect(exitCode).toBe(0);
    expect(payload).toMatchObject({
      timedOut: false,
      done: true,
      doneReason: "overall-comment",
      events: [{ done: true, doneReason: "overall-comment" }],
    });
  });

  it("reports done from open --loop --json when every thread is cleared", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n\nClean prose.\n");

    const openPromise = runCli(
      ["open", documentPath, "--loop", "--json", "--batch-window", "0"],
      test.deps,
    );
    const port = await waitForPersistedPort(test.deps.env);
    await submitDoneReviewing(port, {});

    const exitCode = await openPromise;
    const payload = parseOnlyJsonLog<LoopPayload>(test.logs);

    expect(exitCode).toBe(0);
    expect(payload).toMatchObject({
      timedOut: false,
      done: true,
      doneReason: "threads-cleared",
    });
  });

  it("reports the loop continuing from open --loop --json when threads stay open", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, OPEN_THREAD_DRAFT);

    const openPromise = runCli(
      ["open", documentPath, "--loop", "--json", "--batch-window", "0"],
      test.deps,
    );
    const port = await waitForPersistedPort(test.deps.env);
    await submitDoneReviewing(port, {
      overallComment: "Please prioritize the CLI contract.",
    });

    const exitCode = await openPromise;
    const payload = parseOnlyJsonLog<LoopPayload>(test.logs);

    expect(exitCode).toBe(0);
    expect(payload).toMatchObject({
      timedOut: false,
      done: false,
      doneReason: null,
      events: [{ done: false, doneReason: null }],
    });
  });

  it("does not add done fields to open --json output without --loop", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const openPromise = runCli(
      ["open", documentPath, "--json", "--batch-window", "0"],
      test.deps,
    );
    const port = await waitForPersistedPort(test.deps.env);
    await submitDoneReviewing(port, {});

    await openPromise;
    const payload = parseOnlyJsonLog<Record<string, unknown>>(test.logs);

    expect(payload).not.toHaveProperty("done");
    expect(payload).not.toHaveProperty("doneReason");
  });

  it("prints the done-signal in human output from open --loop", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, OPEN_THREAD_DRAFT);

    const openPromise = runCli(
      ["open", documentPath, "--loop", "--batch-window", "0"],
      test.deps,
    );
    const port = await waitForPersistedPort(test.deps.env);
    await submitDoneReviewing(port, { overallComment: "lgtm" });

    const exitCode = await openPromise;

    expect(exitCode).toBe(0);
    expect(test.logs).toContain(`Review completed for ${documentPath}.`);
    expect(test.logs).toContain(
      "Reviewer signaled done: the overall comment says the review is done.",
    );
  });

  it("prints the open thread count in human output from open --loop when the loop continues", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, OPEN_THREAD_DRAFT);

    const openPromise = runCli(
      ["open", documentPath, "--loop", "--batch-window", "0"],
      test.deps,
    );
    const port = await waitForPersistedPort(test.deps.env);
    await submitDoneReviewing(port, {});

    const exitCode = await openPromise;

    expect(exitCode).toBe(0);
    expect(test.logs).toContain(
      "Review continues: 1 item(s) still open and no done-signal. Act on the feedback and reopen the document.",
    );
  });

  it("reports the loop continuing from open --loop --json when the watch times out", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const exitCode = await runCli(
      [
        "open",
        documentPath,
        "--loop",
        "--json",
        "--timeout",
        "0.2",
        "--batch-window",
        "0",
      ],
      test.deps,
    );
    const payload = parseOnlyJsonLog<LoopPayload>(test.logs);

    expect(exitCode).toBe(1);
    expect(payload).toMatchObject({
      timedOut: true,
      done: false,
      doneReason: null,
    });
  });

  it("rejects --loop together with --no-watch or --print-url", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    expect(
      await runCli(["open", documentPath, "--loop", "--no-watch"], test.deps),
    ).toBe(2);
    expect(
      await runCli(["open", documentPath, "--loop", "--print-url"], test.deps),
    ).toBe(2);
    expect(test.errors).toEqual([
      "Use either --loop or --no-watch, not both.",
      "Use either --loop or --print-url, not both.",
    ]);
  });

  it("rejects --loop on the watch command", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const exitCode = await runCli(["watch", documentPath, "--loop"], test.deps);

    expect(exitCode).toBe(2);
    expect(test.errors).toEqual(["Unknown flag: --loop"]);
  });

  it("documents --loop in open help", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["open", "--help"], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs).toContain(
      "  roughdraft open <path> [--label <text>] [--no-open] [--no-watch] [--loop] [--print-url] [--port <port>]",
    );
    expect(test.logs.join("\n")).toContain("  --loop ");
  });

  interface WatchScriptResponse {
    events: unknown[];
    timedOut: boolean;
    nextSequence: number;
    instanceId?: string;
  }

  function createWatchScriptTest(
    script: Array<Error | WatchScriptResponse>,
    envOverrides: NodeJS.ProcessEnv = {},
    // Scripted /api/status answers, one per call; the last entry repeats. An
    // Error entry is a refused connection. Empty means a plain running server.
    statusScript: Array<string | Error> = [],
  ) {
    const logs: string[] = [];
    const errors: string[] = [];
    const sleeps: number[] = [];
    const requests: Array<{
      timeoutSeconds?: number;
      afterSequence?: number;
      fromNow?: boolean;
    }> = [];
    const remaining = [...script];
    const statusRemaining = [...statusScript];

    const deps = createCliDependencies({
      env: {
        ...process.env,
        ROUGHDRAFT_STATE_DIR: stateDir,
        ...envOverrides,
      },
      cwd: projectDir,
      fetchImpl: async (input, init) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );

        if (url.pathname === "/api/status") {
          const scripted =
            statusRemaining.length > 1
              ? statusRemaining.shift()
              : statusRemaining[0];
          if (scripted instanceof Error) {
            throw scripted;
          }
          return new Response(
            JSON.stringify({
              backend: "local-files",
              port: Number.parseInt(url.port || "80", 10),
              projectDir,
              serverRoot,
              ...(scripted ? { instanceId: scripted } : {}),
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        if (url.pathname === "/api/review-events/watch") {
          if (typeof init?.body === "string") {
            requests.push(JSON.parse(init.body) as (typeof requests)[number]);
          }
          const next = remaining.shift();
          if (!next) {
            throw new Error("watch script exhausted: unexpected extra request");
          }
          if (next instanceof Error) {
            throw next;
          }
          return new Response(JSON.stringify(next), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        throw new Error(`Unexpected request in watch test: ${url.pathname}`);
      },
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
      isProcessRunning: () => false,
      stopProcess: async () => {},
      spawnServerProcess: async () => {
        throw new Error("should not spawn");
      },
      openUrl: () => "disabled",
      resolveUpdateStatus: noUpdateStatus,
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
    });

    return { deps, logs, errors, requests, sleeps };
  }

  function connectionLost(code: string): TypeError {
    return Object.assign(new TypeError("fetch failed"), { cause: { code } });
  }

  it("keeps an untimed watch alive across undici header-timeout rejections until the review completes", async () => {
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");
    const test = createWatchScriptTest([
      { events: [], timedOut: true, nextSequence: 41 },
      Object.assign(new TypeError("fetch failed"), {
        cause: { code: "UND_ERR_HEADERS_TIMEOUT" },
      }),
      {
        events: [{ documentPath, type: "review.completed" }],
        timedOut: false,
        nextSequence: 43,
      },
    ]);

    const exitCode = await runCli(["watch", documentPath], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs.join("\n")).toContain("Review completed");
  });

  it("sends a bounded timeoutSeconds on every untimed watch request", async () => {
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");
    const test = createWatchScriptTest([
      { events: [], timedOut: true, nextSequence: 1 },
      {
        events: [{ documentPath, type: "review.completed" }],
        timedOut: false,
        nextSequence: 2,
      },
    ]);

    await runCli(["watch", documentPath], test.deps);

    expect(test.requests.length).toBeGreaterThan(0);
    for (const body of test.requests) {
      expect(typeof body.timeoutSeconds).toBe("number");
      expect(body.timeoutSeconds).toBeLessThanOrEqual(240);
    }
  });

  it("honors ROUGHDRAFT_WATCH_SEGMENT_SECONDS as the watch segment bound", async () => {
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");
    const test = createWatchScriptTest(
      [
        { events: [], timedOut: true, nextSequence: 1 },
        {
          events: [{ documentPath, type: "review.completed" }],
          timedOut: false,
          nextSequence: 2,
        },
      ],
      { ROUGHDRAFT_WATCH_SEGMENT_SECONDS: "30" },
    );

    await runCli(["watch", documentPath], test.deps);

    expect(test.requests.length).toBeGreaterThan(0);
    for (const body of test.requests) {
      expect(typeof body.timeoutSeconds).toBe("number");
      expect(body.timeoutSeconds).toBeLessThanOrEqual(30);
    }
  });

  it("resumes each watch segment from the previous nextSequence so no events are lost", async () => {
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");
    const test = createWatchScriptTest([
      { events: [], timedOut: true, nextSequence: 7 },
      { events: [], timedOut: true, nextSequence: 9 },
      {
        events: [{ documentPath, type: "review.completed" }],
        timedOut: false,
        nextSequence: 12,
      },
    ]);

    const exitCode = await runCli(["watch", documentPath], test.deps);

    expect(exitCode).toBe(0);
    // A response's nextSequence is the next unassigned sequence, and the
    // server delivers events with sequence > afterSequence, so the resume
    // cursor must be nextSequence - 1 — a cursor of nextSequence itself would
    // skip the event assigned that number after the previous segment returned.
    expect(test.requests.slice(1).map((body) => body.afterSequence)).toEqual([
      6, 8,
    ]);
  });

  it("still crashes when an untimed watch hits a non-timeout fetch error", async () => {
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");
    const test = createWatchScriptTest([
      Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ECONNREFUSED" },
      }),
    ]);

    await expect(runCli(["watch", documentPath], test.deps)).rejects.toThrow(
      "fetch failed",
    );
  });

  it("reconnects an established watch to a restarted server and re-primes on the new instance", async () => {
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");
    const test = createWatchScriptTest(
      [
        { events: [], timedOut: true, nextSequence: 5 },
        connectionLost("UND_ERR_SOCKET"),
        { events: [], timedOut: true, nextSequence: 1 },
        {
          events: [{ documentPath, type: "review.completed" }],
          timedOut: false,
          nextSequence: 2,
        },
      ],
      {},
      // ensureServerRunning, the watch's own instance read, two refused
      // probes while the server is down, then the replacement answers.
      [
        "instance-a",
        "instance-a",
        connectionLost("ECONNREFUSED"),
        connectionLost("ECONNREFUSED"),
        "instance-b",
      ],
    );

    const exitCode = await runCli(["watch", documentPath], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs.join("\n")).toContain("Review completed");
    // The replacement's queue starts over, so the old cursor is dropped and
    // the watch primes again from now.
    expect(test.requests[2]).toMatchObject({
      fromNow: true,
      timeoutSeconds: 0,
    });
    expect(test.requests[3]).toMatchObject({
      fromNow: false,
      afterSequence: 0,
    });
    expect(test.sleeps).toEqual([2000, 2000]);
    expect(test.errors.join("\n")).toContain("stopped during the review");
    expect(test.errors.join("\n")).toContain("Reconnected");
  });

  it("resumes the same server's cursor when a watch segment drops without a restart", async () => {
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");
    const test = createWatchScriptTest(
      [
        { events: [], timedOut: true, nextSequence: 5 },
        connectionLost("ECONNRESET"),
        {
          events: [{ documentPath, type: "review.completed" }],
          timedOut: false,
          nextSequence: 6,
        },
      ],
      {},
      ["instance-a"],
    );

    const exitCode = await runCli(["watch", documentPath], test.deps);

    expect(exitCode).toBe(0);
    expect(test.requests[2]).toMatchObject({
      fromNow: false,
      afterSequence: 4,
    });
  });

  it("resumes the cursor after a drop when the server's instance was never learned", async () => {
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");
    const test = createWatchScriptTest(
      [
        { events: [], timedOut: true, nextSequence: 5 },
        connectionLost("ECONNRESET"),
        {
          events: [{ documentPath, type: "review.completed" }],
          timedOut: false,
          nextSequence: 6,
        },
      ],
      {},
      // ensureServerRunning answers, the watch's own instance read fails, and
      // the priming poll carries no id either, so the server stays unknown.
      ["instance-a", connectionLost("ECONNREFUSED"), "instance-a"],
    );

    const exitCode = await runCli(["watch", documentPath], test.deps);

    expect(exitCode).toBe(0);
    expect(test.requests[2]).toMatchObject({
      fromNow: false,
      afterSequence: 4,
    });
    expect(test.errors.join("\n")).toContain("resuming the watch");
  });

  it("learns the server's instance from the priming poll when the status read failed", async () => {
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");
    const test = createWatchScriptTest(
      [
        {
          events: [],
          timedOut: true,
          nextSequence: 5,
          instanceId: "instance-a",
        },
        connectionLost("UND_ERR_SOCKET"),
        { events: [], timedOut: true, nextSequence: 1 },
        {
          events: [{ documentPath, type: "review.completed" }],
          timedOut: false,
          nextSequence: 2,
        },
      ],
      {},
      ["instance-a", connectionLost("ECONNREFUSED"), "instance-b"],
    );

    const exitCode = await runCli(["watch", documentPath], test.deps);

    expect(exitCode).toBe(0);
    expect(test.requests[2]).toMatchObject({
      fromNow: true,
      timeoutSeconds: 0,
    });
    expect(test.requests[3]).toMatchObject({
      fromNow: false,
      afterSequence: 0,
    });
  });

  it("reports clearly and exits 1 when the server does not come back", async () => {
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");
    const test = createWatchScriptTest(
      [
        { events: [], timedOut: true, nextSequence: 5 },
        connectionLost("ECONNREFUSED"),
      ],
      { ROUGHDRAFT_WATCH_RECONNECT_SECONDS: "6" },
      ["instance-a", "instance-a", connectionLost("ECONNREFUSED")],
    );

    const exitCode = await runCli(["watch", documentPath], test.deps);

    expect(exitCode).toBe(1);
    expect(test.sleeps).toEqual([2000, 2000, 2000]);
    const report = test.errors.join("\n");
    expect(report).toContain("did not come back within 6 s");
    expect(report).toContain("roughdraft open");
  });

  it("reports the lost server in --loop --json output without a done-signal", async () => {
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");
    const test = createWatchScriptTest(
      [
        { events: [], timedOut: true, nextSequence: 5 },
        connectionLost("ECONNREFUSED"),
      ],
      {
        ROUGHDRAFT_WATCH_RECONNECT_SECONDS: "2",
        ROUGHDRAFT_DEV_FRONTEND_STATE_FILE: devFrontendStateFile,
      },
      ["instance-a", "instance-a", connectionLost("ECONNREFUSED")],
    );

    const exitCode = await runCli(
      ["open", documentPath, "--no-open", "--loop", "--json"],
      test.deps,
    );

    expect(exitCode).toBe(1);
    const payload = parseOnlyJsonLog<{
      disconnected: boolean;
      done: boolean;
      doneReason: string | null;
      error: string;
    }>(test.logs);
    expect(payload).toMatchObject({
      disconnected: true,
      done: false,
      doneReason: null,
    });
    expect(payload.error).toContain("did not come back");
  });

  it("completes a watch started before a real server restart once the replacement receives Done Reviewing", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");
    const first = await ensureServerRunning(test.deps, { projectDir });
    const port = first.server.port;
    const statusUrl = `http://localhost:${port}/api/review-events/status?projectPath=${encodeURIComponent(projectDir)}&path=draft.md`;
    const watcherCount = async () => {
      const response = await fetch(statusUrl);
      return ((await response.json()) as { watcherCount: number }).watcherCount;
    };
    const waitForWatcher = async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          if ((await watcherCount()) > 0) return;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("no watcher registered");
    };

    const watching = runCli(["watch", documentPath], test.deps);
    await waitForWatcher();

    // A real stop: the long-poll socket closes and the port refuses.
    if (first.server.pid !== null) {
      await test.deps.stopProcess(first.server.pid);
    }
    await test.deps.spawnServerProcess({ port, projectDir });
    await waitForWatcher();

    const emitted = await fetch(`http://localhost:${port}/api/review-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectPath: projectDir, path: "draft.md" }),
    });
    expect(emitted.status).toBe(201);

    expect(await watching).toBe(0);
    expect(test.logs.join("\n")).toContain("Review completed");
    expect(test.errors.join("\n")).toContain("Reconnected");
  }, 20_000);

  it("cleans stale state during status checks", async () => {
    const test = createTestDependencies();
    const stateFilePath = getServerStateFilePath(test.deps.env);

    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        port: 3999,
        pid: 999999,
        startedAt: new Date().toISOString(),
        url: "http://localhost:3999",
      }),
    );

    const exitCode = await runCli(["status"], test.deps);

    expect(exitCode).toBe(1);
    expect(fs.existsSync(stateFilePath)).toBeFalsy();
  });

  it("reports and reuses an unmanaged server when the tracked pid is stale", async () => {
    const logs: string[] = [];
    const stateFilePath = path.join(stateDir, "server.json");

    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        port: ROUGHDRAFT_DEFAULT_PORT,
        pid: 424242,
        startedAt: new Date().toISOString(),
        url: `http://localhost:${ROUGHDRAFT_DEFAULT_PORT}`,
      }),
    );

    const deps = createCliDependencies({
      env: {
        ...process.env,
        ROUGHDRAFT_STATE_DIR: stateDir,
      },
      cwd: projectDir,
      fetchImpl: async (input) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );

        if (
          url.pathname === "/api/status" &&
          url.port === String(ROUGHDRAFT_DEFAULT_PORT)
        ) {
          return new Response(
            JSON.stringify({
              backend: "local-files",
              port: ROUGHDRAFT_DEFAULT_PORT,
              projectDir,
              serverRoot,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        throw new Error("connect ECONNREFUSED");
      },
      isProcessRunning: () => false,
      stopProcess: async () => {},
      spawnServerProcess: async () => {
        throw new Error("should not spawn");
      },
      openUrl: () => "disabled",
      log: (message) => logs.push(message),
      error: () => {},
    });

    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const statusExitCode = await runCli(["status"], deps);
    const openExitCode = await runCli(
      ["open", documentPath, "--no-watch"],
      deps,
    );

    expect(statusExitCode).toBe(0);
    expect(openExitCode).toBe(0);
    expect(logs).toContain(
      `Roughdraft is running at http://localhost:${ROUGHDRAFT_DEFAULT_PORT}`,
    );
    expect(logs).toContain(
      `This server is not managed by ${getServerStateFilePath(deps.env)}.`,
    );
    expect(fs.existsSync(stateFilePath)).toBeFalsy();
  });

  it("rejects directories before opening", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["open", projectDir], test.deps);

    expect(exitCode).toBe(1);
    expect(test.getSpawnCount()).toBe(0);
    expect(test.errors).toContain(
      `Roughdraft can only open .md files: ${projectDir}`,
    );
    expect(test.getLastOpenedUrl()).toBeNull();
  });

  it("cleans stale state and warns when another Roughdraft instance owns the port during stop", async () => {
    const errors: string[] = [];
    const stateFilePath = path.join(stateDir, "server.json");

    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        port: ROUGHDRAFT_DEFAULT_PORT,
        pid: 424242,
        startedAt: new Date().toISOString(),
        url: `http://localhost:${ROUGHDRAFT_DEFAULT_PORT}`,
      }),
    );

    const deps = createCliDependencies({
      env: {
        ...process.env,
        ROUGHDRAFT_STATE_DIR: stateDir,
      },
      cwd: projectDir,
      fetchImpl: async (input) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );

        if (
          url.pathname === "/api/status" &&
          url.port === String(ROUGHDRAFT_DEFAULT_PORT)
        ) {
          return new Response(
            JSON.stringify({
              backend: "local-files",
              port: ROUGHDRAFT_DEFAULT_PORT,
              projectDir,
              serverRoot,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        throw new Error("connect ECONNREFUSED");
      },
      isProcessRunning: () => false,
      stopProcess: async () => {},
      spawnServerProcess: async () => {
        throw new Error("should not spawn");
      },
      openUrl: () => "disabled",
      log: () => {},
      error: (message) => errors.push(message),
    });

    const stopExitCode = await runCli(["stop"], deps);

    expect(stopExitCode).toBe(1);
    expect(errors).toContain(
      `Stopped tracked Roughdraft process 424242, but another Roughdraft instance is still running at http://localhost:${ROUGHDRAFT_DEFAULT_PORT}.`,
    );
    expect(fs.existsSync(stateFilePath)).toBeFalsy();
  });

  it("stops a confidently identified unmanaged server with stop --all", async () => {
    const logs: string[] = [];
    let unmanagedRunning = true;
    let stoppedPid: number | null = null;

    const deps = createCliDependencies({
      env: {
        ...process.env,
        ROUGHDRAFT_STATE_DIR: stateDir,
      },
      cwd: projectDir,
      fetchImpl: async (input) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );

        if (
          unmanagedRunning &&
          url.pathname === "/api/status" &&
          url.port === String(ROUGHDRAFT_DEFAULT_PORT)
        ) {
          return new Response(
            JSON.stringify({
              backend: "local-files",
              pid: 4242,
              port: ROUGHDRAFT_DEFAULT_PORT,
              projectDir,
              serverRoot,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        throw new Error("connect ECONNREFUSED");
      },
      isProcessRunning: (pid) => unmanagedRunning && pid === 4242,
      stopProcess: async (pid) => {
        stoppedPid = pid;
        unmanagedRunning = false;
      },
      spawnServerProcess: async () => {
        throw new Error("should not spawn");
      },
      openUrl: () => "disabled",
      log: (message) => logs.push(message),
      error: () => {},
    });

    const exitCode = await runCli(["stop", "--all"], deps);

    expect(exitCode).toBe(0);
    expect(stoppedPid).toBe(4242);
    expect(logs).toContain(
      `Stopped unmanaged Roughdraft at http://localhost:${ROUGHDRAFT_DEFAULT_PORT}.`,
    );
  });

  it("documents extended review syntax in criticmarkup help", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["help", "criticmarkup"], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs).toContain("When adding new review feedback:");
    expect(test.logs).toContain(
      '  Write an inline attribute block right after the marker: {>>Comment<<}{id="c1" by="AI" at="2026-04-28T12:00:00.000Z"}.',
    );
    expect(test.logs).toContain(
      "  Use `c1`, `c2`, etc. for comment ids, `r1`, `r2`, etc. for reply ids, and `s1`, `s2`, etc. for suggested-change ids.",
    );
    expect(test.logs).toContain("Suggested changes with ids:");
    expect(test.logs).toContain(
      '  Add {++one concrete example++}{id="s1" by="AI" at="2026-04-28T12:10:00.000Z"}.',
    );
    expect(test.logs).toContain(
      '  Replace {~~vague phrasing~>specific wording~~}{id="s2" by="AI" at="2026-04-28T12:11:00.000Z"}.',
    );
    expect(test.logs).toContain("Reply to an existing comment:");
    expect(test.logs).toContain(
      '  {>>Needs a source<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}{>>Added one from the intro.<<}{id="r1" by="AI" at="2026-04-28T12:05:00.000Z" re="c1"}',
    );
    expect(test.logs).toContain(
      "  Read that form but never write it. Roughdraft displays the endmatter replies a document already carries.",
    );
    expect(test.logs).toContain(
      "  Comment ids are document-local and usually look like `c1`, `c2`, `c3`.",
    );
    expect(test.logs).toContain(
      "  Treat CriticMarkup inside fenced code blocks as literal example text.",
    );
    expect(test.logs).toContain(
      "  https://raw.githubusercontent.com/kudzuweb/roughdraftplus/main/docs/spec/roughdraft-flavored-markdown.md",
    );
    expect(
      test.logs.some((line) => /comments\.<id>\.body|{#s1}|{#c1}\./.test(line)),
    ).toBe(false);
  });

  it("prints copyable criticmarkup suggestion examples with required inline metadata", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["help", "criticmarkup"], test.deps);
    const example = extractHelpExample(
      test.logs,
      "Suggested changes with ids:",
      "Reply to an existing comment:",
    );
    const validation = validateRoughdraftMarkdown(example);

    expect(exitCode).toBe(0);
    expect(example).toContain('{id="s1" by="AI"');
    expect(example).toContain('{id="s2" by="AI"');
    expect(example).not.toContain("suggestions:");
    expect(validation.diagnostics).toEqual([]);
    expect(validation.summary.suggestions).toBe(2);
  });

  it("prints a copyable inline reply example that validates as a threaded comment", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["help", "criticmarkup"], test.deps);
    const example = extractHelpExample(
      test.logs,
      "Reply to an existing comment:",
      "Reply guidance:",
    )
      .split("\n")
      .filter((line) => line.startsWith("{>>"))
      .join("\n");
    const validation = validateRoughdraftMarkdown(`${example}\n`);

    expect(exitCode).toBe(0);
    expect(example).toContain('re="c1"');
    expect(validation.diagnostics).toEqual([]);
    expect(validation.summary.comments).toBe(2);
  });

  it("points general help to agent setup", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["help"], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs).toContain(
      "  help agent         Print the agent setup prompt",
    );
    expect(test.logs).toContain(
      "Agent setup: https://raw.githubusercontent.com/kudzuweb/roughdraftplus/main/packages/app/public/setup.md",
    );
    expect(test.logs).toContain(
      "Use `roughdraft help agent` for a copyable setup prompt.",
    );
  });

  it("prints a copyable agent setup prompt", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["help", "agent"], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs).toContain(
      "To set up your coding agent, paste this into it:",
    );
    expect(test.logs).toContain(
      'Install Roughdraft from the roughdraftplus fork: clone https://github.com/kudzuweb/roughdraftplus, run `pnpm install && pnpm build` in the clone, then `npm i -g "$(npm pack --silent)"`. Never run `npm i -g roughdraft`. Then read packages/app/public/setup.md in the clone and set yourself up to use it.',
    );
    expect(test.logs).toContain(
      "This command only prints setup text. It does not edit agent instruction files.",
    );
  });

  it("keeps CLAUDE.md as a short compatibility shim to AGENTS.md", () => {
    const claudePath = path.join(serverRoot, "CLAUDE.md");
    const claude = fs.readFileSync(claudePath, "utf8");

    expect(claude.length).toBeLessThan(200);
    expect(claude).toContain("@AGENTS.md");
    expect(claude).toContain("compatibility shim");
    expect(fs.lstatSync(claudePath).isSymbolicLink()).toBe(false);
  });

  it("treats removed install command as an unknown command", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["install"], test.deps);

    expect(exitCode).toBe(2);
    expect(test.errors).toContain("Unknown command: install.");
    expect(test.logs).toEqual([]);
  });

  it("prints package version only for --version", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["--version"], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs).toHaveLength(1);
    expect(test.logs[0]).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("shows per-command help", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["open", "--help"], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs).toContain(
      "  roughdraft open <path> [--label <text>] [--no-open] [--no-watch] [--loop] [--print-url] [--port <port>]",
    );
    expect(test.logs).toContain(
      "  --no-watch           Open the file without waiting",
    );
    expect(test.logs).toContain(
      "  --timeout <seconds>  Maximum watch time; omitted means no timeout",
    );
  });

  it("shows doctor help with the optional markdown path", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["doctor", "--help"], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs).toContain("  roughdraft doctor [path] [--json]");
  });

  it("rejects unknown command typos with suggestions", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["stats"], test.deps);

    expect(exitCode).toBe(2);
    expect(test.errors).toContain(
      "Unknown command: stats. Did you mean status?",
    );
  });

  it("supports agent-setup as a direct setup helper", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["agent-setup"], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs).toContain(
      "Live setup instructions: https://raw.githubusercontent.com/kudzuweb/roughdraftplus/main/packages/app/public/setup.md",
    );
  });

  it("reports dev wrapper metadata from doctor --json", async () => {
    const logs: string[] = [];
    const wrapperPath = path.join(tempDir, "bin", "roughdraft-dev-lyon-v2");
    const devStateDir = path.join(
      tempDir,
      ".roughdraft",
      "dev",
      "roughdraft-dev-lyon-v2",
    );
    const deps = createCliDependencies({
      env: {
        ...process.env,
        ROUGHDRAFT_DEV_WRAPPER_NAME: "roughdraft-dev-lyon-v2",
        ROUGHDRAFT_DEV_WRAPPER_PATH: wrapperPath,
        ROUGHDRAFT_DEV_WRAPPER_REPO_ROOT: serverRoot,
        ROUGHDRAFT_STATE_DIR: devStateDir,
      },
      cwd: projectDir,
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED");
      },
      log: (message) => logs.push(message),
      error: () => {},
    });

    const exitCode = await runCli(["doctor", "--json"], deps);
    const payload = parseOnlyJsonLog<{
      devWrapper: {
        commandName: string;
        path: string;
        repoRoot: string;
        repoRootMatches: boolean;
        stateDir: string;
      };
    }>(logs);

    expect(exitCode).toBe(0);
    expect(payload.devWrapper).toEqual({
      commandName: "roughdraft-dev-lyon-v2",
      path: wrapperPath,
      repoRoot: serverRoot,
      repoRootMatches: true,
      stateDir: devStateDir,
    });
  });

  it("validates a conforming markdown file from doctor path", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(
      documentPath,
      'Please revisit {==this sentence==}{>>Needs a source.<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}.\n',
    );

    const exitCode = await runCli(["doctor", documentPath], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs).toContain("Roughdraft Markdown doctor: draft.md");
    expect(test.logs).toContain("Status: passed");
    expect(test.logs).toContain("Found 1 comment(s) and 0 suggestion(s).");
  });

  it("returns validation errors from doctor path", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "{>>Needs metadata<<}\n");

    const exitCode = await runCli(["doctor", documentPath], test.deps);

    expect(exitCode).toBe(1);
    expect(test.logs).toContain("Status: failed");
    expect(test.logs).toContain("Errors:");
    expect(test.logs).toContain(
      "  1:1  Missing required metadata attribute `id`.",
    );
  });

  it("emits JSON validation output from doctor path --json", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(
      documentPath,
      [
        '{>>First<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}',
        '{++Second++}{id="c1" by="user" at="2026-04-28T12:01:00.000Z"}',
      ].join("\n"),
    );

    const exitCode = await runCli(
      ["doctor", documentPath, "--json"],
      test.deps,
    );
    const payload = parseOnlyJsonLog<{
      kind: string;
      path: string;
      ok: boolean;
      errors: Array<{ code: string }>;
      summary: { comments: number; suggestions: number };
    }>(test.logs);

    expect(exitCode).toBe(1);
    expect(payload).toMatchObject({
      kind: "markdown",
      path: documentPath,
      ok: false,
      summary: {
        comments: 1,
        suggestions: 1,
      },
    });
    expect(payload.errors.map((error) => error.code)).toContain("duplicate-id");
  });

  it("rejects missing markdown files from doctor path before validation", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "missing.md");

    const exitCode = await runCli(["doctor", documentPath], test.deps);

    expect(exitCode).toBe(2);
    expect(test.errors).toContain(`Path not found: ${documentPath}`);
  });

  it("rejects non-markdown doctor paths as usage errors", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.txt");
    fs.writeFileSync(documentPath, "# Draft\n");

    const exitCode = await runCli(["doctor", documentPath], test.deps);

    expect(exitCode).toBe(2);
    expect(test.errors).toContain(
      `Roughdraft doctor can only validate .md files: ${documentPath}`,
    );
  });

  it("starts a new server when the preferred port belongs to another checkout", async () => {
    const stateFilePath = path.join(stateDir, "server.json");
    const otherServerRoot = path.join(tempDir, "other-checkout");
    let spawnedPort: number | null = null;
    let spawnedProjectDir: string | null = null;
    let spawned = false;

    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        port: ROUGHDRAFT_DEFAULT_PORT,
        pid: 424242,
        startedAt: new Date().toISOString(),
        url: `http://localhost:${ROUGHDRAFT_DEFAULT_PORT}`,
      }),
    );

    const deps = createCliDependencies({
      env: {
        ...process.env,
        ROUGHDRAFT_STATE_DIR: stateDir,
      },
      cwd: projectDir,
      fetchImpl: async (input) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );

        if (url.pathname !== "/api/status") {
          throw new Error("Unexpected request");
        }

        if (url.port === String(ROUGHDRAFT_DEFAULT_PORT)) {
          return new Response(
            JSON.stringify({
              backend: "local-files",
              port: ROUGHDRAFT_DEFAULT_PORT,
              projectDir: path.join(tempDir, "other-project"),
              serverRoot: otherServerRoot,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        if (url.port === String(ROUGHDRAFT_DEFAULT_PORT + 1) && spawned) {
          return new Response(
            JSON.stringify({
              backend: "local-files",
              port: ROUGHDRAFT_DEFAULT_PORT + 1,
              projectDir,
              serverRoot,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        throw new Error("connect ECONNREFUSED");
      },
      findAvailablePortImpl: async () => ROUGHDRAFT_DEFAULT_PORT + 1,
      spawnServerProcess: async ({ port, projectDir: nextProjectDir }) => {
        spawned = true;
        spawnedPort = port;
        spawnedProjectDir = nextProjectDir;
        return { pid: 1001 };
      },
      isProcessRunning: (pid) => pid === 424242,
      stopProcess: async () => {},
      openUrl: () => "disabled",
      log: () => {},
      error: () => {},
    });

    const result = await ensureServerRunning(deps, { projectDir });

    expect(result.reused).toBe(false);
    expect(spawnedPort).toBe(ROUGHDRAFT_DEFAULT_PORT + 1);
    expect(spawnedProjectDir).toBe(projectDir);
    expect(result.server.port).toBe(ROUGHDRAFT_DEFAULT_PORT + 1);
  });
});

describe("runCli open in remote mode", () => {
  let tempDir: string;
  let projectDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-cli-remote-"));
    projectDir = path.join(tempDir, "project");
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function startRemoteHost(remoteDocumentToken?: string): Promise<{
    url: string;
    close: () => Promise<void>;
  }> {
    const { app } = createApp({
      remoteDocumentToken,
      staticDirPath: tempDir,
    });
    const server = createHttpServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to bind remote host");
    }
    return {
      url: `http://127.0.0.1:${address.port}`,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    };
  }

  it("prints register failure and exits 1 when the remote host is unreachable", async () => {
    const filePath = path.join(projectDir, "draft.md");
    fs.writeFileSync(filePath, "# hello\n");

    const logs: string[] = [];
    const errors: string[] = [];

    const exitCode = await runCli(["open", filePath], {
      env: { ROUGHDRAFT_HOST: "http://127.0.0.1:1" },
      cwd: projectDir,
      log: (m) => logs.push(m),
      error: (m) => errors.push(m),
      openUrl: () => "disabled",
      resolveUpdateStatus: async () => ({
        packageName: "roughdraft",
        currentVersion: "0.1.0",
        latestVersion: "0.1.0",
        updateAvailable: false,
        updateCommand: "",
      }),
    });

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Could not register remote session");
  });

  it("rejects non-.md targets in remote mode without contacting the host", async () => {
    const filePath = path.join(projectDir, "notes.txt");
    fs.writeFileSync(filePath, "hello");

    const errors: string[] = [];
    let fetchCalls = 0;

    const exitCode = await runCli(["open", filePath], {
      env: { ROUGHDRAFT_HOST: "http://127.0.0.1:1" },
      cwd: projectDir,
      log: () => {},
      error: (m) => errors.push(m),
      openUrl: () => "disabled",
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response("", { status: 200 });
      },
      resolveUpdateStatus: async () => ({
        packageName: "roughdraft",
        currentVersion: "0.1.0",
        latestVersion: "0.1.0",
        updateAvailable: false,
        updateCommand: "",
      }),
    });

    expect(exitCode).toBe(1);
    expect(fetchCalls).toBe(0);
    expect(errors.join("\n")).toContain("can only open .md files");
  });

  it("registers a session, opens the viewer URL, and writes save events to disk", {
    timeout: 15_000,
  }, async () => {
    const remote = await startRemoteHost();
    try {
      const filePath = path.join(projectDir, "draft.md");
      fs.writeFileSync(filePath, "before\n");

      const logs: string[] = [];
      const errors: string[] = [];
      let openedUrl: string | null = null;

      const cliPromise = runCli(["open", filePath], {
        env: { ROUGHDRAFT_HOST: remote.url },
        cwd: projectDir,
        log: (m) => logs.push(m),
        error: (m) => errors.push(m),
        openUrl: (url) => {
          openedUrl = url;
          return "disabled";
        },
        resolveUpdateStatus: async () => ({
          packageName: "roughdraft",
          currentVersion: "0.1.0",
          latestVersion: "0.1.0",
          updateAvailable: false,
          updateCommand: "",
        }),
      });

      // Wait for the CLI to register and open the SSE channel.
      const deadline = Date.now() + 4000;
      while (openedUrl === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(openedUrl).not.toBeNull();
      const sessionId = new URL(
        openedUrl as unknown as string,
      ).searchParams.get("session");
      expect(sessionId).toBeTruthy();

      // Wait until the server actually has the SSE client connected before PUTting.
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Trigger a save event by PUTting new content.
      const putResponse = await fetch(
        `${remote.url}/api/remote-document/${sessionId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "after\n" }),
        },
      );
      expect(putResponse.status).toBe(200);

      // Wait until the file on disk reflects the save.
      const writeDeadline = Date.now() + 4000;
      while (
        fs.readFileSync(filePath, "utf-8") !== "after\n" &&
        Date.now() < writeDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(fs.readFileSync(filePath, "utf-8")).toBe("after\n");

      // Closing the server ends the SSE stream and lets the CLI exit cleanly.
      await remote.close();
      const exitCode = await cliPromise;
      expect(exitCode).toBe(0);
      expect(
        logs.some((m) => m.includes("Opened remote Roughdraft session")),
      ).toBe(true);
    } finally {
      await remote.close();
    }
  });

  it("authenticates remote registration and the CLI save-back stream with ROUGHDRAFT_TOKEN", {
    timeout: 15_000,
  }, async () => {
    const remote = await startRemoteHost("secret-token");
    try {
      const filePath = path.join(projectDir, "draft.md");
      fs.writeFileSync(filePath, "before\n");

      const logs: string[] = [];
      const errors: string[] = [];
      let openedUrl: string | null = null;

      const cliPromise = runCli(["open", filePath], {
        env: {
          ROUGHDRAFT_HOST: remote.url,
          ROUGHDRAFT_TOKEN: "secret-token",
        },
        cwd: projectDir,
        log: (m) => logs.push(m),
        error: (m) => errors.push(m),
        openUrl: (url) => {
          openedUrl = url;
          return "disabled";
        },
        resolveUpdateStatus: async () => ({
          packageName: "roughdraft",
          currentVersion: "0.1.0",
          latestVersion: "0.1.0",
          updateAvailable: false,
          updateCommand: "",
        }),
      });

      const openDeadline = Date.now() + 4000;
      while (openedUrl === null && Date.now() < openDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(openedUrl).not.toBeNull();

      const parsedOpenedUrl = new URL(openedUrl as unknown as string);
      const sessionId = parsedOpenedUrl.searchParams.get("session");
      expect(sessionId).toBeTruthy();
      expect(parsedOpenedUrl.searchParams.get("token")).toBe("secret-token");

      await new Promise((resolve) => setTimeout(resolve, 100));

      const putResponse = await fetch(
        `${remote.url}/api/remote-document/${sessionId}`,
        {
          method: "PUT",
          headers: {
            Authorization: "Bearer secret-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content: "after-token\n" }),
        },
      );
      expect(putResponse.status).toBe(200);

      const writeDeadline = Date.now() + 4000;
      while (
        fs.readFileSync(filePath, "utf-8") !== "after-token\n" &&
        Date.now() < writeDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(fs.readFileSync(filePath, "utf-8")).toBe("after-token\n");

      await remote.close();
      expect(await cliPromise).toBe(0);
      expect(errors).toEqual([]);
      expect(
        logs.some((m) => m.includes("Opened remote Roughdraft session")),
      ).toBe(true);
    } finally {
      await remote.close();
    }
  });

  it("writes remote saves to disk without altering markdown constructs", {
    timeout: 15_000,
  }, async () => {
    const remote = await startRemoteHost();
    try {
      const filePath = path.join(projectDir, "roundtrip.md");
      const originalContent = [
        "---",
        "title: Remote Roundtrip",
        "---",
        "",
        "# Remote Roundtrip",
        "",
        "{>>Keep this comment<<}",
        "{++new text++}",
        "{--old text--}",
        "{~~old~>new~~}",
        "{==highlight==}",
        "",
        "| A | B |",
        "| - | - |",
        "| 1 | 2 |",
        "",
        "- [ ] task",
        "",
        "```md",
        "{>>literal example<<}",
        "```",
        "",
        "Inline `{>>literal<<}` and [local](./neighbor.md).",
        "",
        "<aside>supported html</aside>",
        "",
      ].join("\n");
      const savedContent = originalContent.replace(
        "# Remote Roundtrip",
        "# Remote Roundtrip Edited",
      );
      fs.writeFileSync(filePath, originalContent);

      const logs: string[] = [];
      const errors: string[] = [];
      let openedUrl: string | null = null;

      const cliPromise = runCli(["open", filePath], {
        env: { ROUGHDRAFT_HOST: remote.url },
        cwd: projectDir,
        log: (m) => logs.push(m),
        error: (m) => errors.push(m),
        openUrl: (url) => {
          openedUrl = url;
          return "disabled";
        },
        resolveUpdateStatus: async () => ({
          packageName: "roughdraft",
          currentVersion: "0.1.0",
          latestVersion: "0.1.0",
          updateAvailable: false,
          updateCommand: "",
        }),
      });

      const openDeadline = Date.now() + 4000;
      while (openedUrl === null && Date.now() < openDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(openedUrl).not.toBeNull();

      const sessionId = new URL(
        openedUrl as unknown as string,
      ).searchParams.get("session");
      expect(sessionId).toBeTruthy();

      await new Promise((resolve) => setTimeout(resolve, 100));

      const loaded = await fetch(
        `${remote.url}/api/remote-document/${sessionId}`,
      );
      expect(loaded.status).toBe(200);
      const payload = (await loaded.json()) as { version: string };

      const putResponse = await fetch(
        `${remote.url}/api/remote-document/${sessionId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: savedContent,
            expectedVersion: payload.version,
          }),
        },
      );
      expect(putResponse.status).toBe(200);

      const writeDeadline = Date.now() + 4000;
      while (
        fs.readFileSync(filePath, "utf-8") !== savedContent &&
        Date.now() < writeDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(fs.readFileSync(filePath, "utf-8")).toBe(savedContent);

      await remote.close();
      expect(await cliPromise).toBe(0);
      expect(errors).toEqual([]);
      expect(
        logs.some((m) => m.includes("Saved") && m.includes("roundtrip.md")),
      ).toBe(true);
    } finally {
      await remote.close();
    }
  });

  it("keeps the CLI save-back stream when a browser also watches the remote session", {
    timeout: 15_000,
  }, async () => {
    const remote = await startRemoteHost();
    let browserEventsReader: ReadableStreamDefaultReader<Uint8Array> | null =
      null;

    try {
      const filePath = path.join(projectDir, "draft.md");
      fs.writeFileSync(filePath, "before\n");

      const logs: string[] = [];
      const errors: string[] = [];
      let openedUrl: string | null = null;
      let cliSettled = false;

      const cliPromise = runCli(["open", filePath], {
        env: { ROUGHDRAFT_HOST: remote.url },
        cwd: projectDir,
        log: (m) => logs.push(m),
        error: (m) => errors.push(m),
        openUrl: (url) => {
          openedUrl = url;
          return "disabled";
        },
        resolveUpdateStatus: async () => ({
          packageName: "roughdraft",
          currentVersion: "0.1.0",
          latestVersion: "0.1.0",
          updateAvailable: false,
          updateCommand: "",
        }),
      }).finally(() => {
        cliSettled = true;
      });

      const openDeadline = Date.now() + 4000;
      while (openedUrl === null && Date.now() < openDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(openedUrl).not.toBeNull();

      const sessionId = new URL(
        openedUrl as unknown as string,
      ).searchParams.get("session");
      expect(sessionId).toBeTruthy();

      await new Promise((resolve) => setTimeout(resolve, 100));

      const browserEvents = await fetch(
        `${remote.url}/api/remote-document/${sessionId}/events?role=viewer`,
      );
      expect(browserEvents.status).toBe(200);
      browserEventsReader = browserEvents.body?.getReader() ?? null;
      expect(browserEventsReader).not.toBeNull();

      const decoder = new TextDecoder();
      let connectedChunk = "";
      const browserConnectDeadline = Date.now() + 4000;
      while (
        !connectedChunk.includes("event: connected") &&
        Date.now() < browserConnectDeadline
      ) {
        const chunk = await browserEventsReader?.read();
        if (!chunk || chunk.done) break;
        connectedChunk += decoder.decode(chunk.value);
      }
      expect(connectedChunk).toContain("event: connected");

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(cliSettled).toBe(false);

      const putResponse = await fetch(
        `${remote.url}/api/remote-document/${sessionId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "after-browser-watch\n" }),
        },
      );
      expect(putResponse.status).toBe(200);

      const writeDeadline = Date.now() + 4000;
      while (
        fs.readFileSync(filePath, "utf-8") !== "after-browser-watch\n" &&
        Date.now() < writeDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(fs.readFileSync(filePath, "utf-8")).toBe("after-browser-watch\n");

      await browserEventsReader?.cancel();
      await remote.close();
      expect(await cliPromise).toBe(0);
      expect(errors).toEqual([]);
      expect(
        logs.some((m) => m.includes("Opened remote Roughdraft session")),
      ).toBe(true);
    } finally {
      await browserEventsReader?.cancel().catch(() => undefined);
      await remote.close();
    }
  });
});
