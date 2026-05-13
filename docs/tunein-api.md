# TuneIn OPML API — working guide

This document describes how to use the TuneIn OPML API at
`opml.radiotime.com` for the purposes of this project: browsing the
station catalogue, resolving stream URLs, and rendering results in the
admin UI.

It is a **guide**, not a history. Every claim is annotated with a
source marker so that future maintainers can verify it:

- **`[spec]`** — documented in the archived RadioTime developer docs
  at `docs/reference/radiotime/`. These are the canonical 2010–2011
  pages that certified partner clients (Bose, Sonos, Squeezebox) were
  built against. Field shapes documented as `[spec]` remain
  authoritative.
- **`[observed]`** — verified by direct probing of the live API. Used
  for modern additions that postdate the spec (pagination cursors,
  newer pivot keys, HLS-era stream flags). Every `[observed]` claim is
  reproducible from a single `curl` against the live endpoint.

When the two disagree, prefer `[observed]`. The spec is a baseline,
not a contract.

---

## 1. Endpoints

The OPML service exposes four endpoints under
`http://opml.radiotime.com/`. All return XML by default; pass
`render=json` for JSON.

| Endpoint | Purpose | Spec |
| --- | --- | --- |
| `Browse.ashx` | Walk the catalogue (genres, regions, languages, etc.) | `methods/browse.md` |
| `Search.ashx` | Free-text search across stations, shows, episodes, artists | `methods/browse.md` (search inherits from Browse) |
| `Describe.ashx` | Detailed metadata for a station, show, topic, or taxonomy | `methods/describe.md` |
| `Tune.ashx` | Resolve a playable stream URL for a station, show, or topic | (not in spec; see § 1.4) |

### 1.1 Browse.ashx

Returns an outline tree. Either a flat list of `outline` entries or
nested sections (each containing `children`).

Parameters:

- `c=<class>` `[spec]` — top-level classifier. Documented values:
  `local`, `music`, `talk`, `sports`, `lang`, `podcast`, `popular`,
  `best`, `world`. The configuration classes from the spec
  (`presets`, `schedule`, `playlist`) require partner authentication
  for the full surface, but `schedule` and `playlist` return
  anonymously usable responses.
- `id=<prefix><digits>` `[spec]` — drill into a node by its
  `guide_id`. Accepts `r`, `g`, `c`, `m`, `p`. See § 4 for the prefix
  taxonomy.
- `filter=<value>` `[spec]` — narrows the result set. See § 5.
- `pivot=<axis>` `[observed]` — re-shapes children of a region or
  category drill. Values: `name`, `genre`, `country`. See § 5.4.
- `offset=<N>` `[observed]` — only emitted by the service in cursor
  URLs (`key="nextStations"`). Clients **follow** these cursors; they
  do not construct them.
- `formats=<csv>` `[spec]` — restrict to streams in these container
  formats. Default when omitted: `wma,mp3`. See § 9.
- `render=json` `[spec]` — emit JSON instead of XML.
- `partnerId`, `serial`, `version`, `itemUrlScheme` `[spec]` — partner
  client identification. Accepted on any call; mostly pass-through.

Response shape `[observed]`:

```json
{
  "head": { "title": "Folk", "status": "200" },
  "body": [
    { "text": "Local Stations (2)", "key": "local", "children": [ ... ] },
    { "text": "Stations",           "key": "stations", "children": [ ... ] },
    { "text": "Shows",              "key": "shows", "children": [ ... ] },
    { "text": "Explore Folk",       "key": "related", "children": [ ... ] }
  ]
}
```

Or, on a "deep" drill (e.g. a paginated next-page response), the body
is a flat list of `outline` entries with no section grouping.

### 1.2 Search.ashx

Returns a flat list of `outline` entries — stations (`s` prefix),
shows (`p`), and artists (`m`) interleaved by relevance. `t`-prefix
topics do not appear in raw Search results; they surface only inside
a show's `c=pbrowse` drill.

Parameters:

- `query=<text>` `[spec]` — required. URL-encode normally. Whitespace
  tokens AND-match.
- `filter=p:station` / `p:topic` `[observed]` — return identical
  sets of podcast / show / episode hits (set equality verified across
  multiple queries). Use either; they are aliases in practice.
- `filter=p:show` `[observed]` — narrower than `p:station`/`p:topic`.
  Many queries return zero podcast hits (`comedy`, `tech`); for the
  queries that do return, it is a strict subset. Use only when you
  specifically want podcast "show" rows excluding generic episode
  hits.
- `filter=s:popular|s:topvoted|s:topclick` `[observed]` — drop
  podcasts and re-rank by popularity / votes / clicks. Equivalent to
  `&types=station`.
