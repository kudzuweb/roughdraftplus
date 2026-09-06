# Upstream pull request harvest

One pass over every open pull request on `Lex-Inc/roughdraft`, the unmaintained upstream of this fork, with a verdict each. Upstream PRs are raw material for the fork's own issues, never merge-as-is candidates: every harvest below is reworked into a fork PR that follows `AGENTS.md`, lands its failing test first, and cites the upstream PR in its build record.

Every verdict was checked on 2026-09-05 against upstream's open list (24 PRs, `gh pr list --repo Lex-Inc/roughdraft --state open`) and this fork's `main` at 98e85d5, and re-checked on 2026-09-06 against 5634538, the merge of PR 29 that closed fork issue #3. A verdict is "harvest" when the PR carries material worth reworking for a named fork issue, and "skip" otherwise, with the reason. Where several PRs address one bug, section 3 compares them and names the design that won.

Already fixed at source on this fork, so any upstream PR duplicating them is a skip: the yaml root dependency (4c153c5), the five-minute watch death (dd7fa52), and every registry install and update path (4481200).

Reading depth: the full diff was read for every PR except the seven large feature PRs (85, 102, 103, 131, 143, 147, 151). For those the body, file list, and hunk headers were read in full, plus the specific hunks each verdict names.

## 1. PR 145, assessed first: render replies that live only in YAML endmatter

**Verdict: harvest for #7 (render or migrate legacy endmatter replies).** Checked 2026-09-05. Author moiri-gamboni, last updated 2026-08-08, mergeable against upstream `main`, 171 additions across four files.

**What it fixes.** A reply stored in YAML endmatter has no inline marker, so it is parsed into the comments map but never reaches the rail: `buildCommentThreadRailItems` builds each rail group from the anchor element's `data-comment-ids`, which lists only inline markers, so the reply is filtered out before threads are built. The fork's `packages/app/src/document-comments.ts:195-223` still has exactly the shape the PR patches, and the helper it relies on, `getCommentDescendantIds`, exists at `packages/app/src/critic-markup/index.ts:595` (verified in the worktree). The fix applies to the fork without adaptation.

**What to carry into the #7 work.**

| Piece | Detail |
|---|---|
| `collectAnchoredThreadComments` in `document-comments.ts` | It resolves a group's anchored comment ids, then pulls every descendant of those roots back from the comments map, skipping ids already present so an inline reply is never duplicated. This is the whole rendering fix and it is the right shape: it works from the comments map rather than the DOM, so it covers endmatter replies and the fork's canonical inline replies alike. |
| The same helper applied to the selection banner | `PageCard.tsx` builds `activeComments` from `activeCommentIds` with the same filter, so the PR routes it through the helper too. Without this the reply shows in the rail but not in the banner that opens when the anchor is selected. |
| `resolveAnchoredCommentId` in `PageCard.tsx` | A reply to an endmatter reply has no anchor to hang on, so replying to it failed silently. The PR walks up the `parentCommentId` chain to the nearest anchored ancestor and anchors the new reply there. The fork writes replies inline, so this walk-up is what lets a reviewer answer a legacy reply and get a well-formed inline reply out. |
| The three tests | Two unit tests in a new `document-comments.test.ts` (endmatter-only reply appears in the rail item; an inline reply is not duplicated) and one `page-card.test.tsx` case (reply composer opens from a reply with no inline anchor). The first unit test is the failing-test-first that #7 requires. |

**What not to carry.** Nothing in the PR touches the save path. Issue #7 states that the next save strips endmatter replies; this PR neither fixes nor worsens that, so the save-survival half of #7 (render-and-preserve, or migrate to inline on load) is separate work. The PR's problem statement also treats endmatter replies as the documented reply format; the fork's contract is inline replies, so the PR's framing does not transfer, only its code.

## 2. Every open upstream PR

