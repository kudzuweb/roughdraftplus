import {
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  Pencil,
  Reply,
  Trash2,
  User,
  X,
} from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type MutableRefObject,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./components/ui/tooltip";
import {
  buildCommentThreads,
  type CriticComment,
  type CriticCommentThread,
} from "./critic-markup";
import {
  collapseCommentThread,
  getCommentThreadReplies,
} from "./document-comments";
import { cn } from "./lib/utils";

interface CommentEditorListProps {
  comments: CriticComment[];
  variant?: "banner" | "rail";
  selectedCommentId?: string | null;
  hoveredCommentId?: string | null;
  className?: string;
  testId?: string;
  interactive?: boolean;
  onDeleteComment: (commentId: string) => void;
  onUpdateComment: (commentId: string, nextContent: string) => void;
  onSelectComment?: (commentId: string) => void;
  onHoverComment?: (commentId: string | null) => void;
  onFocusComment?: (commentId: string) => void;
  onReplyComment?: (commentId: string) => void;
  pendingFocusCommentId?: string | null;
  newCommentDraftIds?: string[];
  onAutoFocusComment?: (commentId: string) => void;
  pendingApprovalCommentIds?: string[];
  /**
   * Comments that take the approve action whoever wrote them and wherever
   * they sit in the thread; by default only agent replies do.
   */
  approvableCommentIds?: string[];
  /** Per-comment wording for the pending marker, in place of "Approved". */
  pendingApprovalBadges?: Record<string, PendingApprovalBadge>;
  onApproveComment?: (commentId: string) => void;
  onRevokeApproval?: (commentId: string) => void;
  renderCommentContent?: (context: CommentContentRenderContext) => ReactNode;
  getCommentActions?: (
    context: CommentActionsRenderContext,
  ) => CommentActionDefinition[];
}

export interface PendingApprovalBadge {
  label: string;
  title: string;
}

const DEFAULT_PENDING_APPROVAL_BADGE: PendingApprovalBadge = {
  label: "Approved",
  title: "Resolves when you finish reviewing",
};

export interface CommentActionDefinition {
  key: string;
  label: string;
  tone?: "neutral" | "danger" | "success";
  presentation?: "default" | "popover";
  icon: ReactNode;
  compact?: boolean;
  active?: boolean;
  onClick: (event: MouseEvent) => void;
}

type CommentApprovalState = "none" | "available" | "confirming" | "pending";

export interface CommentContentRenderContext {
  comment: CriticComment;
  depth: number;
  isEditing: boolean;
  defaultContent: ReactNode;
}

export interface CommentActionsRenderContext {
  comment: CriticComment;
  depth: number;
  isEditing: boolean;
  defaultActions: CommentActionDefinition[];
}

interface CommentReplyCollapseState {
  isExpanded: boolean;
  hiddenReplyCount: number;
  onToggle: () => void;
}

interface CommentThreadView {
  thread: CriticCommentThread;
  replyCollapse: CommentReplyCollapseState | null;
}

function isEditableShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable="true"], [role="textbox"]',
    ),
  );
}

function isReplyShortcut(event: KeyboardEvent) {
  return (
    event.key.toLowerCase() === "r" &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey
  );
}