- `types=station` `[observed]` — alias for `filter=s:popular`. Both
  drop the podcast block; both return the same set.
- `formats=<csv>`, `render=json` — as for Browse.
- `lang=<code>` `[observed]` — minor re-ranking effect; adds 1–4
  locale-relevant results. Does **not** unlock a different inventory.
- `locale=<code>` `[observed]` — stronger than `lang`; same intent.

**Search does not paginate.** `[observed]` All
pagination-style parameters (`offset`, `page`, `pageSize`, `count`,
`limit`, `max`) are silently ignored. The one-shot response is all
there is — typically 40–100 entries depending on query specificity.

For deep discovery, use Browse and follow its `nextStations` cursors
(§ 6).

### 1.3 Describe.ashx

Returns rich metadata for a single entity, or a taxonomy dump.

Parameters:

- `id=<prefix><digits>` `[spec]` — describe one entity. Works for
  `s` (returns a `<station>` element), `p` (returns a `<show>`), and
  `t` (returns a `<topic>`). For any other prefix (`g`, `c`, `r`,
  `m`, `a`, `l`, `n`) the call returns status 200 with an empty
  body. `[observed]`
- `c=<class>` `[spec]` — taxonomy mode. Returns the full list of
  entries in the named taxonomy. Documented values:
    - `c=countries` — 248 entries with `iso` codes (`n`-prefix IDs)
    - `c=languages` — 102 entries with `lNNN` codes (11 more than
      `Browse.ashx?c=lang` exposes)
    - `c=locales` — 16 locale codes
    - `c=formats` — 16 documented format names
    - `c=genres` — 1743 entries with `gNNN` IDs
- `detail=affiliate,genre,recommendation` `[spec]` — for `id=` calls,
  request additional related sections.
- `render=json` — as for Browse.

### 1.4 Tune.ashx

Resolves a station, show, or topic to playable stream URLs. Not
documented in the 2010 spec but the de-facto resolution endpoint
since.

Parameters `[observed]`:

- `id=<prefix><digits>` — required. Valid for `s` (station),
  `p` (show), `t` (topic). For other prefixes the call returns
  `head.status="404"`, `head.fault="Invalid method"`,
  `head.fault_code="api.methodNotFound"`. **Transport HTTP is
  always 200** — the 4xx lives in `head.status`, not in the HTTP
  status line. See § 12.
- `formats=<csv>` — strongly affects which streams are returned and
  whether the partner-routing layer engages. **For our integration
  always send `formats=mp3,aac`** — without it, some stations return a
  `notcompatible.enUS.mp3` placeholder instead of the real stream.
- `lang=<code>` — similar partner-routing effect. We send `de-de`.
- `sid=<id>` — used in conjunction with `c=pbrowse` to fetch program
  contents.
- `c=pbrowse&id=p<N>` — fetch a show's contents. The body is a
  structured response containing some combination of: a `liveShow`
  section, a `topics` section listing recent episodes (often
  dozens), and/or a flat list of station rows that carry the show.
  The exact composition varies by show — a podcast typically gives
  `liveShow + topics`; an over-the-air program gives a station list.
  Use this when surfacing show detail / episode pickers.

Response shape:

```json
{
  "head": { "status": "200" },
  "body": [
    {
      "element": "audio",
      "url": "http://streams.example.com/live.aac",
      "reliability": 99,
      "bitrate": 128,
      "media_type": "aac",
      "guide_id": "e123456",
      "position": 0,
      "player_width": 0,
      "player_height": 0,
      "is_ad_clipped_content_enabled": "false",
      "is_hls_advanced": "false",
      "live_seek_stream": "false",
      "is_direct": true
    },
    ...
  ]
}
```

Note the per-stream `guide_id` carries an `e<N>` prefix (stream
instance, not station) — distinct from the `s<N>` of the station
itself. Most `is_*` flags arrive as JSON strings (`"false"`); the
sole exception is `is_direct`, which is a real boolean. Multiple
entries are alternate streams ordered by reliability.

Two well-known placeholder URLs indicate failure rather than success:

| URL | Meaning |
| --- | --- |
| `http://cdn-cms.tunein.com/service/Audio/notcompatible.enUS.mp3` | Client not authorised (gating, geo, partner) |
| `http://cdn-cms.tunein.com/service/Audio/nostream.enUS.mp3` | Station currently off-air |

Both should be filtered out by the client before treating the
response as a valid stream.

---

## 2. The `outline` element

Every Browse, Search, and `Describe.ashx?c=<class>` response is a
tree of `outline` elements. The spec for this element is at
`docs/reference/radiotime/elements/outline.md`.

### 2.1 Outline types `[spec]`

Each outline carries one of five `type=` values:

