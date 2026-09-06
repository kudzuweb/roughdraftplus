import {
  generateHTML,
  generateJSON,
  getSchema,
  type JSONContent,
} from "@tiptap/core";
import { Transform } from "@tiptap/pm/transform";
import {
  Marked,
  type RendererThis,
  type Token,
  type TokenizerAndRendererExtension,
  type TokenizerThis,
  type Tokens,
} from "marked";
import type TurndownService from "turndown";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  applyCriticChangeDecision,
  createEditorExtensions,
  type CriticChangeAttrs,
  type CriticChangeDecision,
  type CriticChangeKind,
} from "../editor-extensions";
import {
  createMarkedRenderer,
  createTurndownService,
  placeholderSoftBreakSpans,
  normalizeBlockSpacing,
  appendYamlEndmatter,
  prependYamlFrontmatter,
  protectRichTextRoundTripMarkdown,
  splitYamlDocumentMetadata,
  strictStrikethroughTokenizer,
  type MarkdownOptions,
} from "../markdown";

export interface CriticComment {
  id: string;
  content: string;
  createdAt: string;
  authorType?: "user" | "ai";
  authorId?: string | null;
  parentCommentId?: string | null;
  scope?: "document";
  anchor?: "disposable";
}

export interface CriticCommentThread {
  comment: CriticComment;
  replies: CriticCommentThread[];
}

export interface ReviewIdCounters {
  comments: number;
  suggestions: number;
}

export type { CriticChangeAttrs, CriticChangeDecision, CriticChangeKind };

interface CriticCommentToken {
  type: "criticCommentAnchor";
  raw: string;
  commentIds: string[];
  tokens: Token[];
}

interface CriticStandaloneCommentToken {
  type: "criticStandaloneComment";
  raw: string;
  commentIds: string[];
}

interface CriticChangeToken {
  type: "criticChange";
  raw: string;
  change: CriticChangeAttrs;
  commentIds: string[];
  tokens?: Token[];
  oldTokens?: Token[];
  newTokens?: Token[];
}

const extensions = createEditorExtensions("");
// Text written between review delimiters would otherwise reopen or close the
// marker holding it, so every delimiter is written with a leading backslash and
// read back without it. A comment body is a plain string and unescapes through
// `unescapeCriticMarkupText`. Marker text is Markdown and stays escaped through
// the lexer, which both consumes the escapes and keeps a typed delimiter from
// becoming a marker. The lexer consumes those escapes, but not all of them:
// `unescapeInertMarkerTokens` strips the ones that survive it, without which
// the next save escaped them again and the backslashes doubled on every save.
const criticDelimiterEscapePattern =
  /\\|\{==|==\}|\{>>|<<\}|\{\+\+|\+\+\}|\{--|--\}|\{~~|~~\}|~>/g;
const criticDelimiterUnescapePattern =
  /\\(\\|\{==|==\}|\{>>|<<\}|\{\+\+|\+\+\}|\{--|--\}|\{~~|~~\}|~>)/g;
// Scanning for a marker's closing delimiter treats a backslash as covering the
// character after it, which is what makes an escaped delimiter literal. A
// document written before escaping existed can end a marker's text with a bare
// backslash, and that scan reads it as escaping the close. Each marker
// therefore has a legacy form as well, which reads every backslash as ordinary
// text, tried when the escape-aware form does not match. Both forms come from
// one shape so they cannot drift.
//
// What bounds the escape-aware form is that a marker's text cannot contain an
// unescaped opening delimiter: an unescaped opener is another marker starting,
// so the text ended before it. Without that bound the scan ran on to a later
// marker's closing delimiter and the first marker swallowed everything between,
// taking the marker in between with it. The bound never fires on a document
// this format wrote, because every opener in its marker text is escaped.
const markerOpenerAlternatives = String.raw`\{==|\{>>|\{\+\+|\{--|\{~~`;
const markerTextAtom = String.raw`(?:\\[\s\S]|(?!${markerOpenerAlternatives})[^\\])`;
const legacyMarkerTextAtom = String.raw`[\s\S]`;

interface MarkerPattern {
  escaped: RegExp;
  legacy: RegExp;
}

function markerPattern(build: (textAtom: string) => string): MarkerPattern {
  return {
    escaped: new RegExp(build(markerTextAtom)),
    legacy: new RegExp(build(legacyMarkerTextAtom)),
  };
}

function matchMarker(src: string, pattern: MarkerPattern) {
  return src.match(pattern.escaped) ?? src.match(pattern.legacy);
}

const criticCommentAnchorPattern = markerPattern(
  (text) => String.raw`^\{==(${text}+?)==\}`,
);
const criticCommentBlockPattern = markerPattern(
  (text) =>
    String.raw`^\{>>(${text}*?)<<\}(?:(\{@([\s\S]+?)@\})|(\{(?:\s*[A-Za-z][A-Za-z0-9_-]*="(?:\\[\s\S]|[^"\\])*")+\s*\})|(\{#[A-Za-z][A-Za-z0-9_-]*\}))?`,
);
const criticAdditionPattern = markerPattern(
  (text) => String.raw`^\{\+\+(${text}+?)\+\+\}`,
);
const criticDeletionPattern = markerPattern(
  (text) => String.raw`^\{--(${text}+?)--\}`,
);
const criticSubstitutionPattern = markerPattern(
  (text) => String.raw`^\{~~(${text}+?)~>(${text}+?)~~\}`,
);
const attributeMetadataBlockPattern =
  /^\{(?:\s*[A-Za-z][A-Za-z0-9_-]*="(?:\\[\s\S]|[^"\\])*")+\s*\}/;
const metadataAttributePattern =
  /([A-Za-z][A-Za-z0-9_-]*)="((?:\\[\s\S]|[^"\\])*)"/g;
