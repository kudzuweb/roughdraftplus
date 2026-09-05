# Roughdraft upgrade backlog
Drawn from the fourteen papercuts logged during the phase-1 planning reviews (2026-09-03/04), the findings document, and the seven phase-1 planning-session papercuts (`phase1-planning-papercuts.md`), all in the workflow port bundle. Ranked by what each failure cost in those reviews. Bracketed references are papercut numbers (pc), findings sections (f), and planning papercut ids.

Already fixed at source on this fork, for the record: the yaml install crash (4c153c5), the five-minute watch death (dd7fa52), and every registry install/update path (4481200).

This document deliberately avoids tables and fenced code blocks: it will be reviewed in Roughdraft, which still carries the rendering and reflow bugs listed below.
## Tier 1 — stop destroying documents
These papercuts made documents unreadable and cost rebuilds from git. Everything else is noise by comparison.

**1. Saving must preserve block boundaries** [pc 1, 2, 12; upstream issues 98, 100]

The save path re-renders the whole document through marked in and turndown out, which joins wrapped lines, drops the blank lines before headings, adds trailing whitespace, and rewrites table separators. Worst case: a run of headings, a fenced block, and tables collapsed into two lines, unreadable, worse on every refresh. The identified mechanism for the decay: the serializer drops the blank line between a table and the heading after it, so the next parse absorbs the heading into the table as text.

- Never join lines across a heading, fence, blockquote, or table row — each ends its line.
  
- Keep a blank line between every block and its neighbor on serialize.
  
- Stop emitting trailing whitespace and rewritten separators nobody typed.
  
- The end state to aim for: save what the reviewer typed; any formatter is opt-in.
  

**1a. First PR — stop** `normalizeBlockSpacing` **from stripping structural blank lines** [root cause confirmed in source]

The highest value-to-cost fix in the list, and the first PR to carve out of item 1. Root cause of the worst-case decay (unreadable tail, headings absorbed into tables, CriticMarkup threads corrupted at boundaries) is four lines in `normalizeBlockSpacing` (`packages/app/src/markdown.ts:539-546`), run on every save from both `toMarkdown` and the CriticMarkup save path `editorStateToCriticMarkdown` (`packages/app/src/critic-markup/index.ts:1516`):

- `md.replace(/\n\n(#{1,6} )/g, "\n$1")` strips the blank line before every heading.
  
- `md.replace(/(^#{1,6} [^\n]+)\n\n/gm, "$1\n")` strips the blank line after every heading.
  

These exist on purpose — to keep a compact-authored document compact across a round trip (test at `markdown.test.ts:115`, `toMarkdown(toHtml(compact)) === compact`), since turndown would otherwise add heading blank lines. But they strip unconditionally, including the blank line between a table (or fenced block, blockquote, list) and a following heading, where it is structurally required. A heading glued to the last table row is absorbed into the table as text on the next parse — the decay mechanism. A CriticMarkup thread anchored at such a boundary corrupts for the same reason: its separating blank line is stripped.

Fix: make the two removals context-aware — strip a heading's adjacent blank line only when the neighboring block is a heading or paragraph (where tightness is safe), never when it is a table row, fenced block, blockquote, or list item (where the blank line is load-bearing). Scope: this one function plus its tests; the existing compact round-trip test must still pass, with new cases for heading-after-table, heading-after-fence, and a comment anchored at each. Per the repo's Prove It workflow, land a failing test reproducing the heading-into-table corruption first.

Bounds of this PR: it fixes the boundary corruption and CriticMarkup survival across saves. It does not fix the other reflow noise — turndown joining wrapped lines, trailing whitespace, table-separator rewriting — which originates in turndown and the GFM plugin and is the remainder of the serializer-hardening path (Option A). Separate PRs.

**1b. Open question — the real save-path fix (Option B), and why its hard part decides the shape** [design note, not a ready PR]

Item 1a and the serializer bullets above are Option A: harden the reserializer so it stops corrupting boundaries. Option A is incremental and low-risk but has a ceiling — the parse-and-reserialize round trip discards whatever the editor tree does not represent (original line wrapping, exact separator style), so the first save still normalizes the file once, then reaches a stable fixed point. Option B removes the ceiling: keep the original Markdown text on the server, track which regions the reviewer actually touched, and splice only those regions back into the original bytes, so untouched text stays byte-identical and a save produces a clean diff. Option B is the real fix and a redesign of the save path, not a patch.

The open question is what Option B's position mapping should be, because that is the hard part and it decides the whole shape:

