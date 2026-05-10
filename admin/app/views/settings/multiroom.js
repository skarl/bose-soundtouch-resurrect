// multiroom — settings sub-view: deferred-feature stub.
//
// Multi-room requires a second SoundTouch on the LAN, which can't be
// exercised on the test rig (Bo). State, parsers (parseZoneXml,
// parseListMediaServersXml), actions (setZone / addZoneSlave /
// removeZoneSlave), and tests are all retained in the codebase so a
// future release can revive the picker without re-deriving the seam.
// See issue #35.

import { html, mount, defineView } from '../../dom.js';

export default defineView({
  mount(root) {
    mount(root, html`
      <div class="settings-multiroom" data-section="multiroom">
        <p class="settings-multiroom__stub">
          Multi-room requires a second SoundTouch on the LAN.
          Not implemented in this release.
        </p>
      </div>
    `);
    return {};
  },
});
