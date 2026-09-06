# Reflow
This paragraph wraps across
two source lines and keeps
its wrap points on save.

> A quoted paragraph that wraps
> across two lines.
>
> Second quoted paragraph.

```text
code line

# not a heading


still code
```

```text
a fence that carries a comment
{==keeps its own line breaks==}{>>Note<<}{id="c1" by="user" at="2026-01-01T00:00:00.000Z"}

and its blank lines
```

```md
a fence whose suggestion stays literal
{++inserted++}
{--deleted--}
{~~old~>new~~}

and keeps its blank lines
```

| Item | Status |
|------|--------|
| First | Ready |
| Second | Open |

A closing paragraph after the table,
also wrapped.