export function CommentEditorList({
  comments,
  variant = "banner",
  selectedCommentId = null,
  hoveredCommentId = null,
  className,
  testId,
  interactive = true,
  onDeleteComment,
  onUpdateComment,
  onSelectComment,
  onHoverComment,
  onFocusComment,
  onReplyComment,
  pendingFocusCommentId = null,
  newCommentDraftIds = [],
  onAutoFocusComment,
  pendingApprovalCommentIds = [],
  approvableCommentIds = [],
  pendingApprovalBadges = {},
  onApproveComment,
  onRevokeApproval,
  renderCommentContent,
  getCommentActions,
}: CommentEditorListProps) {
  const textareaRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editingCommentIds, setEditingCommentIds] = useState<string[]>([]);
  const [expandedThreadIds, setExpandedThreadIds] = useState<string[]>([]);
  const [confirmingApprovalCommentId, setConfirmingApprovalCommentId] =
    useState<string | null>(null);
  const threads = useMemo(() => buildCommentThreads(comments), [comments]);
  const threadViews = useMemo<CommentThreadView[]>(
    () =>
      threads.map((thread) => {
        const rootCommentId = thread.comment.id;
        const collapsed = collapseCommentThread(thread);

        if (collapsed.hiddenReplyCount === 0) {
          return { thread, replyCollapse: null };
        }

        const visibleReplyIds = new Set(
          getCommentThreadReplies(collapsed.thread).map((reply) => reply.id),
        );
        const isEditingHiddenReply = getCommentThreadReplies(thread).some(
          (reply) =>
            !visibleReplyIds.has(reply.id) &&
            editingCommentIds.includes(reply.id),
        );
        const isExpanded =
          expandedThreadIds.includes(rootCommentId) || isEditingHiddenReply;
        const onToggle = () => {
          setExpandedThreadIds((current) =>
            isExpanded
              ? current.filter((threadId) => threadId !== rootCommentId)
              : [...current, rootCommentId],
          );
        };

        return {
          thread: isExpanded ? thread : collapsed.thread,
          replyCollapse: {
            isExpanded,
            hiddenReplyCount: collapsed.hiddenReplyCount,
            onToggle,
          },
        };
      }),
    [editingCommentIds, expandedThreadIds, threads],
  );
  const commentMap = useMemo(
    () => new Map(comments.map((comment) => [comment.id, comment])),
    [comments],
  );
  const hasActiveSelection =
    !!selectedCommentId &&
    comments.some((comment) => comment.id === selectedCommentId);
  const handleKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!interactive || !onReplyComment) return;
    if (!isReplyShortcut(event)) return;
    if (isEditableShortcutTarget(event.target)) return;

    const target = event.target;
    if (!(target instanceof Element)) return;

    const rootThread = target.closest<HTMLElement>(
      "[data-comment-thread-root-id]",
    );
    const rootCommentId = rootThread?.dataset.commentThreadRootId;
    if (!rootCommentId) return;

    event.preventDefault();
    event.stopPropagation();
    onReplyComment(rootCommentId);
  };

  useEffect(() => {
    const validCommentIds = new Set(comments.map((comment) => comment.id));

    setDrafts((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([commentId]) =>
          validCommentIds.has(commentId),
        ),
      ),
    );
    setEditingCommentIds((current) =>
      current.filter((commentId) => validCommentIds.has(commentId)),
    );
    setExpandedThreadIds((current) =>
      current.filter((commentId) => validCommentIds.has(commentId)),
    );
    setConfirmingApprovalCommentId((current) =>
      current && validCommentIds.has(current) ? current : null,
    );
  }, [comments]);

  useEffect(() => {
    // A decision made by another control (reject, edit) supersedes an open
    // approve confirm, which would otherwise come back when it is undone.
    setConfirmingApprovalCommentId((current) =>
      current && pendingApprovalCommentIds.includes(current) ? null : current,
    );
  }, [pendingApprovalCommentIds]);

  useEffect(() => {
    if (!interactive) return;
    if (!pendingFocusCommentId) return;

    const pendingComment = commentMap.get(pendingFocusCommentId);
    if (!pendingComment) return;

    setDrafts((current) => ({
      ...current,
      [pendingFocusCommentId]:
        current[pendingFocusCommentId] ?? pendingComment.content,
    }));
    setEditingCommentIds((current) =>
      current.includes(pendingFocusCommentId)
        ? current
        : [...current, pendingFocusCommentId],
    );
  }, [commentMap, interactive, pendingFocusCommentId]);

  useEffect(() => {
    if (!interactive) return;
    if (!pendingFocusCommentId) return;
    if (!editingCommentIds.includes(pendingFocusCommentId)) return;

    const target = textareaRefs.current.get(pendingFocusCommentId);
    if (!target || target.offsetParent === null) return;

    target.focus();
    const cursorPosition = target.value.length;
    target.setSelectionRange(cursorPosition, cursorPosition);
    onAutoFocusComment?.(pendingFocusCommentId);
  }, [
    editingCommentIds,
    interactive,
    onAutoFocusComment,
    pendingFocusCommentId,
  ]);

  if (comments.length === 0) return null;

  const startEditingComment = (commentId: string) => {
    const comment = commentMap.get(commentId);
    if (!comment) return;

    setDrafts((current) => ({
      ...current,
      [commentId]: current[commentId] ?? comment.content,
    }));
    setEditingCommentIds((current) =>
      current.includes(commentId) ? current : [...current, commentId],
    );
    onSelectComment?.(commentId);
  };

  const stopEditingComment = (commentId: string) => {
    setEditingCommentIds((current) =>
      current.filter((currentCommentId) => currentCommentId !== commentId),
    );
  };

  const submitEditingComment = (commentId: string) => {
    const comment = commentMap.get(commentId);
    if (!comment) return;

    const nextContent = (drafts[commentId] ?? comment.content).trim();

    if (nextContent.length === 0) {
      // A comment that the owner does not actually delete (a suggestion's
      // root, say) would otherwise stay stuck in edit mode.
      onDeleteComment(commentId);
    } else if (nextContent !== comment.content) {
      onUpdateComment(commentId, nextContent);
    }

    setDrafts((current) => {
      const nextDrafts = { ...current };
      delete nextDrafts[commentId];
      return nextDrafts;
    });
    stopEditingComment(commentId);
  };

  const cancelEditingComment = (commentId: string) => {
    const comment = commentMap.get(commentId);
    if (!comment) return;

    setDrafts((current) => {
      const nextDrafts = { ...current };
      delete nextDrafts[commentId];
      return nextDrafts;
    });

    if (comment.content.trim().length === 0) {
      onDeleteComment(commentId);
      return;
    }

    stopEditingComment(commentId);
  };

  return (
    <div
      data-testid={testId}
      data-comment-thread-container="true"
      className={cn(
        variant === "banner"
          ? cn(
              "space-y-2 rounded-xl border border-transparent bg-transparent p-3 shadow-none transition-[background-color,border-color,box-shadow] duration-200 ease-out",
              hasActiveSelection
                ? "border-[#DFDFDC] dark:border-slate-600 bg-white dark:bg-card shadow-[0_20px_48px_rgba(57,47,38,0.14)] dark:shadow-[0_20px_48px_rgba(0,0,0,0.4)]"
                : "",
            )
          : "space-y-1.5 px-4 py-3",
        className,
      )}
      onKeyDownCapture={handleKeyDownCapture}
    >
      {threadViews.map(({ thread, replyCollapse }, index) => (
        <CommentThreadNode
          key={thread.comment.id}
          thread={thread}
          depth={0}
          index={index}
          isLast={index === threadViews.length - 1}
          parentLines={[]}
          replyCollapse={replyCollapse}
          variant={variant}
          interactive={interactive}
          drafts={drafts}
          newCommentDraftIds={newCommentDraftIds}
          editingCommentIds={editingCommentIds}
          pendingFocusCommentId={pendingFocusCommentId}
          selectedCommentId={selectedCommentId}
          hoveredCommentId={hoveredCommentId}
          textareaRefs={textareaRefs}
          onDeleteComment={onDeleteComment}
          onUpdateComment={onUpdateComment}
          onSelectComment={onSelectComment}
          onHoverComment={onHoverComment}
          onFocusComment={onFocusComment}
          onReplyComment={onReplyComment}
          onStartEditingComment={startEditingComment}
          onSubmitEditingComment={submitEditingComment}
          onCancelEditingComment={cancelEditingComment}
          pendingApprovalCommentIds={pendingApprovalCommentIds}
          approvableCommentIds={approvableCommentIds}
          pendingApprovalBadges={pendingApprovalBadges}
          confirmingApprovalCommentId={confirmingApprovalCommentId}
          onConfirmingApprovalChange={setConfirmingApprovalCommentId}
          onApproveComment={onApproveComment}
          onRevokeApproval={onRevokeApproval}
          renderCommentContent={renderCommentContent}
          getCommentActions={getCommentActions}
          onChangeDraft={(commentId, nextContent) => {
            setDrafts((current) => ({
              ...current,
              [commentId]: nextContent,
            }));
          }}
        />
      ))}
    </div>
  );
}

