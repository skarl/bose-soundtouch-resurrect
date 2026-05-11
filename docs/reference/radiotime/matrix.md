# API matrix

Capability comparison between RadioTime's three public APIs (OPML,
OpenMedia, Widgets) and guidance on which to pick.

> **Note on naming.** Despite the filename, this page is an
> *API-vs-API* feature matrix, not a method × parameter matrix. The
> OPML method reference is in [methods/](methods/); global parameter
> definitions live in [overview.md § Parameters](overview.md#parameters).

## API Comparison

|  | OPML | OpenMedia | Widgets |
| --- | --- | --- | --- |
| Technology | XML or JSON over HTTP/HTTPS | SOAP Web Services | HTML/Javascript |
| Local browse | yes | yes | no |
| Genre browse | yes | yes | single genre only |
| Location browse | yes | yes | single location only |
| Geo-location browse | yes | no | no |
| Search | yes | yes | no |
| Search within stations, shows | yes | yes | no |
| Search by call sign, frequency, city | yes | no | no |
| Preset management | yes | retrieve only | no |
| Station schedule | yes | yes | no |
| Recommendations | yes | no | no |
| Recent topics | yes | yes | no |
| Authentication | yes | yes | no |

## How do I decide?

If you’re hosting a web site or blog and need to quickly integrate content such as a local dial or set of stations, widgets are the way to go.

For applications and devices, we recommend OPML. Aside from offering a choice of output formats, it is the most full featured and easiest to approach.

## See also

- [overview.md](overview.md) — the OPML API in detail
- [methods/](methods/) — per-method documentation for the OPML methods listed above
