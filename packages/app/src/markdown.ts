import { tables, taskListItems } from "@joplin/turndown-plugin-gfm";
import { Marked, marked, type TokenizerObject } from "marked";
import TurndownService from "turndown";
import { parse as parseYaml } from "yaml";

export const rawMarkdownBlockAttribute = "data-markdown-raw-block";
// A newline inside a paragraph, blockquote line, or list item. The span holds
// a real space so the editor, find-in-page, and copied text read it as one;
// it is written back as the newline the author typed.
export const markdownSoftBreakAttribute = "data-markdown-softbreak";
const markdownSoftBreakHtml = `<span ${markdownSoftBreakAttribute}=""> </span>`;
const markdownSoftBreakWithSpace = new RegExp(
  `(<span ${markdownSoftBreakAttribute}="">) (</span>)`,
  "g",
);
// A soft break inside one of these must stay a space: a heading or table
// cell cannot span lines in markdown.
const singleLineBlockSelector = "h1, h2, h3, h4, h5, h6, th, td";
// The table's delimiter row exactly as the author typed it, so a save does
// not rewrite `|---|---|` as `| --- | --- |`.
export const markdownTableSeparatorAttribute = "data-markdown-table-separator";
const markdownTableSeparatorLine =
  /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
export const rawMarkdownBlockTypeAttribute = "data-markdown-raw-block-type";

export type RawMarkdownBlockType =
  | "table"
  | "details"
  | "html-comment"
  | "indented-code";

export interface MarkdownOptions {
  resolveFileUrl?: (path: string) => string | null;
  resolveLinkUrl?: (path: string) => string | null;
}

export interface YamlFrontmatterSplit {
  frontmatter: string | null;
  body: string;
}

export interface YamlDocumentMetadataSplit {
  frontmatter: string | null;
  body: string;
  endmatter: string | null;
}

function isExternalUrl(path: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//");
}

function isInPageAnchor(path: string): boolean {
  return path.startsWith("#");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function encodeRawMarkdownBlock(markdown: string): string {
  return encodeURIComponent(markdown);
}

export function decodeRawMarkdownBlock(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function createRawMarkdownBlock(
  markdown: string,
  blockType: RawMarkdownBlockType,
): string {
  return `<div ${rawMarkdownBlockAttribute}="${escapeHtml(
    encodeRawMarkdownBlock(markdown),
  )}" ${rawMarkdownBlockTypeAttribute}="${blockType}"></div>\n`;
}

function protectRawHtmlBlocks(markdown: string): string {
  return markdown
    .replace(
      /^[ \t]*<details\b[\s\S]*?<\/details>[ \t]*(?:\r?\n|$)/gim,
      (raw) => createRawMarkdownBlock(raw, "details"),
    )
    .replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*(?:\r?\n|$)/gm, (raw) =>
      createRawMarkdownBlock(raw, "html-comment"),
    );
}

function protectIndentedCodeAfterLists(markdown: string): string {
  return markdown.replace(
    /^(?:[-*+]|\d+[.)]) [^\r\n]*(?:\r?\n)[ \t]*(?:\r?\n)(?:(?: {4}|\t)[^\r\n]*(?:\r?\n|$))+/gm,
    (raw) => createRawMarkdownBlock(raw, "indented-code"),
  );
}

function codeSpanContainsPipe(value: string): boolean {
  return /`[^`\n]*\|[^`\n]*`/.test(value);
}

function protectPipeSensitiveTables(markdown: string): string {
  const lines = markdown.match(/[^\r\n]*(?:\r?\n|$)/g) ?? [];
  const output: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const nextLine = lines[index + 1] ?? "";

    if (
      !line.includes("|") ||
      !/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(nextLine)
    ) {
      output.push(line);
      continue;
    }

    const tableLines = [line, nextLine];
    index += 2;

    while (index < lines.length) {
      const row = lines[index] ?? "";
      if (!row.trim() || !row.includes("|")) break;
      tableLines.push(row);
      index += 1;
    }

    const raw = tableLines.join("");
    const needsProtection = raw.includes("\\|") || codeSpanContainsPipe(raw);
    output.push(needsProtection ? createRawMarkdownBlock(raw, "table") : raw);
    index -= 1;
  }

  return output.join("");
}

