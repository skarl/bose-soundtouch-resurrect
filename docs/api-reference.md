# SoundTouch local API reference

The speaker firmware exposes 102 endpoints on **TCP 8090**, plain HTTP,
LAN-local. They don't depend on any cloud service — they're served by
the firmware itself. Useful for automation, scripting, and the admin UI
this project plans to ship.

There's also a **WebSocket on TCP 8080** for real-time events (button
presses, track changes, volume, source changes, play state). Connect
with any WebSocket client, no auth.

The endpoints below were extracted by querying `/supportedURLs` on a
SoundTouch 10 with firmware 27.0.6. Other firmware versions add or
remove endpoints; `/supportedURLs` is always self-describing.

## Querying conventions

- **Read endpoints**: `GET <endpoint>` (or `GET <endpoint>?param=value`).
- **Write endpoints**: `POST <endpoint>` with XML body.
  `Content-Type: application/xml`.
- **Responses**: XML by default. Element root usually matches the endpoint
  name; errors come back as `<errors>` blocks.
- **Auth**: none on the LAN. Anyone on the same network can do anything.

For the rest of this doc, replace `<speaker-ip>` with your speaker's
LAN IP.

## Status / info (read-only)

| Endpoint                          | Purpose                                                |
| --------------------------------- | ------------------------------------------------------ |
| `/info`                           | Device identity, model, firmware, MAC, IP              |
| `/capabilities`                   | What the speaker supports (DSP, stereo pair, etc.)     |
| `/networkInfo`                    | Active network interface details                       |
| `/netStats`                       | Network counters                                       |
| `/sources`                        | All music sources + status (READY / UNAVAILABLE)       |
| `/supportedURLs`                  | This list, self-served                                 |
| `/soundTouchConfigurationStatus`  | Setup state (paired? configured?)                      |
| `/sourceDiscoveryStatus`          | DLNA / UPnP scan status                                |
| `/serviceAvailability`            | Per-music-service availability                         |
| `/bluetoothInfo`                  | BT pairing state                                       |
| `/trackInfo`                      | Detailed metadata of current track                     |
| `/stationInfo`                    | Detail of the current station                          |
| `/getActiveWirelessProfile`       | Current Wi-Fi credentials (SSID etc.)                  |

## Now playing / playback

| Endpoint                          | Purpose                                                |
| --------------------------------- | ------------------------------------------------------ |
| `/now_playing` / `/nowPlaying`    | What's playing right now (XML)                         |
| `/nowSelection`                   | Currently selected source                              |
| `/select`                         | POST a `ContentItem` to start playback                 |
| `/selectPreset`                   | POST `<preset id="N"/>` — same effect as preset button |
| `/selectLastSource`               | Resume previous source                                 |
| `/selectLastWiFiSource`           | Resume last network source                             |
| `/selectLastSoundTouchSource`     | Resume last cloud-backed source                        |
| `/selectLocalSource`              | Switch to AUX or BT                                    |
| `/playbackRequest`                | Generic playback POST                                  |
| `/userPlayControl`                | Play / pause / stop                                    |
| `/userTrackControl`               | Skip / previous / shuffle / repeat                     |
| `/userRating`                     | Like / dislike (Pandora-style)                         |
| `/key`                            | Emulate any front-panel button press                   |

## Presets

| Endpoint                          | Purpose                                                |
| --------------------------------- | ------------------------------------------------------ |
| `/presets`                        | List all 6 presets                                     |
| `/storePreset`                    | Save current playback as preset N                      |
| `/removePreset`                   | Clear preset N                                         |
| `/selectPreset`                   | Recall preset N (same as physical button)              |

## Sources & music services

| Endpoint                          | Purpose                                                |
| --------------------------------- | ------------------------------------------------------ |
| `/nameSource`                     | Rename a source                                        |
| `/setMusicServiceAccount`         | Bind a music-service account (legacy)                  |
| `/setMusicServiceOAuthAccount`    | Bind an OAuth account (Spotify etc.)                   |
| `/removeMusicServiceAccount`      | Unbind                                                 |
| `/searchStation`                  | Search for radio stations                              |
| `/addStation` / `/removeStation`  | Maintain station favorites                             |
| `/genreStations`                  | Browse by genre                                        |
| `/search`                         | Cross-source search                                    |
| `/navigate`                       | Browse hierarchies (Spotify playlists, DLNA folders)   |
| `/listMediaServers`               | List discovered DLNA / UPnP servers                    |
| `/recents`                        | Recently played history                                |
| `/bookmark`                       | Bookmark current track                                 |

## Audio control

