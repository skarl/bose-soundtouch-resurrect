# TuneIn→Bose-shape lives in three implementations pinned by shared fixtures

The TuneIn-OPML JSON → on-disk Bose station JSON conversion is implemented
three times: `resolver/build.py:make_bose()` (laptop bootstrap +
`refresh_all.py` reuse it via import), `admin/cgi-bin/api/v1/refresh-all`
(busybox-shell + awk on the speaker), and `admin/app/reshape.js` (browser).
We accept this duplication and pin equivalence with a shared fixture suite
under `admin/test/fixtures/` exercised by `resolver/test_build.py` and
`admin/test/test_reshape.js`. Consolidation was considered and rejected:
the shell CGI cannot import Python idiomatically (subprocess startup cost
on Bo's firmware, awkward error surface), the browser cannot import
Python at all, and re-implementing the speaker side in something other
than busybox-shell breaks the "no extra runtime on the device" property
ADR'd implicitly by the on-device hosting decision. Future architecture
reviews should not re-suggest a single source of truth across the three
runtimes; if the fixture suite ever fails to catch a divergence, sharpen
the fixtures rather than collapse the implementations.