- The pipeline discards source positions at the first step. Markdown goes through `marked` into tokens and into TipTap's ProseMirror tree, whose positions index the tree, not the source bytes. Splicing an edit back needs a map from each tree node to a source byte range, and nothing builds one today.
- That map is many-to-one, so it cannot be reconstructed after the fact: `*emphasis*` and `_emphasis_`, `-` and `*` bullets, ATX and setext headings, wrapped and unwrapped paragraphs all parse to identical nodes. The map must be captured during parsing. `marked` does not emit reliable character spans after its inline normalizations, so this likely means a position-emitting parser such as remark/mdast rather than `marked`.
- Tracking positions through the reviewer's edits is the solved part — ProseMirror transactions carry step maps that say exactly how every position moved.
- Structural edits smear the boundaries. Splitting a paragraph, or editing one table cell, no longer maps to a clean source span; tables are the worst case, since ProseMirror holds a table cell-by-cell while the source is line-oriented, so one cell edit re-serializes a whole row that should match its neighbors' column widths and separators.
- CriticMarkup rides inside the text, so the source map has to carry comment and suggestion spans too, or a splice near a thread corrupts it — the same damage as item 1.

Recommended target: block-level patching, not character-level splicing. Track which blocks (paragraphs, headings, individual tables) the reviewer touched, keep each block's source span from parse time, and re-serialize only the dirty blocks; everything untouched stays byte-identical. Block boundaries are line-oriented in Markdown, so their spans are far easier to keep honest than inline character offsets. Build it with Option A's serializer rules applied to the dirty blocks being regenerated, so Option A's tests carry straight over.

Decision to make before building Option B: is block-level patching enough, or is character-level splicing needed? Defer it until Option A (item 1a plus the serializer bullets) has landed and the residual reflow is measured against real documents — that measurement is what says whether block-level patching closes the gap or leaves one worth the character-level cost.

**2. Save only when the reviewer actually changed something, and stop saving after the review ends** [pc 13; pc-a83cf9]

Opening a document, refreshing the tab, and clicking Done Reviewing with zero comments each rewrite the file today. Worse, a tab left open after Done Reviewing keeps saving reflowed copies over the file — one evening it overwrote a git-restored file three times before the cause was seen. Fresh instance [logged 2026-09-05]: Roughdraft's watcher re-saved its reflowed copy over a `git checkout` from another session — the restored content was verified identical to HEAD modulo whitespace, so nothing was lost that time, but it makes the hazard explicit: a checkout is not final while Roughdraft still holds the file, because the watcher's save races filesystem operations outside the review loop entirely, not just editor edits. Gate the save on an actual edit or comment, and stop a tab from writing at all once its review is done or its server is gone. Interim discipline (already in docs/review-loop.md): close the tab, or stop the server, before restoring or editing a file Roughdraft has open, and re-run the checkout afterward if in doubt.

**3. A block that fails to render must leave a visible placeholder** [pc 4, 12]

Tables sometimes do not paint on first load — three of four missing in one review, with no error anywhere. The reviewer reads an empty section as a document with nothing in it and asks what is missing. A refusal placeholder turns three rounds of confusion into one glance.
## Tier 2 — review-loop correctness
**4. Make inline reply threads canonical; render or migrate legacy endmatter** [pc 3; f 8]

The spec prescribes endmatter replies; the shipped UI never shows them and the next save strips them — eleven replies were invisible in one review. This fork makes inline replies (directly after the comment they answer) the canonical format. Remaining work: render or migrate legacy endmatter replies in existing documents (upstream PR 145 is reference material for the rendering half), and rewrite the bundled prompt and spec to prescribe inline — right now the fork's own prompt still prescribes a format its UI cannot show.

**5. Collapse inline threads; newest reply open by default** [from review round 2]

A thread renders collapsed to its anchor plus the most recent reply; expanding shows the full history. Saves screen real estate as threads grow, which they do once agent replies are inline and substantive. Applies to the review rail and any in-prose rendering.

**6. An approval clears its thread** [from review round 2]

When the reviewer's reply to a proposed fix is an approval, that thread is resolved and does not reappear next round. Product side: an approve action on agent replies: a checkmark to the left of the reply button that swaps in place to a small inline confirm ("Approve ✓ / ✕"); confirming records a pending approval, and Done Reviewing applies every pending approval in one save, clearing those threads. An approval is strictly per-comment: it resolves exactly the comment it answers, never the rest of a stacked thread, because different questions in a stack can have different answers. Until the button ships, the agent applies the same rule as discipline: a typed approval clears only the comment it replies to, and no other text is read as approval.

**7. Never reuse comment IDs within a document** [pc 6]

