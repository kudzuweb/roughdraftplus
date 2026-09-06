import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { createApp } from "../../server/src/index";
import {
  createMarkdownProject,
  documentSaveStatus,
  fileConflictNotice,
  listenApp,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  richTextEditor,
  routeApiTo,
  startReplacementServer,
  writeProjectFile,
} from "./helpers";

const reflowingMarkdown = [
  "# Gated save",
  "",
  "A paragraph that is",
  "hard-wrapped across two lines.",
  "",
  "| Column A | Column B |",
  "|----------|----------|",
  "| one      | two      |",
  "",
  "- [ ] a task",
  "",
].join("\n");

function snapshotFile(filePath: string) {
  const stats = fs.statSync(filePath);
  return {
    content: fs.readFileSync(filePath, "utf8"),
    mtimeMs: stats.mtimeMs,
  };
}

function trackFileWrites(page: Page) {
  const writes: string[] = [];
  page.on("request", (request) => {
    const isMarkdownWrite =
      request.method() === "PUT" &&
      request.url().includes("/api/markdown-file");
    const isReviewEvent =
      request.method() === "POST" &&
      request.url().includes("/api/review-events") &&
      !request.url().includes("/api/review-events/watch");
    if (isMarkdownWrite || isReviewEvent) {
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
    }
  });
  return writes;
}

const builtAppDir = path.resolve(
  fileURLToPath(new URL("../dist", import.meta.url)),
);

