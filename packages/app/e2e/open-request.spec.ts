import fs from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { createApp } from "../../server/src/index";
import {
  codeEditor,
  createMarkdownProject,
  logE2eEvent,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

const builtAppDir = path.resolve(
  fileURLToPath(new URL("../dist", import.meta.url)),
);

function builtAppIsCurrent() {
  const indexPath = path.join(builtAppDir, "index.html");
  if (!fs.existsSync(indexPath)) return false;
  const assetsDir = path.join(builtAppDir, "assets");
  const newestBuild = Math.max(
    fs.statSync(indexPath).mtimeMs,
    ...(fs.existsSync(assetsDir)
      ? fs
          .readdirSync(assetsDir)
          .map((name) => fs.statSync(path.join(assetsDir, name)).mtimeMs)
      : []),
  );
  const sourceDir = fileURLToPath(new URL("../src", import.meta.url));
  const newestSource = Math.max(
    ...fs
      .readdirSync(sourceDir)
      .filter((name) => /\.tsx?$/.test(name))
      .map((name) => fs.statSync(path.join(sourceDir, name)).mtimeMs),
  );
  return newestBuild >= newestSource;
}

// Serves the built app from a real server and records every request URL it
// receives, so a test can read what a tab registers with on reconnect: the
// open-request registry has no read route yet, and its only input is the
// tab's subscription query string.
async function listenBuiltApp(homeDir: string, port: number) {
  const { app } = createApp({ homeDir, staticDirPath: builtAppDir });
  const receivedUrls: string[] = [];
  const server: Server = await new Promise((resolve, reject) => {
    const listening = createHttpServer((req, res) => {
      receivedUrls.push(req.url ?? "");
      app(req, res);
    });
    listening.on("error", reject);
    listening.listen(port, "127.0.0.1", () => resolve(listening));
  });
  return {
    port: (server.address() as AddressInfo).port,
    receivedUrls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

test.describe("open document path and session in the header", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("open-request");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("shows the document's absolute path and the session that opened it", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "plan.md",
      "# Plan\n\nPlan body.\n",
    );

    await page.goto(
      `/?${new URLSearchParams({ path: filePath, label: "build-15", editor: "code" })}`,
    );
    await expect(codeEditor(page)).toContainText("Plan body.");

    await expect(page.getByTestId("document-path")).toHaveText(filePath);
    await expect(page.getByTestId("document-session-label")).toHaveText(
      "Opened by build-15",
    );

    logE2eEvent("open-request.header-path-and-label", { file: filePath });
  });

  test("says when no session label was given", async ({ page }) => {
    const filePath = writeProjectFile(
      projectDir,
      "plan.md",
      "# Plan\n\nPlan body.\n",
    );

    await page.goto(`/?${new URLSearchParams({ path: filePath })}`);
    await expect(page.getByTestId("document-path")).toHaveText(filePath);
    await expect(page.getByTestId("document-session-label")).toHaveText(
      "No session label",
    );
  });

  test("shows no path or session line on the in-memory preview route", async ({
    page,
  }) => {
    await page.goto("/preview?editor=code");
    await expect(codeEditor(page)).toContainText("Live Preview");
    await expect(page.getByTestId("document-page-header")).toBeVisible();
    await expect(page.getByTestId("document-location")).toHaveCount(0);
  });

  test("truncates a long session label and keeps the full label in its title", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "plan.md",
      "# Plan\n\nPlan body.\n",
    );
    const longLabel = Array.from(
      { length: 40 },
      (_, index) => `word${index + 1}`,
    ).join(" ");

    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto(
      `/?${new URLSearchParams({ path: filePath, label: longLabel })}`,
    );
    const label = page.getByTestId("document-session-label");
    await expect(label).toHaveAttribute("title", longLabel);
    await expect(label).toContainText("Opened by word1");

    const overflow = await page
      .getByTestId("document-location")
      .evaluate((line) => ({
        line: line.scrollWidth - line.clientWidth,
        label: (() => {
          const span = line.querySelector(
            '[data-testid="document-session-label"]',
          );
          return span ? span.scrollWidth - span.clientWidth : -1;
        })(),
      }));
    // The line no longer overflows its box; the label span itself is the
    // element that clips, which is what shows the ellipsis.
    expect(overflow.line).toBe(0);
    expect(overflow.label).toBeGreaterThan(0);
  });

  test("takes a new session label from a repeated open request without reloading", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "plan.md",
      "# Plan\n\nPlan body.\n",
    );

    await page.goto(
      `/?${new URLSearchParams({ path: filePath, editor: "code" })}`,
    );
    await expect(codeEditor(page)).toContainText("Plan body.");
    await page.evaluate(() => {
      (window as unknown as { __tabMarker?: string }).__tabMarker = "alive";
    });

    const response = await page.request.post("/api/open-request", {
      data: {
        path: filePath,
        url: `/?${new URLSearchParams({ path: filePath, label: "build-15" })}`,
        label: "build-15",
      },
    });
    await expect(response.json()).resolves.toEqual({ delivered: true });

    await expect(page.getByTestId("document-session-label")).toHaveText(
      "Opened by build-15",
    );
    expect(new URL(page.url()).searchParams.get("label")).toBe("build-15");
    expect(
      await page.evaluate(
        () => (window as unknown as { __tabMarker?: string }).__tabMarker,
      ),
    ).toBe("alive");
    await expect(codeEditor(page)).toContainText("Plan body.");
  });

  test("re-registers with the label last delivered when the server restarts", async ({
    browser,
  }) => {
    test.skip(
      !builtAppIsCurrent(),
      "needs a current build of the app in packages/app/dist (pnpm build)",
    );

    const filePath = writeProjectFile(
      projectDir,
      "plan.md",
      "# Plan\n\nPlan body.\n",
    );
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-home-"));
    const context = await browser.newContext();
    const page = await context.newPage();
    const first = await listenBuiltApp(homeDir, 0);
    const port = first.port;
    let second: Awaited<ReturnType<typeof listenBuiltApp>> | null = null;

    try {
      await page.goto(
        `http://127.0.0.1:${port}/?${new URLSearchParams({ path: filePath })}`,
      );
      await expect(page.getByTestId("document-session-label")).toHaveText(
        "No session label",
      );
      await page.evaluate(() => {
        (window as unknown as { __tabMarker?: string }).__tabMarker = "alive";
      });

      const relabel = await page.request.post(
        `http://127.0.0.1:${port}/api/open-request`,
        {
          data: {
            path: filePath,
            url: `http://127.0.0.1:${port}/?${new URLSearchParams({ path: filePath, label: "relabeled" })}`,
            label: "relabeled",
          },
        },
      );
      await expect(relabel.json()).resolves.toEqual({ delivered: true });
      await expect(page.getByTestId("document-session-label")).toHaveText(
        "Opened by relabeled",
      );

      await first.close();
      second = await listenBuiltApp(homeDir, port);

      // The tab's stream reconnects to whatever listens on the port next;
      // the registration it sends must carry the delivered label, not the
      // one the tab loaded with (none).
      await expect
        .poll(
          () =>
            second?.receivedUrls
              .filter((url) => url.startsWith("/api/open-requests"))
              .map((url) =>
                new URL(url, "http://127.0.0.1").searchParams.get("label"),
              ),
          { timeout: 15_000 },
        )
        .toContain("relabeled");
      expect(
        await page.evaluate(
          () => (window as unknown as { __tabMarker?: string }).__tabMarker,
        ),
      ).toBe("alive");
    } finally {
      await context.close();
      await second?.close();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test("warns instead of switching when a different document is opened", async ({
    page,
  }) => {
    const reviewingPath = writeProjectFile(
      projectDir,
      "plan.md",
      "# Plan\n\nPlan body under review.\n",
    );
    const otherPath = writeProjectFile(
      projectDir,
      "spec.md",
      "# Spec\n\nSpec body.\n",
    );

    await page.goto(
      `/?${new URLSearchParams({ path: reviewingPath, label: "build-15", editor: "code" })}`,
    );
    await expect(codeEditor(page)).toContainText("Plan body under review.");

    const response = await page.request.post("/api/open-request", {
      data: {
        path: otherPath,
        url: `/?${new URLSearchParams({ path: otherPath, label: "build-16" })}`,
        label: "build-16",
      },
    });
    await expect(response.json()).resolves.toEqual({ delivered: false });

    const notice = page.getByTestId("document-opened-elsewhere-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(otherPath);
    await expect(notice).toContainText("build-16");

    await expect(codeEditor(page)).toContainText("Plan body under review.");
    expect(new URL(page.url()).searchParams.get("path")).toBe(reviewingPath);
    await expect(page.getByTestId("document-path")).toHaveText(reviewingPath);

    await page.getByTestId("document-opened-elsewhere-dismiss").click();
    await expect(notice).toBeHidden();

    logE2eEvent("open-request.warned-instead-of-switching", {
      reviewing: reviewingPath,
      other: otherPath,
    });
  });
});
