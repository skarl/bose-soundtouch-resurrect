import { html, mount, defineView } from '../../dom.js';

export default defineView({
  mount(root) {
    mount(root, html`<p class="placeholder">Multi-room settings — coming in #38</p>`);
    return {};
  },
});
