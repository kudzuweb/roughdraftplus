# The review loop

How a document round-trips between a reviewer and an agent using Roughdraft. Parts of this
contract are agent discipline today and product behavior tomorrow; the Status section at the end
says which is which. The upgrade backlog (`.context/upgrade-backlog.md`, untracked) carries the
implementation items.

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

## Replies

Inline replies are canonical: a reply sits directly after the comment it answers, in the same
attribute form the UI writes,

`{>>reply text<<}{id="rN" by="AI" at="<ISO timestamp>" re="cN"}`

YAML-endmatter replies are a legacy upstream format the UI never rendered; do not write them.
Existing documents may still carry them until render-or-migrate support lands.

## Approvals

- A reviewer reply that is an approval ("approved", "okay approved", or the approve button once it
  ships) **resolves its thread**: the thread does not reappear next round. The agent removes the
  thread's markup when processing the round; the anchor text stays if it is real prose.
- **"approve all"** on any comment in a thread approves everything stacked in that thread — every
  proposal and request the thread accumulated — and resolves the whole thread. Reviewers stack
  requests onto one thread sometimes; approve-all is the shorthand that closes the stack.
- An approval with a further question or request attached is not a full stop: the agent acts on
  the approval, answers the question, and the thread (or its live tail) survives until the
  reviewer clears it.

Planned UI (backlog item 6): a checkmark affordance on agent replies that swaps to an inline
confirm, records a pending approval, and applies it when the reviewer clicks Done Reviewing.

## Hygiene during the loop

- Review the file at its real path. If it is git-tracked, confirm it is committed before opening,
  so an unwanted rewrite is one checkout away.
- After a round, diff the file: whitespace-only and joined-line changes are save reflow, not
  reviewer edits (upstream issues 98 and 100; backlog items 1 and 2).
- Close the tab before restoring or editing a reviewed file outside the loop — an open tab can
  save over external changes.
- Author documents destined for review defensively while the reflow bugs live: prefer prose and
  bullets over tables and fenced blocks, and keep blank lines between blocks.

## Status

| Behavior | Today | Destination |
|---|---|---|
| Auto-reopen until done-signal | Agent discipline | CLI loop mode (backlog item 13) |
| Approval resolves thread | Agent discipline | Approve button + auto-clear on save (item 6) |
| Approve-all resolves the stack | Agent discipline | Same button semantics (item 6) |
| Inline replies canonical | Agent discipline; prompt/spec still say endmatter | Prompt/spec rewrite + legacy rendering (item 4) |
| Collapsed threads, newest reply visible | Not built | Review rail change (item 5) |
