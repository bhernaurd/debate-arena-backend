import fs from 'node:fs';

const affiliateRoutesUrl = new URL('../affiliateRoutes.js', import.meta.url);
let source = fs.readFileSync(affiliateRoutesUrl, 'utf8');
let changed = false;

const broken = String.raw`if (!confirm('Delete ' + a.display_name + '?\n\n' + appleNotice)) return;`;
const fixed = String.raw`if (!confirm('Delete ' + a.display_name + '?\\n\\n' + appleNotice)) return;`;

if (source.includes(broken)) {
  source = source.replace(broken, fixed);
  changed = true;
  console.log('[build] Fixed Affiliate Admin rendered JavaScript escaping.');
} else if (source.includes(fixed)) {
  console.log('[build] Affiliate Admin rendered JavaScript escaping already fixed.');
} else {
  throw new Error('Affiliate Admin render patch could not locate the expected Delete confirmation source.');
}

const bootstrapMarker = 'data-affiliate-admin-unlock-bootstrap';
const adminScriptMarker = "  <script>\n    let adminKey = sessionStorage.getItem('agoraAffiliateAdminKey') || '';";

if (!source.includes(bootstrapMarker)) {
  if (!source.includes(adminScriptMarker)) {
    throw new Error('Affiliate Admin unlock bootstrap could not locate the admin script marker.');
  }

  const bootstrap = `  <script data-affiliate-admin-unlock-bootstrap>
    (() => {
      const storageKey = 'agoraAffiliateAdminKey';

      async function attemptUnlock() {
        const input = document.getElementById('adminKey');
        const errorEl = document.getElementById('loginError');
        const button = document.getElementById('unlockAdmin');
        const value = String(input?.value || '').trim();

        if (!value) {
          if (errorEl) errorEl.textContent = 'Enter the admin key.';
          return;
        }

        if (errorEl) errorEl.textContent = 'Checking key…';
        if (button) button.disabled = true;

        try {
          const response = await fetch('/api/admin/affiliates', {
            headers: {
              'x-admin-key': value,
              'x-admin-actor': 'owner_admin'
            }
          });

          let payload = null;
          try { payload = await response.json(); } catch { payload = null; }

          if (!response.ok) {
            if (response.status === 401) sessionStorage.removeItem(storageKey);
            const message = payload?.error?.message || ('Unlock failed (' + response.status + ').');
            if (errorEl) errorEl.textContent = message;
            return;
          }

          sessionStorage.setItem(storageKey, value);
          if (errorEl) errorEl.textContent = 'Key verified. Opening dashboard…';
          window.location.reload();
        } catch (error) {
          if (errorEl) errorEl.textContent = error?.message || 'Unable to contact the admin API.';
        } finally {
          if (button) button.disabled = false;
        }
      }

      window.addEventListener('DOMContentLoaded', () => {
        const button = document.getElementById('unlockAdmin');
        const input = document.getElementById('adminKey');

        button?.addEventListener('click', event => {
          event.preventDefault();
          event.stopImmediatePropagation();
          attemptUnlock();
        }, true);

        input?.addEventListener('keydown', event => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          event.stopImmediatePropagation();
          attemptUnlock();
        }, true);
      });
    })();
  </script>

`;

  source = source.replace(adminScriptMarker, bootstrap + adminScriptMarker);
  changed = true;
  console.log('[build] Added independent Affiliate Admin unlock bootstrap.');
} else {
  console.log('[build] Affiliate Admin unlock bootstrap already present.');
}

if (changed) {
  fs.writeFileSync(affiliateRoutesUrl, source);
}
