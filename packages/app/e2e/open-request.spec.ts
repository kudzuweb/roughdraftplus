import { expect, test } from "@playwright/test";
import {
  codeEditor,
  createMarkdownProject,
  logE2eEvent,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

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
