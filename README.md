# Roughdraft
A local-first markdown editor and viewer for working with AI.

This is `roughdraftplus`, a maintained fork of [Lex-Inc/roughdraft](https://github.com/Lex-Inc/roughdraft). Install from this repository, not from the npm registry — the published `roughdraft` package is the unmaintained upstream copy and ships with known bugs this fork fixes.

{==Open one markdown file on your machine. Review it, comment on it, and suggest edits.==}{>>What does this mean?<<}{id="c3" by="user" at="2026-04-30T20:18:51.163Z"}{>>It means Roughdraft works with a normal local Markdown file: you open one .md file from your computer, read it in the app, leave inline comments, and propose edits that are saved back into the Markdown using CriticMarkup.<<}{id="c4" by="AI" at="2026-04-30T20:19:39.000Z" re="c3"}{>>cjool<<}{id="c5" by="user" at="2026-05-07T20:38:25.621Z" re="c4"}

Paste this into your coding agent:

```text
Install Roughdraft from the roughdraftplus fork: clone https://github.com/kudzuweb/roughdraftplus, run `pnpm install && pnpm build` in the clone, then `npm i -g "$(npm pack --silent)"`. Do not run `npm i -g roughdraft` — the registry package is the unmaintained upstream. Then read packages/app/public/setup.md in the clone and set yourself up to use it.
```

Or install and open a file yourself:

```bash
git clone https://github.com/kudzuweb/roughdraftplus.git
cd roughdraftplus
pnpm install && pnpm build
npm i -g "$(npm pack --silent)"
roughdraft open /absolute/path/to/file.md
```
## What is this?
Roughdraft is a local-first markdown editor and viewer that runs on your computer.

Its job is to make markdown files easy to open, read, edit, review, and discuss with your AI agent without moving them into a proprietary format or a hosted app.

Roughdraft opens a single markdown file directly for CriticMarkup comments and suggested changes.
## How it works
- **Local-first markdown editor** — Open normal `.md` files from your machine and edit them directly
  
- **Works with your AI agent** — Tell your local agent to open a file in Roughdraft on your computer, then keep collaborating from there
  
- **Comments & suggested changes** — Use CriticMarkup for inline feedback, revisions, and review conversations
  
- **Markdown files on disk** — Everything stays as regular markdown files you can also edit in VS Code, Vim, Cursor, or anywhere else
  
- **No cloud, no account, no telemetry** — Runs entirely on your machine
  
## Quick start
Install Roughdraft from this repository (see above) and start the local server:

```bash
roughdraft start
```

`roughdraft start` runs Roughdraft in the background, reuses or chooses a free localhost port, writes server state to `~/.roughdraft/server.json`, prints the active URL, and exits while the server keeps running.

Open a specific markdown file:

```bash
roughdraft open ./path/to/my-essay/draft.md
```

For scripts and agents that need a URL without launching a browser:

```bash
roughdraft open ./path/to/my-essay/draft.md --print-url
roughdraft status --json
```

Check or stop the background server:

```bash
roughdraft status
roughdraft stop
```

`roughdraft status` also names each document that is open in a tab and the session label it was opened with (`Session: no label given` when `open` ran without `--label`). `roughdraft status <path>` reports that document's open threads (every comment, reply and suggestion not marked resolved, with their IDs) and the last time the server saved it while a tab had it open, or says the path is not open. That open-thread count is the same one the review loop clears, so `Open threads: 0` and a `threads-cleared` Done Reviewing always agree. When several tabs hold the same path, `Session` and `Opened` name the newest tab and `Also open in` lists the rest. Both forms carry the same facts under `documents` and `document` with `--json`.

`roughdraft open` will reuse the running server and auto-start it if needed. You can also use `roughdraft ./path/to/file.md` as a shortcut when the input clearly looks like a path.

Roughdraft does not edit `~/CLAUDE.md`, `~/AGENTS.md`, or other user-level agent files. The setup prompt asks your agent to update its own guidance.

If the local server is already running, you can also open a file directly by URL:

```text
http://localhost:7373/?path=/absolute/path/to/my-essay/draft.md
```

That makes an agent-friendly workflow possible:

1. Your AI writes or updates markdown files on disk.
  
2. You tell it to open a markdown file in Roughdraft.
  
3. Roughdraft opens locally on your machine.
  
4. You read, edit, leave comments, and suggest changes.
  
5. You click **Done Reviewing** in Roughdraft, and the AI can respond to your comments or revise the document.
  

Agents can watch that handoff directly:

```bash
roughdraft open ./path/to/my-essay/draft.md --json
```

`roughdraft open` starts or reuses the local server, opens the document, registers a fresh watcher, blocks until the next `review.completed` event, then prints event JSON with the document path, file version, feedback counts, and any optional `overallComment` you submit at handoff. By default there is no watch timeout; pass `--timeout <seconds>` when you want one. If the server stops while `open` is waiting (`roughdraft stop`, an upgrade), the wait survives a restart on the same port: the command reconnects and keeps waiting, and gives up with a clear message after `ROUGHDRAFT_WATCH_RECONNECT_SECONDS` (default 60). Use `--no-watch` when you only want to open the document and return immediately. If no watcher is active when you click **Done Reviewing**, Roughdraft shows a fallback prompt you can copy into the agent. Overall comments are written to Markdown as document-level YAML endmatter comments before the handoff event is emitted, so Markdown remains the durable source of truth.

Experimental MCP clients can start the stdio server with:

```bash
roughdraft mcp
```

The MCP server exposes tools to read the review index, list pending feedback, watch review events, append replies, and mark items resolved. CriticMarkup in the Markdown file remains the durable source of truth.
## Local development
```bash
./scripts/setup.sh
./scripts/run.sh
```

`./scripts/setup.sh` installs workspace dependencies and builds the app and server. `./scripts/run.sh` serves the built app at `http://localhost:7373`.

The two scripts coordinate through a lock file, so it's safe to start `./scripts/run.sh` while `./scripts/setup.sh` is still in progress. `run` will wait for setup to finish, or trigger setup itself if nothing has been built yet.

If you prefer package scripts, the same commands are available as `pnpm setup` and `pnpm start`.

Running `pnpm setup` also installs a per-worktree dev CLI wrapper into `~/.local/bin` by default, using the current worktree directory name. For example, this checkout might install `roughdraft-dev-lyon-v2`, which points at this worktree's local code while leaving the fork-built global `roughdraft` command untouched.

Each dev wrapper keeps its own server state under `~/.roughdraft/dev/<wrapper-name>` by default, so opening a file from one worktree will not accidentally reuse a backend started from another worktree. `roughdraft-dev-<worktree> open ...` can start its own background server as needed; you do not need to run `pnpm dev` first just to open files in Roughdraft.

You can refresh that wrapper manually with:

```bash
pnpm dev:install-cli
pnpm dev:install-cli --name api-redesign
```

Quality checks:

```bash
pnpm lint
pnpm test
pnpm check
pnpm test:packaging
```

`pnpm check` is the same command the pull request workflow runs before merge.

`pnpm test:packaging` runs separately because it needs the build `pnpm check` produces, and because it reaches the npm registry to install the packed tarball. It packs the repo, installs the tarball into a throwaway prefix outside the worktree, and runs `roughdraft --help` and `roughdraft status --json` from that install. Run it after `pnpm build` whenever you change the root `package.json` — a runtime dependency declared only under `packages/*/package.json` works in the workspace and is missing from a real install, because npm does not install dependencies of `file:` sub-packages. CI runs it on every pull request.
## Publishing
This fork does not publish to npm. The upstream `Publish to npm` workflow is still in the repository but is gated to `github.repository == 'Lex-Inc/roughdraft'`, so it never runs here. Installs come from a local clone via `npm pack` (see the install instructions above), which is the artifact `pnpm test:packaging` exercises.
## Files on disk
```
my-essay/
  draft-1.md            # A normal markdown file on disk
  draft-2.md            # Another file you can open separately
```

Roughdraft reads and writes the markdown file directly.
## Network exposure
By default the server binds loopback only (`127.0.0.1` and `::1`), so nothing else on the network can open a connection to it directly, and no token or extra configuration is needed.

`ROUGHDRAFT_BIND_HOST` binds other addresses, which is how a document reaches a browser on another machine over something like Tailscale. Any address outside loopback makes the server reachable from another machine, so a non-loopback deployment must set both variables:

```text
ROUGHDRAFT_BIND_HOST
  Comma-separated hosts to listen on. Defaults to 127.0.0.1,::1.

ROUGHDRAFT_TOKEN
  Shared secret. Required whenever ROUGHDRAFT_BIND_HOST names a
  non-loopback address; the server refuses to start without it.
```

Every route that reads or writes a file on the host then requires the token as `Authorization: Bearer <ROUGHDRAFT_TOKEN>` and answers `401` without it. That covers the local-document routes as well as `/api/remote-document`, so an exposed server serves no files to an anonymous caller. Give the CLI on the connecting machine the same `ROUGHDRAFT_TOKEN`.

The token protects the transport, not the paths themselves: any caller holding it can name any `projectPath` on the host. Give it only to people you would give a shell.

The browser has no way to send a bearer header on the local-document routes, so remote viewing goes through remote-document mode, whose viewer URL carries the token in the query string. A non-loopback server is not a way to browse the host's files from another machine's browser.

### A reverse proxy switches the guard off

The guard reads the addresses the server was told to bind and cannot see anything in front of it. Put nginx, Caddy, a Cloudflare tunnel or `tailscale serve` in front of a loopback-bound Roughdraft and every request arrives from loopback, so the server stays in its unguarded default while the proxy hands the file routes to whoever can reach the proxy. Nothing the server can check would tell the two apart, because the proxy's own connection really is local.

If you front Roughdraft with a proxy, set `ROUGHDRAFT_TOKEN` and bind a non-loopback address so the guard is on, or make the proxy itself require authentication before it forwards anything.
## Agent setup
If you want your local agent to remember the Roughdraft workflow, ask it to read the setup prompt:

```text
Install Roughdraft from the roughdraftplus fork: clone https://github.com/kudzuweb/roughdraftplus, run `pnpm install && pnpm build` in the clone, then `npm i -g "$(npm pack --silent)"`. Do not run `npm i -g roughdraft` — the registry package is the unmaintained upstream. Then read packages/app/public/setup.md in the clone and set yourself up to use it.
```

Use `roughdraft help`, `roughdraft help agent`, or `roughdraft help criticmarkup` if you need a local refresher.
## CLI reference
```text
roughdraft [flags] <command> [args]
roughdraft <path>
```

Commands:

```text
open <path>        Open one Markdown file and wait for Done Reviewing
start              Start or reuse the background server
status [<path>]    Show server status, or a document's open threads
stop               Stop the managed background server
watch <path>       Wait for a Done Reviewing event
mcp                Start the experimental stdio MCP server
doctor [path]      Diagnose setup or validate Markdown
help agent         Print the agent setup prompt
help criticmarkup  Show CriticMarkup examples
agent-setup        Print the agent setup prompt
criticmarkup       Show CriticMarkup examples
```

Global flags:

```text
-h, --help         Show help
--version          Print version
--json             Print JSON for supported commands
--no-color         Disable color
```

Useful command flags:

```text
roughdraft open <path> --no-open
roughdraft open <path> --print-url
roughdraft open <path> --json
roughdraft open <path> --no-watch
roughdraft open <path> --label "<session name>"
roughdraft start --port <port>
roughdraft status --json
roughdraft status ./draft.md
roughdraft status ./draft.md --json
roughdraft stop --all
roughdraft watch ./draft.md --json
roughdraft doctor --json
roughdraft doctor ./draft.md
roughdraft doctor ./draft.md --json
```

Usage errors return exit code `2`. Runtime failures return exit code `1`. `roughdraft status --json` returns exit code `0` even when the JSON says `"running": false`, and `roughdraft status <path> --json` returns `0` even when `document.open` is `false`; without `--json`, a path that is not open exits `1` like a server that is not running. When a document is open but its review index cannot be read — the file was renamed or deleted, or the server stopped answering — both forms exit `1`, and `--json` still prints its usual object with `document.openThreads` set to `null` and `document.threadsError` saying why.

Supported environment variables:

```text
ROUGHDRAFT_PORT
  Preferred server port.

PORT
  Legacy preferred server port. Used only when ROUGHDRAFT_PORT is unset.

ROUGHDRAFT_NO_OPEN=1
  Disable browser/app opening.

ROUGHDRAFT_STATE_FILE
  Exact path to the server state JSON file.

ROUGHDRAFT_STATE_DIR
  Directory containing server.json.

ROUGHDRAFT_BIND_HOST
  Comma-separated hosts to listen on. Defaults to 127.0.0.1,::1.
  See "Network exposure" above before setting it.

ROUGHDRAFT_TOKEN
  Bearer token sent on requests to a server bound to a non-loopback
  address. Required on the server whenever ROUGHDRAFT_BIND_HOST names
  one.
```

Development-only environment variables:

```text
ROUGHDRAFT_DEV_FRONTEND_STATE_FILE
ROUGHDRAFT_DEV_BIN_DIR
ROUGHDRAFT_DEV_STATE_BASE_DIR
ROUGHDRAFT_DEV_WRAPPER_NAME
ROUGHDRAFT_DEV_WRAPPER_PATH
ROUGHDRAFT_DEV_WRAPPER_REPO_ROOT
```
## Roughdraft-flavored CriticMarkup
Roughdraft uses [CriticMarkup](https://criticmarkup.com) as the readable review layer inside normal Markdown files. It supports the standard markers for comments, highlights, insertions, deletions, and substitutions:

The canonical Roughdraft Flavored Markdown spec is [docs/spec/roughdraft-flavored-markdown.md](docs/spec/roughdraft-flavored-markdown.md) in this repository, and the review-index JSON Schema is [docs/spec/roughdraft-flavored-markdown.schema.json](docs/spec/roughdraft-flavored-markdown.schema.json). The copies hosted at roughdraft.md are upstream's and still prescribe endmatter replies, which this fork reads and displays but never writes.

```markdown
This is {--deleted--} text.
This is {++inserted++} text.
This is {~~old~>new~~} substituted text.
This is {>>a comment<<} in the margin.
This is {==highlighted==} text.
```

Roughdraft extends those markers with an inline attribute block written immediately after each one, so review state round-trips through the file next to the text it describes:

```markdown
Please revisit {==this sentence==}{>>Needs a source<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}.
```

Supported attributes:

- `id` is the stable document-local id of the comment, reply, or suggested change.
  
- `by` records the reviewer or agent that created it.
  
- `at` records an ISO timestamp.
  
- `re` links a reply to another comment or suggestion id.
  

Replies are inline: each one sits directly after the comment it answers, with `re` pointing at the parent id.

```markdown
Please revisit {==this sentence==}{>>Needs a source<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}{>>I can add one from the intro.<<}{id="r1" by="AI" at="2026-04-28T12:05:00.000Z" re="c1"}.
```

Suggested changes carry ids the same way, and a comment after a suggestion discusses it:

```markdown
Add {++one concrete example++}{id="s1" by="AI" at="2026-04-28T12:10:00.000Z"}{>>Use the launch story.<<}{id="r2" by="user" at="2026-04-28T12:12:00.000Z" re="s1"}.
Remove {--vague phrasing--}{id="s2" by="user" at="2026-04-28T12:13:00.000Z"}.
Use {~~rough~>specific~~}{id="s3" by="AI" at="2026-04-28T12:14:00.000Z"} wording.
```

Ids are never reused within a document. Once a comment or suggestion has been removed, the endmatter records the highest number allocated for that family in a `counters` map, whether the review markup itself is inline or endmatter-backed, and new ids are allocated above it. Roughdraft writes two things to endmatter and nothing else: this map, and the reviewer's overall Done Reviewing comment as a document-level `comments:` entry with a `body` and no `re` (see the `roughdraft open` section above), which the agent acts on and then marks `status: resolved` or removes:

```markdown
---
counters:
  comments: 9
  suggestions: 2
```

Older documents may carry the upstream format instead: compact references such as `{#c1}` with `comments:` and `suggestions:` maps in final YAML endmatter, and replies stored there as entries with `body` and `re`. Roughdraft reads that format, displays the replies it carries alongside the comments they answer, and preserves it on items it is not rewriting, but never writes new review items in it. Legacy `{@id:c1; by:user; at:...@}` blocks are also still accepted.

CriticMarkup inside inline code and fenced code blocks is treated as literal example text, not live review feedback:

````markdown
Inline code stays literal: `{==not a comment==}`.

```text
{++not a suggestion++}
```
````

This matters because the main workflow is often:

- The AI writes a doc
  
- The user opens it in Roughdraft
  
- The user leaves comments and suggested changes
  
- The AI reads those comments and responds in the same markdown file
  
## Try the demo
Don't want to install anything? Try the [live demo](https://roughdraft.md) — it runs entirely in your browser using local storage.
## License
MIT

* * *

Built by [Nathan Baschez](https://twitter.com/nbashaw)
