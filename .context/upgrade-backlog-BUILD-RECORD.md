# Roughdraft upgrade phase — build record

Each PR in the upgrade phase appends an entry here: what the issue planned, what was built, why they differ, every test added, and what was left undone.

## #2 — Stop normalizeBlockSpacing from stripping structural blank lines

### What the issue planned

Make both blank-line removals in `normalizeBlockSpacing` (`packages/app/src/markdown.ts`) context-aware: strip a heading's adjacent blank line only when the neighboring block is a heading or paragraph, never when it is a table row, fenced block, blockquote, or list item. Land a failing test for the heading-into-table corruption first, keep the existing compact round-trip test passing, and add round-trip cases for heading-after-table, heading-after-fence, and a CriticMarkup comment anchored at each of those boundaries.

### What was built

`normalizeBlockSpacing` walks lines instead of running two regex replacements. A blank line is removed when the line above is an ATX heading, or when the line below is an ATX heading and the line above is not a table row, fence marker, or blockquote line (`structuralBlockLine` and `isRemovableHeadingGap` in `packages/app/src/markdown.ts`). The collapse of three or more newlines to two is unchanged. Both callers, `toMarkdown` and `editorStateToCriticMarkdown` in `packages/app/src/critic-markup/index.ts`, pick the change up without edits.

### Why they differ

The issue's wording conflicts with tests already in the suite in two places, so the fix is narrower than the wording:

- List items are not in the keep-set. The existing compact round-trip test in `markdown.test.ts` ("does not add blank lines between headings and adjacent blocks on round-trip") has headings glued to list items on both sides and expects them to stay glued.
- The blank line after a heading is still always removed, even when a table, fence, or blockquote follows. Keeping it broke four existing tests that pin compact heading-then-table output: the `mixed-roundtrip.md` fixture round trip in `test/critic-markup.test.ts` and two autosave tests in `test/page-card.test.tsx`, plus the headerless-table round trip in `markdown.test.ts`. A heading is a single-line block, so the block after it starts fresh and that blank line is not structural. The acceptance criteria name only the heading-after-table and heading-after-fence direction, and both hold.

The literal "heading absorbed into the table on the next parse" does not reproduce in this app's parser: `| 1 | 2 |\n## After` parsed through marked 15.0.12 and through `toHtml` yields a table followed by an `h2`, and a second save is byte-identical to the first. What does reproduce, on every save, is the loss of the author's blank line at each of these boundaries, and that is what the new tests pin.

### Tests added

All in `packages/app/src/markdown.test.ts` under the `normalizeBlockSpacing` block, each asserting a byte-identical round trip:

- keeps the blank line between a table and a following heading (`toMarkdown(toHtml(...))`)
- keeps the blank line between a fenced code block and a following heading
- keeps the blank line between a blockquote and a following heading
- keeps a CriticMarkup comment anchored on the heading after a table across a save (`criticMarkdownToEditorState` then `editorStateToCriticMarkdown`)
- keeps a CriticMarkup comment anchored on the heading after a fence across a save

All five failed against the old function and pass after the fix. The tests commit precedes the fix commit on the branch.

### Verification

`pnpm check` passed: biome over 113 files, the selector check, 29 rfm tests, 230 app tests, 124 server tests, and the build. `pnpm test:smoke` passed 12 of 12 after `pnpm exec playwright install chromium`, which a fresh worktree needs because `pnpm install` does not download the pinned browser.

### Left undone

- A blank line inside a fenced code block before a line starting with `# ` is still stripped, as before: the function does not track fence state. Out of scope for this issue.
- A heading followed by a table, fence, or blockquote still compacts, for the reason above. If that direction should keep its blank line too, the four tests named above need new expectations, which is a separate decision.

## #3 — Stop the serializer from joining wrapped lines, adding trailing whitespace, and rewriting table separators

### What the issue planned

Harden the marked-in, turndown-out save path so that lines are never joined across a heading, fence, blockquote, or table row; a blank line is kept between every block and its neighbor; no trailing whitespace is emitted; and table separators are not rewritten. Stay inside the parse-and-reserialize design. The review comment on the issue added two binding facts: make the `normalizeBlockSpacing` line walk fence-aware (a blank line inside a fence before a `# ` line was still stripped), and reproduce wrapped-line joining and the paragraph-after-table path rather than heading absorption.

### What was built

