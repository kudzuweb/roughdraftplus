import { Extension, Mark, Node, mergeAttributes } from "@tiptap/core";
import Code from "@tiptap/extension-code";
import CodeBlock from "@tiptap/extension-code-block";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { Table } from "@tiptap/extension-table";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableRow } from "@tiptap/extension-table-row";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import type {
  Mark as ProseMirrorMark,
  Node as ProseMirrorNode,
} from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Transform } from "@tiptap/pm/transform";
import type { EditorView } from "@tiptap/pm/view";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ReactNodeViewRenderer } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  markdownSoftBreakAttribute,
  markdownTableSeparatorAttribute,
  rawMarkdownBlockAttribute,
  rawMarkdownBlockTypeAttribute,
} from "./markdown";
import {
  rawMarkdownBlockDeletionRefusedDecoration,
  UnrenderedBlockPlaceholder,
} from "./UnrenderedBlockPlaceholder";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    commentRef: {
      setCommentRef: (attributes: { commentIds: string[] }) => ReturnType;
      removeCommentIds: (
        commentIds: Iterable<string>,
        options?: { disposableCommentIds?: Iterable<string> },
      ) => ReturnType;
      unsetCommentRef: () => ReturnType;
    };
    criticChange: {
      setCriticChange: (attributes: CriticChangeAttrs) => ReturnType;
      unsetCriticChange: () => ReturnType;
      acceptCriticChange: (changeId: string) => ReturnType;
      rejectCriticChange: (changeId: string) => ReturnType;
      editCriticChange: (changeId: string, text: string) => ReturnType;
    };
  }
}

export type CriticChangeKind =
  | "addition"
  | "deletion"
  | "substitution-old"
  | "substitution-new";

export interface CriticChangeAttrs {
  kind: CriticChangeKind;
  changeId: string;
  authorType?: "user" | "ai";
  authorId?: string | null;
  createdAt: string;
}

/**
 * A reviewer's ruling on one suggestion mark. Accept collapses the mark to
 * its final text, reject restores the original text, and edit replaces the
 * whole mark with what the reviewer typed. All three leave plain prose.
 */
export type CriticChangeDecision =
  | { changeId: string; action: "accept" }
  | { changeId: string; action: "reject" }
  | { changeId: string; action: "edit"; text: string };

export const SUGGESTED_PARAGRAPH_SENTINEL = "\u2060";

