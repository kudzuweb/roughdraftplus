import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentWorkspace } from "../src/DocumentWorkspace";
import type { Page, StorageBackend } from "../src/storage";

const plainTable = [
  "| Name | Status |",
  "| --- | --- |",
  "| Roughdraft | ready |",
].join("\n");

const pipeInCodeSpanTable = [
  "| Flag | Meaning |",
  "| --- | --- |",
  "| `a \\| b` | either |",
].join("\n");

const escapedPipeTable = [
  "| Symbol | Meaning |",
  "| --- | --- |",
  "| \\| | vertical bar |",
].join("\n");

function createBackend(): StorageBackend {
  return {
    info: {
      kind: "local-storage",
      label: "Test backend",
      detail: "In-memory",
    },
    canManageProjects: false,
    async getMarkdownFile(relativePath) {
      return { id: relativePath, title: relativePath, content: "" };
    },
    async saveMarkdownFile() {
      return undefined;
    },
    async saveAsset(file) {
      return {
        markdownPath: file.name,
        previewUrl: `file://${file.name}`,
        mimeType: file.type || "application/octet-stream",
      };
    },
    resolveFileUrl(path) {
      return `file://${path}`;
    },
    async openProject() {},
  };
}

function createPage(content: string): Page {
  return { id: "test-doc", title: "Test Doc", content };
}

function setupDomMocks() {
  if (!("ResizeObserver" in globalThis)) {
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    });
  }

  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { ready: Promise.resolve() },
  });

  window.scrollBy = vi.fn();
}

function queryAllPlaceholders(container: ParentNode) {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      '[data-testid="unrendered-block-placeholder"]',
    ),
  );
}

describe("unrendered block placeholder", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    setupDomMocks();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  async function renderWorkspace(documentContent: string) {
    await act(async () => {
      root.render(
        <DocumentWorkspace
          documentPage={createPage(documentContent)}
          activeDocumentPath="test.md"
          documentCopyPath="test.md"
          documentFilenameLabel="test.md"
          documentEditorViewMode="rich-text"
          onDocumentEditorViewModeChange={() => {}}
          onSaveDocument={async () => {}}
          onDocumentSaveStateChange={() => {}}
          onDocumentDirtyStateChange={() => {}}
          onDocumentLocalContentChange={() => {}}
          documentDiskChangeState="clean"
          documentForceResetKey={null}
          onReloadDocumentFromDisk={() => {}}
          onKeepEditingWithoutAutosave={() => {}}
          onOverwriteDocumentOnDisk={() => {}}
          onCompleteReview={async () => ({ delivered: false })}
          backend={createBackend()}
        />,
      );
      await Promise.resolve();
    });

    const editor = container.querySelector<HTMLElement>(
      '[data-testid="rich-text-editor"]',
    );
    expect(editor).not.toBeNull();
    return editor as HTMLElement;
  }

  it("shows a placeholder naming the block where a table cannot be rendered", async () => {
    const editor = await renderWorkspace(
      `# Doc\n\nBefore.\n\n${pipeInCodeSpanTable}\n\nAfter.\n`,
    );

    const placeholders = queryAllPlaceholders(editor);
    expect(placeholders).toHaveLength(1);

    const placeholder = placeholders[0] as HTMLElement;
    expect(placeholder.getAttribute("data-block-type")).toBe("table");
    expect(placeholder.textContent).toContain("Table");
    expect(placeholder.textContent).not.toBe("");

    expect(editor.textContent).toContain("Before.");
    expect(editor.textContent).toContain("After.");
  });

  it("shows one placeholder per unrendered table and none for a table that renders", async () => {
    const editor = await renderWorkspace(
      [plainTable, pipeInCodeSpanTable, escapedPipeTable].join("\n\n"),
    );

    const placeholders = queryAllPlaceholders(editor);
    expect(placeholders).toHaveLength(2);
    expect(
      placeholders.map((placeholder) =>
        placeholder.getAttribute("data-block-type"),
      ),
    ).toEqual(["table", "table"]);
    expect(
      editor.querySelectorAll("table"), // selector-check-ignore: tables carry no test id
    ).toHaveLength(1);
  });

  it("names non-table blocks by their own type", async () => {
    const editor = await renderWorkspace(
      "Intro.\n\n<!-- keep this source note -->\n\n<details>\n<summary>More</summary>\n\nHidden.\n\n</details>\n",
    );

    expect(
      queryAllPlaceholders(editor).map((placeholder) =>
        placeholder.getAttribute("data-block-type"),
      ),
    ).toEqual(["html-comment", "details"]);
  });
});
