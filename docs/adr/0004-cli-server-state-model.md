# 0004: CLI Server State Model

## Context

The CLI starts or reuses a local server so `roughdraft open <file.md>` works without manual process management.

## Decision

The server state file records the managed background process, port, URL, and start time. The CLI should reuse healthy managed servers, recover from stale state, and avoid claiming ownership of unrelated processes unless explicitly requested.

## Consequences

State handling must remain deterministic and testable. Stale-write protection and local-file boundary checks belong in the core server path.

## What This Explicitly Does Not Mean

The state file is not a project database, collaboration backend, sync system, or persistent document model.

## Clarification (2026-04-30): Remote Document Sessions

Remote document mode (see `docs/plans/2026-04-30-001-feat-remote-document-mode-plan.md`) introduces in-memory session state on the server: a map of registered remote-document sessions, each holding a CLI-supplied markdown file's bytes for the lifetime of the SSE connection.

This state is **deliberately not persisted in the state file**. Sessions live only in the running server process and are evicted on disconnect or server restart. The state file's role — managed background process, port, URL, start time — is unchanged. Treating remote-document sessions as transient in-memory state preserves the boundary above: the state file does not become a document model just because the server now hosts other machines' edits.

## Clarification (2026-09-06): Local Open-Document Record

The same reasoning now extends to local documents. The server keeps, in memory only, a per-tab open-document record in its open-request registry (`openRequestClients` in `packages/server/src/index.ts`): for each connected tab, the absolute path it has open, the session label the CLI passed with `roughdraft open --label`, when the tab subscribed, and when the server last wrote that document to disk while the tab was connected. The record is filled when a tab subscribes to `/api/open-requests`, updated when an open request is delivered to that tab, and stamped when `PUT /api/markdown-file` or an overall comment on `POST /api/review-events` writes the file; it is dropped when the tab disconnects and is gone after a server restart, exactly like a remote-document session. `/api/status` lists the records as `documents`, which is what `roughdraft status` and `roughdraft status <path>` read; open threads are not stored, `status <path>` reads them from `/api/review-index` when asked. Nothing about it reaches the state file, so the boundary above holds: the state file remains a process record, not a document model. This record is the single-file-compatible seed that `.context/multi-document-audit.md` describes; a multi-document workspace beyond it still needs the separate decision ADR 0001 calls for.

### Trust model and `ROUGHDRAFT_TOKEN`

The hosted Roughdraft is a write-capable peer for every connected CLI: a PUT to a session causes the CLI on the source machine to atomically rewrite the registered file on disk. Loopback-only deployments can rely on the OS for trust, but the moment the server binds to a non-loopback host (e.g. `ROUGHDRAFT_BIND_HOST=0.0.0.0` for Tailscale access), anyone reachable on that interface can register, read, or PUT.

The mitigation is a shared bearer token, `ROUGHDRAFT_TOKEN`:

- The server reads `ROUGHDRAFT_TOKEN` at startup. When set, all `/api/remote-document/*` endpoints require it on every bind (Authorization: Bearer header, or `?token=` query for the SSE endpoint specifically since `EventSource` can't set headers). On a non-loopback bind the token also gates every route that reads or writes a file on the host — see the 2026-09-06 clarification below.
- `createServer()` refuses to bind to any non-loopback host without a token, returning a clear actionable error before listening.
- The CLI sends the same token via `Authorization: Bearer` on its register POST and SSE GET, and surfaces a 401 explicitly (suggesting the user set `ROUGHDRAFT_TOKEN`).
- The viewerUrl printed by the CLI includes `?token=...` so the browser tab can authenticate. The frontend forwards the token as a header on fetches and as `?token=` on the EventSource.

Loopback-only deployments stay back-compatible: no token required, no behavior change. The token is the contract that lets non-loopback deployments be safe; the secure-by-default startup guard is the contract that lets us ship the feature without expecting users to read documentation before exposing the endpoints.

### Clarification (2026-09-06): the token gates every file-touching route on a non-loopback bind

Gating only `/api/remote-document/*` left the exposure the trust model above set out to close. The local-document routes take a caller-supplied `projectPath` bounded only by `ensureProjectPath`, so with a token configured and no `Authorization` header, `GET /api/files?projectPath=/private/etc&path=hosts` returned the file and `GET`/`PUT /api/markdown-file` read and rewrote any markdown file on the host. The audit in `.context/multi-document-audit.md` records the probe.

The token now gates every route that reads or writes a file the caller names: the `/api/pages` family, `/api/markdown-file` and its event stream, `/api/review-index`, the `/api/review-events` family, `/api/files` and `/api/assets`, alongside `/api/remote-document/*`.

Three decisions this fixes in place:

- **The bind is what switches the guard on, not a request header.** `createApp` takes the hosts the server was told to listen on and treats any host outside loopback as exposed. A header describing the client is caller-controlled and cannot carry a security decision.
- **An unguarded route on an exposed bind answers 401 rather than refusing the bind.** Refusing the bind would end remote-document mode, whose whole purpose is a non-loopback bind. `createServer()` still refuses to bind non-loopback with no token at all, so the two guards compose: no token means no bind, and a token means the token is required everywhere it matters.
- **The loopback default is untouched.** No token, no configuration, no behavior change, which is what keeps every existing local workflow working.

The consequence for the browser: it can send `?token=` but not a bearer header, and only the remote-document routes read the query token. Remote viewing therefore goes through remote-document mode, and a non-loopback server is not a way to browse the host's files from another machine's browser. `/api/status` stays open on every bind because the frontend must read it to discover the backend before it holds a token; it discloses the server's root, its process id and the absolute paths of open documents, which is worth revisiting separately.