| `type` | Meaning |
| --- | --- |
| `link` | Drill target — fetch this URL to descend |
| `text` | Display-only message (e.g. "No stations or shows available") |
| `audio` | Playable stream — leaf of the tree |
| `object` | Metadata wrapper for a station/show/topic. Only in `Describe.ashx` responses |
| `search` | The canonical search URL exposed at the document head |

Containers (section headers) have **no** `type` attribute — they only
have `text`, optionally `key`, and `children`.

### 2.2 Outline attributes — render reference `[spec]`

The full set of display-relevant attributes from the spec:

| Attribute | Applies to | Meaning |
| --- | --- | --- |
| `text` | all | Primary label. Always present |
| `URL` | link, audio, search | Target URL (drill or stream) |
| `guide_id` | link, audio | Globally unique entity ID (see § 4) |
| `subtext` | text, link, audio | The service-picked best secondary identifier: track / show / slogan / language |
| `key` | container, link | Section role (see § 3) |
| `bitrate` | audio | Stream bitrate in kbps |
| `reliability` | audio | 0–100 reliability score |
| `image` | link, audio | Station / show / category logo URL |
| `current_track` | link, audio | Short "now playing" label, often the current show name |
| `playing` | link, audio | Formatted "artist - title" of the current track |
| `media_type` | audio | Container format (mp3, aac, hls, etc.) |
| `preset_id` | link, audio | **Deprecated** — use `guide_id` instead |
| `now_playing_id` | link, audio | **Deprecated** — use `guide_id` instead |
| `preset_number` | link, audio | If the entity is in the user's presets, the slot number |
| `is_preset` | link, audio | Whether the entity is in the user's presets |

The deprecation of `preset_id` and `now_playing_id` is explicit in
the spec — clients should treat `guide_id` as the only authoritative
identifier.

### 2.3 Additional observed attributes `[observed]`

Modern responses include attributes not in the 2010 spec:

| Attribute | Meaning |
| --- | --- |
| `formats` | Station's available container formats, csv |
| `genre_id` | The station's primary genre (`g` prefix) |
| `item` | One of `station`, `show`, `topic` — explicit class label |
| `show_id` | On a station, the currently-airing show (`p` prefix) |
| `playing_image` | Album art for the currently-playing track |

### 2.4 Rendering recipe for an outline row

The spec describes `subtext`, `playing`, and `current_track` as
overlapping fields with distinct intents. For browse-list rendering:

1. **Primary line**: `text` (the row name)
2. **Secondary line**:
    - if `playing` is present, use it ("Artist - Title")
    - else use `subtext`
3. **Tertiary line** (optional, smaller): `current_track` only if it
   differs from the value used on the secondary line
4. **Trailing chips**: `bitrate` (kbps), `formats` / `media_type`
   (codec), reliability badge
5. **Logo**: `image` with size suffix (§ 10)

For station detail views, `playing_image` may be shown alongside the
station logo when the field is present.

---

## 3. Section `key=` values

Section headers and certain link rows carry a `key` attribute that
identifies their semantic role. Two groups exist.

### 3.1 Canonical `key=` values `[spec]`

From `elements/outline.md`:

| `key` | Meaning |
| --- | --- |
| `stations` | Container of live stations within a category |
| `shows` | Container of recurring shows within a category |
| `topics` | Container of on-demand episodes within a show |
| `related` | Container of links to related categories |
| `local` | Container of geolocated local stations |
| `pivot` | Container of cross-cut views (genre / name / etc.) within a region |
| `pivotLocation` | Single link that pivots a genre by location |
| `popular` | Single link to the popular stations within a category |

### 3.2 Modern observed `key=` values `[observed]`

These follow the spec's naming patterns but are not enumerated in the
2010 spec:

| `key` | Meaning |
| --- | --- |
| `nextStations` | Pagination cursor for the `stations` section |
| `nextShows` | Pagination cursor for the `shows` section |
| `pivotName` | Pivot a category by initial letter |
| `pivotGenre` | Pivot a region by genre |
| `localCountry` | Link from `c=local` to the corresponding `r`-prefix country root |
| `unavailable` | (Search only) Container of search hits that are georestricted or otherwise un-playable |
| `topics` | (Search only) Container of podcast / episode hits, distinct from station hits |
| `recommendations` | Container of recommended entities on a show or station drill |
| `genres` | Container of genre links on a show or affiliate drill |
| `affiliates` | Container of affiliate/network links on a show drill |
| `liveShow` | Container describing the currently-airing episode within a `c=pbrowse` response |

The renderer should detect two patterns by prefix rather than by an
exhaustive enum:

- `key.startsWith("next")` — pagination cursor: follow `URL` to load
  more entries of the same kind (§ 6)
