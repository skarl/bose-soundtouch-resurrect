import { html, mount, defineView } from '../../dom.js';

export default defineView({
  mount(root) {
    mount(root, html`<p class="placeholder">Audio settings — coming in #35</p>`);
    return {};
  },
});
