import fs from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { createApp } from "../../server/src/index";
import {
  createMarkdownProject,
  fileConflictNotice,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  richTextEditor,
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

  test("a tab whose server is gone does not write to the file", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "server-gone.md",
      reflowingMarkdown,
    );

    await openMarkdownFile(page, filePath);
    await expect(richTextEditor(page)).toContainText("hard-wrapped");
    await settleAutosave(page);
    const before = snapshotFile(filePath);

    // Replace the server the tab loaded against with a fresh instance on
    // another port, the way a stopped CLI and a later `roughdraft open` do.
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-home-"));
    const { app } = createApp({ homeDir, staticDirPath: projectDir });
    const replacement: Server = await new Promise((resolve) => {
      const server = app.listen(0, "127.0.0.1", () => resolve(server));
    });
    const replacementPort = (replacement.address() as AddressInfo).port;

    try {
      await page.route("**/api/**", async (route) => {
        const original = new URL(route.request().url());
        const response = await route.fetch({
          url: `http://127.0.0.1:${replacementPort}${original.pathname}${original.search}`,
        });
        await route.fulfill({ response });
      });
      await page.route("**/api/markdown-file/events**", (route) =>
        route.abort(),
      );

      await richTextEditor(page).click();
      await page.keyboard.press("End");
      await page.keyboard.type(" typed against a replaced server");
      await expect(richTextEditor(page)).toContainText(
        "typed against a replaced server",
      );
      await expect(fileConflictNotice(page)).toContainText(
        "Roughdraft server stopped",
      );
      await settleAutosave(page);

      expect(snapshotFile(filePath)).toEqual(before);
    } finally {
      await new Promise<void>((resolve) => replacement.close(() => resolve()));
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
