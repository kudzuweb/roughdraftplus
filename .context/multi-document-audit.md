# Multi-document surface audit

Audit of the server's dormant directory-listing, file-tree and project open/create endpoints, with one verdict for the surface as a whole. Read at commit 04c44ae on 2026-09-06; every line number below refers to that commit. Runtime claims come from a probe that started the app in-process on 127.0.0.1:4640 and requested each endpoint (the probe script lived outside the repo and left no process running). The document changes no product code and records the decision that issues #15 (document path and session label in the UI) and #16 (`status` naming the document, `status <path>`) build on.

This document avoids tables and fenced code blocks so that it reviews cleanly in Roughdraft, following `.context/upgrade-backlog.md`.

## Verdict: replace

The surface is scaffolding left behind when upstream removed the folder browser, not a half-built feature waiting to be finished. Delete the five dormant routes and their helpers, keep the one live route the issue listed with them (`/api/files`), and build the open-document state that #15 and #16 need as a new, small, in-memory record on the server. Do not extend any of the dormant routes to carry it.

The reasons, each expanded in the evidence sections below:

- **Nothing calls them and no consumer contract survives.** Upstream commit 3d9451a (2026-04-25, "Simplify Roughdraft to single markdown file") deleted every app-side caller and the `StorageBackend` methods that named their response shapes, and left the server handlers and their tests untouched. No commit since has touched the handlers (`git log -L1127,1228:packages/server/src/index.ts 3d9451a..HEAD` is empty).
- **They implement a different boundary model from the live routes.** Every live file route scopes paths to `projectPath` through `ensureProjectPath` (`packages/server/src/index.ts:216-229`). The dormant listing routes accept any absolute path on the machine with no boundary (`index.ts:1127-1131`, `1141-1145`), and `/api/project/create` runs `mkdir -p` on any absolute path (`index.ts:1204-1205`). ADR 0001 records that the server "resolves that file within local-file boundaries" and ADR 0004 that boundary checks "belong in the core server path".
- **They sit outside the token guard.** The bearer-token check runs only on the four `/api/remote-document` routes (`index.ts:917`, `972`, `985`, `1046`). With a token configured, `/api/fs/list` answered 200 with no `Authorization` header (probe P16) while `/api/remote-document/:id` answered 401 (probe P17). The bind guard's own error text names only the remote-document endpoints as the exposure (`index.ts:1278-1287`), so a non-loopback deployment browses the host filesystem unauthenticated.
- **Their shape is the vault model ADR 0001 rules out.** `projectPath` plus relative path, page ids, a recursive project tree: a finished version needs an ignore list, depth and symlink handling, a boundary, and auth. That is a rewrite of every handler, not a finish.
- **They model the wrong thing for the coming work.** #15 and #16 need per-open-document state: which file is open, which session opened it, when it was last saved, which threads are open. The dormant surface models directories to browse. The server keeps no open-document state today (`stateless: true`, `index.ts:840`); the only per-document server state is the remote-session map (`index.ts:88-96`, `409`).
- **The tests are shape tests.** Each dormant route has one happy-path test and no boundary or negative case (`packages/server/src/index.test.ts:589-696`), so a green suite says nothing about the risks above.

## What the verdict means for #15: showing the open document's path

Nothing in #15 needs a server listing route. The app already holds the absolute path and shows only its leaf:

- The CLI puts the absolute path in the URL as `?path=` (`packages/server/src/cli.ts:1141-1147`, `buildTargetUrl`). The app splits it into `projectPath` and `documentPath` at the last slash (`packages/app/src/app-navigation.ts:52-72`).
- `ApiBackend.openProject` stores that `projectPath` in memory and calls no server route (`packages/app/src/api-backend.ts:216-218`, called from `packages/app/src/App.tsx:1647-1649`).
- `App.tsx` joins them back into `documentAbsolutePath` (`App.tsx:2057-2060`) and passes it to the workspace as `documentCopyPath` (`App.tsx:2076`), where it feeds the copy-path menu (`packages/app/src/DocumentWorkspace.tsx:669-670`, `702-704`). The header button renders only `documentFilenameLabel`, the leaf (`DocumentWorkspace.tsx:1125-1129`, computed at `App.tsx:2061-2062`). The browser tab title already shows the full path with the home directory collapsed to `~` (`App.tsx:1679-1692`, `app-navigation.ts:74-86`).

So the path display is a UI change on data the app already has. Two things follow from the verdict:

- Do not build it on `/api/project/open` (which only echoes a directory back, `index.ts:1189-1193`) or on the `displayPath` from `/api/fs/list` (`index.ts:288-302`, `formatDisplayPath`). The app already has its own `~` collapsing in `formatWorkspacePathForDisplay` (`app-navigation.ts:74-86`); a second implementation on the server would be a second home for the same fact.
- The session label has no carrier today. The open-request payload is `path` and `url` only (`index.ts:83-86`, `881-891`), the SSE event forwards `path`, `url` and `instanceId` (`index.ts:906-911`), and the target URL carries only `path` (`cli.ts:1145`). The label needs a new field on both, plus a field on `BackendInfo` (`packages/app/src/storage.ts:52-60`) to reach the header. That is new state, so it belongs in the open-document record described under #16, not on the dormant surface.

The switch warning in #15 hangs on the same record: a tab that knows which path it has open can compare it with the incoming open-request path (`App.tsx:1607-1677` is the load path; the exact-path match that reuses a window is `index.ts:897-899`).

## What the verdict means for #16: `status` naming the document and `status <path>`

The dormant surface cannot answer either question, so #16 builds on new state rather than on any of it:

- `roughdraft status` today rejects any positional argument (`cli.ts:2423-2426`), finds a server through the state file (`cli.ts:2431`), and prints or emits only `running`, `url`, `port`, `pid`, `startedAt`, `stateFile` and `managed` (`cli.ts:1840-1860`, `buildServerStatusJson`). `/api/status` reports `backend`, `pid`, `instanceId`, `port`, optional `projectDir`, `serverRoot`, `stateless` and `capabilities` (`index.ts:830-848`) and nothing about a document.
- `/api/file-tree` and the `/api/pages` family enumerate what is on disk under a directory (`index.ts:359-393`, `540-553`); neither knows what is open. `/api/project/open` stores nothing (`index.ts:1175-1194`).
- The building blocks for `status <path>` already exist on the live side. Open threads come from `extractRoughdraftReviewIndex`, already served for one file by `/api/review-index` (`index.ts:644-656`, keyed by `projectPath` and relative `path`). The last save lands in `PUT /api/markdown-file` (`index.ts:757-797`), which is where a last-saved timestamp can be recorded. Remote documents keep their bytes in `RemoteSession` (`index.ts:88-96`) and save through `PUT /api/remote-document/:id` (`index.ts:984`).

The record #16 needs is a per-document entry: absolute path, session label, opened-at, last-saved-at, and the server that owns it. Populate it from the open path (the CLI's open request at `index.ts:881-914` and the app's first load through `GET /api/markdown-file` at `index.ts:569-588`) and from the two save routes. Keep it in memory only, as ADR 0004 requires of remote sessions; the state file stays a process record. Expose it through `/api/status` or a new read route keyed by absolute path, so `status` can name the document and `status <path>` can say "not open" for any other path. The CLI change is then a positional on `status` that reads that route.

## Where the surface came from

Verified from `git log` and `git show` in the worktree.

- **c9bf145, 2026-04-22, upstream** introduced `/api/directories`, `/api/project/open`, `/api/project/create` and the `/api/pages` family with the canvas page editor.
- **fb19795, 2026-04-22, upstream, "Add local file browsing and document mode"** introduced `/api/fs/list` and `/api/file-tree`, with a `ProjectPicker` in the app.
- **67798ef, 2026-04-23, upstream, "Add background CLI and project browser"** wired the app's browser to `/api/project/open`.
- **3d9451a, 2026-04-25, upstream, "Simplify Roughdraft to single markdown file"** deleted `AppSidebar.tsx`, `HomeScreen.tsx`, `PathSwitcher.tsx`, `ProjectTreeSidebar.tsx`, `file-system-browser.ts` and `recent-items.ts` from the app, removed `listPages`, `getPage`, `savePage`, `createPage`, `deletePage`, `listDirectories`, `listFileSystem`, `listProjectTree` and `createProject` from `StorageBackend` together with the `DirectoryListing`, `FileSystemListing` and `ProjectTreeListing` types, and removed the fetches to `/api/directories`, `/api/fs/list`, `/api/file-tree` and `/api/project/create` from `api-backend.ts`. Its README diff replaced "open a folder, browse its markdown files" with "opens a single markdown file directly" and dropped the "Folder browsing" feature bullet. The commit did not touch `packages/server/src/index.ts`.
- **524b28f, 2026-04-27, upstream** added ADR 0001, recording the single-file decision two days after the removal.
- **168484b, 2026-05-05** added remote document mode and the ADR clarifications; it left the dormant routes alone.

