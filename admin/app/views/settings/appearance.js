// appearance — settings sub-view: 4-way segmented theme picker.
//
// Wires the user's choice through theme.setTheme(), which persists to
// localStorage and re-applies the resolved palette synchronously. The
// import-time apply in theme.js guarantees no flash-of-wrong-theme on
// page load; mounting the picker just reflects the current preference.

import { html, mount, defineView } from '../../dom.js';
import * as theme from '../../theme.js';

const OPTIONS = [
  { value: 'auto',     label: 'Auto'     },
  { value: 'graphite', label: 'Graphite' },
  { value: 'cream',    label: 'Cream'    },
  { value: 'terminal', label: 'Terminal' },
];

export default defineView({
  mount(root) {
    mount(root, html`
      <div class="settings-appearance">
        <div class="settings-segment" role="radiogroup" aria-label="Colour theme">
        </div>
        <p class="settings-hint">
          Auto follows the system light/dark setting (graphite or terminal).
          Cream is manual-only.
        </p>
      </div>
    `);

    const trackEl = root.querySelector('.settings-segment');

    const buttons = OPTIONS.map((opt) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'settings-segment__opt';
      btn.dataset.theme = opt.value;
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-label', opt.label);
      btn.textContent = opt.label;
      btn.addEventListener('click', () => {
        theme.setTheme(opt.value);
        paint();
      });
      trackEl.appendChild(btn);
      return btn;
    });

    function paint() {
      const cur = theme.current().preference;
      for (const b of buttons) {
        const active = b.dataset.theme === cur;
        b.setAttribute('aria-checked', active ? 'true' : 'false');
        b.dataset.active = active ? 'true' : 'false';
      }
    }

    paint();

    return {};
  },
});
