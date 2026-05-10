// settings — #/settings shell.
//
// Renders seven collapsible <details> sections:
//   Appearance · Speaker · Audio · Bluetooth · Multi-room · Network · System
//
// Appearance, Speaker, and Audio are open by default; the rest start
// collapsed. <details>.open is part of the live DOM (not torn down on
// state change), so the user's expand/collapse choices persist for as
// long as the view is mounted. Sub-views own their own subscriptions
// and fetchers; the shell only wires the frame.

import { html, mount, defineView, mountChild } from '../dom.js';

import appearanceSection from './settings/appearance.js';
import speakerSection    from './settings/speaker.js';
import audioSection      from './settings/audio.js';
import bluetoothSection  from './settings/bluetooth.js';
import multiroomSection  from './settings/multiroom.js';
import networkSection    from './settings/network.js';
import systemSection     from './settings/system.js';

const SECTIONS = [
  { id: 'appearance', label: 'Appearance', view: appearanceSection, open: true },
  { id: 'speaker',    label: 'Speaker',    view: speakerSection,    open: true },
  { id: 'audio',      label: 'Audio',      view: audioSection,      open: true },
  { id: 'bluetooth',  label: 'Bluetooth',  view: bluetoothSection,  open: false },
  { id: 'multiroom',  label: 'Multi-room', view: multiroomSection,  open: false },
  { id: 'network',    label: 'Network',    view: networkSection,    open: false },
  { id: 'system',     label: 'System',     view: systemSection,     open: false },
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
      if (section.open) details.open = true;

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