After threads c1–c9 were cleared, a new comment got c1 again, so an agent tracking threads across rounds mis-attributes them. A monotonic counter in the document metadata suffices.

**8. Show the open document's path in the UI, and don't silently switch it** [pc 7]

A second `roughdraft open` repoints the reviewer's existing tab with no indication. One review's comments landed on a superseded spec. Show the path; when a different path is opened mid-review, warn or open a new tab. Same gap, session flavor [logged 2026-09-05]: nothing tells the reviewer which agent session opened the current document, so with several Claude sessions using Roughdraft at once there is no way to tell whose review this is — the reviewer reconstructs it from memory. Show who opened the document (the CLI could pass a session label with `open`), in the UI and in `status`. And a third instance [logged 2026-09-05, root cause confirmed in source]: opening a document while a tab shows a different one spawns a duplicate browser window that macOS stacks pixel-aligned on top of the first, so it looks like the wrong document opened when really two windows are overlaid — closing the top one reveals the other behind it. Mechanism (`index.ts:869-871`, `cli.ts:2794-2804`): the CLI reuses an existing window only when a tab is registered under a path exactly equal to the one being opened; `/api/open-request` returns `delivered: false` for any other path, and the CLI falls back to `openUrl`, which opens a fresh OS window. So reopening the same path refocuses the tab, but opening any different path always makes a new window — nothing refocuses across documents and nothing deduplicates. The fix belongs with the multi-document work (item 17): one window that navigates between documents, or windows the reviewer can tell apart, not silent pixel-stacked duplicates. Until then the agent hands the reviewer the explicit `?path=` URL and expects to reopen the same path (refocus) rather than assuming a switch is visible.

**9. Restore the document and Done state when the server restarts mid-review** [pc 14]

An upgrade during a review left a tab whose Done Reviewing button was gone, stranding the blocking CLI call. Restoring the document and Done state on reconnect is the goal; announcing orphanhood is only the fallback for what restore cannot cover.

**10. Mark meaningful changes as CriticMarkup so the reviewer can jump to and rule on them** [from review round 5, logged 2026-09-05]

When a comment causes a new section or reworded sentence between rounds, the reviewer wants to go straight to it and either approve it or fix it — not reread the document, and not wade through a full diff. No diff engine: CriticMarkup markers themselves are the highlighting. The agent marks each meaningful change — new text as an insertion (`{++...++}`), reworded text as a substitution (`{~~old~>new~~}`) — and leaves mechanical or already-approved edits (typo fixes the reviewer asked for, applying a change approved last round) unmarked, so the marks are pure signal rather than diff noise. The reviewer navigates the marks and rules on each one.

Near-term work, two parts:

- **Accept on approval.** Approving a mark accepts it in the CriticMarkup sense: an insertion's `{++ ++}` or a substitution's `{~~ ~>...~~}` collapses to the final text as ordinary prose, no highlight, no thread. Same approval action as item 6, applied to a suggestion rather than a comment — approve promotes the change into the document, reject reverts it, edit replaces it with whatever the reviewer types. Until the approve button ships, the agent does this by hand when processing the round: accepted marks lose their markup, rejected ones revert.
  
- **Cleaner mark label.** The inline thread on a mark should show the changed text itself, not the parser's `Insert: <text>` form. One-line rendering fix, independent of the accept behavior.
  

Deferred, gated on item 5:

- **Navigation.** Jump-to-next-and-previous-unresolved-mark, so the reviewer can walk every pending change without scrolling. ⁠ Revisit once item 5 is in and its effect on the rail is visible; it may prove unnecessary.
  

Marking meaningful changes this way stays the right authoring move permanently — it is not a stopgap for a diff feature, it is the feature. It gives the reviewer exactly the signal they want (what changed and matters) and a one-gesture accept that leaves clean prose behind.
## Tier 3 — agent ergonomics
**11. Make status name the document** [pc 8, 9]

Neither `roughdraft status` nor the state file says which file is loaded, and there is no way to ask about open threads or last-save time. A `status <path>` reporting open threads and last save would let an agent stop inferring review state from file diffs.

**12. Clearing a thread should be able to take its anchor with it** [pc 10]

A comment must anchor on some text, so when nothing natural exists the agent adds a filler sentence purely to carry the thread — and clearing the thread strands the filler in the prose. Let a thread flag its anchor as disposable so clearing removes both. Minor; the workaround — anchor threads on real sentences, never on filler — is recorded with papercut 10 and is agent discipline until this ships.

**13. Retired:** `--raw` [pc 11]

The claim traced to nothing: papercut 11 said `--raw` was broken under the macOS system bash, but no such flag exists in the fork's source, its git history, or anything in the port bundle. Retired unless it resurfaces with a reproduction.