- `key.startsWith("pivot")` — cross-cut shortcut: follow `URL` to
  re-view the current node along a different axis

---

## 4. ID prefix taxonomy

Every entity in the catalogue has a globally unique `guide_id`
prefixed by a single letter that identifies its type.

| Prefix | Type | Browse | Describe | Tune | Source | Example |
| --- | --- | --- | --- | --- | --- | --- |
| `s` | Station | n/a | yes | yes | `[spec]` | `s24896` (SWR3) |
| `g` | Genre | yes | empty | no | `[spec]` | `g79` (Folk) |
| `c` | Category / curated collection | yes | empty | no | `[spec]` | `c57940` (Country), `c424724` (Music) |
| `r` | Region / location | yes | empty | no | `[spec]` | `r0` (world), `r100346` (Germany) |
| `m` | Artist / song link | yes | empty | no | `[spec]` | `m119473` |
| `p` | Show / program | yes | yes (`<show>` element) | yes | `[spec]` | `p38913` (Folk Alley) |
| `t` | Topic / episode | n/a | yes (`<topic>` element) | yes | `[spec]` | `t456789` |
| `l` | Language | no — filter token only | yes (via `c=languages`) | no | `[observed]` | `l109` (German), `l1` (English) |
| `n` | Country | no — appears in `Describe.ashx?c=countries` only | yes (via `c=countries`) | no | `[observed]` | `n88` (Germany) |
| `a` | Affiliate / network | yes | empty | no | `[observed]` | `a38337` (Deutschlandradio), `a33300` (NPR) |
| `e` | Stream instance | n/a | n/a | n/a (appears IN Tune responses) | `[observed]` | `e123456` (per-stream guide_id on a `Tune.ashx` audio row) |

For this project's preset workflow, only `s` (stations) and possibly
`p` (shows) are playable. `g`, `c`, `r`, `m`, `a` are browse-tree
nodes. `l` and `n` are filter / taxonomy tokens that never appear as
a top-level `id=`. `e` appears only as a per-row `guide_id` inside
`Tune.ashx` audio responses; it identifies one specific stream
instance and is not separately addressable.

---

## 5. Filter syntax

### 5.1 Filter values from the spec `[spec]`

From `overview.md`:

| Filter | Meaning | Exclusive group |
| --- | --- | --- |
| `s` | Limit to stations | yes |
| `p` | Limit to shows | yes |
| `topic` | Limit to on-demand content | no |
| `video` | Limit to video content | no |
| `random` | Return a single random item | no |
| `bit32`, `bit64`, `bit128` | Limit by bitrate (suffix `*` or `-`) | no |
| `up-low`, `up-med`, `up-hi` | Limit by reliability floor | no |

Multiple values can be combined comma-separated.

### 5.2 Filter values observed in the wild `[observed]`

| Filter | Endpoint | Effect |
| --- | --- | --- |
| `s:popular` | Browse, Search | Re-rank by popularity |
| `s:topvoted` | Browse, Search | Re-rank by votes |
| `s:topclick` | Browse, Search | Re-rank by clicks |
| `p:station` / `p:show` / `p:topic` | Search | Narrow to podcast/show entries — the three values are not reliably distinguishable in practice |
| `s:~A` | Browse (category) | Stations whose name starts with `A`. Single character only |
| `p:~A` | Browse (category) | Shows whose name starts with `A`. Emitted alongside `s:~` rows by `pivot=name` on a category |
| `s:~A:country` | Browse (region) | Within-region, stations starting with `A`. Must be hand-suffixed with `:country` — the API's own `pivot=name` URLs on regions emit only `s:~A` and those return "No stations or shows available" |
| `s:gNN` | Browse (region) | Within-region, stations in genre `gNN`. This is the form actually emitted by `pivot=genre` on a region |
| `s:gNN:country` | Browse (region) | Same as `s:gNN` but with country scoping made explicit; either form works |
| `s:rNNN` | Browse (category) | Within-category, stations in region `rNNN`. Emitted by `pivot=country` rows |
| `l<NNN>` | Browse (with `c=music\|talk\|sports`) | Limit to language `lNNN`. The filter is transitive — it propagates into deeper genre drills rather than affecting the hub list. See § 8.1 |

### 5.3 Filter values that look real but aren't

These are silently ignored — they return the unfiltered result set.
Do not emit them; they create dead-end UI affordances. `[observed]`

- `filter=g:NN` on either Browse or Search
- `filter=l:NN` on `Search.ashx`
- `filter=c:NNN`, `filter=r:NNN`, `filter=n:N`, `filter=a:N` on either
  endpoint
- `types=station,show` and other multi-value `types=` forms on Search
  (only single-value `types=station` works, equivalent to
  `filter=s:popular`)

