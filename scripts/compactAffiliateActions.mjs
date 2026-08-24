import fs from 'node:fs';

const path = 'affiliateRoutes.js';
let source = fs.readFileSync(path, 'utf8');

const cssNeedle = `    .partner-name { font-weight: 750; color: #eee8f1; }\n`;
const cssReplacement = `    .partner-name { font-weight: 750; color: #eee8f1; }\n    .partner-link {\n      appearance: none; border: 0; padding: 0; margin: 0; background: transparent; color: #eee8f1;\n      font: inherit; font-weight: 750; text-align: left; cursor: pointer;\n    }\n    .partner-link:hover, .partner-link:focus-visible { color: var(--gold-soft); outline: none; }\n`;
if (!source.includes(cssNeedle)) throw new Error('partner-name CSS anchor not found');
source = source.replace(cssNeedle, cssReplacement);

const actionsCssNeedle = `    .actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }\n`;
const actionsCssReplacement = `    .actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }\n    .affiliate-actions { display: flex; gap: 6px; align-items: flex-start; flex-wrap: nowrap; }\n    .row-menu { margin: 0; }\n    .row-menu > summary {\n      list-style: none; width: 32px; height: 29px; display: inline-flex; align-items: center; justify-content: center;\n      border: 1px solid rgba(255,255,255,.09); background: rgba(255,255,255,.035); color: #ddd6e2;\n      border-radius: 9px; cursor: pointer; font-weight: 750; letter-spacing: .08em; user-select: none;\n    }\n    .row-menu > summary::-webkit-details-marker { display: none; }\n    .row-menu > summary:hover, .row-menu[open] > summary { background: rgba(255,255,255,.065); }\n    .row-menu-panel { display: flex; flex-direction: column; align-items: stretch; gap: 6px; margin-top: 6px; min-width: 124px; }\n    .row-menu-panel .button { white-space: nowrap; text-align: left; }\n`;
if (!source.includes(actionsCssNeedle)) throw new Error('actions CSS anchor not found');
source = source.replace(actionsCssNeedle, actionsCssReplacement);

const rowNeedle = `          '<td><div class="partner-name">' + html(a.display_name) + '</div><div class="muted tiny">Since ' + html(String(a.affiliate_since || '').slice(0,10)) + '</div></td>' +\n`;
const rowReplacement = `          '<td><button class="partner-link" type="button" data-action="details" data-id="' + html(a.id) + '">' + html(a.display_name) + '</button><div class="muted tiny">Since ' + html(String(a.affiliate_since || '').slice(0,10)) + '</div></td>' +\n`;
if (!source.includes(rowNeedle)) throw new Error('partner row anchor not found');
source = source.replace(rowNeedle, rowReplacement);

const buttonBlockNeedle = `          '<td><div class="actions">' +\n            '<button class="button small" data-action="details" data-id="' + html(a.id) + '">Details</button>' +\n            '<button class="button small" data-action="dashboard" data-id="' + html(a.id) + '">Dashboard</button>' +\n            (canToggle ? '<button class="button small ' + (operationalActive ? 'danger' : 'gold') + '" data-action="toggle" data-id="' + html(a.id) + '" data-active="' + (operationalActive ? 'false' : 'true') + '">' + (operationalActive ? 'Pause' : 'Activate') + '</button>' : '') +\n            '<button class="button small danger" data-action="delete" data-id="' + html(a.id) + '">Delete</button>' +\n          '</div></td>' +\n`;
const buttonBlockReplacement = `          '<td><div class="affiliate-actions">' +\n            '<button class="button small" data-action="dashboard" data-id="' + html(a.id) + '">Dashboard</button>' +\n            '<details class="row-menu"><summary title="More actions" aria-label="More actions">•••</summary><div class="row-menu-panel">' +\n              (canToggle ? '<button class="button small ' + (operationalActive ? '' : 'gold') + '" data-action="toggle" data-id="' + html(a.id) + '" data-active="' + (operationalActive ? 'false' : 'true') + '">' + (operationalActive ? 'Pause Affiliate' : 'Activate Affiliate') + '</button>' : '') +\n              '<button class="button small danger" data-action="delete" data-id="' + html(a.id) + '">Delete Affiliate</button>' +\n            '</div></details>' +\n          '</div></td>' +\n`;
if (!source.includes(buttonBlockNeedle)) throw new Error('affiliate action button block anchor not found');
source = source.replace(buttonBlockNeedle, buttonBlockReplacement);

fs.writeFileSync(path, source);
console.log('Compacted Affiliate Admin row actions without touching unlock/auth logic.');
