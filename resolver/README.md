# resolver/ — the on-speaker static-file resolver

This directory holds everything that gets pushed to the speaker's
`/mnt/nv/resolver/` and `/mnt/nv/shepherd/` to make the speaker self-host
the metadata layer.

For end-to-end install steps see [`../docs/installation.md`](../docs/installation.md).

## What's here

```
build.py                  Fetch fresh stream URLs from TuneIn → emit Bose-shaped JSON
stations.example.json     Example preset list — copy to stations.json and edit
responses/
  services.json           Static BMX service registry (captured + cleaned)
  sourceproviders.xml     Static source-provider list (captured + cleaned)
shepherd-resolver.xml     Daemon config for shepherdd → auto-start httpd at boot
```

`stations.json` (your real preset list) is gitignored on purpose. The
example shows the format; copy it and edit.

## How `build.py` works

For each station ID in `stations.json`, the script:

1. Calls `https://opml.radiotime.com/Tune.ashx?id=<id>&render=json&formats=mp3,aac&lang=de-de`
   with `User-Agent: Bose_Lisa/27.0.6`.
2. Filters out the `notcompatible.enUS.mp3` placeholder TuneIn returns
   when its API can't (or won't) hand out the partner stream URL for a
   given client.
3. Reshapes each remaining `body[]` entry into the JSON shape the speaker
   expects:

   ```json
   {
     "_links": {
       "bmx_reporting":   {"href": "/v1/report?stream_id=e0&guide_id=<id>&listen_id=0&stream_type=liveRadio"},
       "bmx_favorite":    {"href": "/v1/favorite/<id>"},
       "bmx_nowplaying":  {"href": "/v1/now-playing/station/<id>", "useInternalClient": "ALWAYS"}
     },
     "audio": {
       "hasPlaylist": true, "isRealtime": true, "maxTimeout": 60,
       "streamUrl": "<first stream>",
       "streams": [{"streamUrl": "...", ...}, ...]
     },
     "imageUrl": "",
     "isFavorite": false,
     "name": "<station name>",
     "streamType": "liveRadio"
   }
   ```

4. Writes one file per station ID into the cwd, named exactly after the
   ID (e.g. `s12345`).

The crucial discovery: **`formats=mp3,aac&lang=de-de` is not optional**.
Without these query parameters, TuneIn returns the
`http://cdn-cms.tunein.com/service/Audio/notcompatible.enUS.mp3`
placeholder for some stations. With them, you get the real partner-routed
streams. See [`../docs/architecture.md`](../docs/architecture.md) §
"The TuneIn API quirk" for the back-story.

## The static templates (`responses/`)

Two files in `responses/` are copied to the speaker as-is during deploy:

- `services.json` → `/mnt/nv/resolver/bmx/registry/v1/services`. The BMX
  service registry — describes which music services the speaker can use
  (TuneIn etc.) and where to find them.
- `sourceproviders.xml` → `/mnt/nv/resolver/marge/streaming/sourceproviders`.
  The list of streaming source providers that BoseApp asks for at boot.

These were captured from a SoundCork run and verified to be free of
user-specific data (no IPs except `127.0.0.1`, no MACs, no account IDs).
They serve as the minimum-viable bootstrap response set the speaker needs
to come up cleanly.

If you want to regenerate them yourself (e.g. for a different speaker
firmware that wants different fields), spin up a SoundCork stack
locally per [the deborahgu/soundcork README](https://github.com/deborahgu/soundcork),
press a preset on a known-good speaker, and capture:

```bash
curl -s http://localhost:8000/bmx/registry/v1/services > services.json
curl -s http://localhost:8000/marge/streaming/sourceproviders > sourceproviders.xml
```

Sanity-check for personal data with grep before committing.

## The shepherdd daemon config

`shepherd-resolver.xml` gets pushed to
`/mnt/nv/shepherd/Shepherd-resolver.xml` on the speaker. `shepherdd` (the
speaker's process supervisor) reads this file at boot and supervises the
listed daemon — in our case `/bin/httpd` (busybox httpd) bound to
`127.0.0.1:8181` with the resolver tree as docroot.

If the daemon dies, shepherdd restarts it automatically. Verify with:

```bash
ssh root@<speaker-ip> 'cat /mnt/nv/shepherd/pids' | grep httpd
```

## Adding non-TuneIn stations

`build.py` only handles TuneIn. If you want a preset that points at a
direct stream URL (not via TuneIn — e.g. an internet radio station that
isn't in TuneIn's catalogue, or your own Icecast server), hand-edit a
JSON file with the structure above and a unique made-up `s`-prefixed
ID, drop it in `/mnt/nv/resolver/bmx/tunein/v1/playback/station/`, and
assign it as a preset using the API (see
[`../docs/customizing-presets.md`](../docs/customizing-presets.md) §
"Option B").

Patches to `build.py` adding direct-URL support are welcome.