### 5.4 Pivots `[observed]`

`pivot=<axis>` re-views the current node along a different axis. Only
emitted by the service in `key="pivot*"` links; clients follow these
URLs verbatim.

| `pivot=` | Used on | Result |
| --- | --- | --- |
| `name` | Deep category (`id=cNNN`) | Alphabet entries; each letter is `&filter=s:~LETTER` (and/or `&filter=p:~LETTER`). Category-pivot output mixes both forms — observed total ~46 entries |
| `name` | Region (`id=rNNN`) | Alphabet entries; each letter is `&filter=s:~LETTER` (no `:country` suffix in the emitted URL). The client must append `:country` to actually receive results |
| `name` | Top-level (`c=music` etc.) | Unmodified hub — pivot is not honoured at the top level |
| `genre` | Region | Top-level genres for that region (e.g. 32 for Germany without `filter=country`). The full per-country slice is exposed by adding `filter=country` (≈155 entries for Germany at time of writing — count drifts as TuneIn adds genres) |
| `country` | Deep category (`id=cNNN`) | Around a dozen entries — 8 continents plus duplicated `s:`/`p:` rows — drilling into countries-within-continent |
| `country` | Top-level (`c=music` etc.) | Unmodified hub |

Pivot quirks:

- **`pivot=name` is single-character only.** `filter=s:~Ab` silently
  degrades to `filter=s:~A`; multi-character prefixes are not
  supported.
- `pivot=location` behaves differently depending on the parent:
  - on a Region (`id=rNNN`): empty body (`body:[]`) with `head.status=200`
  - on a deep Category (`id=cNNN`): returns 16 continent links
  - on a Genre (`id=gNN`): returns 8 continent links
  - on a top-level (`c=music` etc.): returns the unmodified hub
- `pivot=date`, `pivot=popularity`, `pivot=language` are silently
  ignored — they return the unmodified page.

### 5.5 Compound filters

Compound filters of the form `s:gNN:country` and `s:~A:country` work
**only when emitted by an API pivot URL**. Hand-constructed compound
filters degrade silently — e.g. `filter=s:~SWR:country` returns
stations-starting-with-S, not SWR. Always follow the URL the API
hands you.

---

## 6. Pagination

