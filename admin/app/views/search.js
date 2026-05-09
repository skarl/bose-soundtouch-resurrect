// search — placeholder for slice 1.
// Real implementation lands in 0.2 slice 3 (search view).
// See admin/PLAN.md § View specs / search.

import { html, mount } from '../dom.js';

export default {
  init(root /* , store, ctx */) {
    mount(root, html`
      <section class="placeholder" data-view="search">
        <h1>Search</h1>
        <p>Coming in slice 3.</p>
      </section>
    `);
  },
  update(/* state, changedKey */) {
    // no-op
  },
};