| Endpoint                          | Purpose                                                |
| --------------------------------- | ------------------------------------------------------ |
| `/volume`                         | GET / POST volume (0–100)                              |
| `/bass`                           | GET / POST bass level                                  |
| `/bassCapabilities`               | Bass adjustment range                                  |
| `/balance`                        | GET / POST L/R balance                                 |
| `/DSPMonoStereo`                  | Mono / stereo switch                                   |

## Power / standby

| Endpoint                          | Purpose                                                |
| --------------------------------- | ------------------------------------------------------ |
| `/setPower`                       | Power state                                            |
| `/standby`                        | Enter standby                                          |
| `/lowPowerStandby`                | Deep standby                                           |
| `/powersaving`                    | Power-saving mode                                      |
| `/systemtimeout`                  | Auto-standby timeout                                   |
| `/userActivity`                   | Mark user activity (resets timeout)                    |
| `/powerManagement`                | Battery / power state (irrelevant for ST10)            |

## Multi-room / stereo pair

| Endpoint                          | Purpose                                                |
| --------------------------------- | ------------------------------------------------------ |
| `/getZone` / `/setZone`           | Multi-room zone state                                  |
| `/addZoneSlave` / `/removeZoneSlave` | Add/drop slaves to zone                             |
| `/addGroup` / `/removeGroup`      | Group management                                       |
| `/getGroup` / `/updateGroup`      | Group introspection                                    |
| `/speaker`                        | Per-speaker config inside a group                      |
| `/slaveMsg` / `/masterMsg`        | Internal multi-room comms                              |
| `/rebroadcastlatencymode`         | Sync latency mode                                      |

## Bluetooth pairing

| Endpoint                          | Purpose                                                |
| --------------------------------- | ------------------------------------------------------ |
| `/enterBluetoothPairing`          | Enter BT pairing mode                                  |
| `/clearBluetoothPaired`           | Clear paired BT list                                   |
| `/enterPairingMode` (deprecated)  | Old name for the above                                 |
| `/clearPairedList` (deprecated)   | Old name                                               |
| `/setPairedStatus` / `/setPairingStatus` | Pairing state setters                            |
| `/pairLightswitch` / `/cancelPairLightswitch` | Bose lightswitch accessory pairing          |

## Wi-Fi setup

| Endpoint                          | Purpose                                                |
| --------------------------------- | ------------------------------------------------------ |
| `/performWirelessSiteSurvey`      | Scan for Wi-Fi networks                                |
| `/addWirelessProfile`             | Add Wi-Fi credentials                                  |
| `/setWiFiRadio`                   | Toggle Wi-Fi radio                                     |
| `/setup`                          | Run setup workflow                                     |

## Software updates

| Endpoint                          | Purpose                                                |
| --------------------------------- | ------------------------------------------------------ |
| `/swUpdateCheck`                  | Check for update                                       |
| `/swUpdateQuery`                  | Query update state                                     |
| `/swUpdateStart`                  | Start update                                           |
| `/swUpdateAbort`                  | Abort update                                           |

## Notifications / TTS

| Endpoint                          | Purpose                                                |
| --------------------------------- | ------------------------------------------------------ |
| `/notification`                   | Push a notification (banner/icon)                      |
| `/playNotification`               | TTS-style audio alert                                  |

## Bose cloud bridge ("marge")

| Endpoint                          | Purpose                                                |
| --------------------------------- | ------------------------------------------------------ |
| `/marge`                          | Bridge to Bose cloud (replaced by our resolver)        |
| `/setMargeAccount`                | Bind a Bose account                                    |
| `/pushCustomerSupportInfoToMarge` | Diagnostic upload                                      |

## System / identity

| Endpoint                          | Purpose                                                |
| --------------------------------- | ------------------------------------------------------ |
| `/name`                           | Speaker friendly name                                  |
| `/language`                       | UI language                                            |
| `/factoryDefault`                 | Factory reset                                          |
| `/setProductSerialNumber`         | Override serial (!)                                    |
| `/setProductSoftwareVersion`      | Override version (!)                                   |
| `/setComponentSoftwareVersion`    | Override component versions                            |
| `/criticalError`                  | Report critical error state                            |
| `/clockDisplay` / `/clockTime`    | Clock display config                                   |

## Diagnostic / undocumented

| Endpoint                          | Purpose (uncertain)                                    |
| --------------------------------- | ------------------------------------------------------ |
| `/introspect`                     | Self-describing API; needs `?op=` param                |
| `/test`                           | Internal test hooks                                    |
| `/pdo`                            | Probably "Persistent Data Object" — internal           |
| `/requestToken`                   | Token issuance — for what isn't clear                  |
| `/getBCOReset` / `/setBCOReset`   | Some kind of reset state ("BCO")                       |
| `/art`                            | Album art fetch                                        |