The server-side leftovers are therefore the back half of a feature whose front half was deliberately removed and whose removal was then recorded as the product boundary.

## The endpoints

For each: what it does, what calls it, its test coverage, and what the probe showed. "No caller" was checked with a repository-wide search for the route string across `.ts`, `.tsx`, `.js`, `.mjs`, `.md`, `.json` and `.sh` files outside `node_modules` and `dist`, which found only `packages/server/src/index.ts` and its test file unless stated otherwise.

**1. `GET /api/directories`** (`index.ts:1127-1139`; helper `listDirectories` `index.ts:269-286`)

- Lists the subdirectories of the `path` query, defaulting to the server's home directory (`index.ts:1128-1131`, `homeDir` from `index.ts:397`). Any absolute path is accepted; the only check is that it is an existing directory (`index.ts:1133`). Returns `path`, `parentPath` (null at the filesystem root, `index.ts:283`) and sorted `directories`.
- Callers: none. The app's fetch was removed in 3d9451a.
- Tests: one, listing the home directory with no `path` (`index.test.ts:589-609`). No test for an explicit path, a path outside home, or a non-directory.
- Probe: 200 for the home directory (54 directories), for `/` (15 directories) and for `/private/etc` (19 directories), probes P1 to P3.

**2. `GET /api/fs/list`** (`index.ts:1141-1166`; helpers `listFileSystem` `index.ts:304-347`, `formatDisplayPath` `index.ts:288-302`)

- Lists subdirectories and `.md` files of the `path` query, defaulting to home, with a `displayPath` that collapses home to `~` (`index.ts:341`). Any absolute path is accepted (`index.ts:1142-1145`). A missing path is 404, a non-directory is 400 (`index.ts:1147-1155`), an unreadable directory becomes a thrown error mapped to 500 (`index.ts:313-315`, `1159-1165`).
- `parentPath` is null only when the listed directory is home (`index.ts:342-343`), so at the filesystem root it reports itself as its own parent (probe P5 returned `parentPath: "/"`). `listDirectories` handles the same case correctly (`index.ts:283`). The two helpers are near-duplicates with different edge behavior.
- Callers: none. Removed from the app in 3d9451a.
- Tests: one, listing home with no `path` (`index.test.ts:611-643`).
- Probe: 200 for home and for `/`, 500 "Directory is not readable." for `/private/var/root`, 400 for `/etc/hosts`, probes P4 to P7. With a remote-document token configured and no `Authorization` header it still answered 200 (probe P16).

**3. `GET /api/file-tree`** (`index.ts:1168-1173`; helper `listProjectTree` `index.ts:359-393`, `toCanonicalRelativePath` `index.ts:349-357`)

- Walks `projectPath` recursively and returns every directory (with a trailing slash) and every file as a relative path, directories first at each level (`index.ts:362-388`). No ignore list, no depth limit, no `.md` filter, no symlink handling. `projectPath` is required (`index.ts:1169-1170`, `488-508`).
- Callers: none. Removed from the app in 3d9451a.
- Tests: one, a two-level tree with two files (`index.test.ts:645-665`).
- Probe: over this worktree it returned 31,017 paths in 300 ms, of which 30,809 were under `node_modules` (probe P8). Without `projectPath` it is 400 (probe P18).

**4. `POST /api/project/open`** (`index.ts:1175-1194`)

