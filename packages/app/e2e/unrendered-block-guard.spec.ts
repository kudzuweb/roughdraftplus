import { expect, type Page, test } from "@playwright/test";
import {
  createMarkdownProject,
  logE2eEvent,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  richTextEditor,
  writeProjectFile,
} from "./helpers";

// A pipe inside a code span keeps this table out of rich text, so it reaches
// the editor as the protected atom the placeholder stands for.
const protectedTableMarkdown = [
  "# Unrendered blocks",
  "",
  "Flags in use:",
  "",
  "| Flag | Meaning |",
  "| --- | --- |",
  "| `a \\| b` | either |",
  "",
].join("\n");

function placeholder(page: Page) {
  return page.getByTestId("unrendered-block-placeholder");
}

function deletionRefusedNote(page: Page) {
  return page.getByTestId("unrendered-block-deletion-refused");
}

async function chooseEditingMode(page: Page) {
  await page.getByTestId("document-mode-trigger").click();
  await page.getByTestId("document-mode-option-editing").click();
  await expect(page.getByTestId("document-mode-trigger")).toContainText(
    "Editing",
  );
}

async function selectPlaceholder(page: Page) {
  await richTextEditor(page).click();
  await placeholder(page).click();
}

test.describe("selected unrendered-block placeholder", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("unrendered-block-guard");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("survives Backspace, Delete and typing in editing mode @smoke", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "protected.md",
      protectedTableMarkdown,
    );

    await openMarkdownFile(page, filePath);
    await expect(placeholder(page)).toBeVisible();

    await chooseEditingMode(page);
    await selectPlaceholder(page);

    await page.keyboard.press("Backspace");
    await expect(deletionRefusedNote(page)).toBeVisible();
    await expect(placeholder(page)).toBeVisible();

    await page.keyboard.press("Delete");
    await expect(placeholder(page)).toBeVisible();

    await page.keyboard.type("x");
    await expect(placeholder(page)).toBeVisible();

    // The document is only saved when the editor reports a change, so a
    // refused keystroke should leave the file exactly as it was written.
    await page.waitForTimeout(1_000);
    expect(readProjectFile(projectDir, "protected.md")).toBe(
      protectedTableMarkdown,
    );

    logE2eEvent("unrendered-block-guard.keystrokes-refused", {
      file: "protected.md",
    });
  });

  test("clears the refusal note once the reader moves the selection", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "protected.md",
      protectedTableMarkdown,
    );

    await openMarkdownFile(page, filePath);
    await chooseEditingMode(page);
    await selectPlaceholder(page);

    await page.keyboard.press("Backspace");
    await expect(deletionRefusedNote(page)).toBeVisible();

    await page.keyboard.press("ArrowUp");

    await expect(deletionRefusedNote(page)).toBeHidden();
    await expect(placeholder(page)).toBeVisible();
  });

  test("leaves suggesting mode untouched", async ({ page }) => {
    const filePath = writeProjectFile(
      projectDir,
      "protected.md",
      protectedTableMarkdown,
    );

    await openMarkdownFile(page, filePath);
    await expect(placeholder(page)).toBeVisible();

    await selectPlaceholder(page);
    await page.keyboard.press("Backspace");

    await expect(placeholder(page)).toBeVisible();
    await expect(deletionRefusedNote(page)).toBeHidden();
  });
});