The 2010 spec describes a default page size ("10 for shows, 50 for
stations") but does not document the cursor mechanism. Pagination as
it exists today works via embedded cursor outlines `[observed]`:

- A section's children may contain a final outline with
  `key="nextStations"` (or `"nextShows"`) and a `URL` pointing at the
  next page.
- Following that URL returns the next page of entries — typically 25
  more.
- Page 0 returns the nested section layout (`local`, `stations`,
  `shows`, `related`). Page 1+ returns a **flat** list of audio /
  link entries with the cursor at the tail.

### 6.1 Rules clients must follow

1. **Follow cursor URLs verbatim.** Do not synthesise `offset=` query
   strings; only follow what the service emits.
2. **Re-append `render=json` when following a cursor.** The service
   does not preserve the original `render` parameter across cursor
   emissions.
3. **Detect cursors by `key.startsWith("next")`.** Future cursor
   types (e.g. `nextEpisodes`) will work without code changes.
4. **Dedupe by `guide_id` on insert.** Pagination is unstable: the
   live result set re-ranks mid-crawl, so adjacent pages can share
   `guide_id` values. Page-0 churn has been observed in the
   low-double-digit percentage range within a 20-minute window —
   treat it as routine, not exceptional.

### 6.2 End-of-list detection

A response **with** a `next*` cursor → there are more pages.

A response **without** a `next*` cursor → the list is exhausted.
This is the single reliable end signal.

Three shapes can appear as the final ("terminator") response:

1. A short page — fewer entries than the typical stride. Still valid;
   render the entries.
2. An empty body (`body: []`) — render an empty-list message.
3. A `type:"text"` outline with `text="No stations or shows
   available"` — render an empty-list message.

Distinguish all three from a **fault**: a response carrying
`head.fault="<message>"` plus a non-200 `head.status` (typically
`400` or `404`, with a `head.fault_code` machine token — see § 12).
Note: the transport HTTP status is **always 200**; faults are
in-body, not at the HTTP layer. Faults indicate a malformed request
and should surface as an error in the UI; the three terminator
shapes are all valid empty results.

### 6.3 Sizes observed for capacity planning

| Crawl target | Pages crawled | Stations |
| --- | --- | --- |
| Folk (`c100000948`) | 25 | 623 |
| Country (`c57940`) | 42 | 1,017 |
| Jazz (`c57944`) | 35 | 871 |
| Top 40 & Pop (`c57943`) | 308 | 7,679 |
| Germany popular (`r100346&filter=s:popular`) | 731 | 18,256 |
| German-language music (`c=music&filter=l109`) | 582+ (halted) | 8,075+ |

Implication: never auto-crawl uncapped. A hard cap of approximately
50 pages (≈1,250 stations) is appropriate for filter-driven
auto-crawl, with a user-driven "keep crawling" affordance beyond.

`Search.ashx` does not paginate; the one-shot response is the full
result set (typically 40–100 entries).

---

## 7. URL construction rules

The client emits Browse / Search / Describe / Tune URLs in several
contexts. The rules below ensure consistent, working calls.

### 7.1 Top-level navigation

| Tab | URL |
| --- | --- |
| Music genres | `Browse.ashx?c=music` |
| Talk | `Browse.ashx?c=talk` |
| Sports | `Browse.ashx?c=sports` |
| Local Radio | `Browse.ashx?c=local` (geolocated by request IP) |
| By Location | `Browse.ashx?id=r0` (world root) |
| By Language | `Browse.ashx?c=lang` |
| Podcasts | `Browse.ashx?c=podcast` |

Location is the only top-level that uses `id=`; the other six use
`c=`.

### 7.2 Drill into an entity

When following an outline's `URL` field:

1. Take the URL verbatim — `URL` already encodes the correct
   `id=`/`c=`/`filter=`/`pivot=` combination.
2. Append `render=json`.
3. Strip `formats=mp3,aac` and `lang=de-de` if present (see § 7.4).

### 7.3 Language tree URL rewrite

When the URL contains a `filter=l<NNN>` token and either
`id=c424724`, `id=c424725`, or `id=c424726` (the internal Music /
Talk / Sports container IDs), **rewrite** the `id=` token to the
equivalent `c=` short form before emission:

| Original (broken) | Rewritten (working) |
| --- | --- |
| `id=c424724&filter=l<NNN>` | `c=music&filter=l<NNN>` |
| `id=c424725&filter=l<NNN>` | `c=talk&filter=l<NNN>` |
| `id=c424726&filter=l<NNN>` | `c=sports&filter=l<NNN>` |

This rewrite is required because the service emits the
`id=c424724/5/6` form in its own language-list response but those
URLs return only a `"No stations or shows available"` placeholder for
every language tested.

Note that the rewritten URL still returns the full unfiltered hub
list of genres (25 entries for Music) — the language filter is
**transitive**: it does not reduce the hub list, it propagates into
the deeper drills. To actually receive language-filtered stations,
follow one of the hub's genre links (e.g. `id=g79&filter=l109` for
German-language Folk stations).

The colon form `filter=l:NNN` is **not** a workaround. It is
silently ignored under every shape tested (`c=lang`, `c=music`,
`id=c424724`). Always emit `filter=l<NNN>` (no colon).

### 7.4 Magic-parameter scoping

Two parameters affect partner-routing and stream gating:

- `formats=mp3,aac`
- `lang=de-de`

| Endpoint | Send magic params? |
| --- | --- |
| `Tune.ashx` | **Yes.** Without them, gated stations return the `notcompatible` placeholder |
| `Search.ashx` | Optional. `formats=` filters results; `lang=` lightly re-ranks |
| `Browse.ashx` | **No.** Magic params can suppress or thin Browse results — particularly on filter-scoped drills. Plain `Browse.ashx?...&render=json` is the safe form |
| `Describe.ashx` | No effect, can be omitted |

### 7.5 Language code validation

The service fails open on bogus language codes: `filter=l99999`,
`filter=l0`, `filter=labc`, even empty `filter=l` return the
unfiltered Music hub with no fault. The client must validate the code
before emission.

Fetch `Describe.ashx?c=languages` once at app load and accept only
the `guide_id` values present in the response. The current dump
contains 102 codes (11 more than `Browse.ashx?c=lang` exposes; those
11 are defined-but-empty languages).

### 7.6 Don't hardcode category IDs

Specific `c`-prefix IDs are sometimes used to identify well-known
collections, but they can be renamed or invalidated server-side.
Probing shows `c57946` (formerly Country) faults `Invalid category`
(`head.fault_code="id"`), while `c57940` is now Country and `c57943`
is now Top 40 & Pop.

For any UI affordance that needs a specific category, derive the
current ID at runtime from `Browse.ashx?c=music` rather than
embedding a constant.

---

## 8. Sub-trees of interest

### 8.1 The Language tree

`Browse.ashx?c=lang` returns 91 language entries. Each entry's `URL`
points at one of two forms:

- `Browse.ashx?c=lang&filter=l<NNN>` — the majority form
- `Browse.ashx?id=c424724&filter=l<NNN>` — 11 languages: Bashkir,
  Dari, Dhivehi, Fijian, Kannada, Kashmiri, Romansch, Sami, Shona,
  Uyghur, Welsh

Apply the rewrite from § 7.3 to both forms; emit
`Browse.ashx?c=music&filter=l<NNN>` (or `talk` / `sports`) to
actually fetch content.

`Describe.ashx?c=languages` returns 102 entries — the 11 extra
languages (Berber, Gaelic, Turkmen, Chichewa, Ndebele, Kazakh,
Mongolian, Kyrgyz, Tatar, Lao, Tibetan) are defined-but-empty in the
catalogue. Use the 91-entry browse list for the UI; use the 102-entry
describe list for validation only.

Genre × language composition works as
`Browse.ashx?id=g<NN>&filter=l<NNN>`. Multi-token forms like
`filter=l<NNN>,g<NN>` silently drop the genre.

### 8.2 The Location tree

Starts at `r0` (world) and is statically enumerable: no pagination
exists at intermediate levels (continent, country, region, city).
Only the audio-leaf sections at the deepest level paginate via
`nextStations`.

Observed depth:

- USA path: continent → country → state → city → stations (5
  levels)
- Most other branches: continent → country → city → stations (4
  levels)

Pushing `offset=` past the natural list length of a city/region
leaf returns the "No stations or shows available" tombstone. Do not
paginate city leaves by default; only paginate sections that emit a
`nextStations` cursor explicitly.

### 8.3 Local Radio (`c=local`)

A single section of audio entries, geolocated by request IP.
Approximately 185 entries for a typical European location. It does
**not** paginate: all query parameters (`offset`, `filter`, `pivot`)
are silently ignored. `id=local` is **not** a synonym — it returns
`head.status="400"`, `head.fault="Invalid ID for browse"`,
`head.fault_code="request.idInvalid"`.

The response always includes a `key="localCountry"` link pointing at
the corresponding `r`-prefix country root. Surface this as a "Browse
all of <country>" affordance.

### 8.4 Affiliates / networks (`a` prefix)

National / network groupings (Deutschlandradio `a38337`, NPR
`a33300`, RTL Group, etc.) are surfaced under country pages as
mixed-prefix children. They drill into pages with their own
`stations` and `shows` sections, and their `shows` sections paginate
via `nextShows`. Render them as a distinct type alongside cities /
regions.

---

## 9. Formats

### 9.1 Documented format codes `[spec]`

From `overview.md`:

| Code | Meaning |
| --- | --- |
| `wma` | Windows Media Audio v8/9/10 |
| `mp3` | Standard MP3 |
| `aac` | AAC and AAC+ |
| `real` | RealMedia |
| `flash` | RTMP (typically MP3 or AAC encoded) |
| `html` | Usually desktop player URLs |
| `wmpro` | Windows Media Professional |
| `wmvoice` | Windows Media Voice |
| `wmvideo` | Windows Media Video v8/9/10 |
| `ogg` | Ogg Vorbis |
| `qt` | QuickTime |

Default if `formats=` is omitted: `wma,mp3` `[spec]`.

### 9.2 Live format dump `[observed]`

`Describe.ashx?c=formats` returns 16 codes today, including five
hardware-tuner codes the prose spec mentions only in passing:

| Code | Meaning |
| --- | --- |
| `am` | AM radio (hardware tuners) |
| `dab` | Digital Audio Broadcasting |
| `fm` | FM radio (hardware tuners) |
| `hd` | HD Radio (hardware tuners) |
| `sat` | Satellite radio |

The 11 software-stream codes from § 9.1 round out the list.

### 9.3 Modern additions accepted but not declared `[observed]`

| Code | Meaning |
| --- | --- |
| `hls` | HLS / m3u8 streams. Accepted by `Tune.ashx` and used in live responses, but does **not** appear in the `Describe.ashx?c=formats` dump |

### 9.4 Preference order

The Logitech Media Server certified plugin uses this preference order
for selecting among alternate streams (highest first):

`aac > ogg > mp3 > wmpro > wma > wmvoice > hls > real`

This project uses `formats=mp3,aac` for `Tune.ashx` calls — sufficient
for SoundTouch playback and avoids the placeholder gating.

---

## 10. Image URLs

Station and show logos are served from `cdn-profiles.tunein.com` and
`cdn-radiotime-logos.tunein.com`, with a single-letter size suffix:

| Suffix | Pixels | Use |
| --- | --- | --- |
| `t` | 75 | Thumbnail (search-suggest dropdowns) |
| `q` | 145 | Square (browse-list rows) |
| `d` | 300 | Medium (station-detail header) |
| `g` | 600 | Giant (full-bleed art) |

