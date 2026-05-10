// settings — #/settings shell.
//
// Renders seven collapsible cards (NOT <details>): each section is a
// .settings-card with a button-driven header and a body region that
// only mounts when expanded. Order:
//   Appearance · Speaker · Audio · Bluetooth · Multi-room · Network · System
//
// Default open: Appearance only (theme picker is the most-touched
// control). The rest start collapsed; the user's expand/collapse choices
// live in component state and persist for as long as the view is mounted
// (no localStorage round-trip).

import { html, mount, defineView, mountChild } from '../dom.js';
import { icon } from '../icons.js';

import appearanceSection from './settings/appearance.js';
import speakerSection    from './settings/speaker.js';
import audioSection      from './settings/audio.js';
import bluetoothSection  from './settings/bluetooth.js';
import multiroomSection  from './settings/multiroom.js';
import networkSection    from './settings/network.js';
import systemSection     from './settings/system.js';

const SECTIONS = [
  { id: 'appearance', label: 'Appearance', icon: 'settings',  view: appearanceSection },
  { id: 'speaker',    label: 'Speaker',    icon: 'speaker',   view: speakerSection    },
  { id: 'audio',      label: 'Audio',      icon: 'music',     view: audioSection      },
  { id: 'bluetooth',  label: 'Bluetooth',  icon: 'bt',        view: bluetoothSection  },
  { id: 'multiroom',  label: 'Multi-room', icon: 'multiroom', view: multiroomSection  },
  { id: 'network',    label: 'Network',    icon: 'wifi',      view: networkSection    },
  { id: 'system',     label: 'System',     icon: 'cpu',       view: systemSection     },
];

const DEFAULT_OPEN = new Set(['appearance']);

export default defineView({
  mount(root, store, _ctx, env) {
    mount(root, html`
      <section class="settings-view" data-view="settings">
        <h1 class="settings-title">Settings</h1>
        <div class="settings-cards"></div>
      </section>
    `);

    const cardsEl = root.querySelector('.settings-cards');

    for (const section of SECTIONS) {
      const card = document.createElement('div');
      card.className = 'settings-card';
      card.dataset.section = section.id;

      const header = document.createElement('button');
      header.type = 'button';
      header.className = 'settings-card__header';
      header.setAttribute('aria-expanded', 'false');
      header.id = `settings-card-${section.id}-h`;

      const iconEl = document.createElement('span');
      iconEl.className = 'settings-card__icon';
      iconEl.appendChild(icon(section.icon, 16));
      header.appendChild(iconEl);

      const labelEl = document.createElement('span');
      labelEl.className = 'settings-card__label';
      labelEl.textContent = section.label;
      header.appendChild(labelEl);

      const chevron = document.createElement('span');
      chevron.className = 'settings-card__chevron';
      chevron.appendChild(icon('arrow', 14));
      header.appendChild(chevron);

      const body = document.createElement('div');
      body.className = 'settings-card__body';
      body.id = `settings-card-${section.id}-b`;
      body.hidden = true;
      header.setAttribute('aria-controls', body.id);

      card.appendChild(header);
      card.appendChild(body);
      cardsEl.appendChild(card);

      // Sub-views mount once on first expand. Mounting eagerly would
      // wire every section's WS subscriber + auto-fetch even when the
      // user only opens one card.
      let mounted = false;
      function ensureMounted() {
        if (mounted) return;
        mounted = true;
        mountChild(body, section.view, store, {}, env);
      }

      function setOpen(next) {
        const open = !!next;
        header.setAttribute('aria-expanded', open ? 'true' : 'false');
        card.dataset.open = open ? 'true' : 'false';
        body.hidden = !open;
        if (open) ensureMounted();
      }

      header.addEventListener('click', () => {
        const open = header.getAttribute('aria-expanded') === 'true';
        setOpen(!open);
      });

      setOpen(DEFAULT_OPEN.has(section.id));
    }

    return {};
  },
});
