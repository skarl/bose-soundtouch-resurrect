# TuneIn OPML API — reference

Notes on TuneIn's public OPML API at `opml.radiotime.com`. This is the
same backend the speaker firmware would have called via Bose's cloud,
and the same one `resolver/build.py` and the planned admin UI call to
fetch fresh stream URLs and browse the catalogue.

This API is **not officially documented** by TuneIn for third-party use.
What's here was reverse-engineered by probing live endpoints and by
reading other community projects. It can change without warning. If
something stops working, this is the first place to look.

## Quick map

```
opml.radiotime.com/
├── Browse.ashx                 → directory tree (outline elements)
│   ├── (no args)               → root: Local | Music | Talk | Sports |
│   │                              By Location | By Language | Podcasts
│   ├── ?c=local                → geolocated nearby stations (~100 KB)
│   ├── ?c=music                → ~25 music genres
│   ├── ?c=talk                 → talk categories
│   ├── ?c=sports               → sports categories
│   ├── ?c=lang                 → languages
│   ├── ?c=podcast              → podcasts (Music / Talk / Sports tree)
│   └── ?id=<id>                → drill into any taxonomy node
│
├── Search.ashx?query=...        → mixed-type results (artists, stations,
│                                  programs, topics)
│   ├── &types=station          → live radio only
│   ├── &types=program          → recurring shows
│   └── &types=topic            → individual episodes / segments
│
├── Describe.ashx?id=sNNN        → rich station metadata (slogan, genre,
│                                  language, location, frequency, logo,
│                                  current track if has_song, …)
│
└── Tune.ashx?id=sNNN            → playable stream URLs
                                   (the endpoint resolver/build.py uses)
```

All endpoints accept `&render=json` (recommended; XML is the default).

## ID prefix taxonomy

| Prefix | Type             | Example       | Notes |
| ------ | ---------------- | ------------- | ----- |
| `s`    | Station (live)   | `s12345`     | Resolvable via `Tune.ashx`, gating allowed |
| `g`    | Genre            | `g22`         | Browse target via `Browse.ashx?id=gNN` |
| `c`    | Category / collection | `c57944` | Browse target. Used for sub-collections under genres |
| `r`    | Region / location | `r0`, `r100780` | Browse target. `r0` = world root |
| `m`    | Artist (music)   | `m119473`     | Returned by search; not playable as a station |
| `p`    | Program          | `p123456`     | Recurring show; has episodes |
| `t`    | Topic / episode  | `t456789`     | Single episode of a program |

For the v1 admin and the resolver this project is concerned with **only
the `s` prefix** (live radio). `m`, `p`, `t` are filtered out of search
results; `g`, `c`, `r` are used as browse-tree nodes.

## The magic query parameters

Two query parameters control whether `Tune.ashx` returns real partner-
routed stream URLs or a placeholder:

```
&formats=mp3,aac          # without this, some stations return placeholder
&lang=de-de               # similar effect; signals partner-aware client
```

Without these, `Tune.ashx?id=s12345` returns:

```json
{ "body": [{
  "url": "http://cdn-cms.tunein.com/service/Audio/notcompatible.enUS.mp3",
  …
}]}
```

— a "your client isn't allowed to access this stream" placeholder. With
the magic params, the same call returns the real
`http://streams.<station>.de/.../live.aac` URL and any alternate
streams.

These parameters were discovered empirically. If TuneIn changes their
gating logic, expect this to need rediscovery.

**Other valid `lang` values** (any language code seems to work; locale
is only loosely enforced): `en-us`, `en-gb`, `fr-fr`, `it-it`, etc. The
`de-de` value in this project's code is arbitrary and works for the
stations tested. If you find stations gated even with the magic params,
try alternative locales.

## User-Agent — `Bose_Lisa/27.0.6`

The User-Agent we send is the speaker firmware's own UA. It seems to
help in some marginal cases (presumably the gating logic recognises
"Bose hardware" as a known partner client). Not strictly required for
all stations — many resolve fine with any UA — but it's the safest
default.

## Two failure placeholders to filter

`Tune.ashx` returns a `body[].url` that's one of two well-known
placeholder MP3s when something's wrong:

