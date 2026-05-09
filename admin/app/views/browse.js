// browse — placeholder for slice 1.
// Real implementation lands in 0.2 slice 2 (browse view + tunein CGI).
// See admin/PLAN.md § View specs / browse.

import { html, mount } from '../dom.js';

export default {
  init(root /* , store, ctx */) {
    mount(root, html`
      <section class="placeholder" data-view="browse">
        <h1>Browse</h1>
        <p>Coming in slice 2.</p>
      </section>
    `);
  },
  update(/* state, changedKey */) {
    // no-op
  },
};
