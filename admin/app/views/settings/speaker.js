import { html, mount, defineView } from '../../dom.js';

export default defineView({
  mount(root) {
    mount(root, html`<p class="placeholder">Speaker settings — coming in #34</p>`);
    return {};
  },
});