const metadataReferencePattern = /^\{#([A-Za-z][A-Za-z0-9_-]*)\}$/;
const unanchoredCommentSentinel = "\u2060";

interface ParsedEndmatter {
  comments: Map<string, Record<string, unknown>>;
  suggestions: Map<string, Record<string, unknown>>;
  counters: ReviewIdCounters;
  data: Record<string, unknown> | null;
}

export function escapeCriticMarkupText(text: string): string {
  return text.replace(criticDelimiterEscapePattern, "\\$&");
}

export function unescapeCriticMarkupText(text: string): string {
  return text.replace(criticDelimiterUnescapePattern, "$1");
}

function isAutolinkToken(token: Tokens.Link): boolean {
  return token.raw.startsWith("<") && token.raw.endsWith(">");
}

// Marker text is lexed while still escaped, which is what keeps a delimiter the
// reviewer typed from becoming a marker, and the lexer consumes the escapes as
// it goes. It does not consume all of them, and the ones that survive have two
// separate causes, so a reader that enumerates only the first misses the rest:
//
//  - Markdown leaves a backslash alone in a code span, an autolink and raw
//    HTML, so text taken from those still carries this format's escapes.
//  - `createTurndownService` escapes backslashes itself when it writes a quoted
//    link or image title, and this format's escape then escapes that. Reading
//    peels the serializer's layer and leaves this one.
//
// Either way a backslash survives into the next save, which escapes it again
// and doubles it. Both are stripped here. Every other token has already had its
// escapes consumed, and unescaping it a second time would eat a backslash the
// reviewer typed.
//
// Two of the branches below cannot be covered by a test today, for opposite
// reasons, and the difference is why one is absent and one is present:
//
//  - Raw HTML is on the first list and has no branch. Its content is destroyed
//    before it ever reaches the writer, so unescaping it could not change a
//    byte of any output, under this editor or a later one.
//  - An image title has a branch that no test can reach. An image title is
//    written back intact on every save; only the image's position changes,
//    because the editor lifts an inline image out of its paragraph and so
//    carries it out of the marker, and marker text is the only input this walk
//    ever sees. Fix that and an image title behaves exactly like a link title,
//    which does double without this branch. Deleting it as dead code would
//    reintroduce that doubling through a change that looks unrelated.
function unescapeInertMarkerTokens(tokens: Token[]): Token[] {
  for (const token of tokens) {
    if (token.type === "codespan") {
      token.text = unescapeCriticMarkupText(token.text);
      continue;
    }

    if (token.type === "image") {
      const image = token as Tokens.Image;
      if (image.title) {
        image.title = unescapeCriticMarkupText(image.title);
      }
      continue;
    }

    if (token.type === "link") {
      const link = token as Tokens.Link;

      if (isAutolinkToken(link)) {
        link.href = unescapeCriticMarkupText(link.href);
        link.text = unescapeCriticMarkupText(link.text);
        for (const child of link.tokens ?? []) {
          if (child.type === "text") {
            child.text = unescapeCriticMarkupText(child.text);
          }
        }
        continue;
      }

      if (link.title) {
        link.title = unescapeCriticMarkupText(link.title);
      }
    }

    const childTokens = (token as Tokens.Generic).tokens;
    if (Array.isArray(childTokens)) {
      unescapeInertMarkerTokens(childTokens);
    }
  }

  return tokens;
}

function lexMarkerText(lexer: TokenizerThis["lexer"], text: string): Token[] {
  return unescapeInertMarkerTokens(lexer.inlineTokens(text));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function parseLegacyMetadata(
  metadataText?: string,
): Partial<Omit<CriticComment, "content">> {
  const fields = new Map<string, string>();

  for (const part of metadataText?.split(";") ?? []) {
    const [rawKey, ...valueParts] = part.split(":");
    const key = rawKey?.trim();
    const value = valueParts.join(":").trim();

    if (!key || !value) continue;
    fields.set(key, value);
  }

  const author = fields.get("by") ?? "user";

  return {
    id: fields.get("id"),
    createdAt: fields.get("at") ?? new Date().toISOString(),
    authorType: author.toUpperCase() === "AI" ? "ai" : "user",
    authorId: author.toUpperCase() === "AI" ? null : author,
    parentCommentId: fields.get("re") ?? null,
  };
}

function unescapeMetadataAttributeValue(value: string): string {
  return value.replaceAll(/\\([\s\S])/g, "$1");
}

function escapeMetadataAttributeValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function parseAttributeMetadata(
  metadataText?: string,
): Partial<Omit<CriticComment, "content">> {
  if (!metadataText?.startsWith("{") || !metadataText.endsWith("}")) {
    return {};
  }

  const fields = new Map<string, string>();
  const content = metadataText.slice(1, -1);

  for (const match of content.matchAll(metadataAttributePattern)) {
    fields.set(match[1], unescapeMetadataAttributeValue(match[2]));
  }

  const author = fields.get("by") ?? "user";

  return {
    id: fields.get("id"),
    createdAt: fields.get("at") ?? new Date().toISOString(),
    authorType: author.toUpperCase() === "AI" ? "ai" : "user",
    authorId: author.toUpperCase() === "AI" ? null : author,
    parentCommentId: fields.get("re") ?? null,
    anchor: fields.get("anchor") === "disposable" ? "disposable" : undefined,
  };
}

function commentPartialFromEndmatterEntry(
  id: string,
  entry?: Record<string, unknown>,
  options?: { includeParent?: boolean },
): Partial<Omit<CriticComment, "content">> {
  const author = typeof entry?.by === "string" ? entry.by : "user";
  const includeParent = options?.includeParent ?? true;

  return {
    id,
    createdAt:
      typeof entry?.at === "string" ? entry.at : new Date().toISOString(),
    authorType: author.toUpperCase() === "AI" ? "ai" : "user",
    authorId: author.toUpperCase() === "AI" ? null : author,
    parentCommentId:
      includeParent && typeof entry?.re === "string" ? entry.re : null,
  };
}

function parseMetadata(
  legacyMetadataText?: string,
  attributeMetadataText?: string,
  referenceMetadataText?: string,
  endmatter?: ParsedEndmatter,
  kind: "comment" | "suggestion" = "comment",
): Partial<Omit<CriticComment, "content">> {
  const reference = referenceMetadataText?.match(metadataReferencePattern);
  if (reference) {
    const id = reference[1] ?? "";
    const entry =
      kind === "comment"
        ? endmatter?.comments.get(id)
        : endmatter?.suggestions.get(id);
    return commentPartialFromEndmatterEntry(id, entry, {
      includeParent: false,
    });
  }

  if (attributeMetadataText) {
    return parseAttributeMetadata(attributeMetadataText);
  }

  return parseLegacyMetadata(legacyMetadataText);
}

function serializeMetadata(comment: CriticComment): string {
  const fields = [
    ["id", comment.id],
    ["by", comment.authorType === "ai" ? "AI" : comment.authorId || "user"],
    ["at", comment.createdAt || new Date().toISOString()],
  ];

  if (comment.parentCommentId) {
    fields.push(["re", comment.parentCommentId]);
  }

  if (comment.anchor === "disposable") {
    fields.push(["anchor", comment.anchor]);
  }

  return `{${fields
    .map(([key, value]) => `${key}="${escapeMetadataAttributeValue(value)}"`)
    .join(" ")}}`;
}

function serializeChangeMetadata(change: CriticChangeAttrs): string {
  return serializeMetadata({
    id: change.changeId,
    content: "",
    createdAt: change.createdAt,
    authorType: change.authorType,
    authorId: change.authorId,
  });
}

function emptyParsedEndmatter(): ParsedEndmatter {
  return {
    comments: new Map(),
    suggestions: new Map(),
    counters: createReviewIdCounters(),
    data: null,
  };
}

function parseReviewEndmatter(endmatter?: string | null): ParsedEndmatter {
  if (!endmatter) return emptyParsedEndmatter();

  const yamlText = endmatter.replace(/^---[ \t]*(?:\r\n|\n)/, "");
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch {
    return emptyParsedEndmatter();
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return emptyParsedEndmatter();
  }

  const record = parsed as Record<string, unknown>;
  return {
    comments: parseEndmatterMap(record.comments),
    suggestions: parseEndmatterMap(record.suggestions),
    counters: parseReviewIdCounters(record.counters),
    data: record,
  };
}

function parseEndmatterMap(
  value: unknown,
): Map<string, Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return new Map();
  }

  return new Map(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, Record<string, unknown>] =>
        Boolean(entry[1]) &&
        typeof entry[1] === "object" &&
        !Array.isArray(entry[1]),
    ),
  );
}

function addEndmatterFeedback(
  comments: Map<string, CriticComment>,
  endmatter: ParsedEndmatter,
) {
  for (const [id, entry] of endmatter.comments) {
    if (typeof entry.body !== "string") {
      continue;
    }
    if (comments.has(id)) {
      continue;
    }

    comments.set(
      id,
      createCommentWithContext({
        ...commentPartialFromEndmatterEntry(id, entry),
        content: entry.body,
        parentCommentId: typeof entry.re === "string" ? entry.re : null,
        scope: typeof entry.re === "string" ? undefined : "document",
      }),
    );
  }
}

function areEndmatterEntriesEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);

  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }

  return true;
}

function areEndmatterMapsEqual(
  left: Map<string, Record<string, unknown>>,
  right: Map<string, Record<string, unknown>>,
): boolean {
  if (left.size !== right.size) return false;

  for (const [id, leftEntry] of left) {
    const rightEntry = right.get(id);
    if (!rightEntry || !areEndmatterEntriesEqual(leftEntry, rightEntry)) {
      return false;
    }
  }

  return true;
}

function endmatterEntryForComment(
  comment: CriticComment,
  existing: Record<string, unknown> = {},
): Record<string, unknown> {
  const by = comment.authorType === "ai" ? "AI" : comment.authorId || "user";
  const next: Record<string, unknown> = {
    ...existing,
    by,
    at: comment.createdAt,
  };

  if (comment.scope === "document") {
    next.body = comment.content;
    delete next.re;
  } else if (comment.parentCommentId) {
    next.body = comment.content;
    next.re = comment.parentCommentId;
  } else {
    delete next.body;
    delete next.re;
  }

  return next;
}

