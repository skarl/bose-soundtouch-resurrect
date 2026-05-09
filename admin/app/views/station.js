// station — placeholder for slice 1.
// Real implementation lands in 0.2 slice 4 (station detail + reshape).
// See admin/PLAN.md § View specs / station detail.

import { html, mount } from '../dom.js';

export default {
  init(root, _store, ctx) {
    const id = (ctx && ctx.params && ctx.params.id) || '(no id)';
    mount(root, html`
      <section class="placeholder" data-view="station">
        <h1>Station ${id}</h1>
        <p>Coming in slice 4.</p>
      </section>
    `);
  },
  update(/* state, changedKey */) {
    // no-op
  },
};