export function protectRichTextRoundTripMarkdown(markdown: string): string {
  return protectPipeSensitiveTables(
    protectIndentedCodeAfterLists(protectRawHtmlBlocks(markdown)),
  );
}

function normalizeMarkdownPath(path: string): string {
  if (path.startsWith("./") || path.startsWith("../")) return path;
  return `./${path.replace(/^\/+/, "")}`;
}

function tableHasUnsupportedMarkdownContent(table: HTMLTableElement): boolean {
  return Boolean(
    table.querySelector(
      "blockquote, h1, h2, h3, h4, h5, h6, hr, ol, pre, table, ul",
    ),
  );
}

function getFirstTableRow(table: HTMLTableElement): HTMLTableRowElement | null {
  return table.rows.length > 0 ? table.rows[0] : null;
}

function isHeaderTableRow(row: HTMLTableRowElement | null): boolean {
  if (!row || row.cells.length === 0) return false;

  return Array.from(row.cells).every((cell) => cell.tagName === "TH");
}

function isMarkdownTableDivider(line: string | undefined): boolean {
  return Boolean(line && /^\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line));
}

function markdownTableDividerForCell(cell: HTMLTableCellElement): string {
  const alignment = (
    cell.getAttribute("align") ||
    cell.style.textAlign ||
    ""
  ).toLowerCase();

  if (alignment === "left") return ":---";
  if (alignment === "right") return "---:";
  if (alignment === "center") return ":---:";

  return "---";
}

function markdownTableDividerForRow(row: HTMLTableRowElement): string {
  const dividers = Array.from(row.cells).map(markdownTableDividerForCell);
  return `| ${dividers.join(" | ")} |`;
}

function markdownTableSeparatorColumnCount(separator: string): number {
  return separator.trim().replace(/^\|/, "").replace(/\|$/, "").split("|")
    .length;
}

function typedMarkdownTableSeparator(
  table: HTMLTableElement,
  headerRow: HTMLTableRowElement,
): string | null {
  const separator = table.getAttribute(markdownTableSeparatorAttribute);
  if (!separator || !markdownTableSeparatorLine.test(separator)) return null;
  return markdownTableSeparatorColumnCount(separator) === headerRow.cells.length
    ? separator
    : null;
}

/**
 * The markdown one soft-break span stands for: the newline the author typed,
 * or a space where the block it sits in cannot span lines.
 */
export function softBreakMarkdown(node: HTMLElement): string {
  return node.closest(singleLineBlockSelector) ? " " : "\n";
}

function resolveRenderedUrl(
  path: string,
  resolveFileUrl?: MarkdownOptions["resolveFileUrl"],
) {
  if (isExternalUrl(path) || isInPageAnchor(path)) return path;
  return resolveFileUrl?.(path) ?? path;
}

function isYamlFrontmatterDelimiter(line: string): boolean {
  return /^(?:---|\.\.\.)[ \t]*$/.test(line.replace(/\r$/, ""));
}