function endmatterEntryForChange(
  change: CriticChangeAttrs,
  existing: Record<string, unknown> = {},
): Record<string, unknown> {
  const by = change.authorType === "ai" ? "AI" : change.authorId || "user";

  return {
    ...existing,
    by,
    at: change.createdAt,
  };
}

/**
 * Whether an endmatter comment entry belongs to an item whose text sits inline
 * behind a compact `{#cN}` reference. Such an entry carries only `by` and `at`;
 * an entry with a `body` holds the text itself, which is how a document-level
 * comment and a legacy endmatter reply are written, and neither has a compact
 * reference in the body.
 */
function isCompactReferenceEntry(entry: Record<string, unknown>): boolean {
  return typeof entry.body !== "string";
}

/**
 * Whether this document keeps review metadata in endmatter behind compact
 * references. A `comments:` map holding nothing but entries with their own
 * text does not count: those are document-level comments and legacy endmatter
 * replies, which have nowhere else to live, and treating them as the legacy
 * form flipped every inline attribute block in the document to `{#cN}` on the
 * next save. An emptied map still counts, so a legacy document whose items
 * have all been removed stays legacy and keeps its counters.
 */
function reviewMetadataLivesInEndmatter(parsed: ParsedEndmatter): boolean {
  if (parsed.data === null) return false;
  if ("suggestions" in parsed.data) return true;
  if (!("comments" in parsed.data)) return false;
  return (
    parsed.comments.size === 0 ||
    [...parsed.comments.values()].some(isCompactReferenceEntry)
  );
}

/**
 * Whether a comment's text has no home in the body, so its endmatter entry has
 * to survive a save of an inline-attribute document. A document-level comment
 * applies to the whole document and has no anchor to sit beside; a legacy
 * endmatter reply has no marker of its own. Dropping either would delete the
 * reviewer's words.
 */
function commentTextLivesInEndmatter(
  comment: CriticComment,
  parsed: ParsedEndmatter,
): boolean {
  if (comment.scope === "document") return true;
  // Only a document-level comment and a reply get a `body` from
  // endmatterEntryForComment. Anything else would leave an entry holding
  // neither text nor a reference, and splitYamlDocumentMetadata rejects a
  // comments map that no `{#id}` in the body names, so the block would come
  // back as a horizontal rule and literal YAML. The metadata is written inline
  // in that case, so dropping the entry loses nothing.
  if (!comment.parentCommentId) return false;
  const entry = parsed.comments.get(comment.id);
  return entry !== undefined && !isCompactReferenceEntry(entry);
}

function serializeReviewEndmatter(
  existingEndmatter: string | null,
  comments: Map<string, CriticComment>,
  changes: Map<string, CriticChangeAttrs>,
  idCounters?: ReviewIdCounters,
): string | null {
  const parsed = parseReviewEndmatter(existingEndmatter);
  const useEndmatter = reviewMetadataLivesInEndmatter(parsed);
  const commentEntries = new Map<string, Record<string, unknown>>();
  const suggestionEntries = new Map<string, Record<string, unknown>>();
  const counters = recordedReviewIdCounters(
    parsed.counters,
    mergeReviewIdCounters(
      advanceReviewIdCounters(parsed.counters, [
        ...parsed.comments.keys(),
        ...parsed.suggestions.keys(),
        ...comments.keys(),
        ...changes.keys(),
      ]),
      idCounters ?? parsed.counters,
    ),
    advanceReviewIdCounters(createReviewIdCounters(), [
      ...comments.keys(),
      ...changes.keys(),
    ]),
  );

  for (const comment of comments.values()) {
    if (!useEndmatter && !commentTextLivesInEndmatter(comment, parsed)) {
      continue;
    }
    commentEntries.set(
      comment.id,
      endmatterEntryForComment(comment, parsed.comments.get(comment.id)),
    );
  }

  if (useEndmatter) {
    for (const change of changes.values()) {
      suggestionEntries.set(
        change.changeId,
        endmatterEntryForChange(
          change,
          parsed.suggestions.get(change.changeId),
        ),
      );
    }
  }

  if (
    existingEndmatter &&
    areEndmatterMapsEqual(parsed.comments, commentEntries) &&
    areEndmatterMapsEqual(parsed.suggestions, suggestionEntries) &&
    areReviewIdCountersEqual(parsed.counters, counters)
  ) {
    return existingEndmatter;
  }

  const data: Record<string, unknown> = { ...(parsed.data ?? {}) };
  if (commentEntries.size > 0) {
    data.comments = Object.fromEntries(commentEntries);
  } else if (useEndmatter && "comments" in data) {
    data.comments = {};
  } else {
    delete data.comments;
  }
  if (suggestionEntries.size > 0) {
    data.suggestions = Object.fromEntries(suggestionEntries);
  } else if (useEndmatter && "suggestions" in data) {
    data.suggestions = {};
  } else {
    delete data.suggestions;
  }
  const serializedCounters = serializeReviewIdCounters(counters);
  if (serializedCounters) {
    data.counters = serializedCounters;
  } else {
    delete data.counters;
  }

  if (Object.keys(data).length === 0) return null;

  return `---\n${stringifyYaml(data)}`;
}

const reviewIdPattern = /^([cs])(\d+)$/;

export function createReviewIdCounters(): ReviewIdCounters {
  return { comments: 0, suggestions: 0 };
}

function readReviewIdCounter(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

function parseReviewIdCounters(value: unknown): ReviewIdCounters {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return createReviewIdCounters();
  }

  const record = value as Record<string, unknown>;
  return {
    comments: readReviewIdCounter(record.comments),
    suggestions: readReviewIdCounter(record.suggestions),
  };
}

export function advanceReviewIdCounters(
  counters: ReviewIdCounters,
  ids: Iterable<string>,
): ReviewIdCounters {
  const next = { ...counters };

  for (const id of ids) {
    const match = id.match(reviewIdPattern);
    if (!match) continue;

    const parsed = Number.parseInt(match[2] || "0", 10);
    if (match[1] === "c") {
      next.comments = Math.max(next.comments, parsed);
    } else {
      next.suggestions = Math.max(next.suggestions, parsed);
    }
  }

  return next;
}

function mergeReviewIdCounters(
  left: ReviewIdCounters,
  right: ReviewIdCounters,
): ReviewIdCounters {
  return {
    comments: Math.max(left.comments, right.comments),
    suggestions: Math.max(left.suggestions, right.suggestions),
  };
}

function areReviewIdCountersEqual(
  left: ReviewIdCounters,
  right: ReviewIdCounters,
): boolean {
  return (
    left.comments === right.comments && left.suggestions === right.suggestions
  );
}

function recordedReviewIdCounter(
  recorded: number,
  effective: number,
  present: number,
): number {
  return recorded > 0 || effective > present ? effective : 0;
}

function recordedReviewIdCounters(
  recorded: ReviewIdCounters,
  effective: ReviewIdCounters,
  present: ReviewIdCounters,
): ReviewIdCounters {
  return {
    comments: recordedReviewIdCounter(
      recorded.comments,
      effective.comments,
      present.comments,
    ),
    suggestions: recordedReviewIdCounter(
      recorded.suggestions,
      effective.suggestions,
      present.suggestions,
    ),
  };
}

function serializeReviewIdCounters(
  counters: ReviewIdCounters,
): Record<string, number> | null {
  const serialized: Record<string, number> = {};
  if (counters.comments > 0) serialized.comments = counters.comments;
  if (counters.suggestions > 0) serialized.suggestions = counters.suggestions;
  return Object.keys(serialized).length > 0 ? serialized : null;
}

