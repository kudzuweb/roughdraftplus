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

The same reasoning now extends to local documents. The server keeps, in memory only, a per-tab open-document record in its open-request registry (`openRequestClients` in `packages/server/src/index.ts`): for each connected tab, the absolute path it has open and the session label the CLI passed with `roughdraft open --label`. The record is filled when a tab subscribes to `/api/open-requests` and updated when an open request is delivered to that tab; it is dropped when the tab disconnects and is gone after a server restart, exactly like a remote-document session. Nothing about it reaches the state file, so the boundary above holds: the state file remains a process record, not a document model. This record is the single-file-compatible seed that `.context/multi-document-audit.md` describes; a multi-document workspace beyond it still needs the separate decision ADR 0001 calls for.

### Trust model and `ROUGHDRAFT_TOKEN`

The hosted Roughdraft is a write-capable peer for every connected CLI: a PUT to a session causes the CLI on the source machine to atomically rewrite the registered file on disk. Loopback-only deployments can rely on the OS for trust, but the moment the server binds to a non-loopback host (e.g. `ROUGHDRAFT_BIND_HOST=0.0.0.0` for Tailscale access), anyone reachable on that interface can register, read, or PUT.

The mitigation is a shared bearer token, `ROUGHDRAFT_TOKEN`:

- The server reads `ROUGHDRAFT_TOKEN` at startup. When set, all `/api/remote-document/*` endpoints require it (Authorization: Bearer header, or `?token=` query for the SSE endpoint specifically since `EventSource` can't set headers).
- `createServer()` refuses to bind to any non-loopback host without a token, returning a clear actionable error before listening.
- The CLI sends the same token via `Authorization: Bearer` on its register POST and SSE GET, and surfaces a 401 explicitly (suggesting the user set `ROUGHDRAFT_TOKEN`).
- The viewerUrl printed by the CLI includes `?token=...` so the browser tab can authenticate. The frontend forwards the token as a header on fetches and as `?token=` on the EventSource.

Loopback-only deployments stay back-compatible: no token required, no behavior change. The token is the contract that lets non-loopback deployments be safe; the secure-by-default startup guard is the contract that lets us ship the feature without expecting users to read documentation before exposing the endpoints.
