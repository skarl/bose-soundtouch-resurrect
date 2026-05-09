"""
Contract test for resolver/build.py:make_bose — asserts output matches
the shared fixtures in admin/test/fixtures/. The Node suite
admin/test/test_reshape.js reads the SAME fixtures and asserts the JS
reshape() matches them. Drift between the two implementations becomes
a red CI build, not a silent runtime bug.

Run locally:
    python -m unittest discover resolver/

See admin/PLAN.md § Testing strategy.
"""
import json
import os
import unittest

from build import make_bose


HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES_DIR = os.path.normpath(os.path.join(HERE, "..", "admin", "test", "fixtures"))


def _read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


class ReshapeContract(unittest.TestCase):
    """Each manifest entry is a (sid, name, case) triple. For every
    entry, make_bose(sid, name, tunein) must equal the matching
    <sid>.bose.json fixture."""

    @classmethod
    def setUpClass(cls):
        cls.manifest = _read_json(os.path.join(FIXTURES_DIR, "manifest.json"))

    def test_manifest_has_at_least_two_cases(self):
        # Required by issue #10 acceptance: at least 2 fixture pairs
        # covering playable + gated. A failure here means a contributor
        # accidentally pruned the suite below its contractual minimum.
        cases = {entry["case"] for entry in self.manifest}
        self.assertIn("playable", cases)
        self.assertIn("gated", cases)
        self.assertGreaterEqual(len(self.manifest), 2)

    def test_every_fixture_matches(self):
        for entry in self.manifest:
            sid = entry["sid"]
            name = entry["name"]
            case = entry["case"]
            with self.subTest(sid=sid, case=case):
                tunein = _read_json(os.path.join(FIXTURES_DIR, f"{sid}.tunein.json"))
                expected = _read_json(os.path.join(FIXTURES_DIR, f"{sid}.bose.json"))
                actual = make_bose(sid, name, tunein)
                self.assertEqual(actual, expected)


if __name__ == "__main__":
    unittest.main()