- **Wrapped lines survive a save.** `createMarkedRenderer` in `packages/app/src/markdown.ts` renders every newline inside a leaf text token as `<span data-markdown-softbreak=""> </span>`. An inline atom node `markdownSoftBreak` in `packages/app/src/editor-extensions.ts` carries it through the editor, rendering a real space (so prose reflows, find-in-page and copied text read it as a space) and reporting `" "` through `renderText` and `leafText`. Turndown writes it back as `\n`, or as a space inside a heading or table cell where markdown cannot wrap. Because Turndown lifts whitespace inside an inline element out as flanking text, `placeholderSoftBreakSpans` swaps the space for a zero-width placeholder (U+200B) in the HTML string right before `turndown()` in both `toMarkdown` and `editorStateToCriticMarkdown` (`packages/app/src/critic-markup/index.ts`). The placeholder never reaches the output because the soft-break rule replaces the span wholesale, and it keeps a change span that wraps only a soft break from counting as blank, so a deletion of the wrap alone is written as `{--\n--}` rather than dropped. The blockquote and list-item rules then prefix each line, so `> a\n> b` and `- item\n  continues` round-trip.
- **Suggestions and comments can cover the soft break.** `isInlineAtomOrText` in `editor-extensions.ts` (`node.isInline && node.isAtom`: text and inline atoms, never a block) replaces the `isText` guard in every walker that enumerates change or comment marks: in `PageCard.tsx` the paste, text-input, cut, and Backspace/Delete range collectors, comment ids and change ids under a selection, `addCommentIdsToAnchor`, `getDocumentCriticChanges`, the review-rail item builder (which reads `textContent` so the atom contributes its space to the preview), `getCriticChangeRange`, and `addCommentIdsToCriticChange`; in `editor-extensions.ts` `collectCriticChangeRanges` behind accept and reject, both highlight decoration builders, and `removeCommentId`. A selection across a wrap point therefore yields one `{--across\ntwo--}` or `{~~across\ntwo~>REPL~~}`, accepting it removes the atom and rejecting restores the wrap, a single Backspace after the wrap point or Delete before it marks the atom as `{--\n--}` instead of stepping over it, a change that covers only the atom is counted when the next id is allocated and found by range, and removing a comment anchored across a wrap clears the atom's `commentRef` mark. `getDocumentCriticChanges` and `getCriticChangeRange` are exported so tests call the real walkers.
- **Fence interiors are untouched.** `normalizeBlockSpacing` tracks fence state (backtick or tilde, three or more, matched close) and copies fenced lines through verbatim. The collapse of blank-line runs moved from a global regex into the walk so it no longer collapses blank lines inside code either.
- **No trailing whitespace.** A `blockquoteWithoutTrailingSpace` rule writes a blank quote line as `>` instead of `> `. The `compactListItem` rule no longer indents blank lines or the item's trailing newline, which removes the `  ` lines Turndown left between items; a blank line between an item's paragraph and its nested list is collapsed so a tight nested list stays tight.
- **Table separators are kept as typed.** `renderer.table` stashes the source delimiter row (line two of the token's `raw`, trailing whitespace trimmed) on the `<table>` as `data-markdown-table-separator`; a `MarkdownTable` extension keeps it as a node attribute; the `tiptapHeaderTable` rule emits it in place of the computed divider when it is a valid delimiter row with the same column count as the header row, and falls back to the computed one otherwise.
- **Docs.** `docs/spec/roughdraft-flavored-markdown.md` lists soft line breaks, fence interiors, and delimiter rows under what round trips preserve; its list is a SHOULD statement about conforming implementations, not a description of this save path. The hygiene bullet in `docs/review-loop.md` lists what a save keeps as typed and what it still rewrites, in four groups: block spacing and shape (heading blank lines, cell padding, tight lists, blank-line runs), marker and delimiter style (`-` bullets, `1.`, `_em_`, `**strong**`, `* * *`), syntax-form normalization (ATX headings and dropped trailing `#`s, fenced code, inline links and requoted titles, dropped escapes and reference definitions, decoded entities, unwrapped HTML, tabs, continuation-indent collapse, nested list re-indent, nested blockquote gaining a bare `>` line, code-span newline and padding changes, marked non-exhaustive), and the task-list corruption (#22); a hunk outside those groups is a reviewer edit.

### Why they differ

- **Heading blank lines still compact.** The criterion "a blank line separates every block from its neighbor" conflicts with the existing compact-heading round-trip test and the four tests named in the #2 entry, and the issue also requires every existing test to pass. The #2 decision stands: the blank line after a heading is removed, and the one before it is removed unless the line above is a table row, fence, or blockquote. Every other block pair keeps its blank line.
- **Files outside the issue's list.** The soft break and the separator attribute need editor schema nodes, and the soft break needs the change and comment walkers to admit inline atoms, so `packages/app/src/editor-extensions.ts` and `packages/app/src/PageCard.tsx` changed; the save path's call sites in `packages/app/src/critic-markup/index.ts` changed with the placeholder. The fixture went to `packages/app/test/fixtures/markdown/reflow-roundtrip.md`, where `readMarkdownFixture` reads, rather than `docs/spec/fixtures/`, which holds review-index JSON.
- **Lists.** Before this change a tight list saved as a loose list with whitespace-only lines between items. Now a tight list round-trips tight, and a loose list (`- a\n\n- b`) saves tight. Preserving looseness would need a `loose` attribute carried from marked's list token; not done here (#23).
- **One existing assertion loosened.** The `toHtml` fixture test in `markdown.test.ts` asserted the literal `<table>` open tag; it now asserts `<table` because the tag carries the separator attribute. The behavior it checks, that a table renders, is unchanged.
- **Table cell padding** to three characters (`| 1   |`) is unchanged; the issue names only separators, and the headerless-table test pins the padding.
- **Hard breaks** still serialize as two trailing spaces before the newline, because that is the markdown syntax the author typed.

### Tests added

In `packages/app/src/markdown.test.ts`, each failing before its fix and passing after, with the tests commit preceding every fix commit on the branch:

- keeps a blank line inside a fenced code block before a heading-like line
- keeps consecutive blank lines inside a fenced code block
- keeps wrapped paragraph lines
- keeps wrapped lines inside a blockquote
- keeps wrapped lines inside a list item
- keeps a comment anchored across a wrapped line (CriticMarkup save path)
- keeps a deletion across a wrapped line (`{--this line\ncontinues--}`, byte-identical, no U+200B)
- keeps a deletion that covers only the wrap (`{--\n--}`, byte-identical, no U+200B)
- writes a blank blockquote line as a bare marker
- emits no trailing whitespace for list items on save (also pins `- a\n  - nested\n- b\n`)
- keeps the table separator row as typed
- keeps an aligned table separator row as typed
- round-trips the reflow fixture through the save path (wrapped paragraphs, blockquote, fence with blank lines, table; byte-identical, no trailing whitespace, no U+200B, stable on a second save)

Three guard tests in the same file passed before the change and pin behavior the issue names: the blank line between a table and a following paragraph, between a fence and a following paragraph, and the computed-separator fallback when the stored row's column count no longer matches; the last sets `data-markdown-table-separator`, the attribute the code reads, and fails when the column-count comparison is removed.

In `packages/app/src/suggesting-mode.test.ts`, where every saved string is asserted free of U+200B:

- under "suggesting mode across a soft break": a deletion across a wrap point is one suggestion containing the newline; accepting it removes the soft break; typing over the selection yields one substitution; a single Backspace after the wrap point marks the soft break and accepting that joins the lines
- under "change and comment walkers across a soft break": rejecting a deletion across a wrap point restores the wrap; a change allocated after an atom-only deletion gets `s2` (calls the real `getDocumentCriticChanges`); `getCriticChangeRange` finds an atom-only change; removing a comment anchored across a wrap leaves no `commentRef` mark and saves the original text

The accept test fails with the `isText` guard restored in `collectCriticChangeRanges`, the single-Backspace test fails without the placeholder, and the three walker tests fail with the guard restored at `getDocumentCriticChanges`, `getCriticChangeRange` and `removeCommentId`.

### Verification

`pnpm check` passed: biome over 113 files, the selector check, 29 rfm tests, 254 app tests, 124 server tests, and the build. `pnpm test:smoke` passed 12 of 12. Temporary Playwright specs (not committed) drove the real rich-text editor in Chromium: the reflow fixture rendered four soft-break spans with width and, after a typed edit, saved with wrapped lines, the bare `>` line, both blank lines inside the fence, the `|------|--------|` row, and the blank lines between blocks intact and no trailing whitespace; in Suggesting mode, selecting across the wrap and typing saved one `{~~across\ntwo~>REPL~~}`, Backspace after the wrap point and Delete before it each saved `{--\n--}`, selecting across the wrap, pressing Backspace and accepting from the review rail saved `wraps source` with no atom and no marker, and a Backspace at the wrap followed by typing elsewhere saved `s1` and `s2` as distinct ids.

### Known variances

- Task lists are corrupted by the save path independent of this issue: `- [x] Done` saves as `- [x] \n\n  Done` because the joplin task-list rule sees tiptap's `<label><input><span></span></label><div>` markup. Pre-existing, reproduced by probe, not touched (#22).
- A loose list saves tight (#23).
- A deletion covering only the soft break inside bold, italic or a link serializes badly (`**a**{----}**b**`, a link split in three); whitespace-only suggestions inside emphasis are a pre-existing family and are not touched here (#24).
- The suggesting-mode tests mirror the `PageCard.tsx` keyboard, paste and cut handlers in local helper functions rather than calling them, because those handlers are closures inside the editor props; a guard change in a handler alone would not fail them, which is why the walker gaps above passed a green suite once. The two exported walkers are called directly; extracting the segment collector into a shared module is the follow-up (#25).
- A space typed just before a wrap point persists as a single trailing space; two typed spaces save as one, so no hard break is produced.
- Not demonstrated for the soft break: Firefox and Safari caret behaviour around the non-editable inline, IME composition and touch selection, undo and redo across an atom deletion, and find-and-replace.
- The fence tracker recognizes fences indented up to three spaces, so a fence nested four or more spaces deep inside a list still gets the heading-gap treatment.