const CommentRef = Mark.create({
  name: "commentRef",
  priority: 1100,
  inclusive: false,
  spanning: true,

  addAttributes() {
    return {
      commentIds: {
        default: [],
        parseHTML: (element) => {
          const ids = element.getAttribute("data-comment-ids");

          if (!ids) return [];

          try {
            return JSON.parse(ids);
          } catch {
            return [];
          }
        },
        renderHTML: (attributes) =>
          attributes.commentIds?.length
            ? { "data-comment-ids": JSON.stringify(attributes.commentIds) }
            : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-comment-ids]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        class: "comment-anchor",
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setCommentRef:
        (attributes) =>
        ({ commands }) =>
          commands.setMark(this.name, attributes),
      removeCommentIds:
        (commentIds, options) =>
        ({ tr, state, dispatch }) => {
          const markType = state.schema.marks.commentRef;

          if (!markType) return false;

          const removedIds = new Set(commentIds);

          if (removedIds.size === 0) return false;

          // The whole set of comments leaving the document is known here, so
          // an anchor emptied by that set is judged once against every id it
          // carried — the rule applyPendingApprovalsToCriticMarkdown applies
          // in code view. Deciding per comment instead would spare the anchor
          // of a flagged thread that has replies, since the flagged root
          // leaves while its replies still hold the mark.
          const disposableIds = new Set(options?.disposableCommentIds ?? []);
          let found = false;
          // Anchor text that was written only to carry a thread leaves with
          // it. Ranges are collected during the walk and deleted from the end
          // so earlier positions stay valid.
          const disposedRanges: Array<{ from: number; to: number }> = [];

          state.doc.descendants((node, pos) => {
            if (!isInlineAtomOrText(node)) return;

            const mark = node.marks.find(
              (candidate) =>
                candidate.type === markType &&
                Array.isArray(candidate.attrs.commentIds) &&
                (candidate.attrs.commentIds as string[]).some((id) =>
                  removedIds.has(id),
                ),
            );

            if (!mark) return;

            found = true;

            const from = pos;
            const to = pos + node.nodeSize;
            const currentIds = mark.attrs.commentIds as string[];
            const nextIds = currentIds.filter((id) => !removedIds.has(id));

            tr.removeMark(from, to, markType);

            if (nextIds.length > 0) {
              tr.addMark(from, to, markType.create({ commentIds: nextIds }));
            } else if (currentIds.some((id) => disposableIds.has(id))) {
              disposedRanges.push({ from, to });
            }
          });

          for (let index = disposedRanges.length - 1; index >= 0; index -= 1) {
            const range = disposedRanges[index];
            if (range) {
              tr.delete(range.from, range.to);
            }
          }

          if (found && dispatch) {
            dispatch(tr);
          }

          return found;
        },
      unsetCommentRef:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
});

function isCriticChangeKind(value: unknown): value is CriticChangeKind {
  return (
    value === "addition" ||
    value === "deletion" ||
    value === "substitution-old" ||
    value === "substitution-new"
  );
}

function readCriticChangeAttrs(element: HTMLElement): CriticChangeAttrs | null {
  const kind = element.getAttribute("data-critic-change-kind");
  const changeId = element.getAttribute("data-critic-change-id");
  const createdAt = element.getAttribute("data-critic-change-at");

  if (!isCriticChangeKind(kind) || !changeId || !createdAt) {
    return null;
  }

  const rawBy = element.getAttribute("data-critic-change-by") || "user";
  const authorType = rawBy.toUpperCase() === "AI" ? "ai" : "user";

  return {
    kind,
    changeId,
    authorType,
    authorId: authorType === "ai" ? null : rawBy,
    createdAt,
  };
}

// Text and inline atoms such as the soft break can carry a change mark, so a
// suggestion covers a wrap point instead of skipping it. Block nodes never can.
export function isInlineAtomOrText(node: ProseMirrorNode): boolean {
  return node.isInline && node.isAtom;
}

function collectCriticChangeRanges(doc: ProseMirrorNode, changeId: string) {
  const markType = doc.type.schema.marks.criticChange;
  const ranges: Array<{
    from: number;
    to: number;
    kind: CriticChangeKind;
    mark: ProseMirrorMark;
  }> = [];

  if (!markType) return ranges;

  doc.descendants((node, pos) => {
    if (!isInlineAtomOrText(node)) return;

    const mark = node.marks.find(
      (candidate) =>
        candidate.type === markType &&
        candidate.attrs.changeId === changeId &&
        isCriticChangeKind(candidate.attrs.kind),
    );

    if (!mark) return;

    const kind = mark.attrs.kind as CriticChangeKind;
    const previous = ranges[ranges.length - 1];

    if (
      previous &&
      previous.to === pos &&
      previous.kind === kind &&
      previous.mark.eq(mark)
    ) {
      previous.to = pos + node.nodeSize;
      return;
    }

    ranges.push({
      from: pos,
      to: pos + node.nodeSize,
      kind,
      mark,
    });
  });

  return ranges;
}

function findSuggestedParagraphSentinels(
  doc: ProseMirrorNode,
  from: number,
  to: number,
) {
  const positions: number[] = [];

  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText || !node.text) return;

    let index = node.text.indexOf(SUGGESTED_PARAGRAPH_SENTINEL);
    while (index >= 0) {
      positions.push(pos + index);
      index = node.text.indexOf(SUGGESTED_PARAGRAPH_SENTINEL, index + 1);
    }
  });

  return positions;
}

function isOnlyTextblockContent(
  doc: ProseMirrorNode,
  from: number,
  to: number,
) {
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);

  return (
    $from.sameParent($to) &&
    $from.parent.isTextblock &&
    from === $from.start() &&
    to === $from.end()
  );
}

