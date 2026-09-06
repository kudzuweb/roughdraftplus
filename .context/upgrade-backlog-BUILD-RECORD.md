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