| URL                                                          | Meaning                                          |
| ------------------------------------------------------------ | ------------------------------------------------ |
| `http://cdn-cms.tunein.com/service/Audio/notcompatible.enUS.mp3` | Client isn't allowed (gating, geo, partner)    |
| `http://cdn-cms.tunein.com/service/Audio/nostream.enUS.mp3`     | Station is currently off-air                   |

Both `resolver/build.py` and the admin's preset-assign flow filter
these. The admin shows the user a clear "not available" / "off-air"
message; build.py emits a WARN and skips the station.

## Response shapes

### `Browse.ashx` — outline tree

Each entry is an `outline` element. Two main flavours:

**Link** (drillable category):
```json
{
  "element": "outline",
  "type": "link",
  "text": "Music",
  "URL": "http://opml.radiotime.com/Browse.ashx?c=music&formats=mp3,aac",
  "key": "music"           // sometimes; for top-level categories
}
```

**Audio** (a station leaf):
```json
{
  "element": "outline",
  "type": "audio",
  "text": "Example Radio",
  "URL": "http://opml.radiotime.com/Tune.ashx?id=s12345&formats=mp3,aac",
  "guide_id": "s12345",
  "subtext": "The biggest new pop and all-day vibes",
  "image": "http://cdn-profiles.tunein.com/s12345/images/logoq.png",
  "bitrate": "128",
  "reliability": "99",
  "formats": "mp3",
  "genre_id": "g4137",
  "now_playing_id": "s12345",
  "preset_id": "s12345"
}
```

`Browse.ashx?c=music` returns ~25 sub-categories (each a `link`).
Drilling into any of them returns either further links or audio leaves.
Some categories return a heading + grouped children:

```json
{ "element": "outline", "text": "Local Stations (1)", "children": [...] }
{ "element": "outline", "text": "Stations", "children": [...] }
```

Treat any `children`-bearing outline as a section header. Renders
naturally as a sub-list.

### `Search.ashx` — mixed types

`Search.ashx?query=jazz&render=json&formats=mp3,aac` returns ~190 mixed
results — artists, stations, programs, topics, all interleaved. Filter
by:

- `&types=station` — live radio only (typical for our use)
- `&types=program` — shows
- `&types=topic` — individual episodes

The shape is identical to `Browse.ashx`'s — array of `outline` entries,
each with `element: "outline"` and `type: "audio"` or `"link"`.

### `Describe.ashx` — full station metadata

```json
{
  "head": { "status": "200" },
  "body": [{
    "element": "station",
    "guide_id": "s12345",
    "preset_id": "s12345",
    "name": "Example Radio",
    "call_sign": "Example Radio",
    "slogan": "Aktuelles aus den Charts, neue coole Hits...",
    "frequency": "88.1",
    "band": "FM",
    "url": "http://www.example.de",
    "detail_url": "http://tun.in/...",
    "is_available": true,
    "is_music": true,
    "has_song": false,
    "has_schedule": false,
    "has_topics": false,
    "twitter_id": "...",
    "logo": "https://cdn-profiles.tunein.com/s12345/images/logoq.png?t=...",
    "location": "Anytown",
    "current_song": null,
    "current_artist": null,
    "language": "German",
    "genre_id": "g4137",
    "genre_name": "Top 40 & Pop Music",
    "region_id": "r101839",
    "country_region_id": 100346,
    "tz": "GMT + 1 (CEST)",
    "tz_offset": "120",
    …
  }]
}
```

The fields `current_song`, `current_artist`, `current_album` are
populated only for stations with `has_song: true` (i.e. stations that
publish now-playing metadata to TuneIn).

### `Tune.ashx` — playable streams

```json
{
  "head": { "status": "200" },
  "body": [
    {
      "element": "audio",
      "url": "http://streams.<station>/.../hqlivestream.aac",
      "reliability": 99,
      "bitrate": 128,
      "media_type": "aac",
      "is_hls_advanced": "false",
      "live_seek_stream": "false",
      "is_direct": true
    },
    {
      "element": "audio",
      "url": "http://streams.<station>/.../livestream.aac",
      "reliability": 99,
      "bitrate": 47,
      "media_type": "aac",
      …
    },
    …
  ]
}
```