function builtAppIsCurrent() {
  // The restart test runs the built bundle, so a dist older than the source
  // it exercises would test yesterday's app.
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

async function listenBuiltApp(port: number) {
  const { app } = createApp({ staticDirPath: builtAppDir });
  return listenApp(app, port);
}

async function settleAutosave(page: Page) {
  // Autosave debounces edits by 500ms; wait well past that so any reflowed
  // copy the editor emits on load has had time to reach the server.
  await page.waitForTimeout(1500);
}

test.describe("save gating", () => {
  let projectDir: string;
  let pendingWatch: Promise<unknown> | null = null;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("save-gating");
    pendingWatch = null;
  });

  test.afterEach(async () => {
    await pendingWatch?.catch(() => undefined);
    removeMarkdownProject(projectDir);
  });

  test("opening a document leaves the file bytes unchanged @smoke", async ({
    page,
  }) => {
    const filePath = writeProjectFile(projectDir, "open.md", reflowingMarkdown);
    const before = snapshotFile(filePath);
    const writes = trackFileWrites(page);

    await openMarkdownFile(page, filePath);
    await expect(richTextEditor(page)).toContainText("hard-wrapped");
    await settleAutosave(page);

    expect(writes).toEqual([]);
    expect(snapshotFile(filePath)).toEqual(before);
  });

  test("refreshing the tab leaves the file bytes unchanged", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "refresh.md",
      reflowingMarkdown,
    );
    const before = snapshotFile(filePath);
    const writes = trackFileWrites(page);

    await openMarkdownFile(page, filePath);
    await expect(richTextEditor(page)).toContainText("hard-wrapped");
    await page.reload();
    await expect(richTextEditor(page)).toContainText("hard-wrapped");
    await settleAutosave(page);

    expect(writes).toEqual([]);
    expect(snapshotFile(filePath)).toEqual(before);
  });

  test("Done Reviewing with no edits or comments leaves the file bytes unchanged", async ({
    page,
    request,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "approve.md",
      reflowingMarkdown,
    );
    const before = snapshotFile(filePath);
    const writes = trackFileWrites(page);

    pendingWatch = request.post("/api/review-events/watch", {
      data: { projectPath: projectDir, path: "approve.md", timeoutSeconds: 10 },
    });

    await openMarkdownFile(page, filePath);
    await expect(richTextEditor(page)).toContainText("hard-wrapped");
    await expect(page.getByTestId("review-handoff-button")).toHaveText(
      "Approve",
    );
    await page.getByTestId("review-handoff-button").click();
    await expect(page.getByTestId("review-handoff-button")).toHaveText("Sent");
    await settleAutosave(page);

    expect(writes).toEqual(["POST /api/review-events"]);
    expect(snapshotFile(filePath)).toEqual(before);
  });

  test("after Done Reviewing the tab stops writing until a new review starts", async ({
    page,
    request,
  }) => {
    const filePath = writeProjectFile(projectDir, "done.md", reflowingMarkdown);
    const writes = trackFileWrites(page);

    pendingWatch = request.post("/api/review-events/watch", {
      data: { projectPath: projectDir, path: "done.md", timeoutSeconds: 10 },
    });

    await openMarkdownFile(page, filePath);
    await expect(richTextEditor(page)).toContainText("hard-wrapped");
    await page.getByTestId("review-handoff-button").click();
    await expect(page.getByTestId("review-handoff-button")).toHaveText("Sent");
    await pendingWatch;
    await page.keyboard.press("Escape");
    const afterDone = snapshotFile(filePath);

    await richTextEditor(page).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" typed after done");
    await expect(richTextEditor(page)).toContainText("typed after done");
    await settleAutosave(page);

    expect(writes.filter((write) => write.startsWith("PUT"))).toEqual([]);
    expect(snapshotFile(filePath)).toEqual(afterDone);

    // A new agent watch starts a new review; the next edit saves again.
    await page.waitForTimeout(2000);
    pendingWatch = request.post("/api/review-events/watch", {
      data: { projectPath: projectDir, path: "done.md", timeoutSeconds: 10 },
    });
    await expect(page.getByTestId("review-handoff-button")).not.toHaveText(
      "Sent",
    );
    await richTextEditor(page).click();
    await page.keyboard.type(" and in a new review");
    await expect
      .poll(() => readProjectFile(projectDir, "done.md"))
      .toContain("and in a new review");
    expect(readProjectFile(projectDir, "done.md")).toContain(
      "typed after done",
    );
  });

  test("after Done Reviewing only the review that reopened the document resumes saving", async ({
    page,
    request,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "scoped.md",
      reflowingMarkdown,
    );
    const writes = trackFileWrites(page);
    const firstReviewToken = "review-token-first";
    const reopenedReviewToken = "review-token-reopened";
    const watchDocument = (reviewToken?: string) =>
      request.post("/api/review-events/watch", {
        data: {
          projectPath: projectDir,
          path: "scoped.md",
          timeoutSeconds: 10,
          ...(reviewToken ? { reviewToken } : {}),
        },
      });

    const firstWatch = watchDocument(firstReviewToken);
    pendingWatch = firstWatch;

    const params = new URLSearchParams({
      path: filePath,
      reviewToken: firstReviewToken,
    });
    await page.goto(`/?${params.toString()}`);
    await expect(richTextEditor(page)).toContainText("hard-wrapped");
    await page.getByTestId("review-handoff-button").click();
    await expect(page.getByTestId("review-handoff-button")).toHaveText("Sent");
    await firstWatch;
    await page.keyboard.press("Escape");
    const afterDone = snapshotFile(filePath);

    await richTextEditor(page).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" typed after done");
    await expect(richTextEditor(page)).toContainText("typed after done");

    // Watchers this tab's review did not start: a leftover `roughdraft watch`
    // and another session's open on the same path. Neither reopened this
    // document, so neither may resume its saves.
    const strayWatch = watchDocument();
    const otherSessionWatch = watchDocument("review-token-elsewhere");
    await page.waitForTimeout(2000);
    await page.keyboard.type(" and typed while they watch");
    await expect(richTextEditor(page)).toContainText("while they watch");
    await settleAutosave(page);

    expect(writes.filter((write) => write.startsWith("PUT"))).toEqual([]);
    expect(snapshotFile(filePath)).toEqual(afterDone);
    await expect(page.getByTestId("review-handoff-button")).toHaveText("Sent");

    // The `roughdraft open` that reopens the document hands this tab the
    // token of the round it is about to watch; that watch resumes saving.
    await expect
      .poll(async () => {
        const response = await request.post("/api/open-request", {
          data: {
            path: filePath,
            url: page.url(),
            reviewToken: reopenedReviewToken,
          },
        });
        return (await response.json()).delivered;
      })
      .toBe(true);
    const reopenedWatch = watchDocument(reopenedReviewToken);
    pendingWatch = Promise.all([strayWatch, otherSessionWatch, reopenedWatch]);

    await expect(page.getByTestId("review-handoff-button")).not.toHaveText(
      "Sent",
    );
    await richTextEditor(page).click();
    await page.keyboard.type(" and in the reopened review");
    await expect
      .poll(() => readProjectFile(projectDir, "scoped.md"))
      .toContain("and in the reopened review");
  });

  test("a file changed on disk outside the editor is not overwritten by the reflowed copy", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "external.md",
      reflowingMarkdown,
    );
    const writes = trackFileWrites(page);

    await openMarkdownFile(page, filePath);
    await expect(richTextEditor(page)).toContainText("hard-wrapped");
    await settleAutosave(page);

    const checkedOut = [
      "# Gated save",
      "",
      "Checked out",
      "from another session.",
      "",
    ].join("\n");
    fs.writeFileSync(filePath, checkedOut);
    const external = snapshotFile(filePath);

    await expect(richTextEditor(page)).toContainText("Checked out");
    await settleAutosave(page);

    expect(writes).toEqual([]);
    expect(snapshotFile(filePath)).toEqual(external);
  });

  test("a tab whose server is replaced does not write until it adopts the replacement, then saves the kept edit", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "server-replaced.md",
      reflowingMarkdown,
    );
    const putStatuses: number[] = [];
    let fileAtRejection: string | null = null;
    page.on("response", (response) => {
      if (
        response.request().method() !== "PUT" ||
        !response.url().includes("/api/markdown-file")
      ) {
        return;
      }
      putStatuses.push(response.status());
      if (response.status() === 410) {
        fileAtRejection = fs.readFileSync(filePath, "utf8");
      }
    });

    // A stopped server's file-change stream is dead during the outage, so
    // the tab must not learn about the change from the old server.
    await page.route("**/api/markdown-file/events**", (route) => route.abort());
    await openMarkdownFile(page, filePath);
    await expect(richTextEditor(page)).toContainText("hard-wrapped");
    await settleAutosave(page);

    const replacement = await startReplacementServer(projectDir);
    try {
      await routeApiTo(page, replacement.port);

      await richTextEditor(page).click();
      await page.keyboard.press("End");
      await page.keyboard.type(" typed across a restart");
      await expect(richTextEditor(page)).toContainText(
        "typed across a restart",
      );

      // The replacement refuses the stale tab's write, the tab adopts the
      // replacement, confirms the file is unchanged, and saves the kept edit.
      await expect(page.getByTestId("server-restart-notice")).toContainText(
        "Roughdraft server restarted",
      );
      await expect
        .poll(() => readProjectFile(projectDir, "server-replaced.md"))
        .toContain("typed across a restart");

      expect(putStatuses).toEqual([410, 200]);
      expect(fileAtRejection).not.toBeNull();
      expect(fileAtRejection).not.toContain("typed across a restart");
      await expect(documentSaveStatus(page)).toHaveAttribute(
        "aria-label",
        "Saved",
      );
    } finally {
      await replacement.close();
    }
  });

  test("a tab whose server is replaced while the file changed on disk shows the conflict banner and does not write", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "server-replaced-conflict.md",
      reflowingMarkdown,
    );
    const putStatuses: number[] = [];
    page.on("response", (response) => {
      if (
        response.request().method() === "PUT" &&
        response.url().includes("/api/markdown-file")
      ) {
        putStatuses.push(response.status());
      }
    });

    // A stopped server's file-change stream is dead during the outage, so
    // the tab must not learn about the change from the old server.
    await page.route("**/api/markdown-file/events**", (route) => route.abort());
    await openMarkdownFile(page, filePath);
    await expect(richTextEditor(page)).toContainText("hard-wrapped");
    await settleAutosave(page);

    const replacement = await startReplacementServer(projectDir);
    try {
      await routeApiTo(page, replacement.port);

      const changedWhileAway =
        "# Gated save\n\nChanged while the server was away.\n";
      fs.writeFileSync(filePath, changedWhileAway);
      const external = snapshotFile(filePath);

      await richTextEditor(page).click();
      await page.keyboard.press("End");
      await page.keyboard.type(" typed across a restart");
      await expect(richTextEditor(page)).toContainText(
        "typed across a restart",
      );

      await expect(fileConflictNotice(page)).toContainText(
        "File changed on disk",
      );
      await settleAutosave(page);

      expect(putStatuses).toEqual([410]);
      expect(snapshotFile(filePath)).toEqual(external);
    } finally {
      await replacement.close();
    }
  });

  test("a clean tab adopts a restarted server from the agent's open request without reloading or writing", async ({
    browser,
    request,
  }) => {
    test.skip(
      !builtAppIsCurrent(),
      "needs a current build of the app in packages/app/dist (pnpm build)",
    );

    const filePath = writeProjectFile(
      projectDir,
      "server-restarted.md",
      reflowingMarkdown,
    );
    const before = snapshotFile(filePath);
    const context = await browser.newContext();
    const page = await context.newPage();
    const writes = trackFileWrites(page);

    // Serve the built app straight from a real server so the tab's event
    // streams reconnect to whatever listens on the same port next, the way
    // they do after `roughdraft stop` and `roughdraft start`.
    const first = await listenBuiltApp(0);
    const port = first.port;
    let second: ListeningApp | null = null;
    try {
      const params = new URLSearchParams({ path: filePath });
      await page.goto(`http://127.0.0.1:${port}/?${params.toString()}`);
      await expect(richTextEditor(page)).toContainText("hard-wrapped");
      await page.evaluate(() => {
        (window as unknown as { __tabMarker?: string }).__tabMarker = "alive";
      });
      const firstStatus = await (
        await page.request.get(`http://127.0.0.1:${port}/api/status`)
      ).json();

      await first.close();
      second = await listenBuiltApp(port);
      const secondStatus = await (
        await page.request.get(`http://127.0.0.1:${port}/api/status`)
      ).json();
      expect(secondStatus.instanceId).not.toBe(firstStatus.instanceId);

      // The agent's `roughdraft open` reaches the tab once its open-request
      // stream has reconnected to the restarted server.
      await expect
        .poll(
          async () => {
            const response = await page.request.post(
              `http://127.0.0.1:${port}/api/open-request`,
              { data: { path: filePath, url: page.url() } },
            );
            return (await response.json()).delivered;
          },
          { timeout: 15_000 },
        )
        .toBe(true);

      // The tab adopts the restarted server in place: no reload, no write,
      // and the handoff control comes back when the agent's watch registers.
      pendingWatch = request.post(
        `http://127.0.0.1:${port}/api/review-events/watch`,
        {
          data: {
            projectPath: projectDir,
            path: "server-restarted.md",
            timeoutSeconds: 10,
          },
        },
      );
      await expect(page.getByTestId("review-handoff-button")).toBeVisible();
      expect(
        await page.evaluate(
          () => (window as unknown as { __tabMarker?: string }).__tabMarker,
        ),
      ).toBe("alive");
      expect(writes).toEqual([]);
      expect(snapshotFile(filePath)).toEqual(before);

      await richTextEditor(page).click();
      await page.keyboard.press("End");
      await page.keyboard.type(" typed after the restart");
      await expect
        .poll(() => readProjectFile(projectDir, "server-restarted.md"))
        .toContain("typed after the restart");
      await expect(page.getByTestId("file-conflict-notice")).toBeHidden();
    } finally {
      await context.close();
      await second?.close();
    }
  });
});
