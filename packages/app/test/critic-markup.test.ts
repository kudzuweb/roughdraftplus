import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import {
  advanceReviewIdCounters,
  createCriticChange,
  createCriticComment,
  createNextChangeId,
  createNextCommentId,
  criticMarkdownHasReviewRail,
  criticMarkdownToEditorState,
  criticMarkdownToRenderedHtml,
  disposableAnchorCommentIds,
  editorStateToCriticMarkdown,
  applyPendingApprovalsToCriticMarkdown,
  getCommentDescendantIds,
} from "../src/critic-markup";
import { createEditorExtensions } from "../src/editor-extensions";

function readMarkdownFixture(name: string): string {
  return `${fs
    .readFileSync(
      path.join(process.cwd(), "test", "fixtures", "markdown", name),
      "utf8",
    )
    .trimEnd()}\n`;
}

describe("CriticMarkup comments", () => {
  it("preserves YAML frontmatter delimiters and raw table-like YAML text", () => {
    const input = [
      "---",
      "title: Frontmatter round trip",
      "summary: |",
      "  | column | value |",
      "  | --- | --- |",
      "  | path | docs/table.md |",
      "tags:",
      "  - roughdraft",
      "---",
      "",
      "# Body",
      "Opening this file in rich text should not rewrite frontmatter.",
      "",
    ].join("\n");

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("detects review rail content without counting fenced examples", () => {
    expect(
      criticMarkdownHasReviewRail(
        [
          "```md",
          "This is {--deleted--} text.",
          "This is {++inserted++} text.",
          "This is {~~old~>new~~} substituted text.",
          "This is {>>a comment<<} in the margin.",
          "```",
        ].join("\n"),
      ),
    ).toBe(false);
    expect(
      criticMarkdownHasReviewRail(
        [
          "<details>",
          "<summary>Literal examples</summary>",
          "",
          '{==example==}{>>literal HTML comment example<<}{id="c60" by="AI" at="2026-05-24T18:50:00.000Z"}',
          "",
          "</details>",
          "",
        ].join("\n"),
      ),
    ).toBe(false);

    expect(
      criticMarkdownHasReviewRail(
        'This is {==anchored text==}{>>a threaded comment<<}{id="c1" by="user" at="2026-04-23T18:00:00.000Z"}.\n',
      ),
    ).toBe(true);
    expect(criticMarkdownHasReviewRail("This is {++inserted++} text.\n")).toBe(
      true,
    );
  });

  it("round-trips a highlighted comment anchor", () => {
    const input =
      'This is {==highlighted==}{>>comment text<<}{id="cmt1" by="AI" at="2024-01-15T10:30:00.000Z"} text.\n';

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(comments.get("cmt1")).toMatchObject({
      id: "cmt1",
      content: "comment text",
      authorType: "ai",
    });
    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("renders YAML endmatter-backed root comments and replies", () => {
    const input = [
      "This is {==highlighted==}{>>comment text<<}{#c1} text.",
      "",
      "---",
      "comments:",
      "  c1:",
      "    by: AI",
      '    at: "2024-01-15T10:30:00.000Z"',
      "  c2:",
      "    body: Reply text",
      "    by: user",
      '    at: "2024-01-15T10:31:00.000Z"',
      "    re: c1",
      "",
    ].join("\n");

    const { doc, comments, endmatter } = criticMarkdownToEditorState(input);

    expect(endmatter).toContain("comments:");
    expect(comments.get("c1")).toMatchObject({
      id: "c1",
      content: "comment text",
      authorType: "ai",
    });
    expect(comments.get("c2")).toMatchObject({
      id: "c2",
      content: "Reply text",
      parentCommentId: "c1",
    });
    const output = editorStateToCriticMarkdown(doc, comments);
    expect(output).toContain("{==highlighted==}{>>comment text<<}{#c1}");
    expect(output).toContain("body: Reply text");
    expect(output).toContain("re: c1");
  });

  it("does not treat horizontal rules and fenced YAML examples as review endmatter", () => {
    const input = [
      "# Markdown examples",
      "",
      "A normal horizontal rule follows.",
      "",
      "---",
      "",
      "```yaml",
      "comments:",
      "  c1:",
      "    body: This is documentation, not review metadata.",
      "suggestions:",
      "  s1:",
      "    by: AI",
      "```",
      "",
    ].join("\n");

    const { doc, comments, endmatter } = criticMarkdownToEditorState(input);
    const output = editorStateToCriticMarkdown(doc, comments);

    expect(endmatter).toBeNull();
    expect(comments.size).toBe(0);
    expect(output).toContain("* * *");
    expect(output).toContain("```yaml");
    expect(output).toContain("comments:");
    expect(output).toContain("suggestions:");
    expect(output).toContain("This is documentation, not review metadata.");
  });

  it("does not treat ordinary final comments sections as review endmatter", () => {
    const input = [
      "# Release notes",
      "",
      "---",
      "comments:",
      "  c1:",
      "    by: docs",
      '    at: "not review metadata"',
      "",
    ].join("\n");

    const { doc, comments, endmatter } = criticMarkdownToEditorState(input);
    const output = editorStateToCriticMarkdown(doc, comments);

    expect(endmatter).toBeNull();
    expect(comments.size).toBe(0);
    expect(output).toContain("comments:");
    expect(output).toContain("not review metadata");
  });

  it("writes YAML metadata for new suggestions in endmatter-backed documents", () => {
    const input = [
      "Replace {++draft++}{#s1}.",
      "",
      "---",
      "suggestions:",
      "  s1:",
      "    by: AI",
      '    at: "2026-05-24T10:00:00.000Z"',
      "",
    ].join("\n");
    const parsed = criticMarkdownToEditorState(input);
    const nextDoc = structuredClone(parsed.doc);
    const paragraph = nextDoc.content?.[0];

    paragraph?.content?.push(
      { type: "text", text: " Add " },
      {
        type: "text",
        text: "specifics",
        marks: [
          {
            type: "criticChange",
            attrs: createCriticChange("addition", {
              changeId: "s2",
              createdAt: "2026-05-24T11:00:00.000Z",
              authorType: "user",
              authorId: "user",
            }),
          },
        ],
      },
      { type: "text", text: "." },
    );

    const output = editorStateToCriticMarkdown(nextDoc, parsed.comments);

    expect(output).toContain("{++specifics++}{#s2}");
    expect(output).toContain("suggestions:");
    expect(output).toContain("s1:");
    expect(output).toContain("s2:");
    expect(output).toContain("at: 2026-05-24T11:00:00.000Z");
  });

  it("removes deleted comments and replies from YAML endmatter", () => {
    const input = [
      "Please revisit {==this claim==}{>>Needs a source.<<}{#c1}.",
      "",
      "---",
      "comments:",
      "  c1:",
      "    by: Nora",
      '    at: "2026-05-24T10:45:00.000Z"',
      "  c2:",
      "    body: I can soften this.",
      "    by: AI",
      '    at: "2026-05-24T10:46:00.000Z"',
      "    re: c1",
      "  c3:",
      "    body: Stale reply.",
      "    by: AI",
      '    at: "2026-05-24T10:47:00.000Z"',
      "    re: c1",
      "",
    ].join("\n");
    const { doc, comments } = criticMarkdownToEditorState(input);
    const nextComments = new Map(comments);

    nextComments.delete("c2");
    nextComments.delete("c3");

    const output = editorStateToCriticMarkdown(doc, nextComments);

    expect(output).toContain("comments:");
    expect(output).toContain("c1:");
    expect(output).not.toContain("c2:");
    expect(output).not.toContain("c3:");
    expect(output).not.toContain("I can soften this.");
    expect(output).not.toContain("Stale reply.");
  });

  it("preserves unknown top-level YAML endmatter keys on save", () => {
    const input = [
      "Please revisit {==this claim==}{>>Needs a source.<<}{#c1}.",
      "",
      "---",
      "comments:",
      "  c1:",
      "    by: Nora",
      '    at: "2026-05-24T10:45:00.000Z"',
      "workflow:",
      "  owner: editorial",
      "",
    ].join("\n");

    const { doc, comments } = criticMarkdownToEditorState(input);
    const output = editorStateToCriticMarkdown(doc, comments);

    expect(output).toContain("workflow:");
    expect(output).toContain("owner: editorial");
  });

  it("renders YAML endmatter-backed unanchored comments", () => {
    const input = [
      "This paragraph has an unanchored note.{>>Consider whether this belongs in the executive summary instead.<<}{#c3}",
      "",
      "---",
      "comments:",
      "  c3:",
      "    by: user",
      '    at: "2026-05-24T17:00:00.000Z"',
      "",
    ].join("\n");

    expect(criticMarkdownHasReviewRail(input)).toBe(true);

    const { html, comments } = criticMarkdownToRenderedHtml(input);
    const parsed = criticMarkdownToEditorState(input);
    const output = editorStateToCriticMarkdown(parsed.doc, parsed.comments);

    expect(comments.get("c3")).toMatchObject({
      id: "c3",
      content:
        "Consider whether this belongs in the executive summary instead.",
      authorType: "user",
      createdAt: "2026-05-24T17:00:00.000Z",
    });
    expect(html).toContain('data-comment-ids="[&quot;c3&quot;]"');
    expect(html).toContain('data-comment-anchorless="true"');
    expect(html).not.toContain("{&gt;&gt;Consider whether");
    expect(output).toContain(
      "This paragraph has an unanchored note.{>>Consider whether this belongs in the executive summary instead.<<}{#c3}",
    );
    expect(output).not.toContain("{==\u2060==}");
  });

  it("renders and preserves YAML endmatter-backed document-level comments", () => {
    const input = [
      "# Draft",
      "",
      "---",
      "comments:",
      "  c1:",
      "    body: Please address the risk section.",
      "    by: user",
      '    at: "2026-05-24T12:00:00.000Z"',
      "",
    ].join("\n");

    expect(criticMarkdownHasReviewRail(input)).toBe(true);

    const parsed = criticMarkdownToEditorState(input);
    const output = editorStateToCriticMarkdown(parsed.doc, parsed.comments);

    expect(parsed.comments.get("c1")).toMatchObject({
      id: "c1",
      content: "Please address the risk section.",
      authorType: "user",
      createdAt: "2026-05-24T12:00:00.000Z",
      parentCommentId: null,
      scope: "document",
    });
    expect(output).toContain("comments:");
    expect(output).toContain("  c1:");
    expect(output).toContain("    body: Please address the risk section.");
    expect(output).not.toContain("{#c1}");
  });

  it("reserves YAML endmatter-backed unanchored comment ids for new replies", () => {
    const input = [
      "Please revisit {==this claim==}{>>This needs a source.<<}{#c1}.",
      "",
      "This paragraph has an unanchored note.{>>Consider whether this belongs in the executive summary instead.<<}{#c3}",
      "",
      "---",
      "comments:",
      "  c1:",
      "    by: Nora",
      '    at: "2026-05-24T10:45:00.000Z"',
      "  c2:",
      "    body: I can soften the claim if we do not have a citation.",
      "    by: AI",
      '    at: "2026-05-24T10:46:00.000Z"',
      "    re: c1",
      "  c3:",
      "    by: user",
      '    at: "2026-05-24T17:00:00.000Z"',
      "suggestions:",
      "  s1:",
      "    by: AI",
      '    at: "2026-05-24T10:48:00.000Z"',
      "",
    ].join("\n");

    const { comments } = criticMarkdownToEditorState(input);

    expect(comments.get("c3")).toMatchObject({
      id: "c3",
      content:
        "Consider whether this belongs in the executive summary instead.",
      parentCommentId: null,
    });
    expect(createNextCommentId(comments.values())).toBe("c4");
  });

  it("repairs stale YAML reply metadata when an inline root comment id was reused", () => {
    const input = [
      "Add {++one concrete customer example++}{#s1}.",
      "",
      "This paragraph has an unanchored note.{>>Consider whether this belongs in the executive summary instead.<<}{#c3}",
      "",
      "---",
      "comments:",
      "  c3:",
      "    by: user",
      '    at: "2026-05-24T17:38:55.763Z"',
      "    body: reply to suggestion",
      "    re: s1",
      "suggestions:",
      "  s1:",
      "    by: AI",
      '    at: "2026-05-24T10:48:00.000Z"',
      "",
    ].join("\n");

    const { doc, comments } = criticMarkdownToEditorState(input);
    const output = editorStateToCriticMarkdown(doc, comments);

    expect(comments.get("c3")).toMatchObject({
      id: "c3",
      content:
        "Consider whether this belongs in the executive summary instead.",
      parentCommentId: null,
    });
    expect(output).toContain(
      "This paragraph has an unanchored note.{>>Consider whether this belongs in the executive summary instead.<<}{#c3}",
    );
    expect(output).not.toContain("body: reply to suggestion");
    expect(output).not.toContain("re: s1");
    expect(createNextCommentId(comments.values())).toBe("c4");
  });

  it("renders YAML endmatter-backed suggestions", () => {
    const input = [
      "Add {++one concrete example++}{#s1}.",
      "",
      "---",
      "suggestions:",
      "  s1:",
      "    by: AI",
      '    at: "2024-01-15T10:30:00.000Z"',
      "",
    ].join("\n");

    const { changes } = criticMarkdownToRenderedHtml(input);

    expect(changes.get("s1")).toMatchObject({
      changeId: "s1",
      authorType: "ai",
      createdAt: "2024-01-15T10:30:00.000Z",
    });
  });

  it("preserves formatting nested inside a comment anchor", () => {
    const input =
      'The {==**important**==}{>>Review this phrasing<<}{id="cmt2" by="user@example.com" at="2024-01-15T10:31:00.000Z"} section stays bold.\n';

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("preserves inline code nested inside a comment anchor", () => {
    const input =
      'Check {==`roughdraft open`==}{>>Make sure this command is visible<<}{id="cmt-code" by="user" at="2024-01-15T10:31:00.000Z"} before sharing.\n';

    const { doc, comments } = criticMarkdownToEditorState(input);
    const paragraph = doc.content?.[0];
    const codeNode = paragraph?.content?.[1];

    expect(codeNode).toMatchObject({
      type: "text",
      text: "roughdraft open",
      marks: expect.arrayContaining([
        expect.objectContaining({
          type: "commentRef",
          attrs: expect.objectContaining({ commentIds: ["cmt-code"] }),
        }),
        expect.objectContaining({ type: "code" }),
      ]),
    });
    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("creates one comment anchor when a selection spans inline code", () => {
    const input =
      "Each dev wrapper keeps its own server state under `~/.roughdraft/dev/<wrapper-name>` by default, so opening works.\n";
    const { doc } = criticMarkdownToEditorState(input);
    const editor = new Editor({
      extensions: createEditorExtensions(""),
      content: doc,
    });

    try {
      const text = editor.state.doc.textBetween(
        0,
        editor.state.doc.content.size,
        "\n",
      );
      const start = text.indexOf("its own server state under");
      const end = text.indexOf(" by default") + " by default".length;

      editor.commands.setTextSelection({ from: start + 1, to: end + 1 });
      editor.commands.setCommentRef({ commentIds: ["c1"] });

      expect(
        editorStateToCriticMarkdown(
          editor.getJSON(),
          new Map([
            [
              "c1",
              {
                id: "c1",
                content: "test",
                createdAt: "2026-04-25T21:54:47.475Z",
              },
            ],
          ]),
        ),
      ).toBe(
        'Each dev wrapper keeps {==its own server state under `~/.roughdraft/dev/<wrapper-name>` by default==}{>>test<<}{id="c1" by="user" at="2026-04-25T21:54:47.475Z"}, so opening works.\n',
      );
    } finally {
      editor.destroy();
    }
  });

  it("keeps the anchor attached when nearby text changes", () => {
    const input =
      'Before {==target==}{>>Check this<<}{id="cmt3" by="AI" at="2024-01-15T10:32:00.000Z"} after.\n';
    const { doc, comments } = criticMarkdownToEditorState(input);
    const nextDoc = structuredClone(doc);
    const firstParagraph = nextDoc.content?.[0];
    const firstTextNode = firstParagraph?.content?.[0];

    if (firstTextNode?.type !== "text") {
      throw new Error("Expected leading text node in parsed paragraph");
    }

    firstTextNode.text = "Before nearby ";

    expect(editorStateToCriticMarkdown(nextDoc, comments)).toBe(
      'Before nearby {==target==}{>>Check this<<}{id="cmt3" by="AI" at="2024-01-15T10:32:00.000Z"} after.\n',
    );
  });

  it("round-trips comments inside list items and headings", () => {
    const input = `## Sprint Notes

* First item
* {==Second item==}{>>Needs review<<}{id="cmt4" by="AI" at="2024-01-15T10:33:00.000Z"}
`;

    const { doc, comments } = criticMarkdownToEditorState(input);
    const output = editorStateToCriticMarkdown(doc, comments);

    expect(output).toContain("## Sprint Notes");
    expect(output).toContain(
      '{==Second item==}{>>Needs review<<}{id="cmt4" by="AI" at="2024-01-15T10:33:00.000Z"}',
    );
    expect(output).toContain("- First item");
  });

  it("does not import a trailing blank line into fenced code blocks", () => {
    const input = `\`\`\`text
Use Roughdraft when I want to open, review, comment on, or compare markdown files.

Start it with \`roughdraft start\` if needed.
Open files or folders with \`roughdraft open "/absolute/path/to/file.md"\`.
After I finish reviewing in Roughdraft, continue by reading the markdown files from disk and making the requested changes there.
Use CriticMarkup for inline review feedback in markdown.
\`\`\`
`;

    const { doc } = criticMarkdownToEditorState(input);
    const codeBlock = doc.content?.[0];
    const textNode = codeBlock?.content?.[0];

    expect(codeBlock?.type).toBe("codeBlock");
    expect(textNode).toMatchObject({
      type: "text",
      text: `Use Roughdraft when I want to open, review, comment on, or compare markdown files.

Start it with \`roughdraft start\` if needed.
Open files or folders with \`roughdraft open "/absolute/path/to/file.md"\`.
After I finish reviewing in Roughdraft, continue by reading the markdown files from disk and making the requested changes there.
Use CriticMarkup for inline review feedback in markdown.`,
    });
    expect(editorStateToCriticMarkdown(doc, new Map())).toBe(input);
  });

  it("creates a comment anchor when a selection is inside a fenced code block", () => {
    const input = `\`\`\`ts
const command = "roughdraft open";
\`\`\`
`;
    const { doc } = criticMarkdownToEditorState(input);
    const editor = new Editor({
      extensions: createEditorExtensions(""),
      content: doc,
    });

    try {
      const text = editor.state.doc.textBetween(
        0,
        editor.state.doc.content.size,
        "\n",
      );
      const start = text.indexOf("roughdraft open");
      const end = start + "roughdraft open".length;

      editor.commands.setTextSelection({ from: start + 1, to: end + 1 });
      const added = editor.commands.setCommentRef({ commentIds: ["c1"] });

      expect(added).toBe(true);
      expect(editor.getJSON().content?.[0]).toMatchObject({
        type: "codeBlock",
        attrs: { language: "ts" },
        content: [
          {
            type: "text",
            text: 'const command = "',
          },
          {
            type: "text",
            text: "roughdraft open",
            marks: [
              {
                type: "commentRef",
                attrs: { commentIds: ["c1"] },
              },
            ],
          },
          {
            type: "text",
            text: '";',
          },
        ],
      });
      expect(
        editorStateToCriticMarkdown(
          editor.getJSON(),
          new Map([
            [
              "c1",
              {
                id: "c1",
                content: "test",
                createdAt: "2026-04-25T22:14:08.827Z",
              },
            ],
          ]),
        ),
      ).toBe(`\`\`\`ts
const command = "{==roughdraft open==}{>>test<<}{id="c1" by="user" at="2026-04-25T22:14:08.827Z"}";
\`\`\`
`);
    } finally {
      editor.destroy();
    }
  });

  it("round-trips comment anchors inside fenced code blocks", () => {
    const input = `\`\`\`ts
const command = "{==roughdraft open==}{>>test<<}{id="c1" by="user" at="2026-04-25T22:14:08.827Z"}";
\`\`\`
`;

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(doc.content?.[0]).toMatchObject({
      type: "codeBlock",
      attrs: { language: "ts" },
      content: [
        {
          type: "text",
          text: 'const command = "',
        },
        {
          type: "text",
          text: "roughdraft open",
          marks: [
            {
              type: "commentRef",
              attrs: { commentIds: ["c1"] },
            },
          ],
        },
        {
          type: "text",
          text: '";',
        },
      ],
    });
    expect(comments.get("c1")).toMatchObject({
      id: "c1",
      content: "test",
    });
    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("round-trips an anchored reply thread", () => {
    const input =
      'Please revisit {==this sentence==}{>>Needs a source<<}{id="c1" by="user" at="2024-01-15T10:30:00.000Z"}{>>I can add one from the intro.<<}{id="c2" by="AI" at="2024-01-15T10:31:00.000Z" re="c1"}.\n';

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(comments.get("c2")).toMatchObject({
      id: "c2",
      parentCommentId: "c1",
      authorType: "ai",
    });
    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("resolves one approved reply in a stacked thread and leaves the anchor and the rest of the stack untouched", () => {
    const input =
      'Please revisit {==this sentence==}{>>Needs a source<<}{id="c1" by="user" at="2024-01-15T10:30:00.000Z"}{>>I can add one from the intro.<<}{id="c2" by="AI" at="2024-01-15T10:31:00.000Z" re="c1"}{>>The market report covers it too.<<}{id="c3" by="AI" at="2024-01-15T10:32:00.000Z" re="c1"}.\n';
    const { doc, comments } = criticMarkdownToEditorState(input);
    const editor = new Editor({
      extensions: createEditorExtensions(""),
      content: doc,
    });

    try {
      editor.commands.removeCommentIds(["c2"]);
      const nextComments = new Map(comments);
      nextComments.delete("c2");

      expect(editorStateToCriticMarkdown(editor.getJSON(), nextComments)).toBe(
        'Please revisit {==this sentence==}{>>Needs a source<<}{id="c1" by="user" at="2024-01-15T10:30:00.000Z"}{>>The market report covers it too.<<}{id="c3" by="AI" at="2024-01-15T10:32:00.000Z" re="c1"}.\n',
      );
    } finally {
      editor.destroy();
    }
  });

  it("removes approved comments from a Markdown string without an editor, leaving the anchor and the rest of the stack", () => {
    const input =
      'Please revisit {==this sentence==}{>>Needs a source<<}{id="c1" by="user" at="2024-01-15T10:30:00.000Z"}{>>I can add one from the intro.<<}{id="c2" by="AI" at="2024-01-15T10:31:00.000Z" re="c1"}{>>The market report covers it too.<<}{id="c3" by="AI" at="2024-01-15T10:32:00.000Z" re="c1"}.\n';

    expect(
      applyPendingApprovalsToCriticMarkdown(input, { commentIds: ["c2"] }),
    ).toBe(
      'Please revisit {==this sentence==}{>>Needs a source<<}{id="c1" by="user" at="2024-01-15T10:30:00.000Z"}{>>The market report covers it too.<<}{id="c3" by="AI" at="2024-01-15T10:32:00.000Z" re="c1"}.\n',
    );
    expect(
      applyPendingApprovalsToCriticMarkdown(input, { commentIds: ["missing"] }),
    ).toBe(input);
  });

  // Each removed id stays reserved in the counters endmatter so it is never
  // reused; that is why every collapsed document below carries one.
  describe("pending mark decisions applied to a Markdown string", () => {
    const insertion =
      'Keep {++clear wording++}{id="s1" by="AI" at="2024-01-15T10:30:00.000Z"} here.\n';
    const substitution =
      'Use {~~old phrase~>new phrase~~}{id="s1" by="AI" at="2024-01-15T10:30:00.000Z"} here.\n';

    it("accepts an insertion into plain prose", () => {
      expect(
        applyPendingApprovalsToCriticMarkdown(insertion, {
          changeDecisions: [{ changeId: "s1", action: "accept" }],
        }),
      ).toBe("Keep clear wording here.\n\n---\ncounters:\n  suggestions: 1\n");
    });

    it("rejects an insertion, dropping its text", () => {
      expect(
        applyPendingApprovalsToCriticMarkdown(insertion, {
          changeDecisions: [{ changeId: "s1", action: "reject" }],
        }),
      ).toBe("Keep here.\n\n---\ncounters:\n  suggestions: 1\n");
    });

    it("edits an insertion into the reviewer's text as plain prose", () => {
      expect(
        applyPendingApprovalsToCriticMarkdown(insertion, {
          changeDecisions: [
            { changeId: "s1", action: "edit", text: "crisp wording" },
          ],
        }),
      ).toBe("Keep crisp wording here.\n\n---\ncounters:\n  suggestions: 1\n");
    });

    it("accepts a substitution, leaving the new text as plain prose", () => {
      expect(
        applyPendingApprovalsToCriticMarkdown(substitution, {
          changeDecisions: [{ changeId: "s1", action: "accept" }],
        }),
      ).toBe("Use new phrase here.\n\n---\ncounters:\n  suggestions: 1\n");
    });

    it("rejects a substitution, restoring the old text", () => {
      expect(
        applyPendingApprovalsToCriticMarkdown(substitution, {
          changeDecisions: [{ changeId: "s1", action: "reject" }],
        }),
      ).toBe("Use old phrase here.\n\n---\ncounters:\n  suggestions: 1\n");
    });

    it("edits a substitution into the reviewer's text as plain prose", () => {
      expect(
        applyPendingApprovalsToCriticMarkdown(substitution, {
          changeDecisions: [
            { changeId: "s1", action: "edit", text: "newer phrase" },
          ],
        }),
      ).toBe("Use newer phrase here.\n\n---\ncounters:\n  suggestions: 1\n");
    });

    it("keeps the mark's edge whitespace around edited text, since the rail editor trims what the reviewer types", () => {
      expect(
        applyPendingApprovalsToCriticMarkdown(
          'Keep{++ clear wording ++}{id="s1" by="AI" at="2024-01-15T10:30:00.000Z"}here.\n',
          {
            changeDecisions: [
              { changeId: "s1", action: "edit", text: "crisp" },
            ],
          },
        ),
      ).toBe("Keep crisp here.\n\n---\ncounters:\n  suggestions: 1\n");
    });

    it("drops the suggestion's reply thread along with the mark", () => {
      const withReply =
        'Keep {++clear wording++}{id="s1" by="AI" at="2024-01-15T10:30:00.000Z"}{>>Looks right?<<}{id="c1" by="user" at="2024-01-15T10:31:00.000Z" re="s1"}{>>Yes.<<}{id="c2" by="AI" at="2024-01-15T10:32:00.000Z" re="c1"} here.\n';

      expect(
        applyPendingApprovalsToCriticMarkdown(withReply, {
          changeDecisions: [{ changeId: "s1", action: "accept" }],
        }),
      ).toBe(
        "Keep clear wording here.\n\n---\ncounters:\n  comments: 2\n  suggestions: 1\n",
      );
    });

    it("applies comment approvals and mark decisions in one pass and ignores ids that are not present", () => {
      const input =
        'Keep {++clear wording++}{id="s1" by="AI" at="2024-01-15T10:30:00.000Z"} and {==this==}{>>Why?<<}{id="c1" by="user" at="2024-01-15T10:31:00.000Z"}{>>Because.<<}{id="c2" by="AI" at="2024-01-15T10:32:00.000Z" re="c1"} here.\n';

      expect(
        applyPendingApprovalsToCriticMarkdown(input, {
          commentIds: ["c2", "missing"],
          changeDecisions: [
            { changeId: "s1", action: "accept" },
            { changeId: "s9", action: "reject" },
          ],
        }),
      ).toBe(
        'Keep clear wording and {==this==}{>>Why?<<}{id="c1" by="user" at="2024-01-15T10:31:00.000Z"} here.\n\n---\ncounters:\n  comments: 2\n  suggestions: 1\n',
      );
      expect(
        applyPendingApprovalsToCriticMarkdown(input, {
          changeDecisions: [{ changeId: "s9", action: "accept" }],
        }),
      ).toBe(input);
    });
  });

  it("round-trips a disposable anchor flag on a comment", () => {
    const input =
      'Intro paragraph.\n\n{==Placeholder for the pricing decision.==}{>>Which tier ships first?<<}{id="c1" by="AI" at="2024-01-15T10:30:00.000Z" anchor="disposable"}\n\nClosing paragraph.\n';

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(comments.get("c1")).toMatchObject({
      id: "c1",
      anchor: "disposable",
    });
    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("removes a disposable anchor with its thread in the editor and keeps an unflagged anchor", () => {
    const disposableInput =
      'Intro paragraph.\n\n{==Placeholder for the pricing decision.==}{>>Which tier ships first?<<}{id="c1" by="AI" at="2024-01-15T10:30:00.000Z" anchor="disposable"}\n\nClosing paragraph.\n';
    const plainInput =
      'Intro paragraph.\n\n{==Placeholder for the pricing decision.==}{>>Which tier ships first?<<}{id="c1" by="AI" at="2024-01-15T10:30:00.000Z"}\n\nClosing paragraph.\n';

    const clearThread = (input: string) => {
      const { doc, comments, idCounters } = criticMarkdownToEditorState(input);
      const editor = new Editor({
        extensions: createEditorExtensions(""),
        content: doc,
      });

      try {
        editor.commands.removeCommentIds(["c1"], {
          disposableCommentIds: disposableAnchorCommentIds(["c1"], comments),
        });
        const nextComments = new Map(comments);
        nextComments.delete("c1");
        return editorStateToCriticMarkdown(editor.getJSON(), nextComments, {
          idCounters,
        });
      } finally {
        editor.destroy();
      }
    };

    expect(clearThread(disposableInput)).toBe(
      "Intro paragraph.\n\nClosing paragraph.\n\n---\ncounters:\n  comments: 1\n",
    );
    expect(clearThread(plainInput)).toBe(
      "Intro paragraph.\n\nPlaceholder for the pricing decision.\n\nClosing paragraph.\n\n---\ncounters:\n  comments: 1\n",
    );
  });

  it("removes a disposable anchor with its thread from a Markdown string and keeps an unflagged anchor", () => {
    const disposableInput =
      'Intro paragraph.\n\n{==Placeholder for the pricing decision.==}{>>Which tier ships first?<<}{id="c1" by="AI" at="2024-01-15T10:30:00.000Z" anchor="disposable"}\n\nClosing paragraph.\n';
    const plainInput =
      'Intro paragraph.\n\n{==Placeholder for the pricing decision.==}{>>Which tier ships first?<<}{id="c1" by="AI" at="2024-01-15T10:30:00.000Z"}\n\nClosing paragraph.\n';

    expect(
      applyPendingApprovalsToCriticMarkdown(disposableInput, {
        commentIds: ["c1"],
      }),
    ).toBe(
      "Intro paragraph.\n\nClosing paragraph.\n\n---\ncounters:\n  comments: 1\n",
    );
    expect(
      applyPendingApprovalsToCriticMarkdown(plainInput, {
        commentIds: ["c1"],
      }),
    ).toBe(
      "Intro paragraph.\n\nPlaceholder for the pricing decision.\n\nClosing paragraph.\n\n---\ncounters:\n  comments: 1\n",
    );
  });

  it("keeps a disposable anchor while any comment still references it", () => {
    const input =
      'Intro paragraph.\n\n{==Placeholder for the pricing decision.==}{>>Which tier ships first?<<}{id="c1" by="AI" at="2024-01-15T10:30:00.000Z" anchor="disposable"}{>>Free tier first.<<}{id="c2" by="user" at="2024-01-15T10:31:00.000Z" re="c1"}\n\nClosing paragraph.\n';

    expect(
      applyPendingApprovalsToCriticMarkdown(input, {
        commentIds: ["c2"],
      }),
    ).toBe(
      'Intro paragraph.\n\n{==Placeholder for the pricing decision.==}{>>Which tier ships first?<<}{id="c1" by="AI" at="2024-01-15T10:30:00.000Z" anchor="disposable"}\n\nClosing paragraph.\n\n---\ncounters:\n  comments: 2\n',
    );
  });

  it("removes a disposable anchor when the flagged thread is cleared with its reply, on both clear paths", () => {
    const input =
      'Intro paragraph.\n\n{==Placeholder for the pricing decision.==}{>>Which tier ships first?<<}{id="c1" by="AI" at="2024-01-15T10:30:00.000Z" anchor="disposable"}{>>Free tier first.<<}{id="c2" by="user" at="2024-01-15T10:31:00.000Z" re="c1"}\n\nClosing paragraph.\n';
    const cleared =
      "Intro paragraph.\n\nClosing paragraph.\n\n---\ncounters:\n  comments: 2\n";

    const { doc, comments, idCounters } = criticMarkdownToEditorState(input);
    const removedIds = ["c1", ...getCommentDescendantIds("c1", comments)];
    const editor = new Editor({
      extensions: createEditorExtensions(""),
      content: doc,
    });

    try {
      editor.commands.removeCommentIds(removedIds, {
        disposableCommentIds: disposableAnchorCommentIds(removedIds, comments),
      });
      const nextComments = new Map(comments);
      for (const id of removedIds) {
        nextComments.delete(id);
      }

      expect(
        editorStateToCriticMarkdown(editor.getJSON(), nextComments, {
          idCounters,
        }),
      ).toBe(cleared);
    } finally {
      editor.destroy();
    }

    expect(
      applyPendingApprovalsToCriticMarkdown(input, {
        commentIds: removedIds,
      }),
    ).toBe(cleared);
  });

  it("removes a disposable anchor that spans a soft line break", () => {
    const input =
      'Intro paragraph.\n\n{==Placeholder for the pricing decision,\nwritten only to carry this thread.==}{>>Which tier ships first?<<}{id="c1" by="AI" at="2024-01-15T10:30:00.000Z" anchor="disposable"}\n\nClosing paragraph.\n';
    const { doc, comments, idCounters } = criticMarkdownToEditorState(input);
    const editor = new Editor({
      extensions: createEditorExtensions(""),
      content: doc,
    });

    try {
      editor.commands.removeCommentIds(["c1"], {
        disposableCommentIds: ["c1"],
      });
      const nextComments = new Map(comments);
      nextComments.delete("c1");

      expect(
        editorStateToCriticMarkdown(editor.getJSON(), nextComments, {
          idCounters,
        }),
      ).toBe(
        "Intro paragraph.\n\nClosing paragraph.\n\n---\ncounters:\n  comments: 1\n",
      );
    } finally {
      editor.destroy();
    }

    expect(
      applyPendingApprovalsToCriticMarkdown(input, {
        commentIds: ["c1"],
      }),
    ).toBe(
      "Intro paragraph.\n\nClosing paragraph.\n\n---\ncounters:\n  comments: 1\n",
    );
  });

  it("round-trips nested replies in preorder", () => {
    const input =
      'Please revisit {==this sentence==}{>>Needs a source<<}{id="c1" by="user" at="2024-01-15T10:30:00.000Z"}{>>I can add one from the intro.<<}{id="c2" by="AI" at="2024-01-15T10:31:00.000Z" re="c1"}{>>Use the market report too.<<}{id="c3" by="user" at="2024-01-15T10:32:00.000Z" re="c2"}.\n';

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(comments.get("c3")).toMatchObject({
      id: "c3",
      parentCommentId: "c2",
    });
    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("migrates legacy metadata to attribute metadata on save", () => {
    const input =
      "Please revisit {==this sentence==}{>>Needs a source<<}{@id:c1;by:user;at:2024-01-15T10:30:00.000Z@}.\n";

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(comments.get("c1")).toMatchObject({
      id: "c1",
      content: "Needs a source",
      authorType: "user",
      authorId: "user",
    });
    expect(editorStateToCriticMarkdown(doc, comments)).toBe(
      'Please revisit {==this sentence==}{>>Needs a source<<}{id="c1" by="user" at="2024-01-15T10:30:00.000Z"}.\n',
    );
  });

  it("round-trips escaped attribute metadata values", () => {
    const input =
      'Please revisit {==this sentence==}{>>Needs a source<<}{id="c1" by="user\\\\\\"name" at="2024-01-15T10:30:00.000Z"}.\n';

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(comments.get("c1")).toMatchObject({
      authorId: 'user\\"name',
    });
    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it.each([
    "criticmarkup-basic.md",
    "criticmarkup-code-fences.md",
    "frontmatter-table-yaml.md",
    "mixed-roundtrip.md",
  ])("round-trips markdown fixture %s", (fixtureName) => {
    const input = readMarkdownFixture(fixtureName);
    const { doc, comments, frontmatter } = criticMarkdownToEditorState(input);

    expect(editorStateToCriticMarkdown(doc, comments, { frontmatter })).toBe(
      input,
    );
  });

  it("keeps unanchored CriticMarkup examples literal in code spans and fenced code", () => {
    const input = readMarkdownFixture("criticmarkup-code-fences.md");
    const { doc, comments, frontmatter } = criticMarkdownToEditorState(input);

    expect(comments.size).toBe(0);
    expect(editorStateToCriticMarkdown(doc, comments, { frontmatter })).toBe(
      input,
    );
  });

  it("allocates simple document-local ids", () => {
    expect(
      createNextCommentId([{ id: "c2" }, { id: "note-1" }, { id: "c7" }]),
    ).toBe("c8");
  });

  it("allocates simple document-local suggestion ids", () => {
    expect(
      createNextChangeId([
        { changeId: "s2" },
        { changeId: "suggestion-1" },
        { changeId: "s7" },
      ]),
    ).toBe("s8");
  });

  it("never reuses a comment id after every thread has been cleared", () => {
    const commentEntries = Array.from({ length: 9 }, (_, index) => [
      `  c${index + 1}:`,
      `    body: Thread ${index + 1}.`,
      "    by: user",
      `    at: "2026-05-24T10:0${index}:00.000Z"`,
    ]).flat();
    const input = [
      "# Draft",
      "",
      "Body text.",
      "",
      "---",
      "comments:",
      ...commentEntries,
      "",
    ].join("\n");

    const loaded = criticMarkdownToEditorState(input);
    expect([...loaded.comments.keys()]).toEqual([
      "c1",
      "c2",
      "c3",
      "c4",
      "c5",
      "c6",
      "c7",
      "c8",
      "c9",
    ]);

    const cleared = editorStateToCriticMarkdown(loaded.doc, new Map(), {
      endmatter: loaded.endmatter,
      idCounters: loaded.idCounters,
    });
    const reloaded = criticMarkdownToEditorState(cleared);
    expect(reloaded.comments.size).toBe(0);

    const comment = createCriticComment(undefined, {
      existingComments: reloaded.comments.values(),
      idCounters: reloaded.idCounters,
    });

    expect(comment.id).toBe("c10");
  });

  it("never reuses a suggestion id after every suggestion has been cleared", () => {
    const input = [
      "Add {++one++}{#s1}, {++two++}{#s2}, and {++three++}{#s3}.",
      "",
      "---",
      "suggestions:",
      "  s1:",
      "    by: AI",
      '    at: "2026-05-24T10:00:00.000Z"',
      "  s2:",
      "    by: AI",
      '    at: "2026-05-24T10:01:00.000Z"',
      "  s3:",
      "    by: AI",
      '    at: "2026-05-24T10:02:00.000Z"',
      "",
    ].join("\n");

    const loaded = criticMarkdownToEditorState(input);
    const plain = criticMarkdownToEditorState("Add.\n");
    const cleared = editorStateToCriticMarkdown(plain.doc, new Map(), {
      endmatter: loaded.endmatter,
      idCounters: loaded.idCounters,
    });
    const reloaded = criticMarkdownToEditorState(cleared);

    const change = createCriticChange("addition", undefined, {
      existingChanges: [],
      idCounters: reloaded.idCounters,
    });

    expect(change.changeId).toBe("s4");
  });

  it("never reuses a comment id in an inline-attribute document after every thread has been cleared", () => {
    const input = [
      "# Plan",
      "",
      'Please revisit {==this claim==}{>>Needs a source.<<}{id="c1" by="user" at="2026-05-24T10:00:00.000Z"}{>>Added one.<<}{id="c2" by="AI" at="2026-05-24T10:05:00.000Z" re="c1"} and {==that one==}{>>Also this.<<}{id="c3" by="user" at="2026-05-24T10:06:00.000Z"}.',
      "",
    ].join("\n");

    const loaded = criticMarkdownToEditorState(input);
    expect([...loaded.comments.keys()]).toEqual(["c1", "c2", "c3"]);
    expect(loaded.endmatter).toBeNull();

    const plain = criticMarkdownToEditorState(
      "# Plan\n\nPlease revisit this claim and that one.\n",
    );
    const cleared = editorStateToCriticMarkdown(plain.doc, new Map(), {
      endmatter: loaded.endmatter,
      idCounters: loaded.idCounters,
    });
    const reloaded = criticMarkdownToEditorState(cleared);

    expect(cleared).toContain("counters:\n  comments: 3\n");
    expect(reloaded.comments.size).toBe(0);
    expect(
      createCriticComment(undefined, {
        existingComments: reloaded.comments.values(),
        idCounters: reloaded.idCounters,
      }).id,
    ).toBe("c4");
  });

  it("never reuses a suggestion id in an inline-attribute document after every suggestion has been cleared", () => {
    const input =
      'Add {++one++}{id="s1" by="user" at="2026-05-24T10:00:00.000Z"} and {++two++}{id="s2" by="user" at="2026-05-24T10:01:00.000Z"}.\n';

    const loaded = criticMarkdownToEditorState(input);
    const plain = criticMarkdownToEditorState("Add.\n");
    const cleared = editorStateToCriticMarkdown(plain.doc, new Map(), {
      endmatter: loaded.endmatter,
      idCounters: loaded.idCounters,
    });
    const reloaded = criticMarkdownToEditorState(cleared);

    expect(cleared).toContain("counters:\n  suggestions: 2\n");
    expect(
      createCriticChange("addition", undefined, {
        existingChanges: [],
        idCounters: reloaded.idCounters,
      }).changeId,
    ).toBe("s3");
  });

  it("keeps inline replies inline across a save when only counters live in the endmatter", () => {
    const input = [
      'Please revisit {==this claim==}{>>Needs a source.<<}{id="c1" by="user" at="2026-05-24T10:00:00.000Z"}{>>Added one.<<}{id="c2" by="AI" at="2026-05-24T10:05:00.000Z" re="c1"}.',
      "",
      "---",
      "counters:",
      "  comments: 3",
      "",
    ].join("\n");

    const loaded = criticMarkdownToEditorState(input);
    const output = editorStateToCriticMarkdown(loaded.doc, loaded.comments, {
      endmatter: loaded.endmatter,
      idCounters: loaded.idCounters,
    });

    expect(output).toBe(input);
    expect(
      createCriticComment(
        { parentCommentId: "c1" },
        {
          existingComments: loaded.comments.values(),
          idCounters: loaded.idCounters,
        },
      ).id,
    ).toBe("c4");
  });

  it("reads id counters from YAML endmatter and raises them to the ids in use", () => {
    const input = [
      "Add {++one++}{#s5} to {==this==}{>>Needs work.<<}{#c1}.",
      "",
      "---",
      "comments:",
      "  c1:",
      "    by: user",
      '    at: "2026-05-24T10:00:00.000Z"',
      "suggestions:",
      "  s5:",
      "    by: AI",
      '    at: "2026-05-24T10:01:00.000Z"',
      "counters:",
      "  comments: 12",
      "  suggestions: 3",
      "",
    ].join("\n");

    const { idCounters } = criticMarkdownToEditorState(input);

    expect(idCounters).toEqual({ comments: 12, suggestions: 5 });
  });

  it("keeps a recorded id counter on save and never lowers it", () => {
    const input = [
      "Please revisit {==this claim==}{>>Needs a source.<<}{#c1}.",
      "",
      "---",
      "comments:",
      "  c1:",
      "    by: user",
      '    at: "2026-05-24T10:00:00.000Z"',
      "counters:",
      "  comments: 12",
      "",
    ].join("\n");

    const { doc, comments } = criticMarkdownToEditorState(input);
    const output = editorStateToCriticMarkdown(doc, comments);

    expect(output).toBe(input);
    expect(
      createCriticComment(undefined, {
        existingComments: comments.values(),
        idCounters: criticMarkdownToEditorState(output).idCounters,
      }).id,
    ).toBe("c13");
  });

  it("does not add an id counter while every allocated id is still present", () => {
    const input = [
      "Please revisit {==this claim==}{>>Needs a source.<<}{#c1}.",
      "",
      "---",
      "comments:",
      "  c1:",
      "    by: user",
      '    at: "2026-05-24T10:00:00.000Z"',
      "",
    ].join("\n");

    const { doc, comments, endmatter, idCounters } =
      criticMarkdownToEditorState(input);
    const output = editorStateToCriticMarkdown(doc, comments, {
      endmatter,
      idCounters,
    });

    expect(output).toBe(input);
  });

  it("records an id counter when one thread is removed but its siblings remain", () => {
    const input = [
      "Body text.",
      "",
      "---",
      "comments:",
      "  c1:",
      "    body: First.",
      "    by: user",
      '    at: "2026-05-24T10:00:00.000Z"',
      "  c2:",
      "    body: Second.",
      "    by: user",
      '    at: "2026-05-24T10:01:00.000Z"',
      "  c3:",
      "    body: Third.",
      "    by: user",
      '    at: "2026-05-24T10:02:00.000Z"',
      "",
    ].join("\n");

    const loaded = criticMarkdownToEditorState(input);
    const remaining = new Map(loaded.comments);
    remaining.delete("c3");
    const output = editorStateToCriticMarkdown(loaded.doc, remaining, {
      endmatter: loaded.endmatter,
      idCounters: loaded.idCounters,
    });
    const reloaded = criticMarkdownToEditorState(output);

    expect(output).toContain("counters:\n  comments: 3\n");
    expect([...reloaded.comments.keys()]).toEqual(["c1", "c2"]);
    expect(
      createCriticComment(undefined, {
        existingComments: reloaded.comments.values(),
        idCounters: reloaded.idCounters,
      }).id,
    ).toBe("c4");
  });

  it("keeps a counters-only YAML endmatter out of the rendered document", () => {
    const input = [
      "Body text.",
      "",
      "---",
      "counters:",
      "  comments: 9",
      "  suggestions: 2",
      "",
    ].join("\n");

    const { doc, comments, endmatter, idCounters } =
      criticMarkdownToEditorState(input);
    const rendered = criticMarkdownToRenderedHtml(input);

    expect(comments.size).toBe(0);
    expect(endmatter).toContain("counters:");
    expect(idCounters).toEqual({ comments: 9, suggestions: 2 });
    expect(JSON.stringify(doc.content)).not.toContain("counters");
    expect(rendered.html).not.toContain("counters");
    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("records ids allocated in a session even when the item was removed before saving", () => {
    const input = [
      "Please revisit {==this claim==}{>>Needs a source.<<}{#c1}.",
      "",
      "---",
      "comments:",
      "  c1:",
      "    by: user",
      '    at: "2026-05-24T10:00:00.000Z"',
      "",
    ].join("\n");

    const loaded = criticMarkdownToEditorState(input);
    const reply = createCriticComment(
      { parentCommentId: "c1" },
      {
        existingComments: loaded.comments.values(),
        idCounters: loaded.idCounters,
      },
    );
    const sessionCounters = advanceReviewIdCounters(loaded.idCounters, [
      reply.id,
    ]);
    const output = editorStateToCriticMarkdown(loaded.doc, loaded.comments, {
      endmatter: loaded.endmatter,
      idCounters: sessionCounters,
    });

    expect(reply.id).toBe("c2");
    expect(output).toContain("counters:\n  comments: 2\n");
    expect(
      createCriticComment(undefined, {
        existingComments: loaded.comments.values(),
        idCounters: criticMarkdownToEditorState(output).idCounters,
      }).id,
    ).toBe("c3");
  });

  it("allocates ids above the recorded counters", () => {
    expect(
      createNextCommentId([{ id: "c2" }], { comments: 5, suggestions: 0 }),
    ).toBe("c6");
    expect(
      createNextChangeId([{ changeId: "s9" }], { comments: 0, suggestions: 7 }),
    ).toBe("s10");
    expect(
      advanceReviewIdCounters({ comments: 1, suggestions: 1 }, [
        "c4",
        "s2",
        "note-1",
        "c3",
      ]),
    ).toEqual({ comments: 4, suggestions: 2 });
  });

  it("round-trips an insertion suggestion with metadata", () => {
    const input =
      'Add {++new text++}{id="s1" by="user" at="2024-01-15T10:30:00.000Z"} here.\n';

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("round-trips a deletion suggestion with metadata", () => {
    const input =
      'Remove {--old text--}{id="s2" by="AI" at="2024-01-15T10:31:00.000Z"} here.\n';

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("round-trips a substitution suggestion with metadata", () => {
    const input =
      'Use {~~old text~>new text~~}{id="s3" by="user@example.com" at="2024-01-15T10:32:00.000Z"} here.\n';

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("round-trips a substitution suggestion with an attached comment", () => {
    const input =
      'Use {~~old text~>new text~~}{id="s3" by="AI" at="2024-01-15T10:32:00.000Z"}{>>Confirm this with legal.<<}{id="c1" by="user" at="2024-01-15T10:33:00.000Z" re="s3"} here.\n';

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(comments.get("c1")).toMatchObject({
      id: "c1",
      content: "Confirm this with legal.",
      parentCommentId: "s3",
    });
    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("renders review markup to HTML with comments and changes", () => {
    const input =
      'Keep {==the launch date==}{>>Verify this.<<}{id="c1" by="user" at="2024-01-15T10:33:00.000Z"} and add {++the customer quote++}{id="s1" by="AI" at="2024-01-15T10:34:00.000Z"}.\n';

    const { html, comments, changes, frontmatter } =
      criticMarkdownToRenderedHtml(input);

    expect(frontmatter).toBeNull();
    expect(comments.get("c1")?.content).toBe("Verify this.");
    expect(changes.get("s1")).toMatchObject({
      changeId: "s1",
      kind: "addition",
      authorType: "ai",
    });
    expect(html).toContain('data-comment-ids="[&quot;c1&quot;]"');
    expect(html).toContain('data-critic-change-kind="addition"');
  });

  it("imports suggestions without metadata and serializes generated metadata", () => {
    const { doc, comments } = criticMarkdownToEditorState(
      "Add {++new text++} here.\n",
    );

    expect(editorStateToCriticMarkdown(doc, comments)).toMatch(
      /^Add \{\+\+new text\+\+\}\{id="s1" by="user" at="[^"]+"\} here\.\n$/,
    );
  });

  it("preserves Markdown formatting inside suggested changes", () => {
    const input =
      'Use {++**bold** and `code`++}{id="s1" by="user" at="2024-01-15T10:30:00.000Z"} here.\n';

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("preserves suggested changes next to comments", () => {
    const input =
      'Add {++new text++}{id="s1" by="user" at="2024-01-15T10:30:00.000Z"} near {==this==}{>>Check it<<}{id="c1" by="AI" at="2024-01-15T10:31:00.000Z"}.\n';

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("round-trips a comment whose parent points to a suggestion id", () => {
    const input =
      '{==New wording==}{>>Why this wording?<<}{id="c1" by="user" at="2024-01-15T10:31:00.000Z" re="s1"} follows {++new text++}{id="s1" by="AI" at="2024-01-15T10:30:00.000Z"}.\n';

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(comments.get("c1")).toMatchObject({
      parentCommentId: "s1",
    });
    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("round-trips a comment attached directly to a suggestion", () => {
    const input =
      '{++new text++}{id="s1" by="AI" at="2024-01-15T10:30:00.000Z"}{>>Why this wording?<<}{id="c1" by="user" at="2024-01-15T10:31:00.000Z" re="s1"}\n';

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(comments.get("c1")).toMatchObject({
      parentCommentId: "s1",
    });
    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("preserves suggested changes in headings and list items", () => {
    const input = `## Use {++new title++}{id="s1" by="user" at="2024-01-15T10:30:00.000Z"}

* Keep {--old item--}{id="s2" by="user" at="2024-01-15T10:31:00.000Z"}
`;

    const { doc, comments } = criticMarkdownToEditorState(input);
    const output = editorStateToCriticMarkdown(doc, comments);

    expect(output).toContain(
      '## Use {++new title++}{id="s1" by="user" at="2024-01-15T10:30:00.000Z"}',
    );
    expect(output).toContain(
      '- Keep {--old item--}{id="s2" by="user" at="2024-01-15T10:31:00.000Z"}',
    );
  });

  it("accepts and rejects insertion suggestions", () => {
    const input =
      'Add {++new text++}{id="s1" by="user" at="2024-01-15T10:30:00.000Z"} here.\n';
    const accepted = criticMarkdownToEditorState(input);
    const rejected = criticMarkdownToEditorState(input);
    const acceptEditor = new Editor({
      extensions: createEditorExtensions(""),
      content: accepted.doc,
    });
    const rejectEditor = new Editor({
      extensions: createEditorExtensions(""),
      content: rejected.doc,
    });

    try {
      acceptEditor.commands.acceptCriticChange("s1");
      rejectEditor.commands.rejectCriticChange("s1");

      expect(
        editorStateToCriticMarkdown(acceptEditor.getJSON(), accepted.comments),
      ).toBe("Add new text here.\n");
      expect(
        editorStateToCriticMarkdown(rejectEditor.getJSON(), rejected.comments),
      ).toBe("Add here.\n");
    } finally {
      acceptEditor.destroy();
      rejectEditor.destroy();
    }
  });

  it("accepts and rejects deletion suggestions", () => {
    const input =
      'Remove {--old text--}{id="s1" by="user" at="2024-01-15T10:30:00.000Z"} here.\n';
    const accepted = criticMarkdownToEditorState(input);
    const rejected = criticMarkdownToEditorState(input);
    const acceptEditor = new Editor({
      extensions: createEditorExtensions(""),
      content: accepted.doc,
    });
    const rejectEditor = new Editor({
      extensions: createEditorExtensions(""),
      content: rejected.doc,
    });

    try {
      acceptEditor.commands.acceptCriticChange("s1");
      rejectEditor.commands.rejectCriticChange("s1");

      expect(
        editorStateToCriticMarkdown(acceptEditor.getJSON(), accepted.comments),
      ).toBe("Remove here.\n");
      expect(
        editorStateToCriticMarkdown(rejectEditor.getJSON(), rejected.comments),
      ).toBe("Remove old text here.\n");
    } finally {
      acceptEditor.destroy();
      rejectEditor.destroy();
    }
  });

  it("accepts and rejects substitution suggestions", () => {
    const input =
      'Use {~~old~>new~~}{id="s1" by="user" at="2024-01-15T10:30:00.000Z"} here.\n';
    const accepted = criticMarkdownToEditorState(input);
    const rejected = criticMarkdownToEditorState(input);
    const acceptEditor = new Editor({
      extensions: createEditorExtensions(""),
      content: accepted.doc,
    });
    const rejectEditor = new Editor({
      extensions: createEditorExtensions(""),
      content: rejected.doc,
    });

    try {
      acceptEditor.commands.acceptCriticChange("s1");
      rejectEditor.commands.rejectCriticChange("s1");

      expect(
        editorStateToCriticMarkdown(acceptEditor.getJSON(), accepted.comments),
      ).toBe("Use new here.\n");
      expect(
        editorStateToCriticMarkdown(rejectEditor.getJSON(), rejected.comments),
      ).toBe("Use old here.\n");
    } finally {
      acceptEditor.destroy();
      rejectEditor.destroy();
    }
  });

  it("creates critic change attrs with document-local metadata", () => {
    expect(
      createCriticChange("addition", undefined, {
        existingChanges: [{ changeId: "s1" }],
      }),
    ).toMatchObject({
      kind: "addition",
      changeId: "s2",
      authorType: "user",
      authorId: "user",
    });
  });

  it("collects descendants in nested reply order", () => {
    const comments = new Map([
      [
        "c1",
        {
          id: "c1",
          content: "Root",
          createdAt: "2024-01-15T10:30:00.000Z",
        },
      ],
      [
        "c2",
        {
          id: "c2",
          content: "Reply",
          createdAt: "2024-01-15T10:31:00.000Z",
          parentCommentId: "c1",
        },
      ],
      [
        "c3",
        {
          id: "c3",
          content: "Nested reply",
          createdAt: "2024-01-15T10:32:00.000Z",
          parentCommentId: "c2",
        },
      ],
      [
        "c4",
        {
          id: "c4",
          content: "Sibling reply",
          createdAt: "2024-01-15T10:33:00.000Z",
          parentCommentId: "c1",
        },
      ],
    ]);

    expect(getCommentDescendantIds("c1", comments)).toEqual(["c2", "c3", "c4"]);
  });
});

function richTextRoundTrip(markdown: string): string {
  const { doc, comments, frontmatter } = criticMarkdownToEditorState(markdown);
  return editorStateToCriticMarkdown(doc, comments, { frontmatter });
}

describe("Markdown rich-text round-trip regressions", () => {
  it("preserves GFM strikethrough markup", () => {
    const input = "Keep ~~removed~~ and **bold** text.\n";

    expect(richTextRoundTrip(input)).toBe(input);
  });

  it("preserves inline link titles", () => {
    const input = '[Roughdraft](./README.md "Local title")\n';

    expect(richTextRoundTrip(input)).toBe(input);
  });

  it("preserves image titles", () => {
    const input = '![Alt text](./image.png "Image title")\n';

    expect(richTextRoundTrip(input)).toBe(input);
  });

  it("preserves mailto autolinks as mailto URLs", () => {
    const input = "Visit <https://example.com/a?b=c> or <me@example.com>.\n";

    expect(richTextRoundTrip(input)).toBe(input);
  });

  it("preserves source-only HTML comments", () => {
    const input = [
      "Before",
      "",
      "<!-- keep this source note -->",
      "",
      "After",
      "",
    ].join("\n");

    expect(richTextRoundTrip(input)).toBe(input);
  });

  it("preserves raw details HTML blocks", () => {
    const input = [
      "<details>",
      "<summary>More</summary>",
      "",
      "Hidden **markdown** body.",
      "",
      "</details>",
      "",
    ].join("\n");

    expect(richTextRoundTrip(input)).toBe(input);
  });

  it("preserves multi-line indented code blocks after lists", () => {
    const input = [
      "- Item before",
      "",
      "    code block",
      "    second line",
      "",
      "After",
      "",
    ].join("\n");

    expect(richTextRoundTrip(input)).toBe(input);
  });

  it("preserves table cells containing escaped pipes and inline code pipes", () => {
    const input = [
      "| Column | Value |",
      "| --- | --- |",
      "| Escaped | `a | b` and plain a \\| b |",
      "",
    ].join("\n");

    expect(richTextRoundTrip(input)).toBe(input);
  });
});
