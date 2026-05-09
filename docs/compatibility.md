# Compatibility

Which Bose SoundTouch speakers and firmware versions are confirmed to
work with this project, and how to confirm yours.

## Confirmed working

| Model              | Firmware                 | Notes |
| ------------------ | ------------------------ | ----- |
| SoundTouch 10      | 27.0.6.46330.5043500     | All six preset buttons working with the on-speaker resolver. The reference implementation is built and tested against this configuration. |

If you've successfully run this on any other model + firmware
combination, please open a PR adding it (see
[../CONTRIBUTING.md](../CONTRIBUTING.md) § "Compatibility reports").

## Likely to work, unverified

The project is expected to work on any SoundTouch-family speaker that
shares the same internal Linux + `shepherdd` + busybox architecture.
The full ST 10 / 20 / 30 line and the SoundTouch-equipped Wave variants
all use that architecture. Anything that exposes:

- A local API on TCP 8090 (check with `curl http://<speaker-ip>:8090/info`).
- Preset slots stored on the speaker (`curl http://<speaker-ip>:8090/presets`).
- An `OverrideSdkPrivateCfg.xml` mechanism on `/mnt/nv/`.

is a good candidate.

## Likely to NOT work

- The newer **Bose Home Speaker** line (Home Speaker 300/450/500). Those
  run a different firmware stack and don't expose the SoundTouch port-8090
  API in the same way.
- The **Bose Wireless Link Adapter** without an attached SoundTouch — it's
  a different product internally.
- Any speaker whose firmware predates the SoundTouch app era (you'd
  notice — those don't have preset buttons backed by cloud lookups in the
  first place).

## How to check whether your speaker is a candidate

Before going any further, run from a laptop on the same LAN as the
speaker:

```bash
curl http://<speaker-ip>:8090/info
curl http://<speaker-ip>:8090/supportedURLs
```

If both return XML with a recognisable model name and a long list of
endpoints (102 on a SoundTouch 10), you're in good shape. If the first
is silent or the second 404s, the speaker is on a different firmware
generation and this project won't help directly.

The SSH-enable USB-OTG trick described in
[opening-up-your-speaker.md](opening-up-your-speaker.md) is also
firmware-specific. It's known to work on firmware 27.x. Earlier
firmwares had a different trick (telnet to port 17000 and run
`remote_services on`); if your firmware predates 27.x you might be
able to use that older path instead, but it's outside the scope of
this project.

## Speakers vs. accounts

This project works on the **speaker hardware**. The Bose **account**
side of the SoundTouch ecosystem (favourites sync, cross-device history,
remote control over the internet) is permanently gone with the cloud
shutdown — no project can bring those back. What you get back is the
speaker as a standalone preset radio + AUX/Bluetooth/Spotify Connect
endpoint on your LAN.