export function createNextCommentId(
  existingComments: Iterable<Pick<CriticComment, "id">>,
  counters?: ReviewIdCounters,
): string {
  let maxId = counters?.comments ?? 0;

  for (const comment of existingComments) {
    const match = comment.id.match(/^c(\d+)$/);
    if (!match) continue;

    const parsed = Number.parseInt(match[1] || "0", 10);
    if (parsed > maxId) {
      maxId = parsed;
    }
  }

  return `c${maxId + 1}`;
}

export function createNextChangeId(
  existingChanges: Iterable<Pick<CriticChangeAttrs, "changeId">>,
  counters?: ReviewIdCounters,
): string {
  let maxId = counters?.suggestions ?? 0;

  for (const change of existingChanges) {
    const match = change.changeId.match(/^s(\d+)$/);
    if (!match) continue;

    const parsed = Number.parseInt(match[1] || "0", 10);
    if (parsed > maxId) {
      maxId = parsed;
    }
  }

  return `s${maxId + 1}`;
}

function createCommentWithContext(
  partial?: Partial<CriticComment>,
  existingComments: Iterable<Pick<CriticComment, "id">> = [],
  counters?: ReviewIdCounters,
): CriticComment {
  const authorType = partial?.authorType ?? "user";

  return {
    id: partial?.id ?? createNextCommentId(existingComments, counters),
    content: partial?.content ?? "",
    createdAt: partial?.createdAt ?? new Date().toISOString(),
    authorType,
    authorId: partial?.authorId ?? (authorType === "ai" ? null : "user"),
    parentCommentId: partial?.parentCommentId ?? null,
    scope: partial?.scope,
    anchor: partial?.anchor,
  };
}

function createChangeWithContext(
  kind: CriticChangeKind,
  partial?: Partial<CriticChangeAttrs>,
  existingChanges: Iterable<Pick<CriticChangeAttrs, "changeId">> = [],
  counters?: ReviewIdCounters,
): CriticChangeAttrs {
  const authorType = partial?.authorType ?? "user";

  return {
    kind,
    changeId:
      partial?.changeId ?? createNextChangeId(existingChanges, counters),
    createdAt: partial?.createdAt ?? new Date().toISOString(),
    authorType,
    authorId: partial?.authorId ?? (authorType === "ai" ? null : "user"),
  };
}

function parseChangeMetadata(
  metadataText?: string,
  endmatter?: ParsedEndmatter,
): Partial<CriticChangeAttrs> {
  const reference = metadataText?.match(metadataReferencePattern);
  if (reference) {
    const id = reference[1] ?? "";
    const entry = endmatter?.suggestions.get(id);
    const parsed = commentPartialFromEndmatterEntry(id, entry);
    return {
      changeId: parsed.id,
      createdAt: parsed.createdAt,
      authorType: parsed.authorType,
      authorId: parsed.authorId,
    };
  }

  const parsed = parseAttributeMetadata(metadataText);

  return {
    changeId: parsed.id,
    createdAt: parsed.createdAt,
    authorType: parsed.authorType,
    authorId: parsed.authorId,
  };
}

function buildCommentThreadsFromOrderedComments(
  orderedComments: CriticComment[],
): CriticCommentThread[] {
  const validCommentIds = new Set(orderedComments.map((comment) => comment.id));
  const repliesByParentId = new Map<string, CriticComment[]>();
  const rootComments: CriticComment[] = [];

  for (const comment of orderedComments) {
    const parentCommentId = comment.parentCommentId;

    if (
      !parentCommentId ||
      parentCommentId === comment.id ||
      !validCommentIds.has(parentCommentId)
    ) {
      rootComments.push(comment);
      continue;
    }

    const replies = repliesByParentId.get(parentCommentId) ?? [];
    replies.push(comment);
    repliesByParentId.set(parentCommentId, replies);
  }

  const buildNode = (comment: CriticComment): CriticCommentThread => ({
    comment,
    replies: (repliesByParentId.get(comment.id) ?? []).map(buildNode),
  });

  return rootComments.map(buildNode);
}

export function buildCommentThreads(
  comments: Iterable<CriticComment>,
): CriticCommentThread[] {
  return buildCommentThreadsFromOrderedComments([...comments]);
}

export function flattenCommentThreads(
  threads: Iterable<CriticCommentThread>,
): CriticComment[] {
  const orderedComments: CriticComment[] = [];

  const visit = (thread: CriticCommentThread) => {
    orderedComments.push(thread.comment);
    for (const reply of thread.replies) {
      visit(reply);
    }
  };

  for (const thread of threads) {
    visit(thread);
  }

  return orderedComments;
}

function getOrderedAnchorComments(
  commentIds: string[],
  comments: ReadonlyMap<string, CriticComment>,
): CriticComment[] {
  const visibleComments = commentIds
    .map((commentId) => comments.get(commentId))
    .filter((comment): comment is CriticComment => Boolean(comment));

  return flattenCommentThreads(buildCommentThreads(visibleComments));
}

