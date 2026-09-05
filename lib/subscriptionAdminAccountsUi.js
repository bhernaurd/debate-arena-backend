import { enhanceSubscriptionAdminAccountsHtml as enhanceBaseSubscriptionAdminAccountsHtml } from './subscriptionAdminAccountsUiBase.js';

const ACCOUNT_WORLD_PATH = 'M1000.0 68.7 L954.5 86.2 L935.2 117.7 L933.3 97.7 L959.2 77.7 L875.6 103.8 L892.8 109.3 L890.0 124.2 L854.2 156.1 L858.6 172.2 L838.6 151.6 L827.0 158.3 L840.8 164.1 L831.1 172.4 L838.8 192.3 L823.6 214.0 L796.1 220.6 L802.8 253.9 L791.1 262.8 L777.6 247.2 L789.7 288.4 L754.0 214.6 L723.0 239.1 L715.4 265.3 L702.5 216.3 L635.9 188.3 L642.5 209.3 L657.0 202.2 L666.1 216.5 L620.7 249.4 L590.5 189.9 L600.4 166.1 L572.4 157.0 L615.0 150.4 L601.7 137.3 L609.1 130.1 L583.7 133.2 L580.5 151.7 L562.7 153.6 L566.9 161.5 L564.4 167.5 L537.6 135.2 L551.4 154.7 L544.6 162.3 L524.3 139.9 L494.1 166.4 L473.6 159.4 L474.2 144.6 L495.5 143.3 L486.7 125.8 L527.3 108.5 L523.9 96.1 L530.2 107.0 L553.8 106.1 L565.3 88.9 L584.3 86.4 L559.5 84.1 L570.9 68.9 L562.9 65.8 L544.0 99.7 L529.9 86.5 L515.7 91.2 L514.2 78.6 L568.4 48.3 L615.0 61.7 L588.5 61.6 L603.9 73.2 L622.5 65.6 L620.2 56.3 L689.6 58.2 L685.4 47.9 L699.0 41.7 L704.5 57.2 L692.0 63.4 L700.4 64.8 L718.8 60.5 L704.9 54.6 L707.9 42.0 L732.3 52.7 L723.6 39.5 L789.3 25.1 L816.5 31.6 L812.1 31.6 L815.5 33.7 L797.3 39.2 L793.1 42.3 L989.1 52.1 L1000.0 68.7 Z M268.4 240.5 L276.6 268.1 L262.0 258.9 L257.2 246.8 L212.5 230.0 L180.7 183.2 L195.9 213.1 L188.4 207.5 L156.3 158.9 L159.7 125.0 L139.1 100.2 L93.6 82.3 L78.5 89.1 L85.7 81.0 L56.7 101.5 L46.2 104.1 L64.3 89.5 L38.5 81.1 L53.4 69.9 L33.0 66.6 L55.0 63.9 L36.5 57.5 L144.3 49.7 L202.2 64.3 L205.0 55.4 L235.3 61.5 L237.5 44.8 L256.9 61.7 L262.4 52.2 L270.7 52.8 L268.5 64.3 L239.4 71.7 L248.3 75.3 L236.2 89.5 L278.5 116.8 L282.8 78.4 L309.2 93.1 L321.2 85.4 L340.7 104.9 L331.2 109.5 L345.3 113.5 L305.6 126.7 L330.7 136.8 L285.5 159.8 L276.2 207.1 L255.6 187.0 L228.4 199.0 L233.7 228.6 L258.9 219.5 L253.0 238.3 L268.4 240.5 Z M588.7 184.4 L618.1 253.4 L642.8 257.1 L608.9 309.2 L613.5 344.3 L596.2 360.9 L598.6 376.2 L575.0 408.8 L555.6 413.2 L532.8 355.1 L538.5 331.1 L527.0 279.0 L475.8 276.5 L453.4 250.3 L452.8 217.9 L484.8 169.3 L527.1 164.3 L528.4 176.6 L552.7 188.7 L588.7 184.4 Z M296.2 475.9 L289.9 454.2 L298.5 446.6 L304.7 356.7 L274.3 307.8 L286.0 279.6 L278.0 260.8 L300.9 250.1 L300.8 261.9 L305.5 251.0 L328.1 256.0 L357.5 278.4 L353.6 298.6 L371.7 296.2 L403.3 317.8 L386.2 369.0 L364.6 380.6 L349.6 412.7 L337.7 407.1 L340.1 424.5 L319.4 433.5 L310.1 473.6 L296.2 475.9 Z M906.2 426.5 L864.3 401.6 L819.8 411.6 L816.6 368.5 L866.6 331.5 L890.6 353.8 L895.9 330.0 L926.8 391.9 L906.2 426.5 Z M375.8 86.2 L350.9 65.1 L360.4 59.1 L350.9 60.4 L360.2 58.9 L348.3 49.5 L356.4 45.7 L297.1 23.5 L386.4 9.1 L377.0 5.9 L464.2 11.2 L440.9 15.3 L455.3 15.5 L436.8 28.6 L443.3 39.7 L423.0 41.0 L440.3 49.9 L418.7 50.1 L438.6 51.4 L385.7 68.5 L375.8 86.2 Z';