function acceptCriticChangeInTransform(tr: Transform, changeId: string) {
  const markType = tr.doc.type.schema.marks.criticChange;
  if (!markType) return false;

  const ranges = collectCriticChangeRanges(tr.doc, changeId);
  if (ranges.length === 0) return false;

  for (const range of [...ranges].reverse()) {
    if (range.kind === "deletion" || range.kind === "substitution-old") {
      tr.delete(range.from, range.to);
    } else {
      const sentinelPositions = findSuggestedParagraphSentinels(
        tr.doc,
        range.from,
        range.to,
      );
      // Map through this range's own deletions only: in a chain the
      // transform already carries earlier commands' steps, and the range
      // was collected from the document those steps produced.
      const stepsBefore = tr.steps.length;

      for (const position of [...sentinelPositions].reverse()) {
        tr.delete(position, position + SUGGESTED_PARAGRAPH_SENTINEL.length);
      }

      const mapping = tr.mapping.slice(stepsBefore);
      tr.removeMark(
        mapping.map(range.from, -1),
        mapping.map(range.to, -1),
        markType,
      );
    }
  }

  return true;
}

function rejectCriticChangeInTransform(tr: Transform, changeId: string) {
  const markType = tr.doc.type.schema.marks.criticChange;
  if (!markType) return false;

  const ranges = collectCriticChangeRanges(tr.doc, changeId);
  if (ranges.length === 0) return false;

  for (const range of [...ranges].reverse()) {
    if (range.kind === "addition" || range.kind === "substitution-new") {
      const sentinelPositions = findSuggestedParagraphSentinels(
        tr.doc,
        range.from,
        range.to,
      );
      if (
        sentinelPositions.length > 0 &&
        isOnlyTextblockContent(tr.doc, range.from, range.to)
      ) {
        const $from = tr.doc.resolve(range.from);
        tr.delete($from.before(), $from.after());
      } else {
        tr.delete(range.from, range.to);
      }
    } else {
      tr.removeMark(range.from, range.to, markType);
    }
  }

  return true;
}

function editCriticChangeInTransform(
  tr: Transform,
  changeId: string,
  text: string,
) {
  const schema = tr.doc.type.schema;
  if (!schema.marks.criticChange) return false;

  const ranges = collectCriticChangeRanges(tr.doc, changeId);
  if (ranges.length === 0) return false;

  // The rail editor trims what the reviewer types, so the mark's own edge
  // whitespace is what keeps the edited words spaced from the prose.
  const finalText = ranges
    .filter(
      (range) => range.kind === "addition" || range.kind === "substitution-new",
    )
    .map((range) => tr.doc.textBetween(range.from, range.to, "", " "))
    .join("");
  const leadingWhitespace =
    finalText.trim().length === 0
      ? finalText
      : (finalText.match(/^\s*/)?.[0] ?? "");
  const trailingWhitespace =
    finalText.trim().length === 0 ? "" : (finalText.match(/\s*$/)?.[0] ?? "");
  const replacement = `${/^\s/.test(text) ? "" : leadingWhitespace}${text}${
    /\s$/.test(text) ? "" : trailingWhitespace
  }`;

  for (const range of [...ranges].reverse()) {
    tr.delete(range.from, range.to);
  }

  if (replacement.length === 0) return true;

  // Every later range was deleted first, so the first range still starts
  // where it did.
  const insertAt = ranges[0].from;
  const proseMarks = tr.doc
    .resolve(insertAt)
    .marks()
    .filter(
      (mark) =>
        mark.type.name !== "criticChange" && mark.type.name !== "commentRef",
    );
  tr.insert(insertAt, schema.text(replacement, proseMarks));

  return true;
}

/**
 * Applies one reviewer decision to a suggestion mark on a transform that
 * need not belong to a mounted editor. Returns false when the document has
 * no mark with that id, leaving the transform untouched.
 */