function serializeCommentBlocks(
  commentIds: string[],
  comments: ReadonlyMap<string, CriticComment>,
  useEndmatter = false,
): string {
  const orderedComments = useEndmatter
    ? commentIds
        .map((commentId) => comments.get(commentId))
        .filter(
          (comment): comment is CriticComment =>
            comment !== undefined && !comment.parentCommentId,
        )
    : getOrderedAnchorComments(commentIds, comments);
  let result = "";

  for (const comment of orderedComments) {
    result += `{>>${escapeCriticMarkupText(comment.content)}<<}${
      useEndmatter ? `{#${comment.id}}` : serializeMetadata(comment)
    }`;
  }

  return result;
}

export function getCommentDescendantIds(
  commentId: string,
  comments: ReadonlyMap<string, CriticComment>,
): string[] {
  const childrenByParentId = new Map<string, string[]>();

  for (const comment of comments.values()) {
    if (!comment.parentCommentId || comment.parentCommentId === comment.id) {
      continue;
    }

    const childIds = childrenByParentId.get(comment.parentCommentId) ?? [];
    childIds.push(comment.id);
    childrenByParentId.set(comment.parentCommentId, childIds);
  }

  const descendantIds: string[] = [];
  // A hand-edited document can point two `re:` entries at each other, which
  // would otherwise walk forever.
  const visited = new Set<string>([commentId]);
  const stack = [...(childrenByParentId.get(commentId) ?? [])].reverse();

  while (stack.length > 0) {
    const nextCommentId = stack.pop();
    if (!nextCommentId || visited.has(nextCommentId)) continue;

    visited.add(nextCommentId);
    descendantIds.push(nextCommentId);

    const childIds = childrenByParentId.get(nextCommentId) ?? [];
    for (let index = childIds.length - 1; index >= 0; index -= 1) {
      const childId = childIds[index];
      if (childId) {
        stack.push(childId);
      }
    }
  }

  return descendantIds;
}

function tokenizeCriticCommentAnchor(
  lexer: TokenizerThis["lexer"],
  src: string,
  existingComments: Iterable<Pick<CriticComment, "id">>,
  endmatter?: ParsedEndmatter,
):
  | {
      token: CriticCommentToken;
      comments: CriticComment[];
    }
  | undefined {
  const anchorMatch = matchMarker(src, criticCommentAnchorPattern);

  if (!anchorMatch) return undefined;

  const [, anchor] = anchorMatch;
  let raw = anchorMatch[0];
  let offset = raw.length;
  const parsedComments: CriticComment[] = [];

  while (offset < src.length) {
    const nextMatch = matchMarker(src.slice(offset), criticCommentBlockPattern);
    if (!nextMatch) break;

    const [
      ,
      commentText,
      ,
      legacyMetadataText,
      attributeMetadataText,
      referenceMetadataText,
    ] = nextMatch;
    const comment = createCommentWithContext(
      {
        ...parseMetadata(
          legacyMetadataText,
          attributeMetadataText,
          referenceMetadataText,
          endmatter,
          "comment",
        ),
        content: unescapeCriticMarkupText(commentText),
      },
      [...existingComments, ...parsedComments],
    );
    parsedComments.push(comment);
    raw += nextMatch[0];
    offset += nextMatch[0].length;
  }

  if (parsedComments.length === 0) return undefined;

  return {
    token: {
      type: "criticCommentAnchor",
      raw,
      commentIds: parsedComments.map((comment) => comment.id),
      tokens: lexMarkerText(lexer, anchor),
    },
    comments: parsedComments,
  };
}

function getTrailingAttributeMetadata(src: string, offset: number) {
  const reference = src.slice(offset).match(/^\{#[A-Za-z][A-Za-z0-9_-]*\}/);
  if (reference) {
    return {
      metadataText: reference[0],
      raw: reference[0],
    };
  }

  const match = src.slice(offset).match(attributeMetadataBlockPattern);

  if (!match) {
    return {
      metadataText: undefined,
      raw: "",
    };
  }

  return {
    metadataText: match[0],
    raw: match[0],
  };
}

function tokenizeCriticCommentBlocks(
  src: string,
  offset: number,
  existingComments: Iterable<Pick<CriticComment, "id">>,
  endmatter?: ParsedEndmatter,
) {
  let raw = "";
  let nextOffset = offset;
  const parsedComments: CriticComment[] = [];

  while (nextOffset < src.length) {
    const nextMatch = matchMarker(
      src.slice(nextOffset),
      criticCommentBlockPattern,
    );
    if (!nextMatch) break;

    const [
      ,
      commentText,
      ,
      legacyMetadataText,
      attributeMetadataText,
      referenceMetadataText,
    ] = nextMatch;
    const comment = createCommentWithContext(
      {
        ...parseMetadata(
          legacyMetadataText,
          attributeMetadataText,
          referenceMetadataText,
          endmatter,
          "comment",
        ),
        content: unescapeCriticMarkupText(commentText),
      },
      [...existingComments, ...parsedComments],
    );
    parsedComments.push(comment);
    raw += nextMatch[0];
    nextOffset += nextMatch[0].length;
  }

  return {
    raw,
    comments: parsedComments,
  };
}

function tokenizeCriticStandaloneComment(
  src: string,
  existingComments: Iterable<Pick<CriticComment, "id">>,
  endmatter?: ParsedEndmatter,
):
  | {
      token: CriticStandaloneCommentToken;
      comments: CriticComment[];
    }
  | undefined {
  const result = tokenizeCriticCommentBlocks(
    src,
    0,
    existingComments,
    endmatter,
  );

  if (result.comments.length === 0) return undefined;

  return {
    token: {
      type: "criticStandaloneComment",
      raw: result.raw,
      commentIds: result.comments.map((comment) => comment.id),
    },
    comments: result.comments,
  };
}

function tokenizeCriticChange(
  lexer: TokenizerThis["lexer"],
  src: string,
  existingChanges: Iterable<Pick<CriticChangeAttrs, "changeId">>,
  existingComments: Iterable<Pick<CriticComment, "id">>,
  endmatter?: ParsedEndmatter,
):
  | {
      token: CriticChangeToken;
      comments: CriticComment[];
    }
  | undefined {
  const additionMatch = matchMarker(src, criticAdditionPattern);

  if (additionMatch) {
    const [, text] = additionMatch;
    const metadata = getTrailingAttributeMetadata(src, additionMatch[0].length);
    const trailingComments = tokenizeCriticCommentBlocks(
      src,
      additionMatch[0].length + metadata.raw.length,
      existingComments,
      endmatter,
    );
    const change = createChangeWithContext(
      "addition",
      parseChangeMetadata(metadata.metadataText, endmatter),
      existingChanges,
    );

    return {
      token: {
        type: "criticChange",
        raw: additionMatch[0] + metadata.raw + trailingComments.raw,
        change,
        commentIds: trailingComments.comments.map((comment) => comment.id),
        tokens: lexMarkerText(lexer, text),
      },
      comments: trailingComments.comments,
    };
  }

  const deletionMatch = matchMarker(src, criticDeletionPattern);

  if (deletionMatch) {
    const [, text] = deletionMatch;
    const metadata = getTrailingAttributeMetadata(src, deletionMatch[0].length);
    const trailingComments = tokenizeCriticCommentBlocks(
      src,
      deletionMatch[0].length + metadata.raw.length,
      existingComments,
      endmatter,
    );
    const change = createChangeWithContext(
      "deletion",
      parseChangeMetadata(metadata.metadataText, endmatter),
      existingChanges,
    );

    return {
      token: {
        type: "criticChange",
        raw: deletionMatch[0] + metadata.raw + trailingComments.raw,
        change,
        commentIds: trailingComments.comments.map((comment) => comment.id),
        tokens: lexMarkerText(lexer, text),
      },
      comments: trailingComments.comments,
    };
  }

  const substitutionMatch = matchMarker(src, criticSubstitutionPattern);

  if (substitutionMatch) {
    const [, oldText, newText] = substitutionMatch;
    const metadata = getTrailingAttributeMetadata(
      src,
      substitutionMatch[0].length,
    );
    const trailingComments = tokenizeCriticCommentBlocks(
      src,
      substitutionMatch[0].length + metadata.raw.length,
      existingComments,
      endmatter,
    );
    const change = createChangeWithContext(
      "substitution-old",
      parseChangeMetadata(metadata.metadataText, endmatter),
      existingChanges,
    );

    return {
      token: {
        type: "criticChange",
        raw: substitutionMatch[0] + metadata.raw + trailingComments.raw,
        change,
        commentIds: trailingComments.comments.map((comment) => comment.id),
        oldTokens: lexMarkerText(lexer, oldText),
        newTokens: lexMarkerText(lexer, newText),
      },
      comments: trailingComments.comments,
    };
  }

  return undefined;
}

function renderCriticChangeSpan(
  change: CriticChangeAttrs,
  content: string,
  kind: CriticChangeKind = change.kind,
  commentIds: string[] = [],
) {
  const by = change.authorType === "ai" ? "AI" : change.authorId || "user";
  const changeSpan = `<span data-critic-change-kind="${escapeHtml(kind)}" data-critic-change-id="${escapeHtml(
    change.changeId,
  )}" data-critic-change-by="${escapeHtml(by)}" data-critic-change-at="${escapeHtml(
    change.createdAt,
  )}">${content}</span>`;

  if (commentIds.length === 0) {
    return changeSpan;
  }

  return `<span data-comment-ids="${escapeHtml(
    JSON.stringify(commentIds),
  )}">${changeSpan}</span>`;
}

function renderCriticCodeText(
  text: string,
  comments: Map<string, CriticComment>,
  endmatter?: ParsedEndmatter,
) {
  let result = "";
  let offset = 0;

  while (offset < text.length) {
    const anchorMatch = matchMarker(
      text.slice(offset),
      criticCommentAnchorPattern,
    );

    if (!anchorMatch || anchorMatch.index !== 0) {
      result += escapeHtml(text[offset] ?? "");
      offset += 1;
      continue;
    }

    const [, anchor] = anchorMatch;
    let nextOffset = offset + anchorMatch[0].length;
    const parsedComments: CriticComment[] = [];

    while (nextOffset < text.length) {
      const commentMatch = matchMarker(
        text.slice(nextOffset),
        criticCommentBlockPattern,
      );
      if (!commentMatch) break;

      const [
        ,
        commentText,
        ,
        legacyMetadataText,
        attributeMetadataText,
        referenceMetadataText,
      ] = commentMatch;
      const comment = createCommentWithContext(
        {
          ...parseMetadata(
            legacyMetadataText,
            attributeMetadataText,
            referenceMetadataText,
            endmatter,
            "comment",
          ),
          content: unescapeCriticMarkupText(commentText),
        },
        [...comments.values(), ...parsedComments],
      );
      parsedComments.push(comment);
      nextOffset += commentMatch[0].length;
    }

    if (parsedComments.length === 0) {
      result += escapeHtml(anchorMatch[0]);
      offset += anchorMatch[0].length;
      continue;
    }

    for (const comment of parsedComments) {
      comments.set(comment.id, comment);
    }

    result += `<span data-comment-ids="${escapeHtml(
      JSON.stringify(parsedComments.map((comment) => comment.id)),
    )}">${escapeHtml(unescapeCriticMarkupText(anchor))}</span>`;
    offset = nextOffset;
  }

  return result;
}

