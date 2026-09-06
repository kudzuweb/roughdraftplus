# Roughdraft Flavored Markdown 0.2

Status: Draft

Roughdraft Flavored Markdown is regular Markdown plus a portable review layer based on CriticMarkup. Its purpose is to let people and coding agents exchange comments, threaded replies, and pending changes inside the Markdown file itself.

The key words "MUST", "MUST NOT", "SHOULD", "SHOULD NOT", and "MAY" in this document are to be interpreted as described in RFC 2119.

## Scope

This specification defines the review markup that Roughdraft reads and writes. It does not define a replacement for Markdown, a hosted document format, a sync protocol, or a project database.

A conforming document is a Markdown document that may contain Roughdraft review spans. Markdown parsing SHOULD follow CommonMark with GitHub Flavored Markdown extensions. Strikethrough is the one deliberate departure: a doubled tilde (`~~struck~~`) renders as strikethrough and a single tilde (`~struck~`) does not, because GFM's single-tilde form turns ordinary prose such as `~57% (~100h)` into strikethrough and saves it back as `~~57% (~~100h)`. Implementations MAY preserve YAML frontmatter as document metadata. Roughdraft review state lives in the same Markdown file as inline review anchors, each carrying its metadata in an inline attribute block. A final YAML endmatter block holds only the [id counters](#id-counters); documents written by older implementations may also keep review metadata there, and the [Legacy Endmatter Metadata](#legacy-endmatter-metadata) section says how readers treat it.

## Canonical Markers

Roughdraft uses these CriticMarkup-compatible markers:

```markdown
{>>comment<<}
{++inserted text++}
{--deleted text--}
{~~old text~>new text~~}
{==highlighted text==}
```

An implementation MUST treat the opening and closing marker pairs as review delimiters outside inline code and fenced code blocks.

Implementations MUST treat review markers inside inline code spans and fenced code blocks as literal example text. They MUST NOT create comments, suggestions, or highlights from those code contexts.

## Comments

A comment is written as:

```ebnf
comment = "{>>" comment-text "<<}" [ metadata ]
```

Comment text is plain inline Markdown content. Comment text MUST NOT contain the literal closing delimiter `<<}` unless the implementation defines an escaping extension. Writers that do not implement escaping MUST reject comment or reply text containing raw CriticMarkup close delimiters instead of emitting ambiguous review markup.

A comment MAY appear by itself when the feedback applies to the surrounding paragraph or document:

```markdown
Add one concrete launch example here.{>>This should come from the customer story.<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}
```

### Document-Level Comments

A document-level comment applies to the whole document and has no position in the body. It is the one kind of comment written to final YAML endmatter: an entry under `comments:` with a `body`, `by`, and `at`, no `re`, and no matching reference anywhere in the body text. Roughdraft's server writes one for the reviewer's overall comment when the reviewer clicks Done Reviewing with a message:

```markdown
Body text.

---
comments:
  c1:
    body: Please prioritize the CLI contract.
    by: user
    at: "2026-04-28T12:00:00.000Z"
```

A document-level comment counts as unresolved until it carries `status: resolved` or is removed. Readers MUST report it as a review item; writers MUST NOT add `re` to it or move it into the body. Writing one MUST NOT move the rest of the document's metadata into endmatter; see [Legacy Endmatter Metadata](#legacy-endmatter-metadata).

## Anchored Comments

An anchored comment is a highlight immediately followed by one or more comment blocks:

```ebnf
anchored-comment = highlight 1*comment
highlight        = "{==" anchor-text "==}"
```

Example:

```markdown
Please revisit {==this sentence==}{>>Needs a source.<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}.
```

The highlighted text is the visible anchor. Implementations SHOULD attach all immediately following comment blocks to the same anchor until another token interrupts the sequence.

A standalone highlight is valid CriticMarkup. Roughdraft 0.1 reserves it as review syntax, but standalone highlights are not required to produce a review-thread item unless an implementation explicitly supports highlight-only annotations.

### Disposable Anchors

A comment must anchor on some text, so when nothing in the document is a natural anchor a writer may add a sentence written only to carry the thread. The comment marks that sentence as filler with `anchor="disposable"`:

```markdown
{==Placeholder for the pricing decision.==}{>>Which tier ships first?<<}{id="c1" by="AI" at="2026-04-28T12:00:00.000Z" anchor="disposable"}
```

When a comment carrying `anchor="disposable"` is removed and no comment remains on its anchor, an implementation MUST remove the anchor text with it. This applies to the whole set of comments removed together: clearing a flagged thread removes its replies and the anchor in one action. While any comment still references the anchor, the anchor text stays. Removing a comment without the flag leaves its anchor text in place as plain prose. A writer SHOULD put the flag on the root comment of the thread, and MUST NOT put it on a comment whose anchor is real document text.

