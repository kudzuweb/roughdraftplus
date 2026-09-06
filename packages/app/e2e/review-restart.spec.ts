import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  openMarkdownFile,
  removeMarkdownProject,
  routeApiTo,
  startReplacementServer,
  writeProjectFile,
} from "./helpers";

// The agent's blocking `roughdraft open` is stood in for by a watch request:
// the one on the primary server is the watch the restart interrupts, and the
// one on the replacement is the reconnected watch. The notice under the Done
// button appears only after a few lost polls, so its expectations wait longer
// than the default.
const noticeTimeout = 15_000;

test.describe("review across a server restart", () => {
  let projectDir: string;
  let pendingWatch: Promise<unknown> | null = null;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("review-restart");
    pendingWatch = null;
  });

  test.afterEach(async () => {
    await pendingWatch?.catch(() => undefined);
    removeMarkdownProject(projectDir);
  });

  test("keeps the Done button through a restart and delivers the handoff to the reconnected watch @smoke", async ({
    page,
    request,
  }) => {
    const relativePath = "restart.md";
    const filePath = writeProjectFile(
      projectDir,
      relativePath,
      ["# Restart", "", "Review this across a restart.", ""].join("\n"),
    );
    pendingWatch = request.post("/api/review-events/watch", {
      data: { projectPath: projectDir, path: relativePath, timeoutSeconds: 10 },
    });

    await openMarkdownFile(page, filePath);
    await expect(page.getByTestId("review-handoff-button")).toBeVisible();

    const replacement = await startReplacementServer(projectDir);
    try {
      await routeApiTo(page, replacement.port);

      await expect(page.getByTestId("review-watcher-notice")).toContainText(
        "Agent disconnected",
        { timeout: noticeTimeout },
      );
      await expect(page.getByTestId("review-handoff-button")).toBeVisible();

      const reconnectedWatch = request.post(
        `http://127.0.0.1:${replacement.port}/api/review-events/watch`,
        {
          data: {
            projectPath: projectDir,
            path: relativePath,
            timeoutSeconds: 10,
          },
        },
      );
      await expect(page.getByTestId("review-watcher-notice")).toBeHidden();

      await page.getByTestId("review-handoff-button").click();
      await expect(page.getByTestId("review-handoff-button")).toHaveText(
        "Sent",
      );

      const payload = await (await reconnectedWatch).json();
      expect(payload.events).toHaveLength(1);
      expect(payload.events[0]).toMatchObject({
        type: "review.completed",
        relativePath,
      });
    } finally {
      await replacement.close();
    }
  });

  test("names the orphaned state while the server is unreachable and when no agent comes back", async ({
    page,
    request,
  }) => {
    const relativePath = "orphaned.md";
    const filePath = writeProjectFile(
      projectDir,
      relativePath,
      ["# Orphaned", "", "Nobody is coming back for this one.", ""].join("\n"),
    );
    pendingWatch = request.post("/api/review-events/watch", {
      data: { projectPath: projectDir, path: relativePath, timeoutSeconds: 10 },
    });

    await openMarkdownFile(page, filePath);
    await expect(page.getByTestId("review-handoff-button")).toBeVisible();

    const statusRoute = "**/api/review-events/status**";
    await page.route(statusRoute, (route) => route.abort());
    await expect(page.getByTestId("review-watcher-notice")).toContainText(
      "Roughdraft server unreachable",
      { timeout: noticeTimeout },
    );
    await page.unroute(statusRoute);

    const replacement = await startReplacementServer(projectDir);
    try {
      await routeApiTo(page, replacement.port);

      const notice = page.getByTestId("review-watcher-notice");
      await expect(notice).toContainText("Agent disconnected", {
        timeout: noticeTimeout,
      });
      await expect(notice).toContainText("roughdraft open");

      await page.getByTestId("review-handoff-button").click();
      await expect(page.getByTestId("review-handoff-status")).toContainText(
        "No agent is watching now",
      );
      await expect(page.getByTestId("review-handoff-status")).toContainText(
        "roughdraft open",
      );
    } finally {
      await replacement.close();
    }
  });
});
