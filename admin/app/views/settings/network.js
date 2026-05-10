import { html, mount, defineView } from '../../dom.js';

export default defineView({
  mount(root) {
    mount(root, html`<p class="placeholder">Network settings — coming in #42</p>`);
    return {};
  },
});