export function applyCriticChangeDecision(
  tr: Transform,
  decision: CriticChangeDecision,
) {
  switch (decision.action) {
    case "accept":
      return acceptCriticChangeInTransform(tr, decision.changeId);
    case "reject":
      return rejectCriticChangeInTransform(tr, decision.changeId);
    case "edit":
      return editCriticChangeInTransform(tr, decision.changeId, decision.text);
  }
}

const CriticChange = Mark.create({
  name: "criticChange",
  priority: 1090,
  inclusive: false,
  spanning: true,

  addAttributes() {
    return {
      kind: {
        default: "addition",
        parseHTML: (element) =>
          readCriticChangeAttrs(element as HTMLElement)?.kind ?? "addition",
        renderHTML: (attributes) => ({
          "data-critic-change-kind": attributes.kind,
        }),
      },
      changeId: {
        default: null,
        parseHTML: (element) =>
          readCriticChangeAttrs(element as HTMLElement)?.changeId ?? null,
        renderHTML: (attributes) =>
          attributes.changeId
            ? { "data-critic-change-id": attributes.changeId }
            : {},
      },
      authorType: {
        default: "user",
        parseHTML: (element) =>
          readCriticChangeAttrs(element as HTMLElement)?.authorType ?? "user",
        renderHTML: () => ({}),
      },
      authorId: {
        default: "user",
        parseHTML: (element) =>
          readCriticChangeAttrs(element as HTMLElement)?.authorId ?? "user",
        renderHTML: (attributes) => ({
          "data-critic-change-by":
            attributes.authorType === "ai"
              ? "AI"
              : attributes.authorId || "user",
        }),
      },
      createdAt: {
        default: null,
        parseHTML: (element) =>
          readCriticChangeAttrs(element as HTMLElement)?.createdAt ?? null,
        renderHTML: (attributes) =>
          attributes.createdAt
            ? { "data-critic-change-at": attributes.createdAt }
            : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-critic-change-kind]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        class: `critic-change critic-change-${HTMLAttributes["data-critic-change-kind"]}`,
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setCriticChange:
        (attributes) =>
        ({ commands }) =>
          commands.setMark(this.name, attributes),
      unsetCriticChange:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
      acceptCriticChange:
        (changeId) =>
        ({ state, dispatch }) => {
          const tr = state.tr;
          if (!acceptCriticChangeInTransform(tr, changeId)) return false;
          if (dispatch) dispatch(tr);
          return true;
        },
      rejectCriticChange:
        (changeId) =>
        ({ state, dispatch }) => {
          const tr = state.tr;
          if (!rejectCriticChangeInTransform(tr, changeId)) return false;
          if (dispatch) dispatch(tr);
          return true;
        },
      editCriticChange:
        (changeId, text) =>
        ({ state, dispatch }) => {
          const tr = state.tr;
          if (!editCriticChangeInTransform(tr, changeId, text)) return false;
          if (dispatch) dispatch(tr);
          return true;
        },
    };
  },
});

interface CommentHighlightMeta {
  selectedCommentId: string | null;
  hoveredCommentId: string | null;
}

interface CommentHighlightPluginState extends CommentHighlightMeta {
  decorations: DecorationSet;
}

interface CriticChangeHighlightMeta {
  selectedChangeId: string | null;
  hoveredChangeId: string | null;
}

interface CriticChangeHighlightPluginState extends CriticChangeHighlightMeta {
  decorations: DecorationSet;
}

export const commentHighlightPluginKey =
  new PluginKey<CommentHighlightPluginState>("commentHighlight");
export const criticChangeHighlightPluginKey =
  new PluginKey<CriticChangeHighlightPluginState>("criticChangeHighlight");