| PR | Title (author, last updated) | Verdict (checked 2026-09-05) |
|---|---|---|
| 85 | Add voice + pointer-guided review feedback workflow (richardguerre, 2026-05-22) | Skip: a draft that conflicts with upstream `main`, adds an OpenRouter API key requirement and a transcription command, and touches 17 files; no fork issue asks for voice input. |
| 102 | Render mermaid code blocks as diagrams (alexmodrono, 2026-05-28) | Skip: no fork issue asks for Mermaid rendering, and it conflicts with upstream `main`. If Mermaid is ever ticketed, PR 143's design wins over this one (section 3). |
| 103 | Appearance settings (theme, font, width) + syntax highlighting (alexmodrono, 2026-05-30) | Skip: no fork issue asks for a settings dialog, and it conflicts with upstream `main`. Its width toggle overlaps PR 147 and its highlighting overlaps PR 143 (section 3). |
| 110 | Declare `yaml` as a root dependency so global installs work (gitsacha, 2026-08-12) | Skip: already fixed in the fork at 4c153c5. Its `packaging.test.ts`, which asserts every `@roughdraft/rfm` runtime dependency is also in the root manifest, is the one piece the fork lacks (section 5). |
| 112 | Fix legacy multiline inline comment rendering (3mdistal, 2026-06-03) | Skip: its fix normalizes a multiline inline comment into an empty inline marker plus a YAML `body:` block, which is the opposite direction from the fork's inline-canonical contract, and no fork issue covers it. Whether the underlying render leak exists in the fork was not probed. |
| 117 | Add yaml to root runtime dependencies (xianzuyang9-blip, 2026-06-09) | Skip: already fixed in the fork at 4c153c5. Identical manifest change to PR 110 without the test. |
| 120 | Fix Nathan Baschez profile link in README (nickgraynews, 2026-06-10) | Skip: no fork issue, cosmetic. The fork's `README.md:320` still carries the old `twitter.com/nbashaw` link, so the one-line change applies if anyone wants it. |
| 121 | Bound watch long-polls so reviews over 5 minutes don't crash (zain, 2026-06-11) | Skip: already fixed in the fork at dd7fa52, whose design is equivalent to this one (section 3). |
| 126 | Fix roughdraft open/watch crashes on undici idle headers timeout (nickgraynews, 2026-06-19) | Skip: already fixed in the fork at dd7fa52, and this is the weakest of the six designs: it retries on error codes with `fromNow: false` and no sequence cursor, so it can replay events from session start, and it has no tests (section 3). |
| 131 | Add comment reactions (up/down/clarify) (gitsacha, 2026-08-12) | Harvest as a design reference for #17 (disposable anchor flag): it adds one metadata attribute end to end, through `rfm` parse and serialize in both inline and endmatter form, the spec, the JSON schema, and the review index, which is the exact plumbing #17 needs for its new attribute. The reaction feature itself has no fork issue and is not carried. Its action-row button wiring in `CommentEditorList.tsx` is also a pattern for #9's approve control. |
| 135 | Preserve single tilde text in markdown (peterhartree, 2026-07-08) | Skip: no fork issue. The bug is present in the fork (section 5) and the fix, a custom marked `del` tokenizer that requires a double tilde, is small and sound, so file a ticket if wanted. |
| 136 | Extend review watch timeout (peterhartree, 2026-07-08) | Skip: it raises the server's wait clamp from 5 to 30 minutes and changes nothing on the client, so the undici five-minute headers timeout still kills the CLI; the fork's dd7fa52 makes the clamp irrelevant (section 3). |
| 138 | Global npm install crashes with ERR_MODULE_NOT_FOUND for 'yaml' (gorkamolero, 2026-07-13) | Skip: already fixed in the fork at 4c153c5. It also deletes the root `pnpm.onlyBuiltDependencies` block for no stated reason, which the fork should not copy. |
| 139 | 'roughdraft open' crashes after 5 minutes of waiting (gorkamolero, 2026-07-13) | Skip: already fixed in the fork at dd7fa52, whose design is equivalent to this one (section 3). |
| 141 | Show full-value tooltips for clipped path and filename in the file menu (foobarnes, 2026-07-22) | Skip: #15 wants the document path always visible in the UI, and this shows it only on a 600 ms hover inside the file menu. Its shared `tooltip.tsx` changes (positioner z-index above popovers, optional `arrowClassName`) are not needed by any fork issue. |
| 142 | Popover arrow rendering artifacts in the document file menu (foobarnes, 2026-07-22) | Skip: no fork issue, cosmetic. Three-line change to `components/ui/popover.tsx` (`isolate`, arrow at `z-[-1]`, `arrowPadding={12}`) that applies as-is if anyone wants it. |
| 143 | Render Mermaid diagrams and highlight fenced code (simulcast, 2026-08-06) | Harvest, one part, for the fenced-CriticMarkup ticket to be filed from section 5 (no open fork issue covers it; #3 closed with PR 29 without fixing it): its `serializeCriticCodeChildren` replaces `service.turndown(codeElement.innerHTML)` inside `addCriticCodeBlockRule` with a node walk that serializes comment and change spans inside a fence without routing the code through Turndown. That Turndown call is the mechanism only for fences that carry a comment or change span; a plain multi-line fence round-trips intact on the fork. The Mermaid and Shiki halves are skipped: no fork issue asks for them, though this is the better of the two Mermaid designs (section 3). |
| 144 | Fix `open`/`watch` crash when a review runs longer than 5 minutes (jamescbury, 2026-08-07) | Harvest, one part, for #11 (server restart mid-review): its bounded retry on transient fetch failures (up to 5 consecutive, 2 s apart, with a stderr line each). The fork's `runWatch` retries only timeout-class errors and rethrows everything else (`packages/server/src/cli.ts:2173-2187`), so a connection refused during a server restart still kills the blocking `open`. Harvesting the retry reverses a behavior the fork pinned on purpose at dd7fa52: `packages/server/src/cli.test.ts:1284`, "still crashes when an untimed watch hits a non-timeout fetch error", asserts that an `ECONNREFUSED` rethrows, so the #11 builder flips that test as a decision. Do not carry PR 144's test as the failing test: "keeps watching after a transient long-poll fetch failure" injects `UND_ERR_HEADERS_TIMEOUT`, which `isSegmentTimeout` already retries, so it passes on the fork today; the fork's failing test must inject `ECONNREFUSED`. Two more parts the builder needs: the priming poll at `cli.ts:2189` sits outside the retry loop, so a refused connection there needs covering too, and a retry that reconnects to a restarted server must reset `afterSequence`, since the cursor from the old process means nothing to the new one. The segmentation itself is already fixed at dd7fa52 (section 3). |
| 145 | Render replies that live only in YAML endmatter (moiri-gamboni, 2026-08-08) | Harvest for #7; section 1 names what to carry. |
| 147 | Add document width preference toggle for comfortable/wide layouts (claudiunicolaa, 2026-08-18) | Skip: no fork issue asks for a width preference. Overlaps PR 103's width setting; if ever wanted, this focused version is the one to rework (section 3). |
| 148 | Keep the Approve button visible after the watcher disconnects (jamescbury, 2026-08-21) | Harvest for #11 (server restart mid-review): a `reviewWatcherSeen` flag, set once any poll reports a watcher and reset when the document changes, keeps the Done Reviewing button mounted through a watcher drop, and a click with no watcher already degrades to the existing `undelivered` state. This is the tab-side half of #11's "the button was gone" failure. Rework it against #28, which makes the post-Done unblock per review token rather than per path: a sticky per-path flag must not re-widen what #28 narrows. |
| 149 | Disable undici header/body timeouts on the review watch long-poll (cathrynlavery, 2026-09-01) | Skip: already fixed in the fork at dd7fa52 by a different design, and this one adds `undici` as a runtime dependency and edits `pnpm-workspace.yaml` for pnpm 11. It is the only PR that also patches the MCP watch tool, which the fork has not fixed (section 5). |
| 150 | Improve comment readability on large displays (AndySparks, 2026-09-04) | Skip: no fork issue asks for a wider review rail. The change is one CSS clamp on `--review-rail-width` plus a `document-page-main` test id. |
| 151 | Dock the comment composer on narrow screens (jwarwick78, 2026-09-04) | Skip: no fork issue covers viewports under 1100 px, and it changes nothing above that breakpoint. The `comment-dock.ts` clearance math is self-contained if narrow screens are ever ticketed. |

## 3. Where several PRs address one bug

### The CLI dies at five minutes (121, 126, 136, 139, 144, 149)

`roughdraft open` waited on one unbounded long-poll to `/api/review-events/watch`; Node's fetch aborts any request whose headers have not arrived in 300 s, so every review longer than five minutes crashed the CLI. The fork fixed this at dd7fa52: a priming poll with a zero timeout fetches the sequence cursor, then bounded 240 s segments carry `afterSequence` forward, with an abort margin of 15 s, retry on timeout-class errors, and `ROUGHDRAFT_WATCH_SEGMENT_SECONDS` for tests (`packages/server/src/cli.ts:2107-2200`).

| PR | Design | Judgement |
|---|---|---|
| 121 | It polls in 240 s slices, threads `nextSequence - 1` into `afterSequence`, exports the slice constant, and adds one re-poll test. | Equivalent to the fork's core loop, without the priming poll or any retry on a failed segment. |
| 126 | It wraps the single unbounded fetch in a retry loop keyed on five undici and socket error codes and sets `fromNow: false` without a cursor on retry. | Weakest: replaying from session start can redeliver old events, the poll is still unbounded so every segment ends in a caught error, and there are no tests. |
| 136 | It raises the server-side wait clamp to 30 minutes. | Does not touch the client, so the undici timeout still fires at 300 s; on its own it fixes nothing. |
| 139 | It polls in 240 s slices with a deadline, carries `nextSequence` forward, and updates the `open --json` test to assert the slice shape. | Equivalent to 121 and to the fork's core loop, without retry. |
| 144 | It polls in 240 s slices with a cursor, and adds a bounded retry on transient fetch failures (5 consecutive, 2 s apart, logged) with tests for the crash, the slice contract, cursor resumption, and `--timeout` expiry. | Best upstream design. The fork already has the slicing; the transient retry is the harvest, filed under #11 above, with a fork-written failing test rather than 144's, whose injected `UND_ERR_HEADERS_TIMEOUT` the fork already retries. |
| 149 | It passes a shared `undici.Agent({ headersTimeout: 0, bodyTimeout: 0 })` as the fetch dispatcher on the CLI and MCP watch fetches, adding `undici` as a dependency. | A legitimate alternative that avoids slicing, but it adds a runtime dependency to reach undici internals and leaves the server's 300 s clamp in place, so an unbounded wait is still cut short server-side. Its MCP coverage is the one thing the others lack. |

Winner: the fork's own dd7fa52, which matches the 121/139/144 shape and adds the priming poll. PR 144's transient-failure retry is the only upstream piece that improves on it.

### `yaml` missing from a global install (110, 117, 138)

All three make the identical one-line change, promoting `yaml: ^2.9.0` to the root `dependencies`, which the fork made at 4c153c5. PR 110 wins on design because it lands a regression test first (`packaging.test.ts`, asserting every `@roughdraft/rfm` runtime dependency is declared at the root) that guards the whole class of bug rather than the one package. PR 138 also deletes the root `pnpm.onlyBuiltDependencies` block, an unrelated change with no rationale.

### Mermaid rendering (102, 143)

Neither has a fork issue. If one is opened, PR 143 is the design to rework: it keeps a Mermaid fence as an ordinary editable `codeBlock` with a presentation-only SVG view, lazy-loads Mermaid with `securityLevel: "strict"`, falls back to the source with an actionable error, follows the color scheme, and ships unit, component, and Playwright coverage plus a screenshot-guide entry. PR 102 replaces the fence with an atomic TipTap node, which breaks comment anchoring inside the block, and it conflicts with upstream `main`.

### Width and appearance (103, 147, 150)

Not a bug, three overlapping layout features with no fork issue. PR 103 bundles a width toggle into a settings dialog with theme and font choices; PR 147 is the width toggle alone, with e2e geometry tests; PR 150 leaves the writing column alone and widens only the rail. They are listed together so nobody harvests two of them.

## 4. Harvests by fork issue

| Fork issue | Upstream material |
|---|---|
| Fenced CriticMarkup flattens on save (ticket to be filed from section 5) | PR 143's `serializeCriticCodeChildren` and the widened `addCriticCodeBlockRule` signature, with its `critic-markup.test.ts` cases for comments and each suggestion form inside a fence. |
| #7, legacy endmatter replies | PR 145 in full, per section 1. |
| #11, server restart mid-review | PR 144's transient-failure retry in `runWatch`, with a fork-written failing test that injects `ECONNREFUSED` and a deliberate flip of `cli.test.ts:1284`, and PR 148's `reviewWatcherSeen` flag in `DocumentWorkspace.tsx`, reworked against #28. |
| #17, disposable anchor flag | PR 131 as the pattern for adding a metadata attribute through `rfm`, the spec, and the schema, in both inline and endmatter form. |
| #9, approve action | PR 131's action-row button wiring in `CommentEditorList.tsx`, as a pattern only. |

## 5. Bugs the pass found in the fork with no backlog item

These change no verdict above. The orchestrator files each as its own ticket.

| Finding | Evidence |
|---|---|
| A multi-line fence that carries a CriticMarkup comment saves as one line. | Checked against 5634538, the merge of PR 29 that closed #3: `packages/app/src/critic-markup/index.ts:1083` still reads `service.turndown(codeElement.innerHTML)` inside `addCriticCodeBlockRule`, and Turndown collapses the code's line breaks on the way out. The PR 30 review probe (2026-09-06, `criticMarkdownToEditorState` then `editorStateToCriticMarkdown`, run on this branch and on `git archive 5634538`) turned a three-line `ts` fence with `{==b==}{>>why b<<}{id="c1" ...}` on its middle line into a single line `const a = 1; const {==b==}{>>why b<<}{id="c1" ...} = 2; const c = 3;`; the same probe round-trips a plain fence with a blank line, and fences carrying `{++ ++}` or `{~~ ~> ~~}` text, unchanged. PR 143's `serializeCriticCodeChildren` is the material (section 2). |
| A single tilde becomes strikethrough. | `marked.parse("Tracked ~57% of work time (~100h)", {gfm: true})` with the fork's installed marked returns `<del>57% of work time (</del>`, and `toHtml` in `packages/app/src/markdown.ts:575-581` calls marked the same way. PR 135's tokenizer is the fix. |
| The MCP tool `roughdraft_watch_review_events` still long-polls unbounded. | `packages/server/src/mcp.ts:293-300` issues one fetch with no timeout and no segmentation, so an MCP caller waiting more than five minutes hits the same undici timeout the CLI used to. dd7fa52 fixed `cli.ts` only. PR 149 is the only upstream PR that touches this surface; the fork's segmented loop is the design to reuse. |
| Nothing guards the root manifest against a future rfm runtime dependency. | The fork has no equivalent of PR 110's `packaging.test.ts`; a new import in `packages/rfm` would reintroduce the global-install crash silently. |
| The README credit line still points at the old profile URL. | `README.md:320`, one-line change from PR 120. |
