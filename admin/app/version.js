// Version-drift detection.
//
// On boot we capture the in-memory admin version from the
// <meta name="admin-version"> tag that admin/deploy.sh substituted at
// deploy time. Whenever the tab returns to the foreground we re-fetch
// /index.html (cache-busted) and compare. A mismatch means the
// speaker has been redeployed under us, so we mount a non-dismissable
// banner offering a Reload button.
//
// We never auto-reload — a stale tab is annoying, but yanking it from
// under a user mid-action is worse.
//
// See admin/PLAN.md § Build, deploy, uninstall → Cache busting + version
// drift, and the "Stale tab after redeploy" row in the failure-modes
// table.

const META_SELECTOR = 'meta[name="admin-version"]';
const BANNER_ID = 'version-drift-banner';

function readMetaVersion(doc) {
  const el = doc.querySelector(META_SELECTOR);
  return el ? el.getAttribute('content') : null;
}

async function fetchServerVersion() {
  // Cache-busted GET so we hit busybox httpd, not a stale browser
  // cache. We don't need the Date here — `Date.now()` is enough and
  // matches the URL pattern called out in PLAN.md.
  const url = `/index.html?_=${Date.now()}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`fetch /index.html → ${res.status}`);
  const text = await res.text();
  const parsed = new DOMParser().parseFromString(text, 'text/html');
  return readMetaVersion(parsed);
}

function mountBanner() {
  if (document.getElementById(BANNER_ID)) return;
  const banner = document.createElement('div');
  banner.id = BANNER_ID;
  banner.setAttribute('role', 'alert');
  const msg = document.createElement('span');
  msg.textContent = 'new version available, reload to update';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Reload';
  btn.addEventListener('click', () => location.reload());
  banner.append(msg, btn);
  document.body.prepend(banner);
}

export function installVersionDriftCheck({
  doc = document,
  fetcher = fetchServerVersion,
  mounter = mountBanner,
} = {}) {
  const current = readMetaVersion(doc);
  if (!current) return; // No meta — running in a dev preview; nothing to do.

  let checking = false;
  const onVisible = async () => {
    if (doc.visibilityState !== 'visible') return;
    if (checking) return;
    if (doc.getElementById(BANNER_ID)) return; // already shown
    checking = true;
    try {
      const served = await fetcher();
      if (served && served !== current) mounter();
    } catch (_e) {
      // Network blip — silently ignore; we'll retry next visibility flip.
    } finally {
      checking = false;
    }
  };
  doc.addEventListener('visibilitychange', onVisible);
  return onVisible; // returned for tests / hand-tracing
}
