export function enhanceSubscriptionAdminAutoRenewHtml(html) {
  let output = String(html);

  output = output
    .replace(
      '      <div class="grid" id="breakdownMetrics"><div class="loading">Loading subscriber breakdown...</div></div>',
      '      <div class="renewal-freshness" id="renewalFreshness">Apple auto-renew verification: checking…</div>\\n      <div class="grid" id="breakdownMetrics"><div class="loading">Loading subscriber breakdown...</div></div>'
    )
    .replace(
      '.hidden { display:none !important; }',
      `.renewal-freshness { display:flex;align-items:center;gap:8px;margin:0 0 12px;padding:10px 12px;border:1px solid #233347;border-radius:10px;background:rgba(82,145,208,.08);color:#98bce2;font-size:11px;font-weight:650;line-height:1.35; }\n    .renewal-freshness.good { border-color:#234b38;background:rgba(60,170,111,.07);color:#91d5ad; }\n    .renewal-freshness.warn { border-color:#5a4820;background:rgba(210,166,69,.08);color:#d9bd76; }\n    .hidden { display:none !important; }`
    )
    .replace(
      '  let breakdownData=null;',
      `  let autoRenewVerificationData=null;\n  function verificationAge(value){\n    if(!value)return null; const date=new Date(value); if(Number.isNaN(date.getTime()))return null;\n    const seconds=Math.max(0,Math.floor((Date.now()-date.getTime())/1000));\n    if(seconds<45)return 'just now'; if(seconds<3600)return Math.floor(seconds/60)+'m ago'; if(seconds<86400)return Math.floor(seconds/3600)+'h ago';\n    return date.toLocaleDateString(undefined,{month:'short',day:'numeric'})+' '+date.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});\n  }\n  function autoRenewVerificationFor(c){\n    const key=String(c?.original_transaction_id||''); return autoRenewVerificationData?.chains?.[key]||null;\n  }\n  function autoRenewDetail(c){\n    if(c?.is_lifetime_pro)return 'N/A';\n    const state=c?.auto_renew_enabled===true?'On':c?.auto_renew_enabled===false?'Off':'Unknown';\n    const verification=autoRenewVerificationFor(c); const age=verificationAge(verification?.verifiedAt);\n    return age?state+' · verified '+age:state+' · verification pending';\n  }\n  function renderRenewalFreshness(){\n    const el=qs('#renewalFreshness'); if(!el)return; const config=autoRenewVerificationData?.configuration||{}, run=autoRenewVerificationData?.lastRun||null;\n    el.classList.remove('good','warn');\n    if(!config.enabled){ el.classList.add('warn'); el.textContent='Apple auto-renew verification is not enabled.'; return; }\n    if(!run?.completedAt){ el.textContent='Apple auto-renew verification is waiting for its first server check.'; return; }\n    const age=verificationAge(run.completedAt)||fmtDate(run.completedAt);\n    if(Number(run.failed||0)>0){ el.classList.add('warn'); el.textContent='Last Apple auto-renew check '+age+' · '+Math.max(0,Number(run.checked||0)-Number(run.failed||0))+'/'+Number(run.checked||0)+' verified · '+Number(run.failed||0)+' retrying'; return; }\n    el.classList.add('good'); el.textContent='Apple auto-renew verified '+age+' · '+Number(run.checked||0)+' checked · hourly safety net';\n  }\n  let breakdownData=null;`
    )
    .replace(
      "const [overview,history]=await Promise.all([api('/overview'),api('/history')]);",
      "const [overview,history,verification]=await Promise.all([api('/overview'),api('/history'),api('/auto-renew-verification')]);"
    )
    .replace(
      'breakdownData={overview,history};',
      'breakdownData={overview,history}; autoRenewVerificationData=verification; renderRenewalFreshness();'
    )
    .replace(
      "const d=await api('/customers/'+encodeURIComponent(key)); const c=(d.chains||[])[0]||{};",
      "const [d,verification]=await Promise.all([api('/customers/'+encodeURIComponent(key)),api('/auto-renew-verification')]); autoRenewVerificationData=verification; const c=(d.chains||[])[0]||{};"
    )
    .replace(
      "['Auto-renew',c.is_lifetime_pro?'N/A':(c.auto_renew_enabled===true?'On':c.auto_renew_enabled===false?'Off':'Unknown')]",
      "['Auto-renew',autoRenewDetail(c)]"
    );

  return output;
}

export default enhanceSubscriptionAdminAutoRenewHtml;