function createCommentHighlightDecorations(
  doc: ProseMirrorNode,
  selectedCommentId: string | null,
  hoveredCommentId: string | null,
) {
  const commentMarkType = doc.type.schema.marks.commentRef;
  const changeMarkType = doc.type.schema.marks.criticChange;
  const decorations: Decoration[] = [];

  if (!commentMarkType) {
    return DecorationSet.create(doc, decorations);
  }

  doc.descendants((node: ProseMirrorNode, pos: number) => {
    if (!isInlineAtomOrText(node)) return;

    const commentIds = [
      ...new Set(
        node.marks.flatMap((mark: ProseMirrorMark) =>
          mark.type === commentMarkType && Array.isArray(mark.attrs.commentIds)
            ? mark.attrs.commentIds
            : [],
        ),
      ),
    ];

    if (commentIds.length === 0) return;

    const isSelected =
      !!selectedCommentId && commentIds.includes(selectedCommentId);
    const isHovered =
      !!hoveredCommentId && commentIds.includes(hoveredCommentId);
    const classNames = ["comment-decoration"];

    if (isSelected) {
      classNames.push("comment-decoration-active");
    } else if (isHovered) {
      classNames.push("comment-decoration-hovered");
    }

    if (
      changeMarkType &&
      node.marks.some((mark) => mark.type === changeMarkType)
    ) {
      classNames.push("comment-decoration-on-critic-change");
    }

    decorations.push(
      Decoration.inline(pos, pos + node.nodeSize, {
        class: classNames.join(" "),
        "data-testid": classNames.includes(
          "comment-decoration-on-critic-change",
        )
          ? "comment-decoration-on-critic-change"
          : "comment-decoration",
      }),
    );
  });

  return DecorationSet.create(doc, decorations);
}

const CommentHighlight = Extension.create({
  name: "commentHighlight",

  addProseMirrorPlugins() {
    return [
      new Plugin<CommentHighlightPluginState>({
        key: commentHighlightPluginKey,
        state: {
          init: (_, state) => ({
            selectedCommentId: null,
            hoveredCommentId: null,
            decorations: createCommentHighlightDecorations(
              state.doc,
              null,
              null,
            ),
          }),
          apply: (tr, pluginState) => {
            const meta = tr.getMeta(commentHighlightPluginKey) as
              | CommentHighlightMeta
              | undefined;

            if (!meta && !tr.docChanged) {
              return pluginState;
            }

            const selectedCommentId =
              meta !== undefined
                ? meta.selectedCommentId
                : pluginState.selectedCommentId;
            const hoveredCommentId =
              meta !== undefined
                ? meta.hoveredCommentId
                : pluginState.hoveredCommentId;

            return {
              selectedCommentId,
              hoveredCommentId,
              decorations: createCommentHighlightDecorations(
                tr.doc,
                selectedCommentId,
                hoveredCommentId,
              ),
            };
          },
        },
        props: {
          decorations: (state) =>
            commentHighlightPluginKey.getState(state)?.decorations ?? null,
        },
      }),
    ];
  },
});

function createCriticChangeHighlightDecorations(
  doc: ProseMirrorNode,
  selectedChangeId: string | null,
  hoveredChangeId: string | null,
) {
  const changeMarkType = doc.type.schema.marks.criticChange;
  const decorations: Decoration[] = [];

  if (!changeMarkType) {
    return DecorationSet.create(doc, decorations);
  }

  doc.descendants((node: ProseMirrorNode, pos: number) => {
    if (!isInlineAtomOrText(node)) return;

    const changeIds = [
      ...new Set(
        node.marks.flatMap((mark: ProseMirrorMark) =>
          mark.type === changeMarkType &&
          typeof mark.attrs.changeId === "string"
            ? [mark.attrs.changeId]
            : [],
        ),
      ),
    ];

    if (changeIds.length === 0) return;

    const isSelected =
      !!selectedChangeId && changeIds.includes(selectedChangeId);
    const isHovered = !!hoveredChangeId && changeIds.includes(hoveredChangeId);

    if (!isSelected && !isHovered) return;

    const changeKind = node.marks.find(
      (mark) =>
        mark.type === changeMarkType &&
        typeof mark.attrs.changeId === "string" &&
        changeIds.includes(mark.attrs.changeId) &&
        isCriticChangeKind(mark.attrs.kind),
    )?.attrs.kind as CriticChangeKind | undefined;
    decorations.push(
      Decoration.inline(pos, pos + node.nodeSize, {
        "data-testid": isSelected
          ? "critic-change-decoration-active"
          : "critic-change-decoration-hovered",
        class: [
          isSelected
            ? "critic-change-decoration-active"
            : "critic-change-decoration-hovered",
          changeKind ? `critic-change-decoration-${changeKind}` : null,
        ]
          .filter(Boolean)
          .join(" "),
      }),
    );
  });

  return DecorationSet.create(doc, decorations);
}

