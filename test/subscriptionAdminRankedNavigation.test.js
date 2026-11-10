import test from 'node:test';
import assert from 'node:assert/strict';
import { enhanceSubscriptionAdminRankedHtml } from '../lib/subscriptionAdminRankedUi.js';

test('Ranked Management becomes a registered, visible dashboard view', () => {
  // These are the exact view-routing fragments produced by the Accounts enhancer.
  // The regression was a nav button without corresponding switchView registration.
  const html = `
    <button class="nav" data-view="accounts">Accounts</button>
    <section id="view-history" class="hidden"></section>
    <script>
      function eventParams(){}
      function switchView(view){
        ['overview','breakdown','accounts','customers','history','events'].forEach(v=>qs('#view-'+v).classList.toggle('hidden',v!==view));
        const meta={accounts:['Accounts','Registered Agora accounts and account creation over time'],}[view];
        qs('#pageTitle').textContent=meta[0]; qs('#pageSub').textContent=meta[1];
        if(view==='accounts')loadAccounts();
      }
    </script>`;
  const output = enhanceSubscriptionAdminRankedHtml(html);
  assert.match(output, /data-view="ranked"/);
  assert.match(output, /id="view-ranked"/);
  assert.match(output, /\['overview','breakdown','accounts','ranked','customers','history','events'\]/);
  assert.match(output, /ranked:\['Ranked Management','Manage Ranked RP and restore unfair losses'\]/);
  assert.match(output, /if\(view==='ranked'\)loadRanked\(\)/);
  assert.match(output, /function rankedApplyNow\(/);
  const client = output.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(client);
  assert.doesNotThrow(() => new Function(client));
});

test('Ranked Management clearly labels users with unfinished placements', () => {
  const html = `<button class="nav" data-view="accounts">Accounts</button>
  <section id="view-history" class="hidden"></section><script>function eventParams(){}</script>`;
  const output = enhanceSubscriptionAdminRankedHtml(html);
  assert.match(output, /function rankedAccountStatus\(a\)/);
  assert.match(output, /a\.placement_status==='in_progress'/);
  assert.match(output, /Placements · /);
  assert.match(output, /a\.placement_trials_completed/);
  assert.match(output, /esc\(rankedAccountStatus\(a\)\)/);
});
