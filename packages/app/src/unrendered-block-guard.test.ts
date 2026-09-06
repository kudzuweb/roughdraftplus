import { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { AllSelection, NodeSelection, TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it } from "vitest";
import {
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "./critic-markup";
import {
  createEditorExtensions,
  rawMarkdownBlockGuardPluginKey,
} from "./editor-extensions";

const protectedTableMarkdown = [
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

const plainMarkdown = ["First paragraph.", "", "Second paragraph.", ""].join(
  "\n",
);

const editors: Editor[] = [];

afterEach(() => {
  while (editors.length > 0) {
    editors.pop()?.destroy();
  }
});

function createEditor(markdown: string): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);

  const editor = new Editor({
    element,
    extensions: createEditorExtensions(""),
    content: criticMarkdownToEditorState(markdown).doc,
  });
  editors.push(editor);

  return editor;
}

/**
 * Helper: build an editor holding one protected table between prose, the
 * document shape a rich-text reader sees for Markdown that cannot round-trip.
 */
function createEditorWithProtectedTable(): Editor {
  return createEditor(protectedTableMarkdown);
}

function findRawMarkdownBlockPos(editor: Editor): number {
  let found: number | null = null;
  editor.state.doc.descendants((node: ProseMirrorNode, pos: number) => {
    if (found === null && node.type.name === "rawMarkdownBlock") {
      found = pos;
    }
    return found === null;
  });

  if (found === null) {
    throw new Error("Expected the document to hold a rawMarkdownBlock");
  }

  return found;
}

function blockRange(editor: Editor): { from: number; to: number } {
  const from = findRawMarkdownBlockPos(editor);
  const node = editor.state.doc.nodeAt(from);
  if (!node) throw new Error("Expected a rawMarkdownBlock at that position");
  return { from, to: from + node.nodeSize };
}

function selectPlaceholder(editor: Editor): void {
  const { state } = editor.view;
  editor.view.dispatch(
    state.tr.setSelection(
      NodeSelection.create(state.doc, findRawMarkdownBlockPos(editor)),
    ),
  );
}

/**
 * Helper: press one key on the editor's own DOM node, so the keystroke runs
 * through ProseMirror's keymap the way a reader's Backspace does.
 */
function pressKey(editor: Editor, key: string): void {
  editor.view.dom.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
  );
}

function toMarkdown(editor: Editor): string {
  return editorStateToCriticMarkdown(editor.getJSON(), new Map());
}

function countRawMarkdownBlocks(editor: Editor): number {
  let count = 0;
  editor.state.doc.descendants((node: ProseMirrorNode) => {
    if (node.type.name === "rawMarkdownBlock") count += 1;
    return true;
  });
  return count;
}

function refusedPos(editor: Editor): number | null {
  return (
    rawMarkdownBlockGuardPluginKey.getState(editor.state)?.refusedPos ?? null
  );
}

describe("a transaction that would drop a protected block", () => {
  it("is refused when it deletes the block on its own", () => {
    const editor = createEditorWithProtectedTable();
    const { from, to } = blockRange(editor);

    editor.view.dispatch(editor.state.tr.delete(from, to));

    expect(countRawMarkdownBlocks(editor)).toBe(1);
    expect(toMarkdown(editor)).toBe(protectedTableMarkdown);
  });

  it("is refused when it deletes a range that spans the block", () => {
    const editor = createEditorWithProtectedTable();
    const { to } = blockRange(editor);

    editor.view.dispatch(editor.state.tr.delete(1, to + 1));

    expect(countRawMarkdownBlocks(editor)).toBe(1);
    expect(toMarkdown(editor)).toBe(protectedTableMarkdown);
  });

  it("is refused when it replaces the whole document", () => {
    const editor = createEditorWithProtectedTable();
    const { state } = editor.view;

    editor.view.dispatch(
      state.tr.setSelection(new AllSelection(state.doc)).deleteSelection(),
    );

    expect(countRawMarkdownBlocks(editor)).toBe(1);
    expect(toMarkdown(editor)).toBe(protectedTableMarkdown);
  });

  it("is refused when Backspace lands on the selected placeholder", () => {
    const editor = createEditorWithProtectedTable();
    selectPlaceholder(editor);

    pressKey(editor, "Backspace");

    expect(countRawMarkdownBlocks(editor)).toBe(1);
    expect(toMarkdown(editor)).toBe(protectedTableMarkdown);
  });

  it("is refused when Delete lands on the selected placeholder", () => {
    const editor = createEditorWithProtectedTable();
    selectPlaceholder(editor);

    pressKey(editor, "Delete");

    expect(countRawMarkdownBlocks(editor)).toBe(1);
    expect(toMarkdown(editor)).toBe(protectedTableMarkdown);
  });

  it("notes the refusal on the block that would have gone", async () => {
    const editor = createEditorWithProtectedTable();
    const { from, to } = blockRange(editor);
    expect(refusedPos(editor)).toBe(null);

    editor.view.dispatch(editor.state.tr.delete(from, to));
    await Promise.resolve();

    expect(refusedPos(editor)).toBe(from);
  });

  it("clears the refusal note once the reader moves the selection", async () => {
    const editor = createEditorWithProtectedTable();
    const { from, to } = blockRange(editor);
    editor.view.dispatch(editor.state.tr.delete(from, to));
    await Promise.resolve();

    editor.commands.setTextSelection(1);

    expect(refusedPos(editor)).toBe(null);
  });
});

describe("a transaction that keeps every protected block", () => {
  it("goes through when it deletes a range holding nothing protected", () => {
    const editor = createEditorWithProtectedTable();
    const { to } = blockRange(editor);
    const before = editor.state.doc.content.size;

    editor.view.dispatch(
      editor.state.tr.delete(to + 1, editor.state.doc.content.size - 1),
    );

    expect(countRawMarkdownBlocks(editor)).toBe(1);
    expect(editor.state.doc.content.size).toBeLessThan(before);
    expect(refusedPos(editor)).toBe(null);
  });

  it("goes through when the document holds nothing protected", () => {
    const editor = createEditor(plainMarkdown);

    editor.view.dispatch(
      editor.state.tr.delete(1, editor.state.doc.content.size - 1),
    );

    expect(editor.state.doc.textContent).not.toContain("First paragraph.");
  });

  it("goes through for a caret typing beside the placeholder", () => {
    const editor = createEditorWithProtectedTable();
    editor.commands.setTextSelection(1);

    editor.view.dispatch(editor.state.tr.insertText("x", 1, 1));

    expect(countRawMarkdownBlocks(editor)).toBe(1);
    expect(editor.state.doc.textContent).toContain("xFlags in use:");
  });

  it("goes through when a document is loaded over one holding a block", () => {
    const editor = createEditorWithProtectedTable();

    editor.commands.setContent(criticMarkdownToEditorState(plainMarkdown).doc, {
      emitUpdate: false,
    });

    expect(countRawMarkdownBlocks(editor)).toBe(0);
    expect(editor.state.doc.textContent).toContain("First paragraph.");
  });

  it("goes through when undo restores a document without the block", () => {
    const editor = createEditorWithProtectedTable();
    const blocksBefore = countRawMarkdownBlocks(editor);

    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1)),
    );
    editor.view.dispatch(editor.state.tr.insertText("x", 1, 1));
    expect(editor.state.doc.textContent).toContain("xFlags in use:");

    editor.commands.undo();

    expect(countRawMarkdownBlocks(editor)).toBe(blocksBefore);
    expect(editor.state.doc.textContent).not.toContain("xFlags in use:");
  });
});