const ACCOUNT_ACTIVITY_REFINEMENT = `
  let accountActivityExpanded=false;
  let accountActivityRows=[];
  function accountActivityVisibleLimit(){
    return window.matchMedia&&window.matchMedia('(max-width:700px)').matches?5:8;
  }
  function accountActivityTableHtml(rows){
    if(!rows?.length)return '<div class="empty">No accounts match these filters.</div>';
    const limit=accountActivityVisibleLimit();
    const visible=accountActivityExpanded?rows:rows.slice(0,limit);
    const table='<table><thead><tr><th>Account</th><th>Status</th><th>Access</th><th>Events</th><th>Referral</th><th>Created</th><th>Last sign-in</th></tr></thead><tbody>'+visible.map(row=>'<tr><td><div class="account-activity-name"><strong>'+esc(accountActivityName(row))+'</strong>'+(row.email&&row.email!==accountActivityName(row)?'<span class="muted">'+esc(row.email)+'</span>':'')+'<span class="account-activity-id">'+esc(row.id)+'</span></div></td><td>'+accountStatusHtml(row)+'</td><td>'+accountAccessHtml(row)+'</td><td><span class="account-events" title="Tracked analytics events across this account’s linked installations">'+esc(Number(row.totalEvents||0).toLocaleString())+'</span></td><td>'+accountReferralHtml(row)+'</td><td>'+esc(fmtDate(row.createdAt))+'</td><td>'+esc(row.lastAuthenticatedAt?fmtDate(row.lastAuthenticatedAt):'Never')+'</td></tr>').join('')+'</tbody></table>';
    if(rows.length<=limit)return table;
    const hidden=Math.max(0,rows.length-limit);
    const label=accountActivityExpanded?'Show fewer':'Show all '+rows.length+' accounts';
    const detail=accountActivityExpanded?'Collapse to '+limit+' rows':hidden+' more account'+(hidden===1?'':'s');
    return table+'<div class="account-activity-expand"><button type="button" id="accountActivityExpand" aria-expanded="'+(accountActivityExpanded?'true':'false')+'"><strong>'+esc(label)+'</strong><span>'+esc(detail)+'</span><span class="account-activity-expand-caret">'+(accountActivityExpanded?'↑':'↓')+'</span></button></div>';
  }
  function renderAccountActivity(){
    const el=qs('#accountActivityTable'); if(!el)return;
    el.innerHTML=accountActivityTableHtml(accountActivityRows);
    const toggle=qs('#accountActivityExpand');
    if(toggle)toggle.addEventListener('click',()=>{ accountActivityExpanded=!accountActivityExpanded; renderAccountActivity(); });
  }
  async function loadAccountActivity(){
    const el=qs('#accountActivityTable'); if(!el)return;
    accountActivityExpanded=false;
    el.innerHTML='<div class="loading">Loading account activity...</div>';
    try{ const data=await api('/accounts-activity?'+accountActivityParams().toString()); accountActivityRows=data.accounts||[]; renderAccountActivity(); }
    catch(e){ showError(el,e); }
  }
`;

