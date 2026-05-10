"""
Bulk-refresh helper: decide whether a freshly-probed TuneIn response
warrants rewriting the on-disk resolver JSON for a given station.

The on-speaker `cgi-bin/api/v1/refresh-all` CGI is busybox-shell + awk
because Bo's firmware has no Python. This module exists to (a) document
the canonical decision rule and (b) keep the CGI's shell rewrite
honest — the same `make_bose()` from `build.py` produces the JSON shape
both `app/reshape.js` (browser preview path) and `build.py` (laptop
preset bootstrap) emit, so any drift between the three implementations
fails the shared fixture suite.

Public surface:
    extract_stream_urls(bose_json) -> list[str]
        Pull the ordered list of streamUrl strings from a Bose-shape
        resolver JSON. Returns [] if the structure isn't recognised.

    streams_match(current_json, new_json) -> bool
        True when both inputs expose the same ordered list of streamUrl
        strings. None on either side counts as "no streams".

    update_or_unchanged(sid, name, tunein, current_json) -> dict
        Decide what to do with a freshly-probed station. Returns one of:
            {"action": "unchanged",  "json": current_json}
            {"action": "updated",    "json": <new bose-shape dict>}
            {"action": "failed",     "error": "<reason>"}
        `failed` covers two cases: the TuneIn response had no compatible
        streams (make_bose returned None) AND no on-disk fallback worth
        keeping; or the input shape is otherwise unparseable.
"""
import json

from build import make_bose


def extract_stream_urls(bose_json):
    if not isinstance(bose_json, dict):
        return []
    audio = bose_json.get("audio")
    if not isinstance(audio, dict):
        return []
    streams = audio.get("streams")
    if not isinstance(streams, list):
        return []
    out = []
    for s in streams:
        if isinstance(s, dict):
            url = s.get("streamUrl")
            if isinstance(url, str) and url:
                out.append(url)
    return out


def streams_match(current_json, new_json):
    return extract_stream_urls(current_json) == extract_stream_urls(new_json)


def update_or_unchanged(sid, name, tunein, current_json):
    new_json = make_bose(sid, name, tunein)
    if new_json is None:
        # TuneIn returned no compatible streams. Don't clobber an
        # existing on-disk file with null — leave whatever's there.
        return {
            "action": "failed",
            "error": "no compatible streams in TuneIn response",
        }
    if streams_match(current_json, new_json):
        return {"action": "unchanged", "json": current_json}
    return {"action": "updated", "json": new_json}


def name_from_current(current_json, fallback=""):
    """Pull the station's `name` from an on-disk Bose JSON. Used by
    the CGI to avoid re-fetching the friendly name from /presets when
    rewriting — the resolver JSON is the source of truth for the
    station's display name once it's been bootstrapped."""
    if isinstance(current_json, dict):
        n = current_json.get("name")
        if isinstance(n, str) and n:
            return n
    return fallback


def load_json_or_none(path):
    """Read a Bose-shape resolver JSON from disk. Returns None on any
    I/O or parse error so callers can treat "missing" and "corrupt" the
    same way (both trigger a fresh write)."""
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None
