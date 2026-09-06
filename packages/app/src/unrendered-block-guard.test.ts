import { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Slice } from "@tiptap/pm/model";
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
].join("\n");

const editors: Editor[] = [];

afterEach(() => {
  while (editors.length > 0) {
    editors.pop()?.destroy();
  }
});

/**
 * Helper: build a tiptap Editor in JSDOM holding one protected table, the
 * document shape a rich-text reader sees for Markdown that cannot round-trip.
 */
function createEditorWithProtectedTable(): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);

  const editor = new Editor({
    element,
    extensions: createEditorExtensions(""),
    content: criticMarkdownToEditorState(protectedTableMarkdown).doc,
  });
  editors.push(editor);

  return editor;
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

function selectPlaceholder(editor: Editor): void {
  const pos = findRawMarkdownBlockPos(editor);
  const { state } = editor.view;
  editor.view.dispatch(
    state.tr.setSelection(NodeSelection.create(state.doc, pos)),
  );
}

/**
 * Helper: press one key on the editor's own DOM node, so the keystroke runs
 * through ProseMirror's keymap the way a reader's Backspace does. Editing mode
 * is what `PageCard` leaves in place when its suggesting-mode handlers decline
 * the event, so the bare editor stands in for it.
 */
function pressKey(editor: Editor, key: string): void {
  editor.view.dom.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
    }),
  );
}

/**
 * Helper: select from the start of the document to its end, the range a reader
 * gets from Select All or a shift-arrow sweep past the placeholder.
 */
function selectWholeDocument(editor: Editor): void {
  const { state } = editor.view;
  editor.view.dispatch(state.tr.setSelection(new AllSelection(state.doc)));
}

/**
 * Helper: select a text range that spans the placeholder without being a node
 * selection on it, which is what shift-arrow produces.
 */
function selectRangeAcrossPlaceholder(editor: Editor): void {
  const { state } = editor.view;
  const blockPos = findRawMarkdownBlockPos(editor);
  const block = state.doc.nodeAt(blockPos);
  if (!block) throw new Error("Expected a rawMarkdownBlock to select across");

  editor.view.dispatch(
    state.tr.setSelection(
      TextSelection.create(state.doc, 1, blockPos + block.nodeSize + 1),
    ),
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

describe("selected unrendered-block placeholder in editing mode", () => {
  it("keeps the protected block when Backspace is pressed", () => {
    const editor = createEditorWithProtectedTable();
    selectPlaceholder(editor);

    pressKey(editor, "Backspace");

    expect(countRawMarkdownBlocks(editor)).toBe(1);
    expect(toMarkdown(editor)).toBe(protectedTableMarkdown);
  });

  it("keeps the protected block when Delete is pressed", () => {
    const editor = createEditorWithProtectedTable();
    selectPlaceholder(editor);

    pressKey(editor, "Delete");

    expect(countRawMarkdownBlocks(editor)).toBe(1);
    expect(toMarkdown(editor)).toBe(protectedTableMarkdown);
  });

  it("keeps the protected block when the reader types over it", () => {
    const editor = createEditorWithProtectedTable();
    selectPlaceholder(editor);

    expect(
      editor.view.someProp("handleTextInput", (handler) =>
        handler(
          editor.view,
          editor.state.selection.from,
          editor.state.selection.to,
          "x",
        ),
      ),
    ).toBe(true);

    expect(countRawMarkdownBlocks(editor)).toBe(1);
    expect(toMarkdown(editor)).toBe(protectedTableMarkdown);
  });

  it("notes the refusal on the placeholder that was selected", () => {
    const editor = createEditorWithProtectedTable();
    selectPlaceholder(editor);

    expect(rawMarkdownBlockGuardPluginKey.getState(editor.state)).toEqual({
      refusedPos: null,
    });

    pressKey(editor, "Backspace");

    expect(rawMarkdownBlockGuardPluginKey.getState(editor.state)).toEqual({
      refusedPos: findRawMarkdownBlockPos(editor),
    });
  });

  it("clears the refusal note once the reader moves the selection", () => {
    const editor = createEditorWithProtectedTable();
    selectPlaceholder(editor);
    pressKey(editor, "Backspace");

    editor.commands.setTextSelection(1);

    expect(rawMarkdownBlockGuardPluginKey.getState(editor.state)).toEqual({
      refusedPos: null,
    });
  });

  it("keeps the protected block when the selection is cut", () => {
    const editor = createEditorWithProtectedTable();
    selectPlaceholder(editor);

    const cut = new Event("cut", { bubbles: true, cancelable: true });
    expect(
      editor.view.someProp("handleDOMEvents", (handlers) =>
        handlers.cut?.(editor.view, cut),
      ),
    ).toBe(true);
    expect(cut.defaultPrevented).toBe(true);

    expect(countRawMarkdownBlocks(editor)).toBe(1);
    expect(toMarkdown(editor)).toBe(protectedTableMarkdown);
  });

  it("keeps the protected block when the selection is pasted over", () => {
    const editor = createEditorWithProtectedTable();
    selectPlaceholder(editor);

    expect(
      editor.view.someProp("handlePaste", (handler) =>
        handler(editor.view, new Event("paste"), Slice.empty),
      ),
    ).toBe(true);

    expect(countRawMarkdownBlocks(editor)).toBe(1);
    expect(toMarkdown(editor)).toBe(protectedTableMarkdown);
  });

  it("keeps the protected block when a text range sweeps across it", () => {
    const editor = createEditorWithProtectedTable();
    selectRangeAcrossPlaceholder(editor);

    pressKey(editor, "Backspace");

    expect(countRawMarkdownBlocks(editor)).toBe(1);
    expect(toMarkdown(editor)).toBe(protectedTableMarkdown);
  });

  it("keeps the protected block when the whole document is selected", () => {
    const editor = createEditorWithProtectedTable();
    selectWholeDocument(editor);

    pressKey(editor, "Backspace");

    expect(countRawMarkdownBlocks(editor)).toBe(1);
    expect(toMarkdown(editor)).toBe(protectedTableMarkdown);
  });

  it("keeps the protected block when the whole document is typed over", () => {
    const editor = createEditorWithProtectedTable();
    selectWholeDocument(editor);

    expect(
      editor.view.someProp("handleTextInput", (handler) =>
        handler(
          editor.view,
          editor.state.selection.from,
          editor.state.selection.to,
          "x",
        ),
      ),
    ).toBe(true);

    expect(countRawMarkdownBlocks(editor)).toBe(1);
    expect(toMarkdown(editor)).toBe(protectedTableMarkdown);
  });

  it("leaves a caret typing beside the placeholder alone", () => {
    const editor = createEditorWithProtectedTable();
    editor.commands.setTextSelection(1);

    expect(
      editor.view.someProp("handleTextInput", (handler) =>
        handler(editor.view, 1, 1, "x"),
      ),
    ).toBeFalsy();
  });

  it("leaves ordinary content deletable", () => {
    const editor = createEditorWithProtectedTable();
    editor.commands.setTextSelection({ from: 1, to: 6 });

    pressKey(editor, "Backspace");

    expect(editor.state.doc.textBetween(1, 9)).not.toContain("Flags");
    expect(countRawMarkdownBlocks(editor)).toBe(1);
  });
});
