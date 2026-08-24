import fs from 'node:fs';

const affiliateRoutesUrl = new URL('../affiliateRoutes.js', import.meta.url);
const source = fs.readFileSync(affiliateRoutesUrl, 'utf8');

const broken = String.raw`if (!confirm('Delete ' + a.display_name + '?\n\n' + appleNotice)) return;`;
const fixed = String.raw`if (!confirm('Delete ' + a.display_name + '?\\n\\n' + appleNotice)) return;`;

if (source.includes(broken)) {
  fs.writeFileSync(affiliateRoutesUrl, source.replace(broken, fixed));
} else if (!source.includes(fixed)) {
  throw new Error('Affiliate Admin Delete confirmation render guard could not locate the expected source.');
}

await import('../server.js');
