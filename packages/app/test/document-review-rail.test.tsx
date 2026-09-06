import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type {
  CriticChangeDecision,
  CriticChangeKind,
  CriticComment,
} from "../src/critic-markup";
import {
  type CriticChangeRailItem,
  DocumentReviewRail,
} from "../src/DocumentReviewRail";
import { SUGGESTED_PARAGRAPH_SENTINEL } from "../src/editor-extensions";

function createSuggestion({
  changeId,
  kind,
  oldText = "",
  newText = "",
}: {
  changeId: string;
  kind: CriticChangeKind;
  oldText?: string;
  newText?: string;
}): CriticChangeRailItem {
  return {
    changeId,
    kind,
    oldText,
    newText,
    change: {
      kind,
      changeId,
      createdAt: "2026-04-25T23:55:00.000Z",
      authorType: "user",
    },
    commentIds: [],
    anchorTop: 0,
    anchorBottom: 20,
  };
}

function queryByTestId<T extends HTMLElement = HTMLElement>(
  container: HTMLElement,
  testId: string,
) {
  return container.querySelector<T>(`[data-testid="${testId}"]`);
}

function getByTestId<T extends HTMLElement = HTMLElement>(
  container: HTMLElement,
  testId: string,
) {
  const element = queryByTestId<T>(container, testId);
  expect(element).not.toBeNull();
  return element as T;
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("DocumentReviewRail suggestion labels", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

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

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  async function renderRail(
    suggestions: CriticChangeRailItem[],
    {
      pendingChangeDecisions = [],
      onDecideSuggestion = vi.fn(),
      onRevokeSuggestionDecision = vi.fn(),
      onUpdateComment = vi.fn(),
      onDeleteComment = vi.fn(),
    }: Partial<{
      pendingChangeDecisions: CriticChangeDecision[];
      onDecideSuggestion: ReturnType<typeof vi.fn>;
      onRevokeSuggestionDecision: ReturnType<typeof vi.fn>;
      onUpdateComment: ReturnType<typeof vi.fn>;
      onDeleteComment: ReturnType<typeof vi.fn>;
    }> = {},
  ) {
    await act(async () => {
      root.render(
        <TooltipProvider>
          <DocumentReviewRail
            commentGroups={[]}
            comments={new Map<string, CriticComment>()}
            suggestions={suggestions}
            selectedCommentId={null}
            hoveredCommentId={null}
            selectedChangeId={null}
            hoveredChangeId={null}
            contentHeight={400}
            layout="flow"
            onDeleteComment={onDeleteComment}
            onUpdateComment={onUpdateComment}
            onReplyComment={vi.fn()}
            onSelectComment={vi.fn()}
            onFocusComment={vi.fn()}
            onHoverComment={vi.fn()}
            onReplySuggestion={vi.fn()}
            onSelectSuggestion={vi.fn()}
            onFocusSuggestion={vi.fn()}
            onHoverSuggestion={vi.fn()}
            pendingChangeDecisions={pendingChangeDecisions}
            onDecideSuggestion={onDecideSuggestion}
            onRevokeSuggestionDecision={onRevokeSuggestionDecision}
          />
        </TooltipProvider>,
      );
    });

    return {
      onDecideSuggestion,
      onRevokeSuggestionDecision,
      onUpdateComment,
      onDeleteComment,
    };
  }

  it("labels an insertion with the inserted text", async () => {
    await renderRail([
      createSuggestion({
        changeId: "s1",
        kind: "addition",
        newText: "clearer wording",
      }),
    ]);

    const thread = queryByTestId(container, "suggestion-thread-s1");
    expect(
      queryByTestId(container, "suggestion-thread-s1-inserted-text")
        ?.textContent,
    ).toBe("clearer wording");
    expect(
      queryByTestId(container, "suggestion-thread-s1-deleted-text"),
    ).toBeNull();
    expect(thread?.textContent).not.toContain("Insert:");
    expect(thread?.textContent).not.toContain('"clearer wording"');
  });

  it("labels a deletion with the deleted text", async () => {
    await renderRail([
      createSuggestion({
        changeId: "s2",
        kind: "deletion",
        oldText: "dead text",
      }),
    ]);

    const thread = queryByTestId(container, "suggestion-thread-s2");
    expect(
      queryByTestId(container, "suggestion-thread-s2-deleted-text")
        ?.textContent,
    ).toBe("dead text");
    expect(
      queryByTestId(container, "suggestion-thread-s2-inserted-text"),
    ).toBeNull();
    expect(thread?.textContent).not.toContain("Delete:");
    expect(thread?.textContent).not.toContain('"dead text"');
  });

  it("labels a substitution with the old text followed by the new text", async () => {
    await renderRail([
      createSuggestion({
        changeId: "s3",
        kind: "substitution-old",
        oldText: "old phrase",
        newText: "new phrase",
      }),
    ]);

    const thread = queryByTestId(container, "suggestion-thread-s3");
    const threadText = thread?.textContent ?? "";
    expect(
      queryByTestId(container, "suggestion-thread-s3-deleted-text")
        ?.textContent,
    ).toBe("old phrase");
    expect(
      queryByTestId(container, "suggestion-thread-s3-inserted-text")
        ?.textContent,
    ).toBe("new phrase");
    expect(threadText.indexOf("old phrase")).toBeLessThan(
      threadText.indexOf("new phrase"),
    );
    expect(threadText).not.toContain("Replace:");
    expect(threadText).not.toContain("with");
  });

  it("keeps the placeholder for an inserted paragraph and truncates long text", async () => {
    const longInsertedText = "x".repeat(150);
    await renderRail([
      createSuggestion({
        changeId: "s4",
        kind: "addition",
        newText: SUGGESTED_PARAGRAPH_SENTINEL,
      }),
      createSuggestion({
        changeId: "s5",
        kind: "addition",
        newText: longInsertedText,
      }),
    ]);

    expect(
      queryByTestId(container, "suggestion-thread-s4")?.textContent,
    ).toContain("Inserted paragraph");
    expect(
      queryByTestId(container, "suggestion-thread-s5-inserted-text")
        ?.textContent,
    ).toBe(`${"x".repeat(140)}...`);
  });

  it("offers approve, reject and edit on an insertion and a substitution, and no edit on a deletion", async () => {
    await renderRail([
      createSuggestion({ changeId: "s1", kind: "addition", newText: "new" }),
      createSuggestion({
        changeId: "s2",
        kind: "substitution-old",
        oldText: "old",
        newText: "new",
      }),
      createSuggestion({ changeId: "s3", kind: "deletion", oldText: "gone" }),
    ]);

    for (const changeId of ["s1", "s2", "s3"]) {
      expect(
        queryByTestId(container, `comment-rail-${changeId}-action-approve`),
      ).not.toBeNull();
      expect(
        queryByTestId(container, `comment-rail-${changeId}-action-reject`),
      ).not.toBeNull();
      expect(
        queryByTestId(container, `comment-rail-${changeId}-action-accept`),
      ).toBeNull();
    }
    expect(
      queryByTestId(container, "comment-rail-s1-action-edit"),
    ).not.toBeNull();
    expect(
      queryByTestId(container, "comment-rail-s2-action-edit"),
    ).not.toBeNull();
    expect(queryByTestId(container, "comment-rail-s3-action-edit")).toBeNull();
  });

  it("records an accept decision only after the inline confirm", async () => {
    const { onDecideSuggestion } = await renderRail([
      createSuggestion({ changeId: "s1", kind: "addition", newText: "new" }),
    ]);

    await click(getByTestId(container, "comment-rail-s1-action-approve"));
    expect(onDecideSuggestion).not.toHaveBeenCalled();
    expect(
      getByTestId(container, "comment-rail-s1-approve-confirm").textContent,
    ).toContain("Approve");

    await click(
      getByTestId(container, "comment-rail-s1-action-approve-confirm"),
    );

    expect(onDecideSuggestion).toHaveBeenCalledWith({
      changeId: "s1",
      action: "accept",
    });
  });

  it("records a reject decision from the reject action", async () => {
    const { onDecideSuggestion } = await renderRail([
      createSuggestion({
        changeId: "s2",
        kind: "substitution-old",
        oldText: "old",
        newText: "new",
      }),
    ]);

    await click(getByTestId(container, "comment-rail-s2-action-reject"));

    expect(onDecideSuggestion).toHaveBeenCalledWith({
      changeId: "s2",
      action: "reject",
    });
  });

  it("records an edit decision with the reviewer's text, starting from the mark's new text", async () => {
    const { onDecideSuggestion, onUpdateComment } = await renderRail([
      createSuggestion({
        changeId: "s2",
        kind: "substitution-old",
        oldText: "old phrase",
        newText: "new phrase",
      }),
    ]);

    await click(getByTestId(container, "comment-rail-s2-action-edit"));
    const editor = getByTestId<HTMLTextAreaElement>(
      container,
      "comment-rail-s2-editor",
    );
    expect(editor.value).toBe("new phrase");

    await act(async () => {
      setTextareaValue(editor, "newer phrase");
      await Promise.resolve();
    });
    await click(getByTestId(container, "comment-rail-s2-action-save"));

    expect(onDecideSuggestion).toHaveBeenCalledWith({
      changeId: "s2",
      action: "edit",
      text: "newer phrase",
    });
    expect(onUpdateComment).not.toHaveBeenCalled();
  });

  it("cancels an edit saved empty without recording a decision or deleting anything", async () => {
    const { onDecideSuggestion, onDeleteComment } = await renderRail([
      createSuggestion({ changeId: "s1", kind: "addition", newText: "new" }),
    ]);

    await click(getByTestId(container, "comment-rail-s1-action-edit"));
    await act(async () => {
      setTextareaValue(
        getByTestId<HTMLTextAreaElement>(container, "comment-rail-s1-editor"),
        "",
      );
      await Promise.resolve();
    });
    await click(getByTestId(container, "comment-rail-s1-action-save"));

    expect(onDecideSuggestion).not.toHaveBeenCalled();
    expect(onDeleteComment).not.toHaveBeenCalled();
    expect(queryByTestId(container, "comment-rail-s1-editor")).toBeNull();
  });

  it("shows each pending decision with its marker and a lit undo, hiding the other actions", async () => {
    const suggestions = [
      createSuggestion({ changeId: "s1", kind: "addition", newText: "one" }),
      createSuggestion({ changeId: "s2", kind: "addition", newText: "two" }),
      createSuggestion({
        changeId: "s3",
        kind: "substitution-old",
        oldText: "old",
        newText: "three",
      }),
    ];
    const { onRevokeSuggestionDecision } = await renderRail(suggestions, {
      pendingChangeDecisions: [
        { changeId: "s1", action: "accept" },
        { changeId: "s2", action: "reject" },
        { changeId: "s3", action: "edit", text: "edited three" },
      ],
    });

    expect(
      getByTestId(container, "comment-rail-s1-approval-pending").textContent,
    ).toBe("Approved");
    expect(
      getByTestId(container, "comment-rail-s2-approval-pending").textContent,
    ).toBe("Rejected");
    expect(
      getByTestId(container, "comment-rail-s3-approval-pending").textContent,
    ).toBe("Edited");
    expect(
      getByTestId(container, "suggestion-thread-s3-inserted-text").textContent,
    ).toBe("edited three");
    expect(
      getByTestId(container, "suggestion-thread-s3-deleted-text").textContent,
    ).toBe("old");

    for (const changeId of ["s1", "s2", "s3"]) {
      expect(
        queryByTestId(container, `comment-rail-${changeId}-action-approve`),
      ).toBeNull();
      expect(
        queryByTestId(container, `comment-rail-${changeId}-action-reject`),
      ).toBeNull();
      expect(
        queryByTestId(container, `comment-rail-${changeId}-action-edit`),
      ).toBeNull();
    }

    await click(getByTestId(container, "comment-rail-s1-action-unapprove"));
    await click(getByTestId(container, "comment-rail-s2-action-unreject"));
    await click(getByTestId(container, "comment-rail-s3-action-unedit"));

    expect(onRevokeSuggestionDecision.mock.calls).toEqual([
      ["s1"],
      ["s2"],
      ["s3"],
    ]);
  });
});
