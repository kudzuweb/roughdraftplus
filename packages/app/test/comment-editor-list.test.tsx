import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentEditorList } from "../src/CommentEditorList";
import type { CriticComment } from "../src/critic-markup";

function queryByTestId<T extends Element = HTMLElement>(
  container: ParentNode,
  testId: string,
) {
  return container.querySelector<T>(`[data-testid="${testId}"]`);
}

function getByTestId<T extends Element = HTMLElement>(
  container: ParentNode,
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

function createThread(replyCount: number): CriticComment[] {
  const root: CriticComment = {
    id: "root",
    content: "Root comment",
    createdAt: "2026-04-24T00:00:00.000Z",
  };
  const replies = Array.from({ length: replyCount }, (_, index) => ({
    id: `r${index + 1}`,
    content: `Reply ${index + 1}`,
    createdAt: `2026-04-24T00:00:0${index + 1}.000Z`,
    parentCommentId: "root",
  }));

  return [root, ...replies];
}

describe("CommentEditorList reply collapsing", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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

  async function renderList(
    comments: CriticComment[],
    variant: "rail" | "banner" = "rail",
  ) {
    await act(async () => {
      root.render(
        <TooltipProvider>
          <CommentEditorList
            comments={comments}
            variant={variant}
            onDeleteComment={vi.fn()}
            onUpdateComment={vi.fn()}
            onReplyComment={vi.fn()}
          />
        </TooltipProvider>,
      );
    });
  }

  it("renders a thread with one reply in full without a toggle", async () => {
    await renderList(createThread(1));

    expect(queryByTestId(container, "comment-rail-root")).not.toBeNull();
    expect(queryByTestId(container, "comment-rail-r1")).not.toBeNull();
    expect(
      queryByTestId(container, "comment-rail-root-action-expand-replies"),
    ).toBeNull();
    expect(
      queryByTestId(container, "comment-rail-root-action-collapse-replies"),
    ).toBeNull();
  });

  it("collapses a thread with several replies to the anchor plus the newest reply", async () => {
    await renderList(createThread(3));

    expect(queryByTestId(container, "comment-rail-root")).not.toBeNull();
    expect(queryByTestId(container, "comment-rail-r1")).toBeNull();
    expect(queryByTestId(container, "comment-rail-r2")).toBeNull();
    expect(queryByTestId(container, "comment-rail-r3")).not.toBeNull();

    const expandButton = getByTestId<HTMLButtonElement>(
      container,
      "comment-rail-root-action-expand-replies",
    );
    expect(expandButton.textContent).toContain("2 earlier replies");
    expect(expandButton.getAttribute("aria-expanded")).toBe("false");
  });

  it("expands to every reply in order and collapses back to the default", async () => {
    await renderList(createThread(3));

    await click(
      getByTestId(container, "comment-rail-root-action-expand-replies"),
    );

    const visibleIds = [
      ...container.querySelectorAll('[data-testid^="comment-rail-r"]'),
    ]
      .map((element) => element.getAttribute("data-testid"))
      .filter((testId) => /^comment-rail-r\d+$/.test(testId ?? ""));
    expect(visibleIds).toEqual([
      "comment-rail-r1",
      "comment-rail-r2",
      "comment-rail-r3",
    ]);
    expect(
      queryByTestId(container, "comment-rail-root-action-expand-replies"),
    ).toBeNull();

    const collapseButton = getByTestId<HTMLButtonElement>(
      container,
      "comment-rail-root-action-collapse-replies",
    );
    expect(collapseButton.getAttribute("aria-expanded")).toBe("true");
    await click(collapseButton);

    expect(queryByTestId(container, "comment-rail-r1")).toBeNull();
    expect(queryByTestId(container, "comment-rail-r2")).toBeNull();
    expect(queryByTestId(container, "comment-rail-r3")).not.toBeNull();
    expect(
      queryByTestId(container, "comment-rail-root-action-expand-replies"),
    ).not.toBeNull();
  });

  it("applies the same collapsing to the banner variant used in prose", async () => {
    await renderList(createThread(2), "banner");

    expect(queryByTestId(container, "comment-banner-r1")).toBeNull();
    expect(queryByTestId(container, "comment-banner-r2")).not.toBeNull();
    expect(
      getByTestId(container, "comment-banner-root-action-expand-replies")
        .textContent,
    ).toContain("1 earlier reply");
  });

  it("keeps a collapsed thread expanded when a hidden reply is pending focus", async () => {
    const comments = createThread(3);

    await act(async () => {
      root.render(
        <TooltipProvider>
          <CommentEditorList
            comments={comments}
            variant="rail"
            pendingFocusCommentId="r1"
            onDeleteComment={vi.fn()}
            onUpdateComment={vi.fn()}
            onReplyComment={vi.fn()}
          />
        </TooltipProvider>,
      );
    });

    expect(queryByTestId(container, "comment-rail-r1-editor")).not.toBeNull();
    expect(queryByTestId(container, "comment-rail-r2")).not.toBeNull();
  });
});
