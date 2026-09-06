import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  logE2eEvent,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

test.describe("review handoff", () => {
  let projectDir: string;
  let pendingWatch: Promise<unknown> | null = null;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("review-handoff");
    pendingWatch = null;
  });

  test.afterEach(async () => {
    await pendingWatch?.catch(() => undefined);
    removeMarkdownProject(projectDir);
  });

  test("persists an overall handoff comment from the primary done button to YAML endmatter @smoke", async ({
    page,
    request,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "handoff-comment.md",
      ["# Handoff Comment", "", "Review this document.", ""].join("\n"),
    );
    const relativePath = "handoff-comment.md";
    const overallComment = "Please prioritize the CLI contract.";

    pendingWatch = request.post("/api/review-events/watch", {
      data: {
        projectPath: projectDir,
        path: relativePath,
        timeoutSeconds: 10,
      },
    });

    await openMarkdownFile(page, filePath);
    await expect(page.getByTestId("review-handoff-button")).toBeVisible();

    await page.getByTestId("review-handoff-comment-trigger").click();
    await page
      .getByTestId("review-handoff-overall-comment")
      .fill(overallComment);
    await page.getByTestId("review-handoff-button").click();

    await expect(page.getByTestId("review-handoff-status")).toContainText(
      "Your agent is now working",
    );

    await expect
      .poll(() => readProjectFile(projectDir, relativePath))
      .toMatch(
        /---\ncomments:\n {2}c1:\n {4}body: Please prioritize the CLI contract\.\n {4}by: user\n {4}at: [^\n]+\n?$/,
      );

    const watchResponse = await pendingWatch;
    const payload = await watchResponse.json();
    expect(payload.events).toHaveLength(1);
    expect(payload.events[0]).toMatchObject({
      type: "review.completed",
      overallComment,
      summary: {
        comments: 1,
      },
    });
  });

  test("keeps an inline document inline after the server persists an overall comment @smoke", async ({
    page,
    request,
  }) => {
    const relativePath = "inline-after-overall-comment.md";
    const filePath = writeProjectFile(
      projectDir,
      relativePath,
      [
        "# Inline After Overall Comment",
        "",
        'Please revisit {==this claim==}{>>Needs a source.<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}.',
        "",
      ].join("\n"),
    );

    const persisted = await request.post("/api/review-events", {
      data: {
        projectPath: projectDir,
        path: relativePath,
        overallComment: "Please prioritize the CLI contract.",
      },
    });
    expect(persisted.status()).toBe(201);
    expect(readProjectFile(projectDir, relativePath)).toContain(
      "body: Please prioritize the CLI contract.",
    );

    // The flip lands on the next save the tab makes, so the document has to be
    // read back from the bytes the server wrote and then saved again.
    await openMarkdownFile(page, filePath);
    const rail = page.getByTestId("document-review-rail");
    await expect(rail.getByTestId("comment-rail-c1")).toContainText(
      "Needs a source.",
    );

    await rail
      .getByTestId("comment-rail-c1-action-reply")
      .evaluate((element) => {
        (element as HTMLButtonElement).click();
      });
    await page.getByTestId("comment-rail-c3-editor").fill("Pulled it in.");
    await page
      .getByTestId("comment-rail-c3-action-save")
      .evaluate((element) => {
        (element as HTMLButtonElement).click();
      });

    await expect
      .poll(() => readProjectFile(projectDir, relativePath))
      .toContain("Pulled it in.");
    const saved = readProjectFile(projectDir, relativePath);
    expect(saved).toContain(
      '{>>Needs a source.<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}',
    );
    expect(saved).not.toContain("{#c1}");
    expect(saved).toContain('re="c1"');
    expect(saved).toContain("body: Please prioritize the CLI contract.");

    logE2eEvent("review-handoff.inline-document-survived-overall-comment", {
      file: relativePath,
    });
  });

  test("applies pending approvals in the handoff save and resolves only the approved reply @smoke", async ({
    page,
    request,
  }) => {
    const relativePath = "approve-reply.md";
    const filePath = writeProjectFile(
      projectDir,
      relativePath,
      [
        "# Approve Reply",
        "",
        'This paragraph has {==target text==}{>>Needs detail<<}{id="c1" by="user" at="2026-04-23T18:00:00.000Z"}{>>First answer<<}{id="c2" by="AI" at="2026-04-23T18:01:00.000Z" re="c1"}{>>Newest answer<<}{id="c3" by="AI" at="2026-04-23T18:02:00.000Z" re="c1"}.',
        "",
      ].join("\n"),
    );

    pendingWatch = request.post("/api/review-events/watch", {
      data: {
        projectPath: projectDir,
        path: relativePath,
        timeoutSeconds: 10,
      },
    });

    await openMarkdownFile(page, filePath);
    const rail = page.getByTestId("document-review-rail");
    await expect(rail.getByTestId("comment-rail-c3")).toBeVisible();

    await page.getByTestId("comment-thread-c1").click();
    await rail.getByTestId("comment-rail-c3-action-approve").click();
    await expect(
      rail.getByTestId("comment-rail-c3-approve-confirm"),
    ).toContainText("Approve");
    await rail.getByTestId("comment-rail-c3-action-approve-confirm").click();
    await expect(
      rail.getByTestId("comment-rail-c3-approval-pending"),
    ).toBeVisible();

    // Autosave debounces at 500ms; a pending approval must outlast that
    // without touching the file.
    await page.waitForTimeout(1200);
    expect(readProjectFile(projectDir, relativePath)).toContain(
      "Newest answer",
    );

    await expect(page.getByTestId("review-handoff-button")).toBeVisible();
    await page.getByTestId("review-handoff-button").click();
    await expect(page.getByTestId("review-handoff-status")).toContainText(
      "Your agent is now working",
    );

    await expect
      .poll(() => readProjectFile(projectDir, relativePath))
      .not.toContain("Newest answer");
    const savedMarkdown = readProjectFile(projectDir, relativePath);
    expect(savedMarkdown).toContain("{==target text==}");
    expect(savedMarkdown).toContain("Needs detail");
    expect(savedMarkdown).toContain('id="c1"');
    expect(savedMarkdown).toContain("First answer");
    expect(savedMarkdown).toContain('id="c2"');
    expect(savedMarkdown).not.toContain('id="c3"');
    await expect(rail.getByTestId("comment-rail-c3")).toHaveCount(0);

    const watchResponse = await pendingWatch;
    const payload = await watchResponse.json();
    expect(payload.events).toHaveLength(1);
    expect(payload.events[0]).toMatchObject({ type: "review.completed" });

    logE2eEvent("review-handoff.pending-approval-applied", {
      file: relativePath,
    });
  });

  test("reopens the sent handoff status from the muted primary button", async ({
    page,
    request,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "sent-handoff.md",
      ["# Sent Handoff", "", "Review already completed.", ""].join("\n"),
    );
    const relativePath = "sent-handoff.md";

    pendingWatch = request.post("/api/review-events/watch", {
      data: {
        projectPath: projectDir,
        path: relativePath,
        timeoutSeconds: 10,
      },
    });

    await openMarkdownFile(page, filePath);
    await page.getByTestId("review-handoff-button").click();

    await expect(page.getByTestId("review-handoff-button")).toHaveText("Sent");
    await expect(page.getByTestId("review-handoff-status")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("review-handoff-status")).toBeHidden();

    await page.getByTestId("review-handoff-button").click();

    await expect(page.getByTestId("review-handoff-status")).toBeVisible();
    logE2eEvent("review-handoff.sent-button-reopened-status", {
      buttonLabel: await page.getByTestId("review-handoff-button").innerText(),
    });

    await pendingWatch;
  });
});
