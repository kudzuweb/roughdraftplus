import { expect, test } from "@playwright/test";
import {
  codeEditor,
  createMarkdownProject,
  logE2eEvent,
  openMarkdownFile,
  removeMarkdownProject,
  richTextEditor,
  writeProjectFile,
} from "./helpers";

test.describe("opening local markdown files", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("open-file");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("shows a placeholder naming a table it cannot render", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "flags.md",
      [
        "# Flags",
        "",
        "| Flag | Meaning |",
        "| --- | --- |",
        "| `a \\| b` | either |",
        "",
        "After the table.",
        "",
      ].join("\n"),
    );

    await openMarkdownFile(page, filePath, "rich-text");

    const placeholder = richTextEditor(page).getByTestId(
      "unrendered-block-placeholder",
    );
    await expect(placeholder).toBeVisible();
    await expect(placeholder).toHaveAttribute("data-block-type", "table");
    await expect(placeholder).toContainText("Table");
    await expect(richTextEditor(page)).toContainText("After the table.");

    logE2eEvent("open-file.unrendered-block-placeholder", {
      file: filePath,
      blockType: "table",
    });
  });

  test("renders core Markdown blocks from a real file @smoke", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "review.md",
      [
        "# Smoke Fixture",
        "",
        "A paragraph with [local link](./notes.md), [anchor](#smoke-fixture), and [mail](mailto:review@example.com).",
        "",
        "- first",
        "- second",
        "",
        "- [x] shipped",
        "- [ ] pending",
        "",
        "| Name | Status |",
        "| --- | --- |",
        "| Roughdraft | ready |",
        "",
        '![Sketch](./images/sketch.png "Sketch title")',
        "",
        "```ts",
        "const value = 1;",
        "```",
        "",
      ].join("\n"),
    );
    writeProjectFile(
      projectDir,
      "images/sketch.png",
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      ),
    );

    await openMarkdownFile(page, filePath);

    const editor = page.getByTestId("rich-text-editor");
    await expect(editor).toContainText("Smoke Fixture");
    await expect(editor).toContainText("first");
    await expect(editor).toContainText("Roughdraft");
    await expect(
      editor.locator('a[data-markdown-src="./notes.md"]', {
        hasText: "local link",
      }),
    ).toBeVisible();
    await expect(
      editor.locator(
        'img[alt="Sketch"][data-markdown-src="./images/sketch.png"]',
      ),
    ).toBeVisible();
    await expect(editor).toContainText("const value = 1;");

    logE2eEvent("open-file.rendered", {
      projectDir,
      file: "review.md",
    });
  });

  test("focuses an existing window for a repeated open request", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "repeat.md",
      "# Repeat Open\n\nExisting window body.\n",
    );

    await openMarkdownFile(page, filePath, "code");
    await expect(codeEditor(page)).toContainText("Existing window body.");

    const targetUrl = `/?${new URLSearchParams({
      path: filePath,
      editor: "code",
    }).toString()}`;
    const response = await page.request.post("/api/open-request", {
      data: { path: filePath, url: targetUrl },
    });

    expect(response.ok()).toBe(true);
    await expect(response.json()).resolves.toEqual({ delivered: true });
    await expect(codeEditor(page)).toContainText("Existing window body.");

    logE2eEvent("open-file.reused-existing-window", {
      projectDir,
      file: "repeat.md",
    });
  });
});