function isReviewEndmatterMap(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isReviewIdCountersMap(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const entries = Object.entries(value as Record<string, unknown>);
  return (
    entries.length > 0 &&
    entries.every(
      ([family, count]) =>
        (family === "comments" || family === "suggestions") &&
        typeof count === "number" &&
        Number.isInteger(count) &&
        count >= 0,
    )
  );
}

function hasDocumentLevelComment(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  return Object.values(value as Record<string, unknown>).some(
    (entry) =>
      Boolean(entry) &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      typeof (entry as Record<string, unknown>).body === "string" &&
      typeof (entry as Record<string, unknown>).by === "string" &&
      typeof (entry as Record<string, unknown>).at === "string" &&
      typeof (entry as Record<string, unknown>).re !== "string",
  );
}

function hasEndmatterReply(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  return Object.values(value as Record<string, unknown>).some(
    (entry) =>
      Boolean(entry) &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      typeof (entry as Record<string, unknown>).body === "string" &&
      typeof (entry as Record<string, unknown>).re === "string",
  );
}

function isRoughdraftReviewEndmatter(endmatter: string): boolean {
  const yamlText = endmatter.replace(/^---[ \t]*(?:\r\n|\n)/, "");
  let parsed: unknown;

  try {
    parsed = parseYaml(yamlText);
  } catch {
    return false;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }

  const record = parsed as Record<string, unknown>;
  return (
    isReviewEndmatterMap(record.comments) ||
    isReviewEndmatterMap(record.suggestions) ||
    isReviewIdCountersMap(record.counters)
  );
}

export function splitYamlFrontmatter(markdown: string): YamlFrontmatterSplit {
  const openingDelimiter = markdown.match(/^---[ \t]*(?:\r\n|\n)/);
  if (!openingDelimiter) return { frontmatter: null, body: markdown };

  let lineStart = openingDelimiter[0].length;

  while (lineStart < markdown.length) {
    const nextLineBreak = markdown.indexOf("\n", lineStart);
    const lineEnd = nextLineBreak === -1 ? markdown.length : nextLineBreak + 1;
    const line = markdown.slice(
      lineStart,
      nextLineBreak === -1 ? lineEnd : lineEnd - 1,
    );

    if (isYamlFrontmatterDelimiter(line)) {
      let bodyStart = lineEnd;

      while (bodyStart < markdown.length) {
        const blankLineBreak = markdown.indexOf("\n", bodyStart);
        const blankLineEnd =
          blankLineBreak === -1 ? markdown.length : blankLineBreak + 1;
        const blankLine = markdown.slice(
          bodyStart,
          blankLineBreak === -1 ? blankLineEnd : blankLineEnd - 1,
        );

        if (blankLine.replace(/\r$/, "").trim() !== "") break;
        bodyStart = blankLineEnd;
      }

      return {
        frontmatter: markdown.slice(0, bodyStart),
        body: markdown.slice(bodyStart),
      };
    }

    lineStart = lineEnd;
  }

  return { frontmatter: null, body: markdown };
}

export function prependYamlFrontmatter(
  markdown: string,
  frontmatter?: string | null,
): string {
  return frontmatter ? `${frontmatter}${markdown}` : markdown;
}

export function splitYamlDocumentMetadata(
  markdown: string,
): YamlDocumentMetadataSplit {
  const { frontmatter, body } = splitYamlFrontmatter(markdown);
  const matches = [...body.matchAll(/\n---[ \t]*\r?\n/g)];
  const match = matches.at(-1);

  if (!match || match.index === undefined) {
    return { frontmatter, body, endmatter: null };
  }

  const endmatter = body.slice(match.index);
  const candidate = endmatter.replace(/^\n/, "");

  const precedingBody = body.slice(0, match.index);
  if (!isRoughdraftReviewEndmatter(candidate)) {
    return { frontmatter, body, endmatter: null };
  }
  if (!precedingBody.includes("{#")) {
    const yamlText = candidate.replace(/^---[ \t]*(?:\r\n|\n)/, "");
    const parsed = parseYaml(yamlText) as Record<string, unknown> | null;
    if (
      !hasDocumentLevelComment(parsed?.comments) &&
      !hasEndmatterReply(parsed?.comments) &&
      !isReviewIdCountersMap(parsed?.counters)
    ) {
      return { frontmatter, body, endmatter: null };
    }
  }

  return {
    frontmatter,
    body: body.slice(0, match.index).replace(/\s*$/, "\n"),
    endmatter: candidate,
  };
}

export function appendYamlEndmatter(
  markdown: string,
  endmatter?: string | null,
): string {
  return endmatter
    ? `${markdown.replace(/\s*$/, "\n")}\n${endmatter}`
    : markdown;
}

// GFM opens strikethrough on one tilde as well as two, so ordinary prose like
// `~57% (~100h)` parses as `<del>57% (</del>100h)` and saves back as
// `~~57% (~~100h)`. Only `~~text~~` is strikethrough here; a lone `~` is text.
// Returning false hands the source to marked's own rule, undefined matches
// nothing.
export const strictStrikethroughTokenizer: TokenizerObject = {
  del(src) {
    return src.startsWith("~~") ? false : undefined;
  },
};

export function createMarkedRenderer(options?: MarkdownOptions) {
  const renderer = new marked.Renderer();
  const baseRenderer = new marked.Renderer();
  const resolveFileUrl = options?.resolveFileUrl;
  const resolveLinkUrl = options?.resolveLinkUrl;

  renderer.code = ({ text, lang, escaped }) => {
    const language = (lang || "").match(/\S+/)?.[0];
    const content = escaped ? text : escapeHtml(text);
    const classAttr = language
      ? ` class="language-${escapeHtml(language)}"`
      : "";

    return `<pre><code${classAttr}>${content}</code></pre>\n`;
  };

  renderer.text = function (token) {
    const html = baseRenderer.text.call(this, token);
    if ("tokens" in token && token.tokens) return html;
    if ("escaped" in token && token.escaped) return html;
    return html.replaceAll("\n", markdownSoftBreakHtml);
  };

  renderer.table = function (token) {
    const html = baseRenderer.table.call(this, token);
    const separator = token.raw.split("\n")[1]?.trimEnd();
    if (!separator) return html;
    return html.replace(
      "<table>",
      `<table ${markdownTableSeparatorAttribute}="${escapeHtml(separator)}">`,
    );
  };

  renderer.link = function ({ href, title, tokens, raw }) {
    const rawHref = href || "";
    const renderedHref = resolveRenderedUrl(
      rawHref,
      (path) => resolveLinkUrl?.(path) ?? resolveFileUrl?.(path) ?? null,
    );
    const text = this.parser.parseInline(tokens);
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    const markdownSrcAttr = ` data-markdown-src="${escapeHtml(rawHref)}"`;
    const autolinkAttr =
      !title && raw?.startsWith("<") && raw.endsWith(">")
        ? ' data-markdown-autolink="true"'
        : "";
    const externalAttr =
      isExternalUrl(rawHref) && !rawHref.startsWith("mailto:")
        ? ' target="_blank" rel="noreferrer noopener"'
        : "";

    return `<a href="${escapeHtml(renderedHref)}"${titleAttr}${markdownSrcAttr}${autolinkAttr}${externalAttr}>${text}</a>`;
  };

  renderer.image = ({ href, title, text }) => {
    const rawHref = href || "";
    const renderedHref = resolveRenderedUrl(rawHref, resolveFileUrl);
    const alt = text || "";
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    const markdownSrcAttr = ` data-markdown-src="${escapeHtml(rawHref)}"`;

    return `<img src="${escapeHtml(renderedHref)}" alt="${escapeHtml(alt)}"${titleAttr}${markdownSrcAttr}>`;
  };

  renderer.list = function (token) {
    const hasTaskItems = token.items.some((item) => item.task);
    if (!hasTaskItems) {
      return baseRenderer.list.call(this, token);
    }

    const items = token.items
      .map((item) => {
        const checked = item.checked ? "true" : "false";
        const inner = this.parser.parse(item.tokens, false);
        return `<li data-type="taskItem" data-checked="${checked}"><label><input type="checkbox"${
          item.checked ? ' checked="checked"' : ""
        }><span></span></label><div>${inner}</div></li>`;
      })
      .join("");

    return `<ul data-type="taskList">${items}</ul>`;
  };

  return renderer;
}

export function createTurndownService(): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    blankReplacement(_content, node) {
      if (node.hasAttribute(markdownSoftBreakAttribute)) {
        return softBreakMarkdown(node);
      }
      if (node.hasAttribute(rawMarkdownBlockAttribute)) {
        return `\n\n${decodeRawMarkdownBlock(
          node.getAttribute(rawMarkdownBlockAttribute) ?? "",
        ).trimEnd()}\n\n`;
      }

      return (node as HTMLElement & { isBlock?: boolean }).isBlock
        ? "\n\n"
        : "";
    },
  });

  service.use(tables as Parameters<TurndownService["use"]>[0]);
  service.use(taskListItems as Parameters<TurndownService["use"]>[0]);

  // Turndown prefixes every line with "> ", which leaves a trailing space
  // on the blank line between quoted paragraphs.
  service.addRule("blockquoteWithoutTrailingSpace", {
    filter: "blockquote",
    replacement(content) {
      const quoted = content
        .replace(/^\n+|\n+$/g, "")
        .replace(/^(.?)/gm, (_line, first: string) =>
          first ? `> ${first}` : ">",
        );
      return `\n\n${quoted}\n\n`;
    },
  });

  service.addRule("compactListItem", {
    filter: "li",
    replacement(content, node, options) {
      const trimmed = content
        .replace(/^\n+/, "")
        .replace(/\n+$/, "\n")
        .replace(/\n{2,}(?=(?:[-*+]|\d+[.)]) )/g, "\n")
        .replace(/\n(?=[^\n])/g, "\n  ");

      let prefix = `${options.bulletListMarker} `;
      const parent = node.parentNode;
      if (parent && parent.nodeName === "OL") {
        const start = (parent as HTMLOListElement).getAttribute("start");
        const index = Array.prototype.indexOf.call(parent.children, node);
        prefix = `${start ? Number(start) + index : index + 1}. `;
      }

      return (
        prefix +
        trimmed +
        (node.nextSibling && !/\n$/.test(trimmed) ? "\n" : "")
      );
    },
  });

  service.addRule("tiptapHeaderTable", {
    filter(node) {
      if (node.tagName !== "TABLE") return false;

      const table = node as HTMLTableElement;
      return (
        !tableHasUnsupportedMarkdownContent(table) &&
        isHeaderTableRow(getFirstTableRow(table))
      );
    },
    replacement(content, node) {
      const table = node as HTMLTableElement;
      const headerRow = getFirstTableRow(table);
      if (!headerRow) return content;

      const lines = content.replace(/\n+/g, "\n").trim().split("\n");
      if (lines.length === 0) return content;

      if (!isMarkdownTableDivider(lines[1])) {
        lines.splice(1, 0, markdownTableDividerForRow(headerRow));
      }
      const typedSeparator = typedMarkdownTableSeparator(table, headerRow);
      if (typedSeparator) lines[1] = typedSeparator;

      const captionContent = table.caption?.textContent || "";
      const caption = captionContent ? `${captionContent}\n\n` : "";

      return `\n\n${caption}${lines.join("\n")}\n\n`;
    },
  });

  // We own the markdown parser and want stable round-trips without doubled escapes.
  service.escape = (value: string) => value;

  service.addRule("markdownAwareLinks", {
    filter: "a",
    replacement(content, node) {
      const element = node as HTMLAnchorElement;
      const href =
        element.getAttribute("data-markdown-src") ||
        element.getAttribute("href") ||
        "";
      const normalizedHref =
        isExternalUrl(href) || isInPageAnchor(href)
          ? href
          : normalizeMarkdownPath(href);
      const title = element.getAttribute("title");
      const titleMarkdown = title
        ? ` "${title.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
        : "";

      if (
        element.getAttribute("data-markdown-autolink") === "true" &&
        !titleMarkdown
      ) {
        return href.startsWith("mailto:")
          ? `<${href.slice("mailto:".length)}>`
          : `<${normalizedHref}>`;
      }

      return `[${content}](${normalizedHref}${titleMarkdown})`;
    },
  });

  service.addRule("markdownAwareImages", {
    filter: "img",
    replacement(_content, node) {
      const element = node as HTMLImageElement;
      const src =
        element.getAttribute("data-markdown-src") ||
        element.getAttribute("src") ||
        "";
      const normalizedSrc = isExternalUrl(src)
        ? src
        : normalizeMarkdownPath(src);
      const alt = element.getAttribute("alt") || "";
      const title = element.getAttribute("title");
      const titleMarkdown = title
        ? ` "${title.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
        : "";
      return `![${alt}](${normalizedSrc}${titleMarkdown})`;
    },
  });

  service.addRule("markdownSoftBreak", {
    filter: (node) =>
      node.nodeName === "SPAN" &&
      (node as HTMLElement).hasAttribute(markdownSoftBreakAttribute),
    replacement(_content, node) {
      return softBreakMarkdown(node as HTMLElement);
    },
  });

  service.addRule("markdownStrikethrough", {
    filter: (node) =>
      node.nodeName === "DEL" ||
      node.nodeName === "S" ||
      node.nodeName === "STRIKE",
    replacement(content) {
      return `~~${content}~~`;
    },
  });

  service.addRule("rawMarkdownBlock", {
    filter: (node) =>
      node.nodeType === 1 &&
      (node as HTMLElement).hasAttribute(rawMarkdownBlockAttribute),
    replacement(_content, node) {
      const encoded =
        (node as HTMLElement).getAttribute(rawMarkdownBlockAttribute) ?? "";
      return `\n\n${decodeRawMarkdownBlock(encoded).trimEnd()}\n\n`;
    },
  });

  return service;
}

