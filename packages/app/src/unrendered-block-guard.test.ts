import { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeSelection } from "@tiptap/pm/state";
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

  it("leaves ordinary content deletable", () => {
    const editor = createEditorWithProtectedTable();
    editor.commands.setTextSelection({ from: 1, to: 6 });

    pressKey(editor, "Backspace");

    expect(editor.state.doc.textBetween(1, 9)).not.toContain("Flags");
    expect(countRawMarkdownBlocks(editor)).toBe(1);
  });
});
