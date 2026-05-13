# RadioTime OPML — canonical reference (2010–2011 archive)

This directory mirrors the **original RadioTime developer
documentation** as it existed on `inside.radiotime.com` between 2010
and 2011, before TuneIn fully absorbed RadioTime. The public
developer site has since been retired; the pages here are recovered
from the Internet Archive.

## What this archive is

**Authoritative.** This is the spec that certified partner clients
were built against — Sonos, Squeezebox, Logitech, Marantz, and the
Bose SoundTouch firmware that this project resurrects. Those
clients still run today against the live `opml.radiotime.com`
endpoint. Field shapes, parameter names, response structure, and
the rendering model documented here remain correct.

If you want to know what an attribute means, what a method accepts,
or how an outline element is shaped — start here.

## What this archive is not

**Exhaustive.** The 2010 spec predates every API addition TuneIn
shipped after the acquisition. Specifically, you will not find:

- `nextStations` / `nextShows` pagination cursors
- `pivotName` / `pivotGenre` / `localCountry` section keys
- HLS-era stream flags (`is_hls_advanced`, `live_seek_stream`,
  `is_direct`)
- Ad / Nielsen / donation metadata fields
- The `a` (affiliate / network) ID prefix
- `l` (language) and `n` (country) ID prefixes as filter tokens

All of these are real and currently used by the live API. They are
covered in `docs/tunein-api.md` (the project's working guide) and
marked there with the `[observed]` tag. **If a feature is not
documented here, check `docs/tunein-api.md` next — do not assume the
feature does not exist.**

## How the two documents relate

| Question | Where to look |
| --- | --- |
| What does this field mean? | Here, if it is a pre-2012 attribute |
| Does this parameter exist? | Here, then `docs/tunein-api.md` for additions |
| How do I use the API in practice? | `docs/tunein-api.md` |
| Why does the API behave this way? | Here, for the original intent |

## Table of contents

| Page | Contents |
| --- | --- |
| [overview.md](overview.md) | Global parameters, headers, response envelope, filter syntax, format enumeration, reserved-services note |
| [matrix.md](matrix.md) | API-vs-API comparison: OPML vs OpenMedia vs Widgets |
| [methods/browse.md](methods/browse.md) | The Browse method — index, local, presets, categories, language, station, schedule, playlist, show |
| [methods/describe.md](methods/describe.md) | The Describe method — nowplaying, station, show, topic, countries, languages, locales, formats, genres |
| [methods/preset.md](methods/preset.md) | The Preset method — add/remove items, add/remove/rename/list folders |
| [methods/options.md](methods/options.md) | The Options method — per-item context menu |
| [methods/account.md](methods/account.md) | The Account method — auth, create, join, drop, query, remind, reset, claim |
| [methods/authenticate.md](methods/authenticate.md) | GET-based credential verification (alternative to `Account.ashx?c=auth`) |
| [methods/config.md](methods/config.md) | The Config method — server time, localized strings, stream samples |
| [elements/opml.md](elements/opml.md) | `<opml>` — root container |
| [elements/head.md](elements/head.md) | `<head>` — status, fault, title, expansionState |
| [elements/body.md](elements/body.md) | `<body>` — payload container (spec page lost, behaviour documented) |
| [elements/outline.md](elements/outline.md) | `<outline>` — primary data element, all types and attributes |
| [elements/station.md](elements/station.md) | `<station>` — metadata body for a radio station |
| [elements/show.md](elements/show.md) | `<show>` — metadata body for a radio show |
| [elements/topic.md](elements/topic.md) | `<topic>` — metadata body for a single episode |
| [elements/resources.md](elements/resources.md) | `<resources>` — spec page not preserved in archive |
| [SOURCES.md](SOURCES.md) | Wayback URL + snapshot timestamp index |

Each `.md` is a verbatim transcription of one Wayback snapshot.
Raw HTML snapshots and intermediate `.txt` extracts were used during
import and are no longer retained — refetch from the Wayback URLs in
[SOURCES.md](SOURCES.md) if you ever need the original source.

## Suggested reading order

1. **[overview.md](overview.md)** — the request/response model and
   global parameters. Everything else assumes you know these.
2. **[methods/browse.md](methods/browse.md)** — the workhorse
   method; once Browse is clear, the rest of the methods are minor.
3. **[elements/outline.md](elements/outline.md)** — the shape of
   nearly every Browse response.
4. **[methods/describe.md](methods/describe.md)** + the metadata
   element pages ([station](elements/station.md),
   [show](elements/show.md), [topic](elements/topic.md)) — how to
   render a detail screen.
5. The remaining methods ([preset](methods/preset.md),
   [account](methods/account.md), [options](methods/options.md),
   [config](methods/config.md), [authenticate](methods/authenticate.md))
   as you need them.

## Refetch recipe

Each page can be re-fetched from the Wayback Machine in raw form (no
toolbar wrapper) using the `id_` flag in the snapshot URL:

```
https://web.archive.org/web/<TIMESTAMP>id_/http://inside.radiotime.com/developers/api/opml/<path>
```

See [SOURCES.md](SOURCES.md) for the exact timestamps used for each page.

## Citing this archive

When `docs/tunein-api.md` references a fact as **`[spec: <file>]`**,
follow that pointer here. When it marks a fact as **`[observed]`**,
the spec does not document it — the behavior was confirmed against
the live API.