function renderCriticCodeBlock(
  token: Tokens.Code,
  comments: Map<string, CriticComment>,
  endmatter?: ParsedEndmatter,
) {
  const language = (token.lang || "").match(/\S+/)?.[0];
  const classAttr = language ? ` class="language-${escapeHtml(language)}"` : "";
  const content = token.escaped
    ? token.text
    : renderCriticCodeText(token.text, comments, endmatter);

  return `<pre><code${classAttr}>${content}</code></pre>\n`;
}

function addCriticCommentRule(
  service: TurndownService,
  comments: Map<string, CriticComment>,
  useEndmatter = false,
) {
  service.addRule("criticComment", {
    filter: (node) =>
      node.nodeName === "SPAN" &&
      (node as HTMLElement).hasAttribute("data-comment-ids"),
    replacement(content, node) {
      const commentIds = parseCommentIdsAttribute(node as HTMLElement);

      if (!commentIds) return content;

      const criticChangeElement = (node as HTMLElement).querySelector(
        "span[data-critic-change-kind]",
      );
      if (criticChangeElement instanceof HTMLElement) {
        return serializeCriticChangeElement(
          service,
          criticChangeElement,
          service.turndown(criticChangeElement.innerHTML).trim(),
          comments,
          commentIds,
          useEndmatter,
        );
      }

      const commentBlocks = serializeCommentBlocks(
        commentIds,
        comments,
        useEndmatter,
      );
      if (!commentBlocks) return content;
      if (content === unanchoredCommentSentinel) return commentBlocks;

      return `{==${escapeCriticMarkupText(content)}==}${commentBlocks}`;
    },
  });
}

/**
 * A fence's content is source text, so it cannot go back through
 * `service.turndown`: turndown reads the code element as inline HTML and
 * collapses every newline in a text node to a space, which saves a multi-line
 * fence as one line. This walk reads the element's children directly instead,
 * writing each text node byte for byte and each review mark back as its own
 * marker, so the only bytes that change are the markers themselves.
 */
function serializeCriticCodeContent(
  service: TurndownService,
  codeElement: HTMLElement,
  comments: Map<string, CriticComment>,
  useEndmatter: boolean,
): string {
  let result = "";

  for (const child of codeElement.childNodes) {
    if (!(child instanceof HTMLElement)) {
      result += child.textContent ?? "";
      continue;
    }

    const commentIds = parseCommentIdsAttribute(child) ?? [];
    const changeElement = child.hasAttribute("data-critic-change-kind")
      ? child
      : child.querySelector("span[data-critic-change-kind]");

    if (changeElement instanceof HTMLElement) {
      result += serializeCriticChangeElement(
        service,
        changeElement,
        changeElement.textContent ?? "",
        comments,
        commentIds,
        useEndmatter,
      );
      continue;
    }

    if (commentIds.length > 0) {
      const commentBlocks = serializeCommentBlocks(
        commentIds,
        comments,
        useEndmatter,
      );
      result += commentBlocks
        ? `{==${escapeCriticMarkupText(child.textContent ?? "")}==}${commentBlocks}`
        : (child.textContent ?? "");
      continue;
    }

    result += child.textContent ?? "";
  }

  return result;
}

/** The ids a comment anchor carries, or null when it carries no readable list. */
function parseCommentIdsAttribute(element: HTMLElement): string[] | null {
  const commentIdsText = element.getAttribute("data-comment-ids");

  if (!commentIdsText) return null;

  try {
    return JSON.parse(commentIdsText) as string[];
  } catch {
    return null;
  }
}

function addCriticCodeBlockRule(
  service: TurndownService,
  comments: Map<string, CriticComment>,
  useEndmatter = false,
) {
  service.addRule("criticCodeBlock", {
    filter: (node) => {
      if (node.nodeName !== "PRE") return false;
      const codeElement = (node as HTMLElement).firstElementChild;
      return (
        codeElement?.nodeName === "CODE" &&
        Boolean(
          codeElement.querySelector(
            "span[data-comment-ids], span[data-critic-change-kind]",
          ),
        )
      );
    },
    replacement(_content, node) {
      const codeElement = (node as HTMLElement)
        .firstElementChild as HTMLElement | null;

      if (!codeElement) return "";

      const language =
        [...codeElement.classList]
          .find((className) => className.startsWith("language-"))
          ?.slice("language-".length) ?? "";
      // Turndown's own fenced-code rule drops exactly one trailing newline, so
      // this drops one too and a fence carrying a marker saves the same bytes
      // as the plain fence beside it.
      const content = serializeCriticCodeContent(
        service,
        codeElement,
        comments,
        useEndmatter,
      ).replace(/\n$/, "");

      return `\n\n\`\`\`${language}\n${content}\n\`\`\`\n\n`;
    },
  });
}

function getElementChangeAttrs(element: HTMLElement): CriticChangeAttrs | null {
  const kind = element.getAttribute("data-critic-change-kind");
  const changeId = element.getAttribute("data-critic-change-id");
  const createdAt = element.getAttribute("data-critic-change-at");

  if (
    kind !== "addition" &&
    kind !== "deletion" &&
    kind !== "substitution-old" &&
    kind !== "substitution-new"
  ) {
    return null;
  }

  if (!changeId || !createdAt) return null;

  const rawBy = element.getAttribute("data-critic-change-by") || "user";
  const authorType = rawBy.toUpperCase() === "AI" ? "ai" : "user";

  return {
    kind,
    changeId,
    createdAt,
    authorType,
    authorId: authorType === "ai" ? null : rawBy,
  };
}

function isPairedSubstitutionElement(
  element: Element | null,
  kind: CriticChangeKind,
  changeId: string,
) {
  return (
    element instanceof HTMLElement &&
    element.getAttribute("data-critic-change-kind") === kind &&
    element.getAttribute("data-critic-change-id") === changeId
  );
}

