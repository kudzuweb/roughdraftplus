# The review loop

How a document round-trips between a reviewer and an agent using Roughdraft. Parts of this
contract are agent discipline today and product behavior tomorrow; the Status section at the end
says which is which. The upgrade backlog (`.context/upgrade-backlog.md`, tracked) carries the
implementation items, and Agent Dash works them as one phase.

## The loop

1. The agent writes or revises a Markdown document on disk and runs `roughdraft open <path>`,
   leaving the command blocking — its exit is the signal that review happened.
2. The reviewer reads, edits, comments, and suggests changes in the browser, then clicks
   **Done Reviewing**.
3. The agent reads the file from disk, acts on every open thread, and replies inline.
4. The agent reopens the document for the next round automatically. The reviewer never has to ask
   for another round.

The loop ends only when the reviewer signals it:

- submitting with an **overall comment that says the review is done**, or
- submitting with **every comment thread cleared**.

Anything else — including submitting with no new comments while threads remain open — continues
the loop.

`roughdraft open --loop` reports that decision after each round, in human and `--json` output
(`done`, and `doneReason` as `overall-comment`, `threads-cleared`, or null), so the agent reopens
on the CLI's answer instead of inferring it from the file. The server decides on the Done Reviewing
event. An overall comment counts as done when its whole text is one of these phrases, ignoring
case and punctuation, an optional leading "ok", "okay", "yes" or "the", and an optional trailing
"thanks", "thank you" or "ty": "done", "all done", "I'm done", "we're done", "done reviewing",
"review done", "review complete", "review completed", "review is done", "review is complete",
"finished", "finished reviewing", "lgtm", "looks good", "looks good to me", "no further comments",
"no more comments", "nothing further". A trailing question mark ("Done?") is a question, not a
signal. "Approved" and "ship it" are deliberately not on the list: per Approvals below, an approval
resolves the one comment it answers and nothing else is read as approval, so an overall "approved"
with open threads continues the loop. Every thread is cleared when the document has no unresolved
comment, reply or suggestion. An overall comment that is not a done-signal is new feedback, so it
continues the loop even when the threads are otherwise clear.

The server persists every overall comment, done-signal or not, into the document's YAML
endmatter as a document-level comment, and the tab re-attaches the endmatter on every save, so the
comment survives into later rounds and counts as unresolved until it carries `status: resolved`.
Until then the threads-cleared signal cannot fire, and the "item(s) still open" count runs one
higher than the visible threads. The review rail does not render document-level comments today, so
the reviewer cannot see or clear it in the browser; the agent clears it after acting on it, by
marking it resolved (`roughdraft_mark_resolved` over MCP, or `markRoughdraftResolved` from
`@roughdraft/rfm`) or by removing the entry from the endmatter. Rendering document-level comments
in the rail, with a way to clear them, is a follow-up.

## Replies

Inline replies are canonical: a reply sits directly after the comment it answers, in the same
attribute form the UI writes,

`{>>reply text<<}{id="rN" by="AI" at="<ISO timestamp>" re="cN"}`

YAML-endmatter replies are a legacy upstream format the UI never rendered; do not write them.
Existing documents may still carry them until render-or-migrate support lands.

Every meaningful change between rounds is marked with CriticMarkup so the reviewer can jump to it
and rule on it: new text as an insertion (`{++new text++}`), reworded text as a substitution
(`{~~old~>new~~}`). Mechanical or already-approved edits (a typo fix the reviewer asked for,
applying a change approved last round) are left unmarked, so the marks are signal, not a full diff.
Approving a mark **accepts** it: the markup collapses to the final text as ordinary prose. Rejecting
reverts it; editing replaces it with what the reviewer typed. This is the item-6 approval action
applied to a suggestion instead of a comment. The marks are the reviewer's change surface — there is
no separate diff view (backlog item 10).

## Approvals

- A reviewer reply that is an approval ("approved", "okay approved", or the approve button)
  **resolves exactly the comment it answers** — never the rest of a stacked thread, because
  different questions in one stack can have different answers. The agent removes the resolved
  markup when processing the round; the anchor text stays if it is real prose, and the thread's
  other comments survive untouched.