The flag is read only from a comment's inline attribute block. A comment written in the legacy compact reference form, `{#c1}` with its metadata in the YAML endmatter, cannot carry it: an endmatter `anchor` entry is ignored and the anchor text stays.

## Suggestions

Suggestions represent pending edits. Implementations MUST NOT silently collapse suggestions into normal prose while reading or writing Roughdraft Flavored Markdown.

### Insertion

```ebnf
addition = "{++" new-text "++}" [ metadata ] *comment
```

```markdown
Add {++one concrete example++}{id="s1" by="AI" at="2026-04-28T12:05:00.000Z"}.
```

### Deletion

```ebnf
deletion = "{--" old-text "--}" [ metadata ] *comment
```

```markdown
Remove {--vague phrasing--}{id="s2" by="user" at="2026-04-28T12:06:00.000Z"}.
```

### Substitution

```ebnf
substitution = "{~~" old-text "~>" new-text "~~}" [ metadata ] *comment
```

```markdown
Use {~~rough~>specific~~}{id="s3" by="AI" at="2026-04-28T12:07:00.000Z"} wording.
```

Trailing comment blocks after a suggestion attach discussion to that suggestion; each carries `re` pointing at the suggestion id:

```markdown
Add {++one concrete example++}{id="s1" by="AI" at="2026-04-28T12:05:00.000Z"}{>>Use the launch story.<<}{id="r1" by="user" at="2026-04-28T12:08:00.000Z" re="s1"}.
```

## Metadata

Every comment, reply, and suggestion carries its metadata in an inline attribute block written immediately after the marker it describes:

```ebnf
metadata  = "{" 1*attribute "}"
attribute = name "=" quoted-value
name      = ALPHA *( ALPHA / DIGIT / "_" / "-" )
```

Attribute values are double-quoted strings. Inside a quoted value, `\"` represents a literal quote and `\\` represents a literal backslash.

```markdown
Please revisit {==this sentence==}{>>Needs a source.<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}.
```

Known metadata attributes:

| Attribute | Applies to | Required when writing | Meaning |
| --- | --- | --- | --- |
| `id` | Comments and suggestions | Yes | Stable document-local identifier. |
| `by` | Comments and suggestions | Yes | Author or agent label. `AI` identifies an agent author. |
| `at` | Comments and suggestions | Yes | ISO 8601 timestamp. |
| `re` | Comments | No | Parent comment or suggestion id for threaded replies. |
| `anchor` | Comments | No | `disposable` marks the anchor text as filler written only to carry the thread, removed with the last comment on it. See [Disposable Anchors](#disposable-anchors). |
| `status` | Comments and suggestions | No | Review state. Roughdraft currently writes `resolved` when an item has been addressed. |
| `resolved` | Comments and suggestions | No | Optional short resolution summary for an item whose `status` is `resolved`. |

Implementations SHOULD generate simple document-local ids:

```ebnf
id = ALPHA *( ALPHA / DIGIT / "_" / "-" )
```

Roughdraft uses `c1`, `c2`, and so on for comments and `s1`, `s2`, and so on for suggestions. An agent SHOULD use `r1`, `r2`, and so on for its replies; Roughdraft's own reply writers, the review rail and the `roughdraft_reply_to_comment` MCP tool, allocate `c<n>` ids for replies, so a reply is identified by its `re` attribute and not by its id. A writer MUST NOT give a new comment, reply, or suggestion an id the document has already used, even after every item that carried it has been removed; the [Id Counters](#id-counters) section defines how that is recorded. Implementations MUST preserve unknown valid attributes when possible, but they MUST NOT require unknown metadata for correct review rendering.

### Legacy Endmatter Metadata

Earlier versions of this format placed metadata in final YAML endmatter behind a compact inline reference:

```ebnf
reference = "{#" id "}"
```

```markdown
Please revisit {==this sentence==}{>>Needs a source.<<}{#c1}.

---
comments:
  c1:
    by: user
    at: "2026-04-28T12:00:00.000Z"
  c2:
    body: I can add one from the intro.
    by: AI
    at: "2026-04-28T12:05:00.000Z"
    re: c1
suggestions:
  s1:
    by: AI
    at: "2026-04-28T12:05:00.000Z"
```

In that form, root comment bodies and suggestion text stay inline while their `by` and `at` live under `comments:` or `suggestions:`, and a reply lives entirely in endmatter as an entry with `body` and `re`. An endmatter reply has no marker of its own in the body, so a reader MUST attach it to the item its `re` names and MUST NOT require an inline marker to display it. Roughdraft shows such a reply in the thread of the nearest ancestor that does have a marker.

Readers MUST accept this form and MUST preserve its `comments:` and `suggestions:` maps on items they are not rewriting. Writers MUST NOT emit new body comments, replies, or suggestions in it. The only endmatter entries a writer emits are the `counters` map ([Id Counters](#id-counters)) and a [document-level comment](#document-level-comments); neither is legacy. For compatibility, readers MAY also accept legacy comment metadata of the form `{@id:c1; by:AI; at:2026-04-28T12:00:00.000Z@}`.

A document is in this form when its endmatter carries a `suggestions:` key, or a `comments:` key that is either empty or holds at least one entry without a `body`. An entry without a `body` belongs to an item whose text sits inline behind a compact reference. An entry carrying a `body` holds the text itself and has no compact reference in the body, so on its own neither a [document-level comment](#document-level-comments) nor an endmatter reply puts a document in this form. A writer MUST NOT rewrite a document's inline attribute blocks into compact references because its endmatter carries one of those entries, and MUST keep such an entry when saving a document that writes its metadata inline.

An empty map counts, and a writer MUST keep it rather than dropping the key. Removing the last comment or suggestion from a document in this form leaves `comments: {}` or `suggestions: {}` behind, and that map is then the only record of which form the document uses. Reading an empty map as the inline form would migrate the document silently on the next item it receives, writing that item's metadata inline into a document whose every earlier item used a compact reference.

## Id Counters

Agents track threads across review rounds by id, so an id MUST stay unique for the life of a document. The ids still present cannot show which ids have been removed, so the endmatter records the highest number ever allocated for each id family in a `counters` map. This map and a [document-level comment](#document-level-comments) are the only review metadata a writer places in endmatter:

```markdown
Body text.

---
counters:
  comments: 9
  suggestions: 2
```

- `counters.comments` is the highest `n` ever allocated as a `c<n>` comment id, and `counters.suggestions` is the highest `n` ever allocated as an `s<n>` suggestion id. Each value is a non-negative integer, and a missing family counts as `0`. Ids that do not follow the `c<n>` or `s<n>` form are not tracked, so a writer allocating an `r<n>` reply id MUST allocate above every `r<n>` present in the document.
- The effective counter for a family is the greater of the recorded value and the highest id of that family present anywhere in the document, including legacy `comments:` and `suggestions:` entries. Writers MUST allocate new ids above the effective counter.
- Writers MUST record a family's counter once it exceeds the highest id of that family still present, and MUST NOT lower or drop a recorded counter afterwards. A writer MAY leave a counter unrecorded while every allocated id is still present, since the ids imply it; that keeps a save of an untouched document byte-identical.
- Readers MUST treat a final YAML block containing a valid `counters` map as review endmatter even when it has no `comments:` or `suggestions:` entries and the body has no compact references, so a document whose review items have all been removed keeps its counters.

## Threads

Threading is represented by `re`. A reply is written directly after the comment or suggestion it answers, and its `re` names that parent's id:

```markdown
Review {==this sentence==}{>>Needs a source.<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}{>>I can add one from the intro.<<}{id="r1" by="AI" at="2026-04-28T12:05:00.000Z" re="c1"}.
```

A reply to a reply points `re` at the reply's id and follows it in the same run of comment blocks. A reply whose `re` points to a missing id SHOULD be treated as a top-level comment. A comment MUST NOT be its own parent.

## Parsing And Round Trips

Implementations SHOULD parse Roughdraft review markers as inline review annotations without rewriting unrelated Markdown.

Round trips SHOULD preserve:

- YAML frontmatter delimiters and content.
- Local links and image paths.
- Tables and task lists, including the table delimiter row as written.
- Inline code and fenced code blocks, including blank lines inside a fence.
- Soft line breaks inside paragraphs, blockquotes, and list items.
- Raw review marker text inside code contexts.
- Metadata values, including escaped quotes and backslashes.
- The `counters` map in YAML endmatter.
- Legacy `comments:` and `suggestions:` maps in YAML endmatter, for documents that carry them.

When importing a valid comment or suggestion without metadata, an implementation MAY synthesize missing `id`, `by`, and `at` values on write.

## Review Interchange JSON

The Markdown file is the normative storage format. For APIs, tests, and integrations, implementations MAY expose a review index JSON document that follows [`roughdraft-flavored-markdown.schema.json`](./roughdraft-flavored-markdown.schema.json).

The review index intentionally does not replace a Markdown AST. It indexes Roughdraft review annotations while leaving block parsing to the Markdown implementation.

Example:

```json
{
  "format": "roughdraft-flavored-markdown",
  "version": "0.1",
  "source": {
    "markdown": "Please revisit {==this sentence==}{>>Needs a source.<<}{id=\"c1\" by=\"user\" at=\"2026-04-28T12:00:00.000Z\"}.\\n"
  },
  "comments": [
    {
      "id": "c1",
      "body": "Needs a source.",
      "by": "user",
      "at": "2026-04-28T12:00:00.000Z",
      "anchor": {
        "text": "this sentence"
      }
    }
  ],
  "suggestions": []
}
```

Conformance fixtures live in [`fixtures/`](./fixtures/). A parser that claims Roughdraft Flavored Markdown 0.1 support SHOULD pass those examples or document any intentional differences.
