# Roughdraft upgrade phase — build record

Each PR in the upgrade phase appends an entry here: what the issue planned, what was built, why they differ, every test added, and anything left undone.

## #4 — Save only when the reviewer actually changed something, and stop saving after the review ends

### What the issue planned

Gate the save on an actual edit or comment, and stop a tab from writing at all once its review is done or its server is gone. Opening a document, refreshing the tab, and approving with no edits must leave the file's bytes unchanged; a file changed on disk outside the editor must not be overwritten by the tab's reflowed copy; every behavior lands with a failing test first and the file-backed behavior runs against a real save/load cycle.

### What was built

- **Reflow on load no longer saves** (`packages/app/src/PageCard.tsx`). The rich-text editor's `onUpdate` now returns early when the dispatched transaction did not change the document. A slog run against the real app showed the load-time write came from a selection-only `commentHighlight$` transaction whose appended transaction, StarterKit's trailing-node extension, inserted an empty paragraph after the closing table or list. That appended change made `onUpdate` serialize and emit reflowed markdown, which the autosave then wrote. Real edits always carry `transaction.docChanged`, so they save as before. This one change is what makes opening, refreshing, and the watcher's reload after an external change leave the file alone.
- **Approving an untouched document does not write** (`packages/app/src/App.tsx`, `handleCompleteReview`). The handoff only calls `saveMarkdownFile` when the reviewer's draft differs from the loaded document content. The `POST /api/review-events` call already skipped its own write when there is no overall comment.
- **A delivered handoff ends the review** (`packages/app/src/DocumentWorkspace.tsx`, `isDocumentSaveBlocked`). While the handoff state is `notified`, `PageCard` runs with `saveBlocked`, so edits show as unsaved and nothing reaches the server. The existing watcher-count logic returns the state to `idle` when an agent watches again, and the next edit in that new review saves the full pending draft, including anything typed while blocked. The states `notifying`, `undelivered` and `error` do not block, because the handoff itself flushes pending edits while notifying and an undelivered handoff may be retried.
- **A tab whose server is gone cannot write** (`packages/server/src/index.ts`, `packages/app/src/detect-backend.ts`, `packages/app/src/api-backend.ts`, `packages/app/src/storage.ts`). `createApp` mints a random `instanceId`, advertised in `GET /api/status`. The browser records it as `serverInstanceId` and sends it with `PUT /api/markdown-file` and `POST /api/review-events`. A server that receives an id other than its own answers 410 without touching the file; requests without an id (CLI, MCP, older clients) are unaffected. The browser turns a 410 into `ServerInstanceGoneError`, and `App` moves the document into a new disk-change state `server-gone`, which blocks saves, shows a banner titled "Roughdraft server stopped" with no actions, and shows a "Server stopped" save-status label. The file watcher ignores change events while in that state, like `paused`.
- **Unchanged writes are not writes** (`packages/server/src/index.ts`, `PUT /api/markdown-file`). When the body equals the file's current content the server skips `writeFileSync`, so the mtime and version stay put and other open tabs are not made stale.
- `docs/spec/ui-state-screenshot-guide.md` lists the new server-stopped banner and save-status state.

### Why they differ

- The issue named `DocumentWorkspace.tsx` and `api-backend.ts` as where the client save logic lives. The load-time write actually originated in `PageCard.tsx`, in the rich-text editor's `onUpdate`, so the first fix landed there.
- The issue did not specify how a tab learns its server is gone. The build uses a per-server instance id checked by the server, rather than client-side detection of a dropped event stream, so a transient disconnect never blocks a live tab and a replaced server refuses the stale tab's writes even if the client logic is bypassed.
- The issue did not ask for UI. A blocked tab needs to say why, so the stale-server case reuses the existing conflict banner and save-status indicator with one new state instead of a new component.
- Skipping unchanged writes on the server is not in the acceptance criteria. It was added as a one-line guard at the endpoint the issue pointed to, because it makes any client that re-sends identical content harmless.

### Tests added

- `packages/app/e2e/save-gating.spec.ts` (real API server, real Vite app, real temp files): opening leaves bytes and mtime unchanged (`@smoke`); refreshing leaves them unchanged; approving with no edits sends only the review event; after a delivered handoff an edit does not write, and a new watch plus a new edit writes both edits; an external rewrite is reloaded and not overwritten; a tab routed to a replacement server instance cannot write and shows the server-stopped banner.
- `packages/app/test/page-card.test.tsx`: a transaction that leaves the document alone, with the trailing-node normalisation it triggers, does not call `onSave`; a real edit afterwards does.
- `packages/app/test/document-save-gating.test.ts`: `isDocumentSaveBlocked` across every handoff and disk-change state.
- `packages/app/src/api-backend.test.ts`: writes and handoffs carry `serverInstanceId`; a 410 becomes `ServerInstanceGoneError`.
- `packages/app/src/detect-backend.test.ts`: the status payload's `instanceId` is recorded on the backend info.
- `packages/server/src/index.test.ts`: an unchanged `PUT` leaves the mtime and version alone; a stale `serverInstanceId` gets 410 on `PUT /api/markdown-file` and on `POST /api/review-events` with an overall comment, and the file is untouched; the status test now expects `instanceId`.

### Left undone

- Edits typed while a handoff is in the `notified` state stay unsaved until an agent watches again and the reviewer edits once more. The issue asked for exactly that; the tradeoff is that a reviewer who keeps typing after approving sees "Unsaved changes" until the next review starts.
- The code editor (CodeMirror) path was not changed; its change listener already fires only on document changes, and the e2e tests cover the rich-text editor where the reflow came from.