## WebSocket events (port 8080)

Connect to `ws://<speaker-ip>:8080/` with the **`gabbo` subprotocol**:

```bash
wscat -s gabbo -c ws://<speaker-ip>:8080/
```

```js
new WebSocket("ws://<speaker-ip>:8080/", "gabbo")
```

**The subprotocol is mandatory.** A connection without it succeeds
and returns the `<SoundTouchSdkInfo>` hello frame, but the speaker
never pushes state-change events afterwards. With `gabbo`, events
flow on any state change — no application-level subscribe message
required.

Events arrive wrapped in `<updates deviceID="…">…</updates>`. The
inner element is the actual event:

- `<volumeUpdated>` — volume changed
- `<nowPlayingUpdated>` — track changed / source changed (incl. STANDBY transition)
- `<nowSelectionUpdated>` — preset selected (reports which slot, which station)
- `<sourcesUpdated>` — source list changed
- `<keyEvent>` — key press/release (may fire only for some keys; not reliably observed for preset buttons)
- `<bassUpdated>` / `<balanceUpdated>` / etc.
- `<connectionStateUpdated>` — Wi-Fi state changed
- `<presetsUpdated>` — preset stored / removed
- `<zoneUpdated>` — multi-room zone changed

Two events arrive **outside** the `<updates>` envelope (self-closing,
top-level):

- `<SoundTouchSdkInfo serverVersion="…" serverBuild="…"/>` — hello
  frame on connect; useful as a "WS is truly ready" readiness signal.
- `<userActivityUpdate deviceID="…" />` — heartbeat-style ping
  whenever the user does something on the speaker.

Confirmed by two open-source SoundTouch clients that Home Assistant
and others use:
[CharlesBlonde/libsoundtouch](https://github.com/CharlesBlonde/libsoundtouch)
and
[thlucas1/bosesoundtouchapi](https://github.com/thlucas1/bosesoundtouchapi).
Bose's own Webservices PDF specifies `gabbo` as the WebSocket
subprotocol name.

## The `sender` attribute on `/key`

The `sender` attribute on `<key>` requests is validated by the firmware.
**`Gabbo` is accepted** — it's a magic word baked into the firmware,
also required as the WebSocket subprotocol on port 8080 (see above).
Bose's internal SoundTouch SDK uses it in both contexts. Random strings
like `api` get rejected with HTTP 400. The full whitelist of accepted
`<key sender="…">` values isn't documented; if you discover other
accepted values, please open an issue.

## Useful one-liners

```bash
SPEAKER=<speaker-ip>

# Volume up/down
curl -X POST -H 'Content-Type: application/xml' \
  -d '<volume>50</volume>' \
  http://$SPEAKER:8090/volume

# Press preset N (1..6) — NOTE: on firmware trunk r46330 (and probably
# others), PRESET_N key events return 200 but do NOT actually recall the
# preset. Use /select with the preset's stored ContentItem instead:
#   curl -X POST -H 'Content-Type: application/xml' \
#     -d '<ContentItem source="TUNEIN" sourceAccount="" type="stationurl" location="…"/>' \
#     http://$SPEAKER:8090/select
# See admin/app/views/now-playing.js#onPresetClick for the working path.
curl -X POST -H 'Content-Type: application/xml' \
  -d '<key state="press" sender="Gabbo">PRESET_3</key>' \
  http://$SPEAKER:8090/key
curl -X POST -H 'Content-Type: application/xml' \
  -d '<key state="release" sender="Gabbo">PRESET_3</key>' \
  http://$SPEAKER:8090/key

# Stream events (gabbo subprotocol is required)
wscat -s gabbo -c ws://$SPEAKER:8080/
# or with websocat:
websocat --protocol gabbo ws://$SPEAKER:8080/

# Push a notification banner
curl -X POST -H 'Content-Type: application/xml' \
  -d '<notify><sourceName>resolver</sourceName><sourceAccount>system</sourceAccount><message>Hello</message></notify>' \
  http://$SPEAKER:8090/notification
```

## Source files on the speaker

If you want to dig further, these files on the speaker (over SSH) define
the API:

```
/opt/Bose/etc/HandCraftedWebServer-SoundTouch.xml   # 73 PUBLIC operations
/opt/Bose/etc/WebServer-SoundTouch.xml              # additional routes
/opt/Bose/etc/services.json                         # source provider config
```

The route definitions evolve between firmware versions. Always re-pull
`/supportedURLs` after any firmware update.
