#!/usr/bin/env python3
"""
Fetch fresh stream URLs from TuneIn's public API and emit Bose-shaped
JSON, one file per preset station.

Usage:
    cp stations.example.json stations.json
    # edit stations.json with your station IDs and friendly names
    python3 build.py

The script writes one file per station ID into the current directory.
The filename matches the TuneIn ID exactly (e.g. ./s12345). After this,
scp the files to your speaker:

    scp -O -oHostKeyAlgorithms=+ssh-rsa s[0-9]* \\
        root@<speaker-ip>:/mnt/nv/resolver/bmx/tunein/v1/playback/station/

See ../docs/customizing-presets.md for how to find a station's ID.
"""
import json
import os
import sys
import urllib.request


HERE = os.path.dirname(os.path.abspath(__file__))
STATIONS_FILE = os.path.join(HERE, "stations.json")
EXAMPLE_FILE = os.path.join(HERE, "stations.example.json")
OUT_DIR = os.getcwd()
USER_AGENT = "Bose_Lisa/27.0.6"


def load_stations() -> list[tuple[str, str]]:
    if not os.path.isfile(STATIONS_FILE):
        sys.exit(
            f"error: {STATIONS_FILE} doesn't exist.\n"
            f"       cp {EXAMPLE_FILE} {STATIONS_FILE} and edit it for "
            "your stations.\n"
            "       See ../docs/customizing-presets.md for how to find "
            "TuneIn IDs."
        )
    try:
        with open(STATIONS_FILE) as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        sys.exit(f"error: {STATIONS_FILE} is not valid JSON: {e}")

    if not isinstance(data, list) or not all(
        isinstance(x, list) and len(x) == 2 and all(isinstance(y, str) for y in x)
        for x in data
    ):
        sys.exit(
            f"error: {STATIONS_FILE} must be a JSON array of [id, name] "
            "pairs. See stations.example.json."
        )
    return [(sid, name) for sid, name in data]


def fetch_tunein(sid: str) -> dict:
    url = (
        f"https://opml.radiotime.com/Tune.ashx?id={sid}"
        "&render=json&formats=mp3,aac&lang=de-de"
    )
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


def make_bose(sid: str, name: str, tunein: dict) -> dict | None:
    streams = []
    for entry in tunein.get("body", []):
        u = entry.get("url", "")
        if not u or "notcompatible" in u:
            continue
        streams.append({
            "bufferingTimeout": 20,
            "connectingTimeout": 10,
            "hasPlaylist": True,
            "isRealtime": True,
            "streamUrl": u,
            "maxTimeout": 60,
        })
    if not streams:
        return None
    return {
        "_links": {
            "bmx_reporting": {
                "href": (
                    f"/v1/report?stream_id=e0&guide_id={sid}"
                    "&listen_id=0&stream_type=liveRadio"
                )
            },
            "bmx_favorite": {"href": f"/v1/favorite/{sid}"},
            "bmx_nowplaying": {
                "href": f"/v1/now-playing/station/{sid}",
                "useInternalClient": "ALWAYS",
            },
        },
        "audio": {
            "hasPlaylist": True,
            "isRealtime": True,
            "maxTimeout": 60,
            "streamUrl": streams[0]["streamUrl"],
            "streams": streams,
        },
        "imageUrl": "",
        "isFavorite": False,
        "name": name,
        "streamType": "liveRadio",
    }


def _write_station(sid: str, bose: dict) -> str:
    path = os.path.join(OUT_DIR, sid)
    with open(path, "w") as f:
        json.dump(bose, f, separators=(",", ":"))
    return path


def main(stations=None, _fetch=fetch_tunein, _writer=_write_station) -> int:
    # Exit 0 iff at least one station file was written. Partial success
    # is success for our purposes — deploy.sh's STATION_COUNT > 0 guard
    # is the real abort gate, and aborting on a single fetch error
    # silently kills the whole flow under `set -eu` (discussion #121).
    if stations is None:
        stations = load_stations()
    succeeded = 0
    failed = 0
    for sid, name in stations:
        try:
            tunein = _fetch(sid)
        except Exception as e:
            print(f"FAIL  {sid:8s} {name}: fetch error {e}", file=sys.stderr)
            failed += 1
            continue
        bose = make_bose(sid, name, tunein)
        if bose is None:
            print(
                f"WARN  {sid:8s} {name}: no compatible streams in TuneIn "
                "response (try a different station, or check that "
                "formats=mp3,aac&lang=de-de still unlocks the partner "
                "URLs)",
                file=sys.stderr,
            )
            failed += 1
            continue
        path = _writer(sid, bose)
        n = len(bose["audio"]["streams"])
        print(f"OK    {sid:8s} {name:24s}  {n} stream(s)  →  {path}")
        succeeded += 1
    total = succeeded + failed
    print(
        f"\nbuilt {succeeded} of {total} station(s); {failed} failed",
        file=sys.stderr,
    )
    return 0 if succeeded > 0 else 1


if __name__ == "__main__":
    sys.exit(main())
