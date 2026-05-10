// settings — #/settings shell.
//
// Renders six collapsible <details> sections in the order
// Speaker · Audio · Bluetooth · Multi-room · Network · System. Each
// section's body is mounted via mountChild into a per-section sub-view
// under app/views/settings/. Sub-views own their own subscriptions and
// fetchers; the shell only wires the frame.
//
// See admin/PLAN.md § View specs / settings.

import { html, mount, defineView, mountChild } from '../dom.js';

import speakerSection   from './settings/speaker.js';
import audioSection     from './settings/audio.js';
import bluetoothSection from './settings/bluetooth.js';
import multiroomSection from './settings/multiroom.js';
import networkSection   from './settings/network.js';
import systemSection    from './settings/system.js';

const SECTIONS = [
  { id: 'speaker',   label: 'Speaker',    view: speakerSection },
  { id: 'audio',     label: 'Audio',      view: audioSection },
  { id: 'bluetooth', label: 'Bluetooth',  view: bluetoothSection },
  { id: 'multiroom', label: 'Multi-room', view: multiroomSection },
  { id: 'network',   label: 'Network',    view: networkSection },
  { id: 'system',    label: 'System',     view: systemSection },
];

export default defineView({
  mount(root, store, _ctx, env) {
    mount(root, html`
      <section class="settings-view" data-view="settings">
        <h1 class="settings-title">Settings</h1>
        <div class="settings-sections"></div>
      </section>
    `);

    const sectionsEl = root.querySelector('.settings-sections');

    for (const section of SECTIONS) {
      const details = document.createElement('details');
      details.className = 'settings-section';
      details.dataset.section = section.id;

      const summary = document.createElement('summary');
      summary.className = 'settings-section__summary';
      summary.textContent = section.label;
      details.appendChild(summary);

      const body = document.createElement('div');
      body.className = 'settings-section__body';
      details.appendChild(body);

      sectionsEl.appendChild(details);
      mountChild(body, section.view, store, {}, env);
    }

    return {};
  },
});