Example: `http://cdn-profiles.tunein.com/s24896/images/logoq.png`
(square). The size suffix appears in the `image` attribute of the
outline element; the client may rewrite it to a different size when
needed.

Album art for the currently-playing track appears in `playing_image`
when available, served from `cdn-albums.tunein.com/gn/...` (Gracenote
fingerprints, square).

---

## 11. Caching

The result set re-ranks frequently. Observed cache-TTL guidance:

| Surface | Sensible TTL |
| --- | --- |
| Page 0 of a popular drill (volatile head) | 15 minutes |
| Deep pages of a crawl (stable tail) | 24 hours |
| Taxonomy dumps (`Describe.ashx?c=languages` etc.) | 24 hours |
| Station metadata (`Describe.ashx?id=s<N>`) | 24 hours |
| `Tune.ashx` stream URLs | Refetch per playback session |

Dedupe by `guide_id` at insert when accumulating multiple cursor
pages — adjacent pages can share entries due to mid-crawl re-ranking.

---

## 12. Error handling

Three response classes the client must distinguish:

| Class | Detection | Meaning | UI |
| --- | --- | --- | --- |
| Success | `head.status="200"` plus non-empty body | Valid result | Render |
| Empty / terminator | `head.status="200"` plus empty body OR a `type:"text"` "No stations or shows available" outline OR a short final page | Valid empty result | "Nothing here" |
| Fault | `head.fault` is set, with `head.status` 400 or 404 | Malformed request | "Couldn't load: <fault message>" |

**Transport HTTP is always 200** regardless of class. Always inspect
`head.status` for the real classification; the HTTP status line will
not tell you anything useful.

The `head.fault_code` token is the machine-readable category;
`head.fault` is the human message. Common combinations:

| Trigger | `head.status` | `head.fault` | `head.fault_code` |
| --- | --- | --- | --- |
| Unknown top-level `c=` value (e.g. `c=xxinvalid`) | `400` | `Invalid root category` | _(absent)_ |
| Unknown `id=c<bad>` value (e.g. `id=c57946`) | `400` | `Invalid category` | `id` |
| Unknown / unbrowseable `id=` (e.g. `id=local`) | `400` | `Invalid ID for browse` | `request.idInvalid` |
| `Tune.ashx?id=` with a non-tuneable prefix (`g`, `c`, `r`, `m`, `l`, `n`, `a`) | `404` | `Invalid method` | `api.methodNotFound` |
| Missing `query=` on `Search.ashx` | `400` | `Empty Query specified` | `request.queryInvalid` |

Distinguishing a fault from an empty result matters: an empty result
is a feature ("no stations match"), a fault is a bug ("the URL we
emitted is wrong").

---

## 13. Quick reference / cookbook

| Goal | Call |
| --- | --- |
| Root taxonomy | `Browse.ashx?render=json` |
| Music genres | `Browse.ashx?c=music&render=json` |
| Stations in genre G | `Browse.ashx?id=g<N>&render=json` |
| Stations in a region | `Browse.ashx?id=r<N>&render=json` |
| Stations of a language | `Browse.ashx?c=music&filter=l<N>&render=json` |
| Popular within a region | `Browse.ashx?id=r<N>&filter=s:popular&render=json` |
| Stations starting with A in region | `Browse.ashx?id=r<N>&filter=s:~A:country&render=json`. **Note:** the `pivotName` URL the API emits on a region uses `&filter=s:~A` (no `:country`) which returns the empty tombstone — append `:country` yourself |
| Free-text search | `Search.ashx?query=<text>&filter=s:popular&render=json` |
| Station metadata | `Describe.ashx?id=s<N>&render=json` |
| Stream URLs for station | `Tune.ashx?id=s<N>&formats=mp3,aac&lang=de-de&render=json` |
| All known languages | `Describe.ashx?c=languages&render=json` |
| All known genres | `Describe.ashx?c=genres&render=json` |
| All known countries | `Describe.ashx?c=countries&render=json` |
| Next page of paginated section | Follow the section's `key="nextStations"` URL, append `render=json` |

---

## 14. References

- Archived RadioTime developer documentation:
  `docs/reference/radiotime/` (with `SOURCES.md` index)
- Logitech Media Server certified TuneIn plugin (Perl, Slim Devices /
  Logitech, public 8.3 branch):
  `https://github.com/LMS-Community/slimserver/tree/public/8.3/Slim/Plugin/InternetRadio`
- mopidy-tunein (Python, actively maintained):
  `https://github.com/kingosticks/mopidy-tunein/blob/master/mopidy_tunein/tunein.py`
- core-hacked/tunein-api (unofficial GitBook for post-2012 fields):
  `https://tunein-api.corehacked.com/`
