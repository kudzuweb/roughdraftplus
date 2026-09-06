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

- **Wrapped lines survive a save.** `createMarkedRenderer` in `packages/app/src/markdown.ts` renders every newline inside a leaf text token as `<span data-markdown-softbreak=""> </span>`. A new inline atom node `markdownSoftBreak` in `packages/app/src/editor-extensions.ts` carries it through the editor, rendering a real space (so prose reflows, find-in-page and copied text read it as a space) and reporting `" "` through `renderText` and `leafText`. Turndown writes it back as `\n`, or as a space inside a heading or table cell where markdown cannot wrap. Because Turndown lifts whitespace inside an inline element out as flanking text, `placeholderSoftBreakSpans` swaps the space for a zero-width placeholder (U+200B) in the HTML string right before `turndown()` in both `toMarkdown` and `editorStateToCriticMarkdown` (`packages/app/src/critic-markup/index.ts`); the placeholder never reaches the output because the soft-break rule replaces the span wholesale, and it keeps a change span that wraps only a soft break from counting as blank. The blockquote and list-item rules then prefix each line, so `> a\n> b` and `- item\n  continues` round-trip.
- **Fence interiors are untouched.** `normalizeBlockSpacing` tracks fence state (backtick or tilde, three or more, matched close) and copies fenced lines through verbatim. The collapse of blank-line runs moved from a global regex into the walk so it no longer collapses blank lines inside code either.
- **No trailing whitespace.** A `blockquoteWithoutTrailingSpace` rule writes a blank quote line as `>` instead of `> `. The `compactListItem` rule no longer indents blank lines or the item's trailing newline, which removes the `  ` lines Turndown left between items; a blank line between an item's paragraph and its nested list is collapsed so a tight nested list stays tight.
- **Table separators are kept as typed.** `renderer.table` stashes the source delimiter row (line two of the token's `raw`, trailing whitespace trimmed) on the `<table>` as `data-markdown-table-separator`; a `MarkdownTable` extension keeps it as a node attribute; the `tiptapHeaderTable` rule emits it in place of the computed divider when it is a valid delimiter row with the same column count as the header row, and falls back to the computed one otherwise.
- `docs/spec/roughdraft-flavored-markdown.md` lists soft line breaks, fence interiors, and delimiter rows under what round trips preserve; `docs/review-loop.md` hygiene now says what the save path still rewrites instead of warning against tables and fences.

### Why they differ

- **Heading blank lines still compact.** The criterion "a blank line separates every block from its neighbor" conflicts with the existing compact-heading round-trip test and the four tests named in the #2 entry, and the issue also requires every existing test to pass. The #2 decision stands: the blank line after a heading is removed, and the one before it is removed unless the line above is a table row, fence, or blockquote. Every other block pair keeps its blank line.
- **Files outside the issue's list.** The soft break and the separator attribute need editor schema nodes, so `packages/app/src/editor-extensions.ts` changed. The fixture went to `packages/app/test/fixtures/markdown/reflow-roundtrip.md`, where `readMarkdownFixture` reads, rather than `docs/spec/fixtures/`, which holds review-index JSON.
- **Lists.** Before this change a tight list saved as a loose list with whitespace-only lines between items. Now a tight list round-trips tight, and a loose list (`- a\n\n- b`) saves tight. Preserving looseness would need a `loose` attribute carried from marked's list token; not done here.
- **One existing assertion loosened.** The `toHtml` fixture test in `markdown.test.ts` asserted the literal `<table>` open tag; it now asserts `<table` because the tag carries the separator attribute. The behavior it checks, that a table renders, is unchanged.
- **Table cell padding** to three characters (`| 1   |`) is unchanged; the issue names only separators, and the headerless-table test pins the padding.
- **Hard breaks** still serialize as two trailing spaces before the newline, because that is the markdown syntax the author typed.

### Tests added

All in `packages/app/src/markdown.test.ts`. Each of these failed before its fix and passes after; the tests commit precedes every fix commit on the branch:

- keeps a blank line inside a fenced code block before a heading-like line
- keeps consecutive blank lines inside a fenced code block
- keeps wrapped paragraph lines
- keeps wrapped lines inside a blockquote
- keeps wrapped lines inside a list item
- keeps a comment anchored across a wrapped line (CriticMarkup save path)
- writes a blank blockquote line as a bare marker
- emits no trailing whitespace for list items on save (also pins `- a\n  - nested\n- b\n`)
- keeps the table separator row as typed
- keeps an aligned table separator row as typed
- round-trips the reflow fixture through the save path (wrapped paragraphs, blockquote, fence with blank lines, table; byte-identical, no trailing whitespace, stable on a second save)

Three guard tests passed before the change and pin behavior the issue names: the blank line between a table and a following paragraph, between a fence and a following paragraph, and the computed-separator fallback when the stored row's column count no longer matches.

### Verification

`pnpm check` passed: biome over 113 files, the selector check, 29 rfm tests, 244 app tests, 124 server tests, and the build. `pnpm test:smoke` passed 12 of 12. A temporary Playwright spec (not committed) opened the reflow fixture in the real rich-text editor, confirmed four soft-break spans rendered with width, typed an edit, and read the file the app saved: wrapped lines, the bare `>` line, both blank lines inside the fence, the `|------|--------|` row, and the blank lines between blocks were intact, with no trailing whitespace.

### Left undone

- Task lists are corrupted by the save path independent of this issue: `- [x] Done` saves as `- [x] \n\n  Done` because the joplin task-list rule sees tiptap's `<label><input><span></span></label><div>` markup. Pre-existing, reproduced by probe, not touched. Tracked as #22.
- A loose list saves tight (above). Tracked as #23.
- The fence tracker recognizes fences indented up to three spaces, so a fence nested four or more spaces deep inside a list still gets the heading-gap treatment.

### Review round 1

Changes applied from the PR #21 review:

- **Finding 1.** The hygiene bullet in `docs/review-loop.md` now lists what a save keeps as typed and what it still rewrites, in four groups: block spacing and shape (heading blank lines, cell padding, tight lists, blank-line runs), marker and delimiter style (`-` bullets, `1.`, `_em_`, `**strong**`, `* * *`), syntax-form normalization (ATX headings, fenced code, inline links, dropped escapes and reference definitions, decoded entities, unwrapped HTML, tabs), and the task-list corruption (#22). The claim that anything else in a diff is a reviewer edit is gone. The round-trip list in `docs/spec/roughdraft-flavored-markdown.md` is a SHOULD-preserve statement about conforming implementations, not a description of this save path, so it was left as is.
- **Finding 2.** The column-count test in `markdown.test.ts` set `data-markdown-separator`, an attribute the code never reads, so it passed without reaching the branch it names. It now sets `data-markdown-table-separator`, and fails when the column-count comparison is removed.
- **Finding 4.** Suggesting mode skipped the soft-break atom: the range collectors in `PageCard.tsx` (paste, text input, cut, Backspace and Delete) and the helpers in `editor-extensions.ts` (`collectCriticChangeRanges` behind accept and reject, and both highlight decoration builders) returned early on every non-text node. They now use `isInlineAtomOrText`, which admits text and inline atoms and never a block, so a selection across a wrap point yields one `{--across\ntwo--}` or `{~~across\ntwo~>REPL~~}`, accepting it removes the atom, and a single Backspace after the wrap point or Delete before it marks the atom as `{--\n--}` instead of stepping over it. That last case needed one change outside the listed guards: a change span wrapping only the emptied soft-break span counted as blank to Turndown and serialized to nothing, so `emptySoftBreakSpans` became `placeholderSoftBreakSpans` and fills the span with U+200B (see "What was built").

Tests added in `packages/app/src/suggesting-mode.test.ts`, under "suggesting mode across a soft break": a deletion across a wrap point is one suggestion containing the newline; accepting it removes the soft break; typing over the selection yields one substitution; a single Backspace after the wrap point marks the soft break and accepting that joins the lines. The accept and single-Backspace tests failed before the guard change and the placeholder change respectively. The helpers in that file mirror the `PageCard.tsx` handlers rather than importing them, as the existing tests do, so the real handlers were exercised in Chromium instead: a temporary Playwright spec (not committed) selected across the wrap and typed, pressed Backspace after the wrap point, pressed Delete before it, and selected across the wrap, pressed Backspace and accepted from the review rail; each saved file matched the forms above and the accepted file read `wraps source`. After this round `pnpm check` passed (biome over 113 files, the selector check, 29 rfm tests, 248 app tests, 124 server tests, and the build) and `pnpm test:smoke` passed 12 of 12.

Known variances, recorded rather than fixed:

- A loose list saves tight (#23).
- A space typed just before a wrap point persists as a single trailing space; two typed spaces save as one, so no hard break is produced.
- Not demonstrated for the soft break: Firefox and Safari caret behaviour around the non-editable inline, IME composition and touch selection, undo and redo across an atom deletion, and find-and-replace.

### Review round 2

The re-verdict on round 1 found walkers the round-1 change had not reached. Changes applied:

- **R1.** The seven remaining text-only walkers in `PageCard.tsx` (comment ids under a selection, change ids under a selection, `addCommentIdsToAnchor`, `getDocumentCriticChanges`, the review-rail item builder, `getCriticChangeRange`, `addCommentIdsToCriticChange`) now use `isInlineAtomOrText`. Before, a deletion covering only the soft-break atom was invisible to `getDocumentCriticChanges`, so the next suggestion was allocated the same id and accepting one applied both; `getCriticChangeRange` returned null for it. The rail builder reads `textContent` instead of `text`, so the atom contributes its space to the preview. `getDocumentCriticChanges` and `getCriticChangeRange` are exported so tests can call the real walkers.
- **R2.** `removeCommentId` in `editor-extensions.ts` uses the same predicate, so removing a comment anchored across a wrap clears the atom's `commentRef` mark instead of leaving a stale one that resurfaced as extra anchors on a surviving comment or a phantom `{==\n==}` when the id was reused.
- **R4.** Every saved string in the soft-break suggesting tests, and the reflow fixture round trip, asserts that U+200B is absent. Two new `markdown.test.ts` cases pin `{--this line\ncontinues--}` and `{--\n--}` through the CriticMarkup save path byte for byte, and a suggesting-mode test pins that rejecting a deletion across a wrap restores the wrap.
- **R5.** Group 3 of the hygiene bullet in `docs/review-loop.md` names the seven further rewrites the reviewer verified and says the group is not exhaustive.

Tests added, all in `packages/app/src/suggesting-mode.test.ts` under "change and comment walkers across a soft break" unless noted: rejecting a deletion across a wrap point restores the wrap; a change allocated after an atom-only deletion gets `s2` (calls the real `getDocumentCriticChanges`); `getCriticChangeRange` finds an atom-only change; removing a comment anchored across a wrap leaves no `commentRef` mark and saves the original text. The three walker tests fail with the old `isText` guards restored at `getDocumentCriticChanges`, `getCriticChangeRange` and `removeCommentId`, and pass with the fix. In real Chromium (temporary Playwright spec, not committed) a Backspace after the wrap point followed by typing at the paragraph end saved `{--\n--}{id="s1" ...}` and `{++NEW++}{id="s2" ...}`. After this round `pnpm check` passed (biome over 113 files, the selector check, 29 rfm tests, 254 app tests, 124 server tests, and the build) and `pnpm test:smoke` passed 12 of 12.

Known variances, recorded rather than fixed:

- **Test structure.** The suggesting-mode tests mirror the `PageCard.tsx` keyboard, paste and cut handlers in local helper functions rather than calling them, because those handlers are closures inside the editor props. That is why R1 passed a green suite in round 1: the helpers were updated and the module-private walkers were not. The two walkers this round exports are now called directly; the handler mirrors remain, for a follow-up that extracts the segment collector into a shared module.
- **R3 (own ticket, filed by the orchestrator).** A deletion covering only the soft break inside bold, italic or a link serializes badly (`**a**{----}**b**`, a link split in three); the family is pre-existing for whitespace-only suggestions inside emphasis and is not touched here.