const CriticChangeHighlight = Extension.create({
  name: "criticChangeHighlight",

  addProseMirrorPlugins() {
    return [
      new Plugin<CriticChangeHighlightPluginState>({
        key: criticChangeHighlightPluginKey,
        state: {
          init: (_, state) => ({
            selectedChangeId: null,
            hoveredChangeId: null,
            decorations: createCriticChangeHighlightDecorations(
              state.doc,
              null,
              null,
            ),
          }),
          apply: (tr, pluginState) => {
            const meta = tr.getMeta(criticChangeHighlightPluginKey) as
              | CriticChangeHighlightMeta
              | undefined;

            if (!meta && !tr.docChanged) {
              return pluginState;
            }

            const selectedChangeId =
              meta !== undefined
                ? meta.selectedChangeId
                : pluginState.selectedChangeId;
            const hoveredChangeId =
              meta !== undefined
                ? meta.hoveredChangeId
                : pluginState.hoveredChangeId;

            return {
              selectedChangeId,
              hoveredChangeId,
              decorations: createCriticChangeHighlightDecorations(
                tr.doc,
                selectedChangeId,
                hoveredChangeId,
              ),
            };
          },
        },
        props: {
          decorations: (state) =>
            criticChangeHighlightPluginKey.getState(state)?.decorations ?? null,
        },
      }),
    ];
  },
});

const MarkdownLink = Link.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      title: {
        default: null,
        parseHTML: (element) => element.getAttribute("title"),
        renderHTML: (attributes) =>
          attributes.title ? { title: attributes.title } : {},
      },
      dataMarkdownSrc: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-markdown-src"),
        renderHTML: (attributes) =>
          attributes.dataMarkdownSrc
            ? { "data-markdown-src": attributes.dataMarkdownSrc }
            : {},
      },
      dataMarkdownAutolink: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-markdown-autolink"),
        renderHTML: (attributes) =>
          attributes.dataMarkdownAutolink
            ? { "data-markdown-autolink": attributes.dataMarkdownAutolink }
            : {},
      },
    };
  },
});

const MarkdownCode = Code.extend({
  excludes: "bold italic strike link",
});

const MarkdownCodeBlock = CodeBlock.extend({
  marks: "commentRef criticChange",
});

const MarkdownImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      title: {
        default: null,
        parseHTML: (element) => element.getAttribute("title"),
        renderHTML: (attributes) =>
          attributes.title ? { title: attributes.title } : {},
      },
      dataMarkdownSrc: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-markdown-src"),
        renderHTML: (attributes) =>
          attributes.dataMarkdownSrc
            ? { "data-markdown-src": attributes.dataMarkdownSrc }
            : {},
      },
    };
  },
});

