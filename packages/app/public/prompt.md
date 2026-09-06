## Roughdraft

Use Roughdraft when the user wants to review or comment on a Markdown file.

The user may refer to Roughdraft as `rd` in natural language. Treat `rd` as shorthand for Roughdraft in user requests, but do not create or modify any shell alias, executable, symlink, or command named `rd`.

When the user asks for a plan, write the plan as a Markdown file on disk before asking them to review it.

When you write or modify a Markdown file and want the user to review or comment on it, open it with:

```bash
roughdraft open "/absolute/path/to/file.md" --label "plan-review"
```

Pass `--label "<short session name>"` on every `roughdraft open`. The document header shows the label as the session that opened the document, so the user can tell reviews apart when several agent sessions use Roughdraft at once. Use a short name for the work of this session, such as `plan-review` or `spec-edit`, never a machine username or anything else that identifies a person.

Roughdraft is currently a single-file Markdown viewer/editor. Open one `.md` file at a time.

If Roughdraft is not running, `roughdraft open` will start it automatically.

After `roughdraft open` opens the document, leave the command running. Do not interrupt, kill, background, detach, or treat the waiting process as cleanup. The wait is intentional: Roughdraft will exit the command after the user clicks Done Reviewing, and that exit is your signal to resume.

After the user finishes reviewing in Roughdraft, read the Markdown file from disk and respond to any CriticMarkup comments or suggested changes. If the user left questions or comments in the document, reply inline in the Markdown file using Roughdraft-flavored CriticMarkup, save it, and open the file in Roughdraft again so the user can continue reviewing.

Use Roughdraft-flavored CriticMarkup when reading or writing inline review feedback in Markdown. The base markers are:

Comment: `{>>comment<<}`
Insertion: `{++new text++}`
Deletion: `{--old text--}`
Substitution: `{~~old~>new~~}`
Highlight: `{==text==}`

Write a backslash before any of those delimiters when the text itself contains one, so it stays literal instead of closing or reopening the marker around it: `{>>Write \{>>a note\<<} to reply.<<}`. This covers `{==`, `==}`, `{>>`, `<<}`, `{++`, `++}`, `{--`, `--}`, `{~~`, `~~}`, `~>` and the backslash itself, which you write as `\\`. Roughdraft strips the backslashes when it reads the text back, so the reviewer sees exactly what you typed.

When you add a new comment or suggested change, write its metadata as an inline attribute block immediately after the marker, such as `{>>Comment text<<}{id="c1" by="AI" at="2026-04-28T12:00:00.000Z"}`. Generate a stable document-local id (`c1`, `c2`, etc. for comments; `s1`, `s2`, etc. for suggestions), set `by` to your agent or author label, and set `at` to the current ISO timestamp. Never reuse an id the document has already used: allocate above every id present and above `counters.comments` or `counters.suggestions` in the final YAML endmatter when that map exists, and raise the counter to the id you allocated. When you remove threads or suggestions, you must record the counter: set `counters.comments` or `counters.suggestions` in the final YAML endmatter to the highest id number removed whenever it exceeds every id of that family still present, creating the `counters` map if the document has none. Without that record the next comment the reviewer adds would get a removed id. Two live items belong in endmatter and nothing else: the `counters` map, and the reviewer's overall comment, which the server writes under `comments:` when the reviewer clicks Done Reviewing with a message. Recognise it by its shape: an entry with a `body`, `by: user`, no `re`, and no matching `{#id}` anywhere in the document. Act on it like any other feedback, then clear it by adding `status: resolved` to the entry or removing the entry; until it is cleared the document counts as having an open item.

Replies are inline. Write each reply directly after the comment it answers, in the same attribute form, with `re` pointing at the parent id and a reply id (`r1`, `r2`, etc.) the document has not used:

`{>>reply text<<}{id="rN" by="AI" at="<ISO timestamp>" re="cN"}`

Older documents may keep review metadata in final YAML endmatter behind compact references such as `{#c1}`, with replies stored as `comments.<id>` entries that carry `body` and `re`. That is a legacy format: read it and preserve it on items you are not rewriting, but never write new comments, replies, or suggestions in it. Roughdraft shows an endmatter reply the document already carries, in the thread of the comment its `re` names, so treat it as live feedback like any other reply.

Anchored comments look like `{==selected text==}{>>Comment text<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}`. When nothing in the document is a natural anchor for a comment, add a sentence written only to carry it and mark the comment with `anchor="disposable"`, such as `{==Placeholder for the pricing decision.==}{>>Which tier ships first?<<}{id="c1" by="AI" at="2026-04-28T12:00:00.000Z" anchor="disposable"}`; when the reviewer clears that thread, Roughdraft removes the sentence with it. Without the flag the anchor text stays after its thread is cleared, so never put the flag on a comment anchored to real document text. Suggested changes look like `{++new text++}{id="s1" by="AI" at="2026-04-28T12:10:00.000Z"}` or `{~~old text~>new text~~}{id="s2" by="AI" at="2026-04-28T12:11:00.000Z"}`. A reply follows its parent on the same line.

Example:

```markdown
{==selected text==}{>>Comment text<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}{>>I can make that edit.<<}{id="r1" by="AI" at="2026-04-28T12:05:00.000Z" re="c1"}
{++new text++}{id="s1" by="AI" at="2026-04-28T12:10:00.000Z"}
```

Use `roughdraft help` and `roughdraft help criticmarkup` for local command and syntax details.
