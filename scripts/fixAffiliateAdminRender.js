import fs from 'node:fs';

const affiliateRoutesUrl = new URL('../affiliateRoutes.js', import.meta.url);
const source = fs.readFileSync(affiliateRoutesUrl, 'utf8');

const broken = String.raw`if (!confirm('Delete ' + a.display_name + '?\n\n' + appleNotice)) return;`;
const fixed = String.raw`if (!confirm('Delete ' + a.display_name + '?\\n\\n' + appleNotice)) return;`;

if (source.includes(broken)) {
  fs.writeFileSync(affiliateRoutesUrl, source.replace(broken, fixed));
  console.log('[build] Fixed Affiliate Admin rendered JavaScript escaping.');
} else if (source.includes(fixed)) {
  console.log('[build] Affiliate Admin rendered JavaScript escaping already fixed.');
} else {
  throw new Error('Affiliate Admin render patch could not locate the expected Delete confirmation source.');
}
