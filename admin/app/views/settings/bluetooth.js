import { html, mount, defineView } from '../../dom.js';

export default defineView({
  mount(root) {
    mount(root, html`<p class="placeholder">Bluetooth settings — coming in #37</p>`);
    return {};
  },
});