interface CommentThreadNodeProps {
  thread: CriticCommentThread;
  depth: number;
  index: number;
  isLast: boolean;
  parentLines: boolean[];
  replyCollapse?: CommentReplyCollapseState | null;
  variant: "banner" | "rail";
  interactive: boolean;
  drafts: Record<string, string>;
  newCommentDraftIds: string[];
  editingCommentIds: string[];
  pendingFocusCommentId: string | null;
  selectedCommentId: string | null;
  hoveredCommentId: string | null;
  textareaRefs: MutableRefObject<Map<string, HTMLTextAreaElement>>;
  onDeleteComment: (commentId: string) => void;
  onUpdateComment: (commentId: string, nextContent: string) => void;
  onSelectComment?: (commentId: string) => void;
  onHoverComment?: (commentId: string | null) => void;
  onFocusComment?: (commentId: string) => void;
  onReplyComment?: (commentId: string) => void;
  onStartEditingComment: (commentId: string) => void;
  onSubmitEditingComment: (commentId: string) => void;
  onCancelEditingComment: (commentId: string) => void;
  pendingApprovalCommentIds: string[];
  approvableCommentIds: string[];
  pendingApprovalBadges: Record<string, PendingApprovalBadge>;
  confirmingApprovalCommentId: string | null;
  onConfirmingApprovalChange: (commentId: string | null) => void;
  onApproveComment?: (commentId: string) => void;
  onRevokeApproval?: (commentId: string) => void;
  renderCommentContent?: (context: CommentContentRenderContext) => ReactNode;
  getCommentActions?: (
    context: CommentActionsRenderContext,
  ) => CommentActionDefinition[];
  onChangeDraft: (commentId: string, nextContent: string) => void;
}