function getElementCommentIds(element: HTMLElement): string[] {
  const commentIdsText = element.getAttribute("data-comment-ids");
  if (!commentIdsText) return [];

  try {
    const parsed = JSON.parse(commentIdsText) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

function getChangeCommentBlocks(
  element: HTMLElement,
  comments: Map<string, CriticComment>,
  extraCommentIds: string[] = [],
  useEndmatter = false,
) {
  return serializeCommentBlocks(
    [...new Set([...getElementCommentIds(element), ...extraCommentIds])],
    comments,
    useEndmatter,
  );
}

function serializeCriticChangeElement(
  service: TurndownService,
  element: HTMLElement,
  content: string,
  comments: Map<string, CriticComment>,
  extraCommentIds: string[] = [],
  useEndmatter = false,
) {
  const change = getElementChangeAttrs(element);

  if (!change) return content;

  const markerText = escapeCriticMarkupText(content);
  const commentBlocks = getChangeCommentBlocks(
    element,
    comments,
    extraCommentIds,
    useEndmatter,
  );
  const metadata = useEndmatter
    ? `{#${change.changeId}}`
    : serializeChangeMetadata(change);

  if (change.kind === "addition") {
    return `{++${markerText}++}${metadata}${commentBlocks}`;
  }

  if (change.kind === "deletion") {
    return `{--${markerText}--}${metadata}${commentBlocks}`;
  }

  if (change.kind === "substitution-new") {
    return isPairedSubstitutionElement(
      element.previousElementSibling,
      "substitution-old",
      change.changeId,
    )
      ? ""
      : `{++${markerText}++}${
          useEndmatter
            ? `{#${change.changeId}}`
            : serializeChangeMetadata({
                ...change,
                kind: "addition",
              })
        }${commentBlocks}`;
  }

  const nextElement = element.nextElementSibling;

  if (
    nextElement instanceof HTMLElement &&
    isPairedSubstitutionElement(
      nextElement,
      "substitution-new",
      change.changeId,
    )
  ) {
    const replacement = escapeCriticMarkupText(
      service.turndown(nextElement.innerHTML).trim(),
    );
    return `{~~${markerText}~>${replacement}~~}${metadata}${commentBlocks}`;
  }

  return `{--${markerText}--}${
    useEndmatter
      ? `{#${change.changeId}}`
      : serializeChangeMetadata({
          ...change,
          kind: "deletion",
        })
  }${commentBlocks}`;
}

function addCriticChangeRule(
  service: TurndownService,
  comments: Map<string, CriticComment>,
  useEndmatter = false,
) {
  service.addRule("criticChange", {
    filter: (node) =>
      node.nodeName === "SPAN" &&
      (node as HTMLElement).hasAttribute("data-critic-change-kind"),
    replacement(content, node) {
      const element = node as HTMLElement;
      return serializeCriticChangeElement(
        service,
        element,
        content,
        comments,
        [],
        useEndmatter,
      );
    },
  });
}

function createCriticMarked(
  markdownOptions?: MarkdownOptions,
  endmatter?: ParsedEndmatter,
) {
  const comments = new Map<string, CriticComment>();
  const changes = new Map<string, CriticChangeAttrs>();
  const renderer = createMarkedRenderer(markdownOptions);
  renderer.code = (token) => renderCriticCodeBlock(token, comments, endmatter);
  const parser = new Marked({
    gfm: true,
    async: false,
    renderer,
    tokenizer: strictStrikethroughTokenizer,
  });

  parser.use({
    extensions: [
      {
        name: "criticCommentAnchor",
        level: "inline",
        start(src: string) {
          return src.indexOf("{==");
        },
        tokenizer(this: TokenizerThis, src: string) {
          const result = tokenizeCriticCommentAnchor(
            this.lexer,
            src,
            comments.values(),
            endmatter,
          );
          if (!result) return undefined;

          for (const comment of result.comments) {
            comments.set(comment.id, comment);
          }
          return result.token;
        },
        renderer(this: RendererThis, token: Tokens.Generic) {
          const criticToken = token as CriticCommentToken;
          return `<span data-comment-ids="${escapeHtml(
            JSON.stringify(criticToken.commentIds),
          )}">${this.parser.parseInline(criticToken.tokens)}</span>`;
        },
        childTokens: ["tokens"],
      } satisfies TokenizerAndRendererExtension,
      {
        name: "criticStandaloneComment",
        level: "inline",
        start(src: string) {
          return src.indexOf("{>>");
        },
        tokenizer(src: string) {
          const result = tokenizeCriticStandaloneComment(
            src,
            comments.values(),
            endmatter,
          );
          if (!result) return undefined;

          for (const comment of result.comments) {
            comments.set(comment.id, comment);
          }
          return result.token;
        },
        renderer(token: Tokens.Generic) {
          const criticToken = token as CriticStandaloneCommentToken;
          return `<span data-comment-ids="${escapeHtml(
            JSON.stringify(criticToken.commentIds),
          )}" data-comment-anchorless="true">${unanchoredCommentSentinel}</span>`;
        },
      } satisfies TokenizerAndRendererExtension,
      {
        name: "criticChange",
        level: "inline",
        start(src: string) {
          const starts = ["{++", "{--", "{~~"]
            .map((marker) => src.indexOf(marker))
            .filter((index) => index >= 0);

          return starts.length > 0 ? Math.min(...starts) : undefined;
        },
        tokenizer(this: TokenizerThis, src: string) {
          const result = tokenizeCriticChange(
            this.lexer,
            src,
            changes.values(),
            comments.values(),
            endmatter,
          );
          if (!result) return undefined;

          for (const comment of result.comments) {
            comments.set(comment.id, comment);
          }
          changes.set(result.token.change.changeId, result.token.change);
          return result.token;
        },
        renderer(this: RendererThis, token: Tokens.Generic) {
          const criticToken = token as CriticChangeToken;

          if (criticToken.change.kind === "substitution-old") {
            const oldContent = this.parser.parseInline(
              criticToken.oldTokens ?? [],
            );
            const newContent = this.parser.parseInline(
              criticToken.newTokens ?? [],
            );
            const substitutionHtml = `${renderCriticChangeSpan(
              criticToken.change,
              oldContent,
              "substitution-old",
            )}${renderCriticChangeSpan(
              criticToken.change,
              newContent,
              "substitution-new",
            )}`;

            if (criticToken.commentIds.length === 0) {
              return substitutionHtml;
            }

            return `<span data-comment-ids="${escapeHtml(
              JSON.stringify(criticToken.commentIds),
            )}">${substitutionHtml}</span>`;
          }

          return renderCriticChangeSpan(
            criticToken.change,
            this.parser.parseInline(criticToken.tokens ?? []),
            criticToken.change.kind,
            criticToken.commentIds,
          );
        },
        childTokens: ["tokens", "oldTokens", "newTokens"],
      } satisfies TokenizerAndRendererExtension,
    ],
  });

  return { parser, comments, changes };
}

export function criticMarkdownHasReviewRail(
  markdown: string,
  options?: MarkdownOptions,
): boolean {
  const { body, endmatter } = splitYamlDocumentMetadata(markdown);
  const parsedEndmatter = parseReviewEndmatter(endmatter);
  const { parser, comments, changes } = createCriticMarked(
    options,
    parsedEndmatter,
  );
  parser.parse(protectRichTextRoundTripMarkdown(body));
  addEndmatterFeedback(comments, parsedEndmatter);
  return comments.size > 0 || changes.size > 0;
}

export function criticMarkdownToRenderedHtml(
  markdown: string,
  options?: MarkdownOptions,
): {
  html: string;
  comments: Map<string, CriticComment>;
  changes: Map<string, CriticChangeAttrs>;
  frontmatter: string | null;
  endmatter: string | null;
} {
  const { frontmatter, body, endmatter } = splitYamlDocumentMetadata(markdown);
  const parsedEndmatter = parseReviewEndmatter(endmatter);
  const { parser, comments, changes } = createCriticMarked(
    options,
    parsedEndmatter,
  );
  const html = parser.parse(protectRichTextRoundTripMarkdown(body)) as string;
  addEndmatterFeedback(comments, parsedEndmatter);

  return { html, comments, changes, frontmatter, endmatter };
}

export function criticMarkdownToEditorState(
  markdown: string,
  options?: MarkdownOptions,
): {
  doc: JSONContent;
  comments: Map<string, CriticComment>;
  frontmatter: string | null;
  endmatter: string | null;
  idCounters: ReviewIdCounters;
} {
  const { frontmatter, body, endmatter } = splitYamlDocumentMetadata(markdown);
  const parsedEndmatter = parseReviewEndmatter(endmatter);
  const { parser, comments, changes } = createCriticMarked(
    options,
    parsedEndmatter,
  );
  const html = parser.parse(protectRichTextRoundTripMarkdown(body)) as string;
  const doc = generateJSON(html, extensions) as JSONContent & {
    yamlFrontmatter?: string;
    yamlEndmatter?: string;
  };
  addEndmatterFeedback(comments, parsedEndmatter);
  if (frontmatter) {
    doc.yamlFrontmatter = frontmatter;
  }
  if (endmatter) {
    doc.yamlEndmatter = endmatter;
  }
  const idCounters = advanceReviewIdCounters(parsedEndmatter.counters, [
    ...parsedEndmatter.comments.keys(),
    ...parsedEndmatter.suggestions.keys(),
    ...comments.keys(),
    ...changes.keys(),
  ]);

  return { doc, comments, frontmatter, endmatter, idCounters };
}