const RawMarkdownBlock = Node.create({
  name: "rawMarkdownBlock",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      rawMarkdown: {
        default: "",
        parseHTML: (element) =>
          element.getAttribute(rawMarkdownBlockAttribute) ?? "",
        renderHTML: (attributes) => ({
          [rawMarkdownBlockAttribute]: attributes.rawMarkdown ?? "",
        }),
      },
      blockType: {
        default: "block",
        parseHTML: (element) =>
          element.getAttribute(rawMarkdownBlockTypeAttribute) ?? "block",
        renderHTML: (attributes) => ({
          [rawMarkdownBlockTypeAttribute]: attributes.blockType ?? "block",
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: `div[${rawMarkdownBlockAttribute}]`, priority: 1000 }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(UnrenderedBlockPlaceholder);
  },
});

/** Position of the placeholder whose deletion was just refused, if any. */
export interface RawMarkdownBlockGuardState {
  refusedPos: number | null;
}

export const rawMarkdownBlockGuardPluginKey =
  new PluginKey<RawMarkdownBlockGuardState>("rawMarkdownBlockGuard");

/**
 * Position of the first protected block inside a range that is about to be
 * replaced, or null when the range holds none. An empty range never matches:
 * a bare caret deletes nothing on its own, and ProseMirror answers Backspace
 * beside an atom by selecting it, which is the state this guard then refuses.
 */
function rawMarkdownBlockPosInRange(
  state: EditorState,
  from: number,
  to: number,
): number | null {
  if (from >= to) return null;

  let found: number | null = null;
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (found !== null) return false;
    if (node.type.name === "rawMarkdownBlock") {
      found = pos;
      return false;
    }
    return true;
  });

  return found;
}

/**
 * Position of the first protected block this transaction would delete, or null
 * when it would delete none. Textblocks are not descended into, so the walk
 * stays cheap enough to run on every transaction.
 */
function firstDeletedRawMarkdownBlockPos(
  tr: Transaction,
  doc: ProseMirrorNode,
): number | null {
  let found: number | null = null;

  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === "rawMarkdownBlock") {
      if (tr.mapping.mapResult(pos).deleted) found = pos;
      return false;
    }
    return !node.isTextblock;
  });

  return found;
}

/**
 * Protects an unrendered-block placeholder from every gesture that would
 * replace it. The placeholder is clickable, so a selected atom takes its
 * Markdown with it on Backspace, Delete, the next character typed, a cut or a
 * paste, and autosave writes the loss to disk with nothing to undo it from. A
 * range selection that merely spans the placeholder does the same.
 *
 * Two layers do the work, because no single one sees every route. The input
 * handlers refuse the gesture before it happens and mark the block so the
 * placeholder can say why. `filterTransaction` is the backstop: a shift-arrow
 * range leaves `state.selection` behind the browser's own DOM selection, so
 * that deletion reaches ProseMirror as an observed DOM change rather than as a
 * key the handlers can decline. Only a rule about the document catches it.
 *
 * The two exemptions are the ways a protected block may legitimately leave:
 * `preventUpdate` marks tiptap's `setContent`, which is how a document is
 * loaded or reloaded from disk, and the history meta marks an undo or redo.
 *
 * Suggesting mode never reaches this plugin: `PageCard` claims key presses,
 * text input and paste in its own editor props, which ProseMirror consults
 * before any plugin's, and its own Cmd-X branch stops a cut before the DOM
 * event exists. Viewing mode never reaches it either, because ProseMirror runs
 * its edit handlers only on an editable view. The priority keeps the guard
 * ahead of the base keymap, which would otherwise delete the node before the
 * guard saw the key.
 */
