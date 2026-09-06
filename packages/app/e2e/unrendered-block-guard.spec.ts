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
  "Trailing paragraph.",
  "",
  "Another paragraph.",
  "",
].join("\n");

const isMac = process.platform === "darwin";
const cutShortcut = isMac ? "Meta+x" : "Control+x";
const pasteShortcut = isMac ? "Meta+v" : "Control+v";
const selectAllShortcut = isMac ? "Meta+a" : "Control+a";

function placeholder(page: Page) {
  return page.getByTestId("unrendered-block-placeholder");
}

function deletionRefusedNote(page: Page) {
  return page.getByTestId("unrendered-block-deletion-refused");
}

async function chooseEditingMode(page: Page) {
  await chooseMode(page, "editing", "Editing");
}

async function selectPlaceholder(page: Page) {
  await richTextEditor(page).click();
  await placeholder(page).click();
}

async function chooseMode(page: Page, mode: string, label: string) {
  await page.getByTestId("document-mode-trigger").click();
  await page.getByTestId(`document-mode-option-${mode}`).click();
  await expect(page.getByTestId("document-mode-trigger")).toContainText(label);
}

/**
 * Sweep a text range from the paragraph above the placeholder to the end of the
 * document. Shift-arrow leaves the view's own selection behind the browser's,
 * so this is the gesture that reaches ProseMirror as an observed DOM change
 * rather than as a key any handler can decline.
 */
async function sweepRangeAcrossPlaceholder(page: Page) {
  await placeholder(page).click();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+End");
}

/**
 * Drag-select the two paragraphs below the placeholder. A real drag leaves the
 * view's own selection matching what the reader sees, where a shift-arrow sweep
 * does not, so this is the gesture that can assert an unprotected range every
 * run instead of most runs.
 */
async function dragRangeBelowPlaceholder(page: Page) {
  const editorBox = await richTextEditor(page).boundingBox();
  const placeholderBox = await placeholder(page).boundingBox();
  if (!editorBox || !placeholderBox) {
    throw new Error("Could not measure the editor or the placeholder");
  }

  const firstLine = placeholderBox.y + placeholderBox.height + 8;
  await page.mouse.move(editorBox.x + 4, firstLine);
  await page.mouse.down();
  await page.mouse.move(editorBox.x + editorBox.width - 8, firstLine + 40, {
    steps: 10,
  });
  await page.mouse.up();
}

async function expectFileUnchanged(page: Page, projectDir: string) {
  // Autosave only writes when the editor reports a change, so a refused
  // gesture should leave the file exactly as it was written.
  await page.waitForTimeout(1_000);
  expect(readProjectFile(projectDir, "protected.md")).toBe(
    protectedTableMarkdown,
  );
}