- No other text is read as approval: approval is the explicit reply (or button), nothing inferred.
- An approval with a further question or request attached is not a full stop: the agent acts on
  the approval, answers the question, and the thread (or its live tail) survives until the
  reviewer clears it.

The approve button (item 6, PR #50) is product behavior: a checkmark on each agent reply swaps to
an inline confirm, confirming marks the reply Approved, and Done Reviewing applies every pending
approval in the same save as the handoff, removing only that reply's markup. Until then a pending
approval is tab state: it survives a switch between rich text and code view and a reload from
disk, and a browser refresh discards it along with any unsaved edits. Done Reviewing applies
pending approvals from code view too, by resolving them on the Markdown text.

## Hygiene during the loop

- Review the file at its real path. If it is git-tracked, confirm it is committed before opening,
  so an unwanted rewrite is one checkout away.
- After a round, diff the file, and read it knowing what a save rewrites on its own. Kept as
  typed (#2, #3): wrapped lines, the blank line between blocks other than around a heading,
  fence interiors, table delimiter rows, `_em_`, `**strong**`, hard breaks, autolinks, images,
  strikethrough. Still rewritten by a save, in four groups:
  1. Block spacing and shape: the blank line before a heading after a paragraph or list, and
     the blank line after a heading, are removed; table cells are padded to three characters;
     loose lists are tightened (#23); runs of blank lines collapse to one outside fences.
  2. Marker and delimiter style: `*` and `+` bullets become `-`; `1)` becomes `1.`; `*em*`
     becomes `_em_` and `__strong__` becomes `**strong**`; a `---` rule becomes `* * *`.
  3. Syntax-form normalization: setext headings become ATX and trailing `#`s on a heading
     are dropped; indented code blocks become fenced; reference-style links become inline and
     their definition lines are dropped; single-quoted link titles become double-quoted;
     footnotes break; backslash escapes are dropped; HTML entities are decoded; inline HTML is
     converted or unwrapped; tabs become spaces; continuation-line indentation collapses to
     one space; a nested ordered list re-indents from three spaces to two; a nested blockquote
     `> a\n>> b` gains a bare `>` line before `> > b`; a newline inside a code span becomes a
     space and double-backtick code-span padding is trimmed. The list is not exhaustive: any
     hunk that changes only how a construct is spelled belongs here.
  4. Task lists are corrupted: `- [x] Done` splits across lines (#22).
  A diff hunk outside those groups is a reviewer edit.
- A tab writes to the file only when the reviewer edits or comments, so restoring or editing a
  reviewed file outside the loop is safe while the tab has no unsaved edits: a `git checkout` is
  final, and the tab reloads the new content without writing. A tab with unsaved edits shows
  "File changed on disk" and stops saving until the reviewer picks reload or overwrite. After
  Done Reviewing the tab does not write until a new review starts. If the server is restarted, the
  tab adopts the replacement and checks the file version first: unsaved edits are kept and saved
  only when the file did not change while the server was away; otherwise the tab shows "File
  changed on disk" and stops saving until the reviewer decides.

## Status

| Behavior | Today | Destination |
|---|---|---|
| Auto-reopen until done-signal | `roughdraft open --loop` reports the done-signal after each round (item 14) | The reopen on `done: false` remains agent discipline |
| Meaningful changes stand out | Agent marks them `{++ins++}` / `{~~sub~~}`, leaves mechanical edits unmarked | Jump-to-next-mark navigation (item 10, deferred behind item 5) |
| Approving a mark accepts it into prose | Agent strips markup on approval | Approve action accepts the suggestion (items 6, 10) |
| Approval resolves its comment (per-comment only) | Product behavior: approve button, applied on Done Reviewing | Shipped (item 6) |
| Inline replies canonical | Agent discipline; prompt/spec still say endmatter | Prompt/spec rewrite + legacy rendering (item 4) |
| Collapsed threads, newest reply visible | Product behavior | Shipped (item 5) |
| Tab writes only on reviewer edits; stops after Done or until a replaced server is adopted | Product behavior | Shipped (item 2) |
