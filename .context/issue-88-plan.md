# How to handle issue #88

Written 2026-09-06 by the Agent Dash orchestrator, after the upgrade phase (issue #1) closed all
twenty-eight of its children. This plan covers sequencing and ownership only. The decomposition
itself is issue #88's own first deliverable and is not attempted here.

## The situation in one paragraph

Two structures on this repository produce recurring bugs, not one. Issue #88 names the first: the
rich-text editor surface, 1,605 lines with nineteen effects coordinating through mutable refs. The
second has no ticket: the Markdown round trip across `markdown.ts`, `critic-markup/index.ts` and
`packages/rfm/src/index.ts`. Twenty-seven issues are open. Thirteen of them are in the round trip,
four are in the editor surface, eight are server and CLI work unrelated to either, and two are
tooling.

## Where the open work actually sits

| Machine | Open issues | Which |
|---|---|---|
| Markdown round trip | 13 | #22, #23, #59, #64, #84, #89, #90, #92, #93, #95, #96, #98, #99 |
| Editor surface (issue #88's subject) | 4 | #25, #61, #63, #72 |
| Server, CLI and MCP | 8 | #62, #71, #75, #76, #78, #79, #80, #85 |
| Tooling and documentation | 2 | #70, #74 |

Only #61 is squarely the effect-ordering class issue #88 describes. #63 straddles both machines.
#72 is a layout offset that happens to live in the same file. #25 is a test-quality ticket.

Five of the round-trip thirteen are silent data loss found by review today: #89, #90, #92, #95, #96.

## Steps, in the order they should happen

### 1. Write the round-trip phase ticket, and do not start it

Issue #88 is correctly shaped and the round trip has nothing equivalent. Write it the same way: a
`phase` issue whose first deliverable is an inventory and a decomposition plan for Mauria's
approval, with no code until she approves. Without it, the audit Mauria asked for cannot happen,
because the carveouts she wants to audit are in this machine and not in #88's.

The carveouts that would be audited, all added this week: the private-use placeholder padding from
#24, the escape token walk and its two-source derivation from #58, the ported fence-growth logic
from #37, the tokenizer override from #38, and the endmatter form check from #53. Each is correct
and each was added because the round trip could not be reasoned about directly.

### 2. Run the round-trip inventory first

One agent, not a fan-out. The effects interact, and an agent given a slice cannot see the
interactions that make the inventory worth having. Deliverable: every path from a document on disk
to the editor and back, naming what reads, what writes, what escapes, what unescapes, and where a
byte can change. Then which of the five corruption tickets that inventory would make unnecessary
rather than cheaper.

That last question is the audit. It is answerable from an inventory and not before it.

### 3. Run issue #88's inventory second, or in parallel if the seam holds

The two phases share exactly one file, `packages/app/src/editor-extensions.ts`, which appears in six
open tickets across both machines. If the inventories are written first and the decomposition plans
name their file boundaries, parallel is safe. If either plan wants that file restructured, they
serialise and the round trip goes first.

### 4. Hold the four authorized tickets until both plans exist

#22, #23, #25 and #59 are authorized and unclaimed. Each adds code to a machine that may be
restructured. #25 is in the editor surface; the other three are in the round trip.

### 5. Take the eight server and CLI issues meanwhile

#62, #71, #75, #76, #78, #79, #80 and #85 touch neither machine. They are the work that can proceed
without prejudging either decomposition, and three of them are test-infrastructure problems that
make everything else cheaper to verify: #71 and #80 are known flakes that cost a rerun on most
checks, and #78 makes a fresh worktree fail its first check.

## Constraints that already apply

- The app must be in a working state between pull requests. Both decompositions must sequence so
  every step leaves `pnpm check` green.
- No behavior change in a decomposition. Every existing test passes unmodified, except where a test
  asserts an internal shape rather than behavior, and each such change is called out in its PR.
- Byte stability is measured against text that is not already at its fixed point, asserted from the
  settling round onward against the settled text. A canonical input proves nothing.
- No new abstraction with one caller. A decomposition is the easiest way to lose the repository's
  current cleanliness on dead code.

## Open questions, and what each blocks

| Question | Blocks |
|---|---|
| Does the round-trip phase get written and promoted? | Steps 1 and 2, and the carveout audit entirely. |
| Does issue #88 get promoted to `Ready`, and when? | Step 3. It is labeled `phase`, so promoting it starts an orchestrator. |
| May the two phases run in parallel? | Step 3. Depends on whether either plan wants `editor-extensions.ts` restructured. |
| Do the eight server and CLI issues proceed now? | Step 5. They are independent of both, but they are also unauthorized. |
| Is issue #88 this run's to work at all? | Everything. It was filed by another session and is not a child of issue #1. |
