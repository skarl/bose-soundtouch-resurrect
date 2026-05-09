// now-playing — placeholder for slice 1.
// 0.2 slice 6 fills in the polled read-only header strip; 0.3 promotes
// this view to the full home view (transport, volume, source, presets).
// See admin/PLAN.md § View specs / now-playing.

import { html, mount } from '../dom.js';

export default {
  init(root /* , store, ctx */) {
    mount(root, html`
      <section class="placeholder" data-view="now-playing">
        <h1>Now playing</h1>
        <p>Coming in 0.3 (header strip lands in slice 6).</p>
      </section>
    `);
  },
  update(/* state, changedKey */) {
    // no-op until slice 6 wires speaker.nowPlaying / speaker.presets
  },
};