const ACCOUNT_GEOGRAPHY_TOOLTIP_REFINEMENT = `
  let accountGeoTooltipEl=null;
  let accountGeoTooltipPinned=false;
  let accountGeoTooltipPinnedCode='';
  function ensureAccountGeoTooltip(){
    if(accountGeoTooltipEl)return accountGeoTooltipEl;
    accountGeoTooltipEl=document.createElement('div');
    accountGeoTooltipEl.className='account-geo-tooltip';
    document.body.appendChild(accountGeoTooltipEl);
    return accountGeoTooltipEl;
  }
  function accountGeoTooltipHtml(row,known){
    const value=Number(row?.downloads||0),share=known?Math.round((value/known)*100):0;
    return '<strong>'+esc(accountCountryName(row?.countryCode))+'</strong><span>'+esc(value+' first-time download'+(value===1?'':'s'))+'</span><span>'+esc(share+'% of known-country downloads')+'</span>';
  }
  function positionAccountGeoTooltip(eventLike){
    const el=ensureAccountGeoTooltip();
    const rect=el.getBoundingClientRect(),vw=window.innerWidth||document.documentElement.clientWidth||0,vh=window.innerHeight||document.documentElement.clientHeight||0;
    const anchorX=Number(eventLike?.clientX||0),anchorY=Number(eventLike?.clientY||0);
    let left=anchorX+14,top=anchorY+14;
    if(left+rect.width>vw-12)left=Math.max(12,anchorX-rect.width-14);
    if(top+rect.height>vh-12)top=Math.max(12,anchorY-rect.height-14);
    el.style.left=Math.round(left)+'px'; el.style.top=Math.round(top)+'px';
  }
  function showAccountGeoTooltip(row,known,eventLike,pinned=false){
    const el=ensureAccountGeoTooltip();
    accountGeoTooltipPinned=!!pinned; accountGeoTooltipPinnedCode=String(row?.countryCode||'').toUpperCase();
    el.innerHTML=accountGeoTooltipHtml(row,known); el.classList.add('visible'); positionAccountGeoTooltip(eventLike);
  }
  function hideAccountGeoTooltip(force=false){
    if(accountGeoTooltipPinned&&!force)return;
    const el=ensureAccountGeoTooltip(); el.classList.remove('visible');
    if(force){ accountGeoTooltipPinned=false; accountGeoTooltipPinnedCode=''; }
  }
  function bindAccountGeoTooltipDismiss(){
    if(window.__accountGeoTooltipDismissBound)return; window.__accountGeoTooltipDismissBound='1';
    document.addEventListener('click',event=>{ if(event.target?.closest?.('.account-map-bubble'))return; hideAccountGeoTooltip(true); });
    document.addEventListener('keydown',event=>{ if(event.key==='Escape')hideAccountGeoTooltip(true); });
    window.addEventListener('resize',()=>hideAccountGeoTooltip(true));
    window.addEventListener('scroll',()=>hideAccountGeoTooltip(true),true);
  }
`;

const ACCOUNT_ACTIVITY_CSS = `
    .account-activity-expand { display:flex;justify-content:center;padding:10px 14px 12px;border-top:1px solid #20242c;background:#0f1116; }
    .account-activity-expand button { width:min(360px,100%);display:grid;grid-template-columns:1fr auto;grid-template-areas:"title caret" "detail caret";column-gap:12px;align-items:center;border:1px solid #2a2f39;border-radius:10px;background:#12151a;color:#dfe4ec;padding:9px 12px;cursor:pointer;font:inherit;text-align:left; }
    .account-activity-expand button:hover { background:#171b21;border-color:#363d49; }
    .account-activity-expand strong { grid-area:title;font-size:11px;font-weight:780; }
    .account-activity-expand span:not(.account-activity-expand-caret) { grid-area:detail;color:#737b89;font-size:10px;margin-top:2px; }
    .account-activity-expand-caret { grid-area:caret;color:#8d95a3;font-size:14px; }
    .account-map-outline { fill:#151a20;stroke:#303844;stroke-width:1.05;stroke-linejoin:round; }
    .account-map-bubble { cursor:pointer; }
    .account-map-bubble:focus { outline:none;fill-opacity:1;stroke-width:2; }
    .account-geo-tooltip { position:fixed;z-index:1000;pointer-events:none;min-width:168px;max-width:240px;padding:10px 12px;border:1px solid #343b46;border-radius:12px;background:rgba(18,21,26,.98);color:#e8edf4;box-shadow:0 14px 36px rgba(0,0,0,.42);opacity:0;transform:translateY(4px);transition:opacity .12s ease,transform .12s ease; }
    .account-geo-tooltip.visible { opacity:1;transform:translateY(0); }
    .account-geo-tooltip strong { display:block;font-size:12px;font-weight:800;color:#f3f1eb; }
    .account-geo-tooltip span { display:block;margin-top:3px;color:#8d95a3;font-size:11px;line-height:1.35; }
`;

