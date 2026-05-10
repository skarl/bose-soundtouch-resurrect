"""
Contract tests for resolver/refresh_all.py:update_or_unchanged.

Drives the same shared TuneIn fixtures used by test_build.py — adding
a "current resolver JSON" parameter to drive the unchanged / updated /
failed branches. Drift between this helper and build.py.make_bose
shows up here automatically because the helper imports make_bose.

Run locally:
    python -m unittest discover resolver/
"""
import json
import os
import unittest

from refresh_all import (
    extract_stream_urls,
    streams_match,
    update_or_unchanged,
    name_from_current,
    load_json_or_none,
)
from build import make_bose


HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES_DIR = os.path.normpath(
    os.path.join(HERE, "..", "admin", "test", "fixtures")
)


def _read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _tunein(sid):
    return _read_json(os.path.join(FIXTURES_DIR, f"{sid}.tunein.json"))


def _bose(sid):
    return _read_json(os.path.join(FIXTURES_DIR, f"{sid}.bose.json"))


class ExtractStreamUrls(unittest.TestCase):
    def test_pulls_ordered_list(self):
        urls = extract_stream_urls(_bose("s12345"))
        self.assertEqual(urls, [
            "http://streams.example.de/live/hqlivestream.aac",
            "http://streams.example.de/live/livestream.mp3",
        ])

    def test_none_input_returns_empty(self):
        self.assertEqual(extract_stream_urls(None), [])

    def test_missing_audio_returns_empty(self):
        self.assertEqual(extract_stream_urls({"name": "x"}), [])

    def test_missing_streams_returns_empty(self):
        self.assertEqual(extract_stream_urls({"audio": {}}), [])


class StreamsMatch(unittest.TestCase):
    def test_identical_files_match(self):
        a = _bose("s12345")
        b = _bose("s12345")
        self.assertTrue(streams_match(a, b))

    def test_disjoint_streams_dont_match(self):
        a = _bose("s12345")
        b = _bose("s67890")
        self.assertFalse(streams_match(a, b))

    def test_none_vs_none_matches(self):
        self.assertTrue(streams_match(None, None))

    def test_order_sensitive(self):
        a = _bose("s12345")
        b = json.loads(json.dumps(a))
        b["audio"]["streams"].reverse()
        self.assertFalse(streams_match(a, b))


class UpdateOrUnchanged(unittest.TestCase):
    def test_unchanged_when_streams_match_on_disk(self):
        sid, name = "s12345", "Example Radio"
        current = _bose(sid)
        result = update_or_unchanged(sid, name, _tunein(sid), current)
        self.assertEqual(result["action"], "unchanged")
        self.assertIs(result["json"], current)

    def test_updated_when_on_disk_is_different_station(self):
        # Feed s12345's tunein response with s67890's on-disk JSON; the
        # streams differ so the helper must signal "updated" with the
        # newly-built JSON.
        sid, name = "s12345", "Example Radio"
        current = _bose("s67890")
        result = update_or_unchanged(sid, name, _tunein(sid), current)
        self.assertEqual(result["action"], "updated")
        self.assertEqual(result["json"], make_bose(sid, name, _tunein(sid)))

    def test_updated_when_no_on_disk_file(self):
        sid, name = "s12345", "Example Radio"
        result = update_or_unchanged(sid, name, _tunein(sid), None)
        self.assertEqual(result["action"], "updated")
        self.assertIsInstance(result["json"], dict)

    def test_failed_when_tunein_has_no_playable_streams(self):
        # s99999 is the gated fixture — TuneIn returns only a
        # notcompatible.mp3 URL, so make_bose() returns None.
        sid, name = "s99999", "Gated Station"
        current = _bose("s12345")
        result = update_or_unchanged(sid, name, _tunein(sid), current)
        self.assertEqual(result["action"], "failed")
        self.assertIn("no compatible streams", result["error"])


class NameFromCurrent(unittest.TestCase):
    def test_pulls_name_from_dict(self):
        self.assertEqual(
            name_from_current(_bose("s12345"), "fallback"),
            "Example Radio",
        )

    def test_falls_back_when_missing(self):
        self.assertEqual(name_from_current(None, "fallback"), "fallback")

    def test_falls_back_when_name_empty(self):
        self.assertEqual(name_from_current({"name": ""}, "fb"), "fb")


class LoadJsonOrNone(unittest.TestCase):
    def test_returns_dict_for_valid_file(self):
        path = os.path.join(FIXTURES_DIR, "s12345.bose.json")
        loaded = load_json_or_none(path)
        self.assertIsInstance(loaded, dict)
        self.assertEqual(loaded["name"], "Example Radio")

    def test_returns_none_for_missing_file(self):
        self.assertIsNone(load_json_or_none("/no/such/file"))


if __name__ == "__main__":
    unittest.main()