const RawMarkdownBlockGuard = Extension.create({
  name: "rawMarkdownBlockGuard",
  priority: 1000,

  addProseMirrorPlugins() {
    const { editor } = this;

    const refuseRange = (
      view: EditorView,
      from: number,
      to: number,
    ): boolean => {
      const refusedPos = rawMarkdownBlockPosInRange(view.state, from, to);
      if (refusedPos === null) return false;

      view.dispatch(
        view.state.tr.setMeta(rawMarkdownBlockGuardPluginKey, { refusedPos }),
      );
      return true;
    };

    const refuseSelection = (view: EditorView): boolean =>
      refuseRange(view, view.state.selection.from, view.state.selection.to);

    return [
      new Plugin<RawMarkdownBlockGuardState>({
        key: rawMarkdownBlockGuardPluginKey,
        state: {
          init: () => ({ refusedPos: null }),
          apply(tr, value) {
            const meta = tr.getMeta(rawMarkdownBlockGuardPluginKey) as
              | RawMarkdownBlockGuardState
              | undefined;
            if (meta) return meta;
            if (value.refusedPos === null) return value;
            return tr.docChanged || tr.selectionSet
              ? { refusedPos: null }
              : value;
          },
        },
        filterTransaction(tr, state) {
          if (!tr.docChanged) return true;
          // `PluginKey("history")` resolves to this string, and reading it by
          // name keeps the guard from importing the history plugin.
          if (tr.getMeta("history$")) return true;
          if (tr.getMeta("preventUpdate") !== undefined) return true;

          const refusedPos = firstDeletedRawMarkdownBlockPos(tr, state.doc);
          if (refusedPos === null) return true;

          // The transaction is being rejected, so the position still points at
          // the block in the document that stays. Dispatching the note has to
          // wait until this dispatch has finished.
          queueMicrotask(() => {
            editor.view.dispatch(
              editor.state.tr.setMeta(rawMarkdownBlockGuardPluginKey, {
                refusedPos,
              }),
            );
          });
          return false;
        },
        props: {
          handleKeyDown(view, event) {
            if (event.key !== "Backspace" && event.key !== "Delete") {
              return false;
            }
            return refuseSelection(view);
          },
          handleTextInput(view, from, to) {
            return refuseRange(view, from, to);
          },
          handlePaste(view) {
            return refuseSelection(view);
          },
          handleDOMEvents: {
            // `runCustomHandler` consults these before ProseMirror's own cut
            // handler, which otherwise dispatches a bare `deleteSelection()`.
            // Preventing the default also stops the browser removing the DOM
            // under the node view.
            cut(view, event) {
              if (!refuseSelection(view)) return false;
              event.preventDefault();
              return true;
            },
          },
          decorations(state) {
            const refusedPos =
              rawMarkdownBlockGuardPluginKey.getState(state)?.refusedPos ??
              null;
            if (refusedPos === null) return null;

            const node = state.doc.nodeAt(refusedPos);
            if (!node) return null;

            return DecorationSet.create(state.doc, [
              Decoration.node(
                refusedPos,
                refusedPos + node.nodeSize,
                {},
                { [rawMarkdownBlockDeletionRefusedDecoration]: true },
              ),
            ]);
          },
        },
      }),
    ];
  },
});

const MarkdownTable = Table.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      markdownSeparator: {
        default: null,
        parseHTML: (element) =>
          element.getAttribute(markdownTableSeparatorAttribute),
        renderHTML: (attributes) =>
          attributes.markdownSeparator
            ? {
                [markdownTableSeparatorAttribute]: attributes.markdownSeparator,
              }
            : {},
      },
    };
  },
});

// A newline inside a paragraph, blockquote, or list item in the source.
// Rendered as a space so the editor reflows prose, and written back as the
// newline the author typed so a save does not join wrapped lines.
const MarkdownSoftBreak = Node.create({
  name: "markdownSoftBreak",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,

  parseHTML() {
    return [{ tag: `span[${markdownSoftBreakAttribute}]` }];
  },

  renderHTML() {
    return ["span", { [markdownSoftBreakAttribute]: "" }, " "];
  },

  renderText() {
    return " ";
  },

  extendNodeSchema(extension) {
    return extension.name === "markdownSoftBreak"
      ? { leafText: () => " " }
      : {};
  },
});

export function createEditorExtensions(placeholder: string) {
  return [
    StarterKit.configure({
      heading: {
        levels: [1, 2, 3],
      },
      code: false,
      codeBlock: false,
      link: false,
    }),
    Placeholder.configure({
      placeholder,
    }),
    MarkdownLink.configure({
      autolink: true,
      openOnClick: false,
      linkOnPaste: true,
    }),
    MarkdownCode,
    MarkdownTable.configure({
      resizable: true,
    }),
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    TaskItem.configure({
      nested: true,
    }),
    CommentRef,
    CriticChange,
    RawMarkdownBlock,
    RawMarkdownBlockGuard,
    MarkdownSoftBreak,
    MarkdownCodeBlock,
    CommentHighlight,
    CriticChangeHighlight,
    MarkdownImage.configure({
      allowBase64: true,
      inline: false,
    }),
  ];
}