export function enhanceSubscriptionAdminAccountsHtml(html) {
  let output = enhanceBaseSubscriptionAdminAccountsHtml(html);

  output = output.replace(
    /const ACCOUNT_WORLD_PATHS=\[[\s\S]*?\];/,
    'const ACCOUNT_WORLD_PATH='+JSON.stringify(ACCOUNT_WORLD_PATH)+';'
  );

  output = output.replace(
    "function accountMapPoint(code){ const meta=ACCOUNT_COUNTRY_META[String(code||'').toUpperCase()]; if(!meta)return null; const lat=Number(meta[1]),lon=Number(meta[2]); return {x:((lon+180)/360)*1000,y:((85-Math.max(-85,Math.min(85,lat)))/170)*500}; }",
    "function accountMapPoint(code){ const meta=ACCOUNT_COUNTRY_META[String(code||'').toUpperCase()]; if(!meta)return null; const lat=Number(meta[1]),lon=Number(meta[2]); return {x:((lon+180)/360)*1000,y:((85-Math.max(-60,Math.min(85,lat)))/145)*500}; }"
  );

  output = output.replace(
    "const outlines=ACCOUNT_WORLD_PATHS.map(path=>'<path class=\"account-map-outline\" d=\"'+path+'\"/>').join('');",
    "const outlines='<path class=\"account-map-outline\" d=\"'+ACCOUNT_WORLD_PATH+'\"/>';"
  );

  output = output.replace(
    "const bubbles=rows.map(row=>{ const point=accountMapPoint(row.countryCode); if(!point)return ''; const value=Number(row.downloads||0),radius=6+Math.sqrt(value/max)*20; return '<circle class=\"account-map-bubble\" cx=\"'+point.x.toFixed(1)+'\" cy=\"'+point.y.toFixed(1)+'\" r=\"'+radius.toFixed(1)+'\"><title>'+esc(accountCountryName(row.countryCode)+': '+value+' download'+(value===1?'':'s'))+'</title></circle>'; }).join('');",
    "const bubbles=rows.map(row=>{ const point=accountMapPoint(row.countryCode); if(!point)return ''; const value=Number(row.downloads||0),radius=6+Math.sqrt(value/max)*20; return '<circle class=\"account-map-bubble\" data-country-code=\"'+esc(row.countryCode)+'\" cx=\"'+point.x.toFixed(1)+'\" cy=\"'+point.y.toFixed(1)+'\" r=\"'+radius.toFixed(1)+'\" tabindex=\"0\" role=\"button\" aria-label=\"'+esc(accountCountryName(row.countryCode)+': '+value+' first-time download'+(value===1?'':'s'))+'\"></circle>'; }).join('');"
  );

  output = output.replace(
    "map.innerHTML='<svg role=\"img\" aria-label=\"First-time App Store downloads by country\" viewBox=\"0 0 1000 500\">'+gridLines+outlines+bubbles+'</svg>';",
    "map.innerHTML='<svg role=\"img\" aria-label=\"First-time App Store downloads by country\" viewBox=\"0 0 1000 500\">'+gridLines+outlines+bubbles+'</svg>'; bindAccountGeoTooltipDismiss(); const rowByCode=new Map(rows.map(row=>[String(row.countryCode||'').toUpperCase(),row])); map.querySelectorAll('.account-map-bubble').forEach(node=>{ const code=String(node.dataset.countryCode||'').toUpperCase(),row=rowByCode.get(code); if(!row)return; node.addEventListener('mouseenter',event=>{ accountGeoTooltipPinned=false; accountGeoTooltipPinnedCode=''; showAccountGeoTooltip(row,known,event,false); }); node.addEventListener('mousemove',event=>{ if(!accountGeoTooltipPinned)positionAccountGeoTooltip(event); }); node.addEventListener('mouseleave',()=>hideAccountGeoTooltip(false)); node.addEventListener('focus',()=>{ const rect=node.getBoundingClientRect(); if(!accountGeoTooltipPinned)showAccountGeoTooltip(row,known,{clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/2},false); }); node.addEventListener('blur',()=>hideAccountGeoTooltip(false)); node.addEventListener('click',event=>{ event.stopPropagation(); if(accountGeoTooltipPinned&&accountGeoTooltipPinnedCode===code){ hideAccountGeoTooltip(true); return; } showAccountGeoTooltip(row,known,event,true); }); });"
  );

  output = output.replace(
    '  function renderAccountGeography(data){',
    ACCOUNT_GEOGRAPHY_TOOLTIP_REFINEMENT+'  function renderAccountGeography(data){'
  );

  output = output.replace(
    "const map=qs('#accountGeographyMap'),list=qs('#accountGeographyList'),summary=qs('#accountGeographySummary'); if(!map||!list||!summary)return;",
    "const map=qs('#accountGeographyMap'),list=qs('#accountGeographyList'),summary=qs('#accountGeographySummary'); if(!map||!list||!summary)return; hideAccountGeoTooltip(true);"
  );

  output = output.replace(
    '  function eventParams(){',
    ACCOUNT_ACTIVITY_REFINEMENT+'  function eventParams(){'
  );

  output = output.replace(
    '.hidden { display:none !important; }',
    ACCOUNT_ACTIVITY_CSS+'    .hidden { display:none !important; }'
  );

  return output;
}

export default enhanceSubscriptionAdminAccountsHtml;