function writeProtectedFile(projectDir: string) {
  return writeProjectFile(projectDir, "protected.md", protectedTableMarkdown);
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

    // Each gesture reselects the placeholder first. A refusal releases the
    // caret clear of the block so the reader can carry on typing, so chaining
    // the three would leave the second and third editing ordinary prose.
    await selectPlaceholder(page);
    await page.keyboard.press("Backspace");
    await expect(deletionRefusedNote(page)).toBeVisible();
    await expect(placeholder(page)).toBeVisible();

    await selectPlaceholder(page);
    await page.keyboard.press("Delete");
    await expect(placeholder(page)).toBeVisible();

    await selectPlaceholder(page);
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

  test("refuses a cut of the selected placeholder", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openMarkdownFile(page, writeProtectedFile(projectDir));
    await chooseEditingMode(page);
    await selectPlaceholder(page);

    await page.keyboard.press(cutShortcut);

    await expect(deletionRefusedNote(page)).toBeVisible();
    await expect(placeholder(page)).toBeVisible();
    await expectFileUnchanged(page, projectDir);
  });

  test("refuses a paste over the selected placeholder", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openMarkdownFile(page, writeProtectedFile(projectDir));
    await chooseEditingMode(page);
    await page.evaluate(() => navigator.clipboard.writeText("PASTED"));
    await selectPlaceholder(page);

    await page.keyboard.press(pasteShortcut);

    await expect(deletionRefusedNote(page)).toBeVisible();
    await expect(placeholder(page)).toBeVisible();
    await expectFileUnchanged(page, projectDir);
  });

  test("refuses a text range that sweeps across the placeholder", async ({
    page,
  }) => {
    await openMarkdownFile(page, writeProtectedFile(projectDir));
    await chooseEditingMode(page);
    await richTextEditor(page).click();
    await sweepRangeAcrossPlaceholder(page);

    await page.keyboard.press("Backspace");

    await expect(deletionRefusedNote(page)).toBeVisible();
    await expect(placeholder(page)).toBeVisible();
    await expectFileUnchanged(page, projectDir);
  });

  test("refuses typing over a whole-document selection", async ({ page }) => {
    await openMarkdownFile(page, writeProtectedFile(projectDir));
    await chooseEditingMode(page);
    await richTextEditor(page).click();

    await page.keyboard.press(selectAllShortcut);
    await page.keyboard.type("z");

    await expect(deletionRefusedNote(page)).toBeVisible();
    await expect(placeholder(page)).toBeVisible();
    await expectFileUnchanged(page, projectDir);
  });

  test("leaves a caret typing beside the placeholder alone", async ({
    page,
  }) => {
    await openMarkdownFile(page, writeProtectedFile(projectDir));
    await chooseEditingMode(page);
    await placeholder(page).click();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("End");

    await page.keyboard.type(" tail");

    await expect(deletionRefusedNote(page)).toBeHidden();
    await expect(placeholder(page)).toBeVisible();
    await expect(richTextEditor(page)).toContainText("Flags in use: tail");
  });

  test("deletes a dragged range that holds nothing protected", async ({
    page,
  }) => {
    // Repeated, because the failure this covers was intermittent: a refusal
    // that appears three runs in five reads as a pass on the other two.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await openMarkdownFile(page, writeProtectedFile(projectDir));
      await expect(placeholder(page)).toBeVisible();
      await chooseEditingMode(page);

      await dragRangeBelowPlaceholder(page);
      await page.keyboard.press("Backspace");

      await expect(deletionRefusedNote(page)).toBeHidden();
      await expect(placeholder(page)).toBeVisible();
      await expect(richTextEditor(page)).not.toContainText(
        "Trailing paragraph.",
      );
      await page.waitForTimeout(900);
      expect(readProjectFile(projectDir, "protected.md")).not.toContain(
        "Trailing paragraph.",
      );
    }
  });

  test("lets the reader keep typing after a refusal", async ({ page }) => {
    const typed = "ABCDEFGHIJ";

    // Repeated, because the loss this covers was intermittent in some gestures
    // and total in others: one clean pass proves nothing here.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await openMarkdownFile(page, writeProtectedFile(projectDir));
      await expect(placeholder(page)).toBeVisible();
      await chooseEditingMode(page);

      await placeholder(page).click();
      await page.keyboard.press("Backspace");
      await expect(deletionRefusedNote(page)).toBeVisible();

      // The refusal leaves the caret clear of the block, so this is an
      // ordinary insertion rather than another replacement of the selection
      // that spanned it.
      await page.keyboard.type(typed);

      await expect(richTextEditor(page)).toContainText(typed);
      await expect(placeholder(page)).toBeVisible();
    }
  });

  test("leaves viewing mode untouched", async ({ page }) => {
    await openMarkdownFile(page, writeProtectedFile(projectDir));
    await chooseMode(page, "viewing", "Viewing");
    await selectPlaceholder(page);

    await page.keyboard.press("Backspace");
    await page.keyboard.press("Delete");
    await page.keyboard.type("x");

    await expect(placeholder(page)).toBeVisible();
    await expect(deletionRefusedNote(page)).toBeHidden();
    await expectFileUnchanged(page, projectDir);
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
