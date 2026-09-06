import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CriticChangeKind, CriticComment } from "../src/critic-markup";
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

function queryByTestId(container: HTMLElement, testId: string) {
  return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
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

  async function renderRail(suggestions: CriticChangeRailItem[]) {
    await act(async () => {
      root.render(
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
          onDeleteComment={vi.fn()}
          onUpdateComment={vi.fn()}
          onReplyComment={vi.fn()}
          onSelectComment={vi.fn()}
          onFocusComment={vi.fn()}
          onHoverComment={vi.fn()}
          onAcceptSuggestion={vi.fn()}
          onRejectSuggestion={vi.fn()}
          onReplySuggestion={vi.fn()}
          onSelectSuggestion={vi.fn()}
          onFocusSuggestion={vi.fn()}
          onHoverSuggestion={vi.fn()}
        />,
      );
    });
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
});