const turndown = createTurndownService();

const atxHeadingLine = /^#{1,6} /;
// A table row, fence marker, or blockquote line. A heading must not be glued
// to one of these: the blank line before the heading is what ends that block.
const structuralBlockLine = /^ {0,3}(?:\||`{3}|~{3}|>)/;
const fenceOpeningLine = /^ {0,3}(`{3,}|~{3,})/;

function isRemovableHeadingGap(previous: string, next: string): boolean {
  if (atxHeadingLine.test(previous)) return true;
  return atxHeadingLine.test(next) && !structuralBlockLine.test(previous);
}

function fenceClosingLine(marker: string): RegExp {
  return new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`);
}

/**
 * Collapse runs of 3+ newlines to 2 and remove the blank line that
 * Turndown inserts before/after ATX headings.  This keeps block
 * separation where it matters (between consecutive paragraphs) while
 * producing a more compact output that round-trips with fewer
 * gratuitous whitespace changes.  The blank line after a heading is
 * always removed, since a heading is a single-line block and whatever
 * follows starts fresh.  The blank line before a heading is removed only
 * when the line above is not a table row, fence marker, or blockquote
 * line.  Lines inside a fenced code block are code, so the walk copies
 * them through untouched.
 */
export function normalizeBlockSpacing(md: string): string {
  const lines = md.split("\n");
  const kept: string[] = [];
  let closingFence: RegExp | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (closingFence) {
      kept.push(line);
      if (closingFence.test(line)) closingFence = null;
      continue;
    }
    const fence = line.match(fenceOpeningLine);
    if (fence) {
      kept.push(line);
      closingFence = fenceClosingLine(fence[1]);
      continue;
    }
    if (line === "") {
      const previous = kept.at(-1);
      if (previous === "") continue;
      let nextIndex = index + 1;
      while (nextIndex < lines.length && lines[nextIndex] === "") nextIndex++;
      if (
        previous !== undefined &&
        nextIndex < lines.length &&
        isRemovableHeadingGap(previous, lines[nextIndex])
      ) {
        continue;
      }
    }
    kept.push(line);
  }
  return kept.join("\n");
}

/**
 * Turndown lifts whitespace inside an inline element out as flanking text,
 * so the space in a soft break span would land in the output next to the
 * newline. Swap it for a zero-width placeholder before Turndown sees it: an
 * emptied span would count as blank, and a change mark wrapping only a soft
 * break would then be dropped instead of written as `{--\n--}`.
 */
export function placeholderSoftBreakSpans(html: string): string {
  return html.replace(markdownSoftBreakWithSpace, "$1\u200b$2");
}

export function toMarkdown(html: string): string {
  return normalizeBlockSpacing(
    `${turndown.turndown(placeholderSoftBreakSpans(html)).trimEnd()}\n`,
  );
}

export function toHtml(markdown: string, options?: MarkdownOptions): string {
  const parser = new Marked({
    async: false,
    gfm: true,
    renderer: createMarkedRenderer(options),
    tokenizer: strictStrikethroughTokenizer,
  });

  return parser.parse(markdown) as string;
}
