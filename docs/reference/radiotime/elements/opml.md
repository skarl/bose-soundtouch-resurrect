# opml

The root container for every OPML response — always wraps exactly
one `<head>` and one `<body>`.

## `<opml>` element

The opml element is the root container for all OPML responses.

### Attributes

| Attribute | Description |
| --- | --- |
| version | Indicates the OPML version compatibility – currently set to 1.0 |

### Child Elements

Will contain exactly one head element and one body element.

## See also

- [elements/head.md](head.md) — the metadata envelope (status, title, fault codes)
- [elements/body.md](body.md) — the payload container
- [elements/outline.md](outline.md) — the elements found inside `<body>`