function collectCriticChangesFromDoc(
  doc: JSONContent,
): Map<string, CriticChangeAttrs> {
  const changes = new Map<string, CriticChangeAttrs>();
  const visit = (node: JSONContent) => {
    for (const mark of node.marks ?? []) {
      if (mark.type !== "criticChange") continue;

      const attrs = mark.attrs as Partial<CriticChangeAttrs> | undefined;
      if (
        attrs?.changeId &&
        attrs.kind &&
        attrs.createdAt &&
        attrs.authorType
      ) {
        changes.set(attrs.changeId, {
          kind: attrs.kind,
          changeId: attrs.changeId,
          createdAt: attrs.createdAt,
          authorType: attrs.authorType,
          authorId: attrs.authorId ?? null,
        });
      }
    }

    for (const child of node.content ?? []) {
      visit(child);
    }
  };

  visit(doc);
  return changes;
}

export function editorStateToCriticMarkdown(
  doc: JSONContent,
  comments: Map<string, CriticComment>,
  options?: {
    frontmatter?: string | null;
    endmatter?: string | null;
    idCounters?: ReviewIdCounters;
  },
): string {
  const html = generateHTML(doc, extensions);
  const service = createTurndownService();
  const frontmatter =
    options?.frontmatter ??
    (doc as JSONContent & { yamlFrontmatter?: string }).yamlFrontmatter ??
    null;
  const sourceEndmatter =
    options?.endmatter ??
    (doc as JSONContent & { yamlEndmatter?: string }).yamlEndmatter ??
    null;
  const changes = collectCriticChangesFromDoc(doc);
  const useEndmatter = reviewMetadataLivesInEndmatter(
    parseReviewEndmatter(sourceEndmatter),
  );
  addCriticCommentRule(service, comments, useEndmatter);
  addCriticChangeRule(service, comments, useEndmatter);
  addCriticCodeBlockRule(service, comments, useEndmatter);
  const endmatter = serializeReviewEndmatter(
    sourceEndmatter,
    comments,
    changes,
    options?.idCounters,
  );
  return appendYamlEndmatter(
    prependYamlFrontmatter(
      normalizeBlockSpacing(
        `${service.turndown(placeholderSoftBreakSpans(html)).trimEnd()}\n`,
      ),
      frontmatter,
    ),
    endmatter,
  );
}

/**
 * The ids among these whose comment flags its anchor as disposable filler.
 * Both clear paths derive their disposal set through this, so the editor and
 * the code view apply one rule to the whole set of comments being removed.
 */
export function disposableAnchorCommentIds(
  commentIds: Iterable<string>,
  comments: ReadonlyMap<string, CriticComment>,
): string[] {
  return [...commentIds].filter(
    (commentId) => comments.get(commentId)?.anchor === "disposable",
  );
}

/**
 * Removes the given comment ids from every commentRef mark. A node whose
 * anchor loses its last comment id is dropped when one of the removed ids
 * carried the disposable-anchor flag, so filler text written only to carry
 * a thread leaves with the thread; otherwise the text stays as plain prose.
 */
function removeCommentIdsFromDoc(
  node: JSONContent,
  commentIds: ReadonlySet<string>,
  disposableAnchorIds: ReadonlySet<string>,
): JSONContent | null {
  let disposeNode = false;
  const marks = node.marks?.flatMap((mark) => {
    if (mark.type !== "commentRef") return [mark];

    const currentIds = Array.isArray(mark.attrs?.commentIds)
      ? (mark.attrs.commentIds as string[])
      : [];
    const nextIds = currentIds.filter((id) => !commentIds.has(id));

    if (nextIds.length === currentIds.length) return [mark];
    if (nextIds.length === 0) {
      disposeNode = currentIds.some((id) => disposableAnchorIds.has(id));
      return [];
    }
    return [{ ...mark, attrs: { ...mark.attrs, commentIds: nextIds } }];
  });

  if (disposeNode) return null;

  const content = node.content?.flatMap((child) => {
    const next = removeCommentIdsFromDoc(
      child,
      commentIds,
      disposableAnchorIds,
    );
    return next ? [next] : [];
  });

  return {
    ...node,
    ...(marks ? { marks } : {}),
    ...(content ? { content } : {}),
  };
}

/**
 * Every comment in a suggestion's own thread: replies to the mark and their
 * descendants. These go with the mark when it is accepted, rejected or
 * edited, so no thread outlives its suggestion.
 */
export function getSuggestionThreadCommentIds(
  changeId: string,
  comments: ReadonlyMap<string, CriticComment>,
): string[] {
  const replyIds = [...comments.values()]
    .filter((comment) => comment.parentCommentId === changeId)
    .map((comment) => comment.id);

  return [
    ...replyIds,
    ...replyIds.flatMap((commentId) =>
      getCommentDescendantIds(commentId, comments),
    ),
  ];
}

interface PendingApprovals {
  commentIds?: Iterable<string>;
  changeDecisions?: readonly CriticChangeDecision[];
}

/**
 * Applies the approvals a reviewer left pending until Done Reviewing to a
 * Markdown document without a mounted editor: approved comments are dropped
 * the way removeCommentIds plus a comments-map delete does inside one, and
 * each mark decision runs the same transform the editor commands use, taking
 * the mark's reply thread with it. An anchor emptied by the whole set being
 * removed is disposed on the same rule removeCommentIds applies. Returns the
 * input untouched when nothing applies, so a no-op never rewrites the file.
 */
export function applyPendingApprovalsToCriticMarkdown(
  markdown: string,
  approvals: PendingApprovals,
  options?: MarkdownOptions,
): string {
  const { doc, comments, frontmatter, endmatter, idCounters } =
    criticMarkdownToEditorState(markdown, options);
  const schema = getSchema(createEditorExtensions(""));
  const transform = new Transform(schema.nodeFromJSON(doc));
  const removedIds = new Set(
    [...(approvals.commentIds ?? [])].filter((commentId) =>
      comments.has(commentId),
    ),
  );
  let appliedDecisions = 0;

  for (const decision of approvals.changeDecisions ?? []) {
    if (!applyCriticChangeDecision(transform, decision)) continue;

    appliedDecisions += 1;
    for (const commentId of getSuggestionThreadCommentIds(
      decision.changeId,
      comments,
    )) {
      removedIds.add(commentId);
    }
  }

  if (appliedDecisions === 0 && removedIds.size === 0) return markdown;

  const disposableAnchorIds = new Set(
    disposableAnchorCommentIds(removedIds, comments),
  );
  const nextComments = new Map(comments);
  for (const commentId of removedIds) {
    nextComments.delete(commentId);
  }

  const decidedDoc = transform.doc.toJSON() as JSONContent;

  return editorStateToCriticMarkdown(
    removeCommentIdsFromDoc(decidedDoc, removedIds, disposableAnchorIds) ??
      decidedDoc,
    nextComments,
    { frontmatter, endmatter, idCounters },
  );
}

export function createCriticComment(
  partial?: Partial<CriticComment>,
  options?: {
    existingComments?: Iterable<Pick<CriticComment, "id">>;
    idCounters?: ReviewIdCounters;
  },
): CriticComment {
  return createCommentWithContext(
    partial,
    options?.existingComments,
    options?.idCounters,
  );
}

export function createCriticChange(
  kind: CriticChangeKind,
  partial?: Partial<CriticChangeAttrs>,
  options?: {
    existingChanges?: Iterable<Pick<CriticChangeAttrs, "changeId">>;
    idCounters?: ReviewIdCounters;
  },
): CriticChangeAttrs {
  return createChangeWithContext(
    kind,
    partial,
    options?.existingChanges,
    options?.idCounters,
  );
}