const COMMENT_TREE_INDENT = 16;
const COMMENT_TREE_ELBOW_TOP = 12;
const COMMENT_TREE_ROW_GAP = 10;
const COMMENT_AVATAR_SIZE = 20;
const COMMENT_AVATAR_CENTER = 12;

function CommentActionButton({
  label,
  testId,
  tone = "neutral",
  presentation = "default",
  icon,
  compact = false,
  active,
  ariaExpanded,
  className,
  onClick,
}: {
  label: string;
  testId?: string;
  tone?: "neutral" | "danger" | "success";
  presentation?: "default" | "popover";
  icon: ReactNode;
  compact?: boolean;
  active?: boolean;
  ariaExpanded?: boolean;
  className?: string;
  onClick: (event: MouseEvent) => void;
}) {
  const button = (
    <Button
      type="button"
      aria-label={compact ? label : undefined}
      aria-expanded={ariaExpanded}
      aria-pressed={active}
      data-testid={testId}
      variant="ghost"
      size={compact ? "icon-xs" : "sm"}
      className={cn(
        presentation === "popover" && !compact
          ? "h-9 w-full rounded-xl bg-[#E8E3DB] px-3 py-2 text-sm font-bold normal-case tracking-normal text-black shadow-[inset_0_1px_0_rgba(255,251,245,0.72)] hover:bg-[#ded8ce] hover:text-black dark:bg-slate-700 dark:text-slate-100 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] dark:hover:bg-slate-600 dark:hover:text-slate-100"
          : compact
            ? "rounded-full border border-transparent transition-colors duration-150"
            : "h-7 rounded-full border border-transparent px-2.5 text-[11px] font-medium tracking-[0.08em] uppercase transition-colors duration-150",
        presentation === "popover"
          ? ""
          : tone === "danger"
            ? active
              ? "bg-rose-100 text-rose-700 hover:bg-rose-200 hover:text-rose-800 dark:bg-rose-900/40 dark:text-rose-400 dark:hover:bg-rose-900/60 dark:hover:text-rose-300"
              : "text-stone-400 hover:bg-rose-100 hover:text-rose-700 dark:text-stone-500 dark:hover:bg-rose-900/40 dark:hover:text-rose-400"
            : tone === "success"
              ? active
                ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200 hover:text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-400 dark:hover:bg-emerald-900/60 dark:hover:text-emerald-300"
                : "text-stone-400 hover:bg-emerald-100 hover:text-emerald-700 dark:text-stone-500 dark:hover:bg-emerald-900/40 dark:hover:text-emerald-400"
              : active
                ? "bg-[#DED8CE]/70 text-stone-700 hover:bg-[#DED8CE] hover:text-stone-800 dark:bg-slate-700 dark:text-stone-200 dark:hover:bg-slate-600 dark:hover:text-stone-100"
                : "text-stone-400 hover:bg-[#DED8CE]/45 hover:text-stone-600 dark:text-stone-500 dark:hover:bg-slate-700 dark:hover:text-stone-300",
        className,
      )}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onClick}
    >
      {icon}
      {compact ? null : <span>{label}</span>}
    </Button>
  );

  if (!compact) return button;

  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function CommentThreadNode({
  thread,
  depth,
  index,
  isLast,
  parentLines,
  replyCollapse = null,
  variant,
  interactive,
  drafts,
  newCommentDraftIds,
  editingCommentIds,
  pendingFocusCommentId,
  selectedCommentId,
  hoveredCommentId,
  textareaRefs,
  onDeleteComment,
  onUpdateComment,
  onSelectComment,
  onHoverComment,
  onFocusComment,
  onReplyComment,
  onStartEditingComment,
  onSubmitEditingComment,
  onCancelEditingComment,
  pendingApprovalCommentIds,
  approvableCommentIds,
  pendingApprovalBadges,
  confirmingApprovalCommentId,
  onConfirmingApprovalChange,
  onApproveComment,
  onRevokeApproval,
  renderCommentContent,
  getCommentActions,
  onChangeDraft,
}: CommentThreadNodeProps) {
  const { comment, replies } = thread;
  const hasReplies = replies.length > 0;
  const replyCollapseLabel = replyCollapse
    ? replyCollapse.isExpanded
      ? "Hide earlier replies"
      : `Show ${replyCollapse.hiddenReplyCount} earlier ${
          replyCollapse.hiddenReplyCount === 1 ? "reply" : "replies"
        }`
    : null;
  const isRootThread = depth === 0;
  const isSelected = comment.id === selectedCommentId;
  const isHovered = comment.id === hoveredCommentId;
  const isEditing = interactive && editingCommentIds.includes(comment.id);
  const isAiAuthor = comment.authorType === "ai";
  const userAuthorId = comment.authorId?.trim();
  const authorLabel = isAiAuthor
    ? "AI"
    : userAuthorId && userAuthorId.toLowerCase() !== "user"
      ? userAuthorId
      : "Me";
  const AuthorIcon = isAiAuthor ? Bot : User;
  const draftContent = drafts[comment.id] ?? comment.content;
  const avatarTone = isAiAuthor
    ? variant === "banner"
      ? "border-sky-200 bg-sky-100 text-sky-700 dark:border-sky-700 dark:bg-sky-900 dark:text-sky-400"
      : "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-700 dark:bg-sky-900 dark:text-sky-400"
    : variant === "banner"
      ? "border-[#D2C7B8] bg-[#DED8CE] text-stone-700 dark:border-slate-600 dark:bg-slate-700 dark:text-stone-300"
      : "border-[#D2C7B8] bg-[#DED8CE] text-stone-700 dark:border-slate-600 dark:bg-slate-700 dark:text-stone-300";
  const bodyTone =
    variant === "banner"
      ? isSelected
        ? "bg-white"
        : isHovered
          ? "bg-white"
          : "bg-transparent"
      : "bg-transparent";
  const treeLineTone =
    variant === "banner"
      ? "bg-[#DED8CE]/90 dark:bg-slate-600/90"
      : "bg-[#DED8CE]/85 dark:bg-slate-600/85";
  const hasCommentContent = comment.content.trim().length > 0;
  const defaultContent = hasCommentContent ? comment.content : "Empty comment";
  const isNewRootCommentDraft =
    isEditing &&
    depth === 0 &&
    (comment.id === pendingFocusCommentId ||
      newCommentDraftIds.includes(comment.id));
  const renderedContent =
    renderCommentContent?.({
      comment,
      depth,
      isEditing,
      defaultContent,
    }) ?? defaultContent;
  const canApprove =
    Boolean(onApproveComment) &&
    (approvableCommentIds.includes(comment.id) || (depth > 0 && isAiAuthor));
  const approvalState: CommentApprovalState = !canApprove
    ? "none"
    : pendingApprovalCommentIds.includes(comment.id)
      ? "pending"
      : confirmingApprovalCommentId === comment.id
        ? "confirming"
        : "available";
  const pendingBadge =
    pendingApprovalBadges[comment.id] ?? DEFAULT_PENDING_APPROVAL_BADGE;
  const approvalActions: CommentActionDefinition[] =
    approvalState === "available"
      ? [
          {
            key: "approve",
            label: "Approve",
            tone: "success",
            icon: <Check className="size-3.5" />,
            compact: true,
            onClick: (event) => {
              event.stopPropagation();
              onConfirmingApprovalChange(comment.id);
            },
          },
        ]
      : approvalState === "pending"
        ? [
            {
              key: "unapprove",
              label: "Undo approval",
              tone: "success",
              active: true,
              icon: <Check className="size-3.5" />,
              compact: true,
              onClick: (event) => {
                event.stopPropagation();
                onRevokeApproval?.(comment.id);
              },
            },
          ]
        : [];
  const defaultActions: CommentActionDefinition[] = isEditing
    ? [
        {
          key: "save",
          label: "Save",
          presentation: isNewRootCommentDraft ? "popover" : "default",
          icon: <Check className="size-3.5" />,
          onClick: (event) => {
            event.stopPropagation();
            onSubmitEditingComment(comment.id);
          },
        },
        {
          key: "cancel",
          label: "Cancel",
          icon: <X className="size-3.5" />,
          onClick: (event) => {
            event.stopPropagation();
            onCancelEditingComment(comment.id);
          },
        },
      ]
    : [
        ...approvalActions,
        {
          key: "reply",
          label: "Reply",
          icon: <Reply className="size-3.5" />,
          compact: true,
          onClick: (event) => {
            event.stopPropagation();
            onReplyComment?.(comment.id);
          },
        },
        {
          key: "edit",
          label: "Edit",
          icon: <Pencil className="size-3.5" />,
          compact: true,
          onClick: (event) => {
            event.stopPropagation();
            onStartEditingComment(comment.id);
          },
        },
        {
          key: "delete",
          label: "Delete",
          tone: "danger",
          icon: <Trash2 className="size-3.5" />,
          compact: true,
          onClick: (event) => {
            event.stopPropagation();
            onDeleteComment(comment.id);
          },
        },
      ];
  const defaultVisibleActions = isNewRootCommentDraft
    ? defaultActions.filter((action) => action.key !== "cancel")
    : defaultActions;
  const actions =
    getCommentActions?.({
      comment,
      depth,
      isEditing,
      defaultActions: defaultVisibleActions,
    }) ?? defaultVisibleActions;
  const nodeRef = useRef<HTMLDivElement>(null);
  const previousApprovalStateRef = useRef<CommentApprovalState>(approvalState);

  useLayoutEffect(() => {
    const previousApprovalState = previousApprovalStateRef.current;
    previousApprovalStateRef.current = approvalState;

    // Each step of the approve swap unmounts the control that was activated,
    // which would drop keyboard focus to the body; hand it to the control
    // that replaced it.
    if (previousApprovalState === approvalState) return;

    // The pending state's undo control is whichever lit action the owner
    // renders, so it is found by its pressed state rather than a fixed key.
    const focusSelector =
      approvalState === "confirming"
        ? `[data-testid="comment-${variant}-${comment.id}-action-approve-confirm"]`
        : approvalState === "pending"
          ? '[aria-pressed="true"]'
          : approvalState === "available" &&
              (previousApprovalState === "confirming" ||
                previousApprovalState === "pending")
            ? `[data-testid="comment-${variant}-${comment.id}-action-approve"]`
            : null;
    if (!focusSelector) return;

    nodeRef.current?.querySelector<HTMLElement>(focusSelector)?.focus();
  }, [approvalState, comment.id, variant]);

  const ancestorGuideOffsets = parentLines.reduce<number[]>(
    (offsets, showLine, guideIndex) => {
      if (showLine) {
        offsets.push(guideIndex * COMMENT_TREE_INDENT + COMMENT_AVATAR_CENTER);
      }
      return offsets;
    },
    [],
  );

  return (
    <div
      ref={nodeRef}
      data-testid={`comment-${variant}-${comment.id}`}
      data-comment-thread-root-id={isRootThread ? comment.id : undefined}
      tabIndex={interactive && isRootThread ? 0 : undefined}
      className={cn(
        "relative transition-all duration-200 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-300 dark:focus-visible:ring-slate-600",
        variant === "rail" &&
          isRootThread &&
          (index > 0
            ? "border-t border-slate-200/80 dark:border-slate-700/80 pt-3"
            : "pt-0"),
      )}
      onClick={() => {
        if (!interactive) return;
        onSelectComment?.(comment.id);
      }}
      onMouseEnter={() => {
        if (!interactive) return;
        onHoverComment?.(comment.id);
      }}
      onMouseLeave={() => {
        if (!interactive) return;
        onHoverComment?.(null);
      }}
      onPointerDown={() => {
        if (!interactive) return;
        onSelectComment?.(comment.id);
      }}
    >
      <div className="relative flex min-w-0 items-stretch">
        {depth > 0 ? (
          <div
            aria-hidden="true"
            className="pointer-events-none relative shrink-0 self-stretch"
            style={{ width: depth * COMMENT_TREE_INDENT }}
          >
            {ancestorGuideOffsets.map((left) => (
              <div
                key={`${comment.id}-guide-${left}`}
                data-testid="comment-tree-line"
                className={cn("absolute top-0 bottom-0 w-px", treeLineTone)}
                style={{
                  left,
                  top: -COMMENT_TREE_ROW_GAP,
                  bottom: -COMMENT_TREE_ROW_GAP,
                }}
              />
            ))}
            <div
              data-testid="comment-tree-line"
              className={cn(
                "absolute w-px",
                treeLineTone,
                isLast ? "" : "bottom-0",
              )}
              style={{
                left: (depth - 1) * COMMENT_TREE_INDENT + COMMENT_AVATAR_CENTER,
                top: -COMMENT_TREE_ROW_GAP,
                ...(isLast
                  ? {
                      height: COMMENT_TREE_ELBOW_TOP + COMMENT_TREE_ROW_GAP,
                    }
                  : {
                      bottom: -COMMENT_TREE_ROW_GAP,
                    }),
              }}
            />
            <div
              data-testid="comment-tree-line"
              className={cn("absolute h-px", treeLineTone)}
              style={{
                left: (depth - 1) * COMMENT_TREE_INDENT + COMMENT_AVATAR_CENTER,
                top: COMMENT_TREE_ELBOW_TOP,
                width: COMMENT_TREE_INDENT,
              }}
            />
          </div>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="relative grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-1.5">
            {interactive && isRootThread ? (
              <CommentActionButton
                label="Delete thread"
                testId={`comment-${variant}-${comment.id}-action-delete-thread`}
                tone="danger"
                icon={<Trash2 className="size-3.5" />}
                compact
                className="absolute top-0 right-0 z-20 bg-white/80 dark:bg-slate-800/80"
                onClick={(event) => {
                  event.stopPropagation();
                  onDeleteComment(comment.id);
                }}
              />
            ) : null}
            {hasReplies ? (
              <div
                aria-hidden="true"
                data-testid="comment-tree-line"
                className={cn(
                  "pointer-events-none absolute w-px",
                  treeLineTone,
                )}
                style={{
                  left: COMMENT_AVATAR_CENTER,
                  top: COMMENT_AVATAR_SIZE,
                  bottom: -COMMENT_TREE_ROW_GAP,
                }}
              />
            ) : null}
            <div className="relative flex justify-center">
              <div
                className={cn(
                  "relative z-10 flex size-5 items-center justify-center rounded-full border shadow-[0_1px_2px_rgba(15,23,42,0.08)]",
                  avatarTone,
                )}
                title={authorLabel}
              >
                <AuthorIcon className="size-2.5 shrink-0" />
              </div>
            </div>
            <div
              className={cn(
                "min-w-0 rounded-xl px-0.5",
                isRootThread && interactive && !isEditing && "pr-7",
                bodyTone,
              )}
            >
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-xs font-semibold text-slate-900 dark:text-slate-100">
                  {authorLabel}
                </span>
                {approvalState === "pending" ? (
                  <span
                    data-testid={`comment-${variant}-${comment.id}-approval-pending`}
                    title={pendingBadge.title}
                    className="shrink-0 rounded-full bg-emerald-100 px-1.5 py-px text-[10px] font-semibold tracking-[0.08em] text-emerald-700 uppercase dark:bg-emerald-900/40 dark:text-emerald-400"
                  >
                    {pendingBadge.label}
                  </span>
                ) : null}
              </div>
              <div
                className={cn(
                  "mt-0.5 text-[13px] leading-5 whitespace-pre-wrap",
                  !hasCommentContent && "italic",
                  variant === "banner"
                    ? "text-slate-800 dark:text-slate-200"
                    : "text-slate-700 dark:text-slate-300",
                )}
              >
                {isEditing ? null : renderedContent}
              </div>
              {isEditing ? (
                <Textarea
                  data-testid={`comment-${variant}-${comment.id}-editor`}
                  ref={(node) => {
                    if (node) {
                      textareaRefs.current.set(comment.id, node);
                    } else {
                      textareaRefs.current.delete(comment.id);
                    }
                  }}
                  value={draftContent}
                  placeholder={
                    depth === 0 ? "Add your comment" : "Write a reply"
                  }
                  rows={1}
                  className={cn(
                    "mt-2 min-h-12 px-2.5 py-2 text-[13px] leading-5 md:text-[13px] md:leading-5",
                    variant === "banner"
                      ? "border-amber-200 dark:border-amber-700 bg-white/90 dark:bg-slate-800/90 text-slate-800 dark:text-slate-200"
                      : "border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 shadow-none",
                  )}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    onSelectComment?.(comment.id);
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                  }}
                  onKeyDown={(event) => {
                    if (
                      (event.metaKey || event.ctrlKey) &&
                      event.key.toLowerCase() === "enter"
                    ) {
                      event.preventDefault();
                      event.stopPropagation();
                      onSubmitEditingComment(comment.id);
                      return;
                    }

                    if (event.key !== "Escape") return;

                    event.preventDefault();
                    event.stopPropagation();
                    onCancelEditingComment(comment.id);
                  }}
                  onFocus={() => {
                    onSelectComment?.(comment.id);
                  }}
                  onChange={(event) => {
                    onChangeDraft(comment.id, event.target.value);
                  }}
                />
              ) : null}
              <div className="mt-2 flex flex-wrap items-center gap-1">
                {approvalState === "confirming" ? (
                  <span
                    data-testid={`comment-${variant}-${comment.id}-approve-confirm`}
                    className="inline-flex items-center gap-0.5 rounded-full border border-emerald-200 bg-emerald-50 py-px pr-0.5 pl-2 text-[11px] font-medium tracking-[0.08em] text-emerald-700 uppercase dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-400"
                  >
                    Approve
                    <CommentActionButton
                      label="Confirm approval"
                      testId={`comment-${variant}-${comment.id}-action-approve-confirm`}
                      tone="success"
                      icon={<Check className="size-3.5" />}
                      compact
                      onClick={(event) => {
                        event.stopPropagation();
                        onConfirmingApprovalChange(null);
                        onApproveComment?.(comment.id);
                      }}
                    />
                    <CommentActionButton
                      label="Cancel approval"
                      testId={`comment-${variant}-${comment.id}-action-approve-cancel`}
                      icon={<X className="size-3.5" />}
                      compact
                      onClick={(event) => {
                        event.stopPropagation();
                        onConfirmingApprovalChange(null);
                      }}
                    />
                  </span>
                ) : null}
                {actions.map((action) => (
                  <CommentActionButton
                    key={action.key}
                    label={action.label}
                    testId={`comment-${variant}-${comment.id}-action-${action.key}`}
                    tone={action.tone}
                    presentation={action.presentation}
                    icon={action.icon}
                    compact={action.compact}
                    active={action.active}
                    onClick={action.onClick}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
      {hasReplies ? (
        <div className="mt-2.5 space-y-2.5">
          {replyCollapse && replyCollapseLabel ? (
            <div
              className="relative flex"
              style={{ paddingLeft: COMMENT_TREE_INDENT }}
            >
              <div
                aria-hidden="true"
                data-testid="comment-tree-line"
                className={cn(
                  "pointer-events-none absolute w-px",
                  treeLineTone,
                )}
                style={{
                  left: COMMENT_AVATAR_CENTER,
                  top: -COMMENT_TREE_ROW_GAP,
                  bottom: -COMMENT_TREE_ROW_GAP,
                }}
              />
              <CommentActionButton
                label={replyCollapseLabel}
                testId={`comment-${variant}-${comment.id}-action-${
                  replyCollapse.isExpanded ? "collapse" : "expand"
                }-replies`}
                icon={
                  replyCollapse.isExpanded ? (
                    <ChevronUp className="size-3.5" />
                  ) : (
                    <ChevronDown className="size-3.5" />
                  )
                }
                ariaExpanded={replyCollapse.isExpanded}
                onClick={(event) => {
                  event.stopPropagation();
                  replyCollapse.onToggle();
                }}
              />
            </div>
          ) : null}
          {replies.map((reply, replyIndex) => (
            <CommentThreadNode
              key={reply.comment.id}
              thread={reply}
              depth={depth + 1}
              index={replyIndex}
              isLast={replyIndex === replies.length - 1}
              parentLines={depth === 0 ? [] : [...parentLines, !isLast]}
              variant={variant}
              interactive={interactive}
              drafts={drafts}
              newCommentDraftIds={newCommentDraftIds}
              editingCommentIds={editingCommentIds}
              pendingFocusCommentId={pendingFocusCommentId}
              selectedCommentId={selectedCommentId}
              hoveredCommentId={hoveredCommentId}
              textareaRefs={textareaRefs}
              onDeleteComment={onDeleteComment}
              onUpdateComment={onUpdateComment}
              onSelectComment={onSelectComment}
              onHoverComment={onHoverComment}
              onFocusComment={onFocusComment}
              onReplyComment={onReplyComment}
              onStartEditingComment={onStartEditingComment}
              onSubmitEditingComment={onSubmitEditingComment}
              onCancelEditingComment={onCancelEditingComment}
              pendingApprovalCommentIds={pendingApprovalCommentIds}
              approvableCommentIds={approvableCommentIds}
              pendingApprovalBadges={pendingApprovalBadges}
              confirmingApprovalCommentId={confirmingApprovalCommentId}
              onConfirmingApprovalChange={onConfirmingApprovalChange}
              onApproveComment={onApproveComment}
              onRevokeApproval={onRevokeApproval}
              renderCommentContent={renderCommentContent}
              getCommentActions={getCommentActions}
              onChangeDraft={onChangeDraft}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