Multiple entries are alternate streams (HQ vs LQ, MP3 vs AAC, HTTP vs
HTTPS) ordered by reliability. The Bose-shaped JSON our resolver
produces preserves all entries in the `audio.streams` array, with the
first one's URL also as the canonical `audio.streamUrl`.

## Resolver-shape vs TuneIn-shape

The JSON the speaker firmware expects from
`/bmx/tunein/v1/playback/station/<id>` (which we serve from
`/mnt/nv/resolver/`) is *different* from `Tune.ashx`'s native shape.

`resolver/build.py` does the reshape:

| Source (TuneIn)            | Destination (Bose)                                  |
| -------------------------- | --------------------------------------------------- |
| `body[].url`               | `audio.streams[].streamUrl`                          |
| `body[0].url`              | also `audio.streamUrl` (canonical)                   |
| `body[].bitrate`, etc.     | flattened into per-stream `audio.streams[]` entries  |
| (synthesised)              | `_links.{bmx_reporting,bmx_favorite,bmx_nowplaying}` |
| (caller-provided)          | `name`                                               |
| (synthesised)              | `streamType: "liveRadio"`                            |

The admin SPA's `app/reshape.js` does the identical transform in JS, so
the same logic exists in two places. They MUST agree. If
`resolver/build.py` is updated, `app/reshape.js` needs the same change
(and vice versa). A future refactor could push the reshape into a
shared `cgi-bin/` helper.

## Categories worth knowing

When implementing the admin's browse view, these top-level categories
from the root `Browse.ashx`:

| `key`    | Label        | Typical content                                       |
| -------- | ------------ | ----------------------------------------------------- |
| `local`  | Local Radio  | Geolocated by request IP. ~100 KB. Slow to render.   |
| `music`  | Music        | 25 music genres (Country, Jazz, Rock, Pop, …)         |
| `talk`   | Talk         | News, comedy, religious, public-radio sub-categories  |
| `sports` | Sports       | Specific sports + team-based collections              |
| —        | By Location  | World → continent → country → region → city           |
| —        | By Language  | List of languages, each leading to stations           |
| `podcast`| Podcasts     | Recurring shows; out of scope for v1 live-radio admin |

Drilling into a music genre like `c57944` (Jazz) typically returns
sub-collections like "Local Stations (N)", "Stations", and one or two
sub-genres. Drill further to reach `audio` leaves.

The Location tree starts at `r0` (world) and is deep — five or six
levels to reach a city's stations.

## Gotchas

- **The `URL` field in outline entries is HTTP, not HTTPS.** TuneIn
  has both available; we always rewrite to HTTPS in the admin's CGI
  proxy for cleanliness.
- **`reliability`** is a 0–100 score TuneIn assigns to each stream.
  Below 50% is genuinely unreliable and worth flagging in UI.
- **Some search results have `has_profile: "false"`** which means
  `Describe.ashx` will return a 404 for that ID. Handle gracefully —
  show the search-result-card metadata only.
- **The `Profile.ashx` endpoint is gone** (returns "Invalid method").
  Use `Describe.ashx` instead.
- **Local stations** for non-test geos can be huge. The admin should
  paginate or lazy-render local results.
- **Episodes (`t` prefix) and programs (`p` prefix)** can sometimes
  appear with `type: "audio"` and a playable URL via Tune.ashx. We
  ignore these in v1 because their lifecycle is different from a live
  station (they have a duration, can finish).

## When TuneIn breaks

If `Tune.ashx` starts returning the `notcompatible` placeholder for
stations that previously worked:

1. Try alternative `lang` values (`en-us`, `fr-fr`, etc.).
2. Check whether the User-Agent matters (try `curl -A 'Bose_Lisa/27.0.6'`
   vs default).
3. Compare `Describe.ashx` output for a known-working station vs the
   newly-broken one — sometimes a station's `is_available` flips.
4. If it's geo-gated, hard luck — the public API doesn't expose a way
   around it. The station may still be reachable via its own direct
   stream URL (visit the station's website, dig their stream URL, and
   build a custom resolver entry by hand. See
   [customizing-presets.md](customizing-presets.md) § "Adding a station
   that isn't on TuneIn".)