- Resolves the body `path`, checks it is an existing directory, and echoes `{ backend: "local-files", projectDir, port }` (`index.ts:1183-1193`). It stores nothing; the server has no current project (`stateless: true`, `index.ts:840`; `projectDir` on `/api/status` comes only from the CLI's start option, `index.ts:836-838`).
- Callers: none. `ApiBackend.openProject` sets `info.projectPath` in memory and does not call the server (`api-backend.ts:216-218`, `22-28`).
- Tests: one, shared with create (`index.test.ts:667-684`).
- Probe: 200 for `path: "/"` (probe P10).

**5. `POST /api/project/create`** (`index.ts:1196-1212`; helper `ensureDirectoryExists` `index.ts:257-259`)

- Resolves the body `path` and creates it recursively, returning 201 with the same echo shape (`index.ts:1204-1211`). Any absolute path; no boundary, no token.
- Callers: none. `createProject` was removed from `StorageBackend` and `api-backend.ts` in 3d9451a.
- Tests: one, shared with open (`index.test.ts:686-695`).
- Probe: 201, and the nested directory existed on disk afterwards (probe P11; the probe removed it).

**6. `GET /api/files`** (`index.ts:1214-1228`) is live, not dormant

- Serves any file inside `projectPath` by relative `path`, through `ensureProjectPath` (`index.ts:1220`, `216-229`); a path that resolves outside the project is 404 (`index.ts:1222-1225`). No extension filter: it served `package.json` (probe P12).
- Callers: `ApiBackend.resolveFileUrl` builds `/api/files` URLs (`api-backend.ts:211-214`); `PageCard.tsx:629-649` and `EditorContextMenu.tsx:91`, `630` pass that resolver into the markdown renderer, which rewrites image and link sources through it (`packages/app/src/markdown.ts:313-349`). `POST /api/assets` returns a `previewUrl` pointing at it (`index.ts:1253`).
- Tests: `index.test.ts:716-729` reads a file, and `745` checks the asset preview URL targets it.
- Probe: 200 inside the project (P12), 404 for `../` traversal (P13) and for an absolute path outside (P14). The boundary holds.
- The issue listed it with the dormant routes; it is not one, and the verdict excludes it. Keep it and `/api/assets` (`index.ts:1230-1256`, called from `api-backend.ts:186-209`).

**Neighbors in the same state**

- The `/api/pages` family (`GET /api/pages` `index.ts:540-553`, `GET /api/pages/:id` `555-567`, `PUT /api/pages/:id` `742-755`, `POST /api/pages` `799-813`, `DELETE /api/pages/:id` `815-828`, helpers `listMdFiles` `143-152`, `nextUntitledId` `204-209`, `pageFilePathFromId` `231-233`) lists, reads, writes, creates and deletes top-level `.md` files by id under `projectPath`. No app caller; the `StorageBackend` methods went in 3d9451a. Tests at `index.test.ts:29-49`, `75-121`, `478-516`, `518-528`. Probe P15 listed this worktree's root markdown files with full content. It is bounded by `ensureProjectPath` (`index.ts:232`) but is the page-database model ADR 0001 names as out of scope. The same verdict applies; it is listed here because the issue did not name it.
- `/api/status` advertises `capabilities.fileSystemBrowsing: true` (`index.ts:843`) and the status test pins it (`index.test.ts:549`). The app's `StatusPayload` type reads only `remoteDocuments` from `capabilities` (`packages/app/src/detect-backend.ts:6-12`), so the flag has no consumer.
- The mock backend in `packages/app/test/page-card.test.tsx:74-94` still defines `listDirectories`, `listFileSystem`, `listProjectTree`, `createProject`, `createPage` and `deletePage`, none of which are on `StorageBackend` any more (`storage.ts:62-84`).
- The `homeDir` option on `createApp` (`index.ts:64`, `397`) is used only by the two listing routes (`index.ts:1131`, `1145`, `1158`).

## What "replace" removes and what it keeps

Removal is a follow-on ticket, not this one; the list is here so it does not have to be rediscovered.

- Remove the five dormant routes (`index.ts:1127-1212`), their helpers and types (`index.ts:31-58`, `257-286`, `288-347`, `349-393`), the `homeDir` option (`index.ts:64`, `397`), the `fileSystemBrowsing` capability (`index.ts:843`) and its assertion (`index.test.ts:549`), and the five tests (`index.test.ts:589-696`). The open-request test between them (`index.test.ts:698-714`) stays.
- Recommend removing the `/api/pages` family and its tests in the same sweep, and the leftover mock methods in `page-card.test.tsx:74-94`.
- Keep `/api/files` and `/api/assets`, `ensureProjectPath`, and everything under `/api/markdown-file`, `/api/review-index`, `/api/review-events`, `/api/open-request` and `/api/remote-document`.
- Add, for #15 and #16, the in-memory open-document record described above. It is new code on the live path, not a repurposing of anything removed.

## How this was checked

- Every line reference was read at commit 04c44ae in this worktree. Callers were found by repository-wide search for the route strings and helper names, excluding `node_modules` and `dist`.
- History came from `git log -S` on the route strings, `git show --stat` and the file diffs of 3d9451a, and `git log -L` over the handler and test ranges since 3d9451a.
- Runtime behavior came from an in-process server built with `createApp({ port: 4640, remoteDocumentToken: "probe-secret" })` listening on 127.0.0.1, with eighteen requests numbered P1 to P18 above. The server was closed and the created directory deleted at the end of the run.
- The repo's `slog` skill was not used: it works by adding log lines to product code, and this ticket changes no product code. The probe answered the same runtime questions from outside.
