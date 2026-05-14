# bose-soundtouch-resurrect

Replaces Bose's shut-down cloud services for the SoundTouch family with a tiny static responder running on the speaker itself. Below is the project-specific vocabulary that recurs in every conversation about this code.

## Language

### Speaker side

**Speaker**:
A Bose SoundTouch device — the audio appliance whose firmware this project keeps working.
_Avoid_: device, unit, box.

**Resolver**:
The on-speaker static-file + CGI responder that replaces the four Bose cloud services. Lives at `/mnt/nv/resolver/`, served by busybox httpd on port 8181.
_Avoid_: server, mock, emulator (used elsewhere for off-speaker variants).

**Override XML**:
`/mnt/nv/OverrideSdkPrivateCfg.xml` — the file that redirects the firmware's four cloud URLs to `http://127.0.0.1:8181`. Read by BoseApp at boot.
_Avoid_: config, redirect.

**Preset**:
One of the six physical preset buttons on the speaker, each holding a station reference.
_Avoid_: slot, favorite, channel.

**Station**:
A TuneIn radio entry referenced by a `sNNNNN` TuneIn ID. The thing a preset points at.
_Avoid_: channel, source, broadcast.

**Stream URL**:
The audio URL the speaker fetches directly from the radio CDN. The cloud was never in the audio path; only metadata.

**TuneIn ID**:
The `sNNNNN` identifier TuneIn uses for a station. The firmware stores these against presets; the resolver maps them to Stream URLs.
_Avoid_: SID (overloaded inside TuneIn's own taxonomy — use the longer form).

### Admin side

**Admin SPA**:
The browser-served admin at `http://<speaker>:8181/` — vanilla HTML/CSS + ES modules under `/app/`. The user-facing interface post-cloud-shutdown.
_Avoid_: dashboard, console, UI.

**CGI**:
A busybox-shell script under `admin/cgi-bin/api/v1/`, serving one endpoint family (play, presets, refresh-all, speaker, tunein, preview). Pinned to POSIX + busybox idioms.

**TuneIn drill**:
The act of crawling TuneIn's outline tree — from a root (genre / location / language) through pagination, lcode validation, and outline classification — down to a station. Implemented across `tunein-url`, `tunein-pager`, `tunein-outline`, `tunein-cache`, `tunein-sid`, plus the renderer under `views/browse/`.
_Avoid_: browse, search (those are distinct concepts in TuneIn's API).

**Crumb stack**:
The breadcrumb trail in the browse view plus the `parts` value type that backs it. Owns parsing, rendering, hydration, and the trail's relationship to the URL hash.
_Avoid_: breadcrumb, trail (those refer to the visual element only; the stack is the value).

**Field**:
The unit of speaker-state synchronisation. A row in the `FIELDS` registry in `admin/app/speaker-state.js`, encoding `path` (REST), `tag` (XML), `parseEl` (decoder), `apply` (writer), and optional `eventTag` (WS event). Both the polling reconcile and the WS dispatch path converge on a field.
_Avoid_: property, attribute (too generic).

**FIELDS registry**:
The list of all known speaker fields — single source of truth for what gets synced and how.

## Relationships

- A **Preset** points to a **Station** by its **TuneIn ID**.
- The **Resolver** maps a **TuneIn ID** to a **Stream URL**; the **Speaker** then streams audio from that URL directly.
- The **Admin SPA** mutates speaker state through **CGIs** that proxy or augment the speaker's port-8090 REST API.
- A **TuneIn drill** terminates at a **Station**; a station can be assigned to a **Preset**.
- The **Crumb stack** represents the user's path through a **TuneIn drill**.
- Every **Field** is reconciled either by polling (REST) or by WS dispatch (inline payload or hint + refetch).

## Example dialogue

> **Maintainer:** "When the WS pipe goes down, does the **Admin SPA** stop reflecting **Speaker** state?"
> **Other maintainer:** "No — `reconcile(store)` polls every **Field** in the registry on a fallback timer. The WS path is the fast path; the polling path is the floor."

## Flagged ambiguities

- *Browse* vs *TuneIn drill*: the SPA's "Browse" tab is one entry point into a **TuneIn drill**, but the drill itself spans the cache, pager, and outline classifier — it's not a synonym for the tab.
- *Preset* usually means "preset button," but in `views/preset.js` can also refer to the preset-row UI element. Use the longer form (preset row / preset slot) when context is ambiguous.