**14. The review loop continues by default** [from review round 2]

After Done Reviewing, the agent processes the feedback and automatically reopens the document for the next round. The loop ends only when the reviewer submits with an overall comment saying it is done, or submits with every thread cleared. Adopted as agent practice immediately (this document is being re-served under that rule); CLI support later could make it explicit, e.g. an open mode that loops until one of those signals. The whole loop contract — rounds, reply format, approval semantics, end conditions, hygiene — is documented at `docs/review-loop.md` in the repo, with a status table of what is agent discipline today versus product behavior to build.
## Tier 4 — housekeeping and direction
**15. Mine upstream's open PRs before writing anything twice** [f 14]

Twenty-plus open PRs upstream, many duplicating the same fixes — six contributors independently fixed the watch timeout, three the yaml bug. Worth one pass to harvest anything ready-made (PR 145's rendering half first) before implementing Tier 1 and 2 from scratch. Standard for the pass: where multiple PRs address one bug, compare them all, pick the best design, and rework it to this fork's bar — upstream PRs are raw material, never merge-as-is candidates.

**16. Make the fork's shipped prompt the single canonical copy** [f 12]

Upstream's hosted prompt.md had drifted from the copy bundled in 0.1.10. The fork should ship one canonical prompt/setup/spec set from the repo — the setup.md side of this landed in 4481200; prompt.md and the spec still need the same treatment, plus the inline-reply rewrite from item 4.

**17. Audit the dormant multi-document surface, then plan multi-doc properly** [f 10]

The server already exposes directory listing, file-tree, and project open/create endpoints that nothing in the shipped UI calls — a multi-file product that never shipped. Step one: audit that code and rule it good-bones-finish-it or slop-replace-it. The verdict feeds the post-papercuts enhancement track: multi-document support, plus opening a document in Roughdraft straight from Finder with a session spun up to engage with it. Both are sequenced after Tiers 1–2; the audit can happen any time since it shapes how items 8 and 11 get built.
## Workflow upgrades from the phase-1 planning papercuts
These came out of the same planning stretch but are not Roughdraft code changes — they are candidate rules and practice changes. pc-a83cf9 (the lingering tab overwriting a restored file) is already folded into item 2 above. Nothing lands in CLAUDE.md or hooks without sign-off; this section is the proposal.

**18. Protocol baselines must use invariant checks** [pc-1b1a31]

A stop-on-mismatch baseline stated the branch's commit count, which every later commit invalidated — it was amended three times in an hour and would have false-stopped the overnight run. Rule for the planning-practices doc and any future protocol template: a check that stops a run must be invariant until the step it guards (a file absent from main, a PR state, a test count) — never a rolling number; a number that must appear is informational and excluded from the stop rule.

**19. In auto mode, write sensitive-text files with the Write tool, never a heredoc** [pc-c4098f]

The auto-mode classifier reads a Bash heredoc body as a command, so documentation text naming a production host and sqlcmd got blocked twice; the same text through the Write tool went through. Candidate global CLAUDE.md rule: files whose text names hosts, credential words, or destructive verbs go through Write/Edit; Bash stays for git and plain commands.

**20. zsh one-liner gotchas** [pc-12839c]

Four retries from shell differences in one session: a leading `=` in an echo argument (zsh expands it), `$var:` triggering zsh's `:` modifiers, unquoted glob patterns in flags, and `timeout` not existing on macOS. Candidate global CLAUDE.md addition, or a hookify rule that catches the patterns before they run.

**21. The attribution reminder conflict** [pc-339b5a]

A mid-turn harness message instructed a session to add a Claude-Session commit trailer despite settings.json explicitly zeroing attribution. The session-side rule (settings win, note the override once) is worth keeping wherever commit rules live; the product-side fix is upstream Claude Code's to make.

**22. Re-read before Edit after any scripted change to the same file** [pc-45a920]

An Edit anchored on a phrase a script had already moved, duplicating half a sentence in a reviewed document. Extends the existing bulk-edit guards: after a scripted replacement, re-read the exact lines before any tool Edit on that file — or let the script make the whole change.

**23. Compaction-summary counts are hypotheses** [pc-c9ed9a]

A post-compaction summary claimed five open review threads; the file held two, and the stale number reached you before the file was checked. Candidate global CLAUDE.md rule: verify any count, list, or status inherited from a compaction summary against the file or command before stating it.

---
comments:
  c18:
    body: okay just tell me about the mapping thing again so i can decide on this, i
      think its all thats left
    by: user
    at: 2026-09-05T14:15:39.932Z
