const MOBILE_DASHBOARD_CSS = `
    @media (max-width:760px){
      body{background:#08090c;}
      .shell{display:block;min-height:100vh;}
      aside{position:static;height:auto;padding:calc(14px + env(safe-area-inset-top)) 14px 12px;border-right:0;border-bottom:1px solid var(--line);display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"brand lock" "nav nav";gap:12px 10px;align-items:center;background:#0b0d11;}
      .brand{grid-area:brand;padding:0;gap:10px;min-width:0;font-size:18px;line-height:1.15;}
      .brandmark{width:40px;height:40px;border-radius:12px;flex:0 0 auto;font-size:0;color:transparent;background:url('/subscription-admin-icon.svg?v=5') center/cover no-repeat;border:1px solid rgba(212,181,102,.28);box-shadow:0 5px 18px rgba(0,0,0,.28);}
      .brand>div:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      .sidebottom{grid-area:lock;position:static;margin:0;}
      .logout{width:auto;min-width:76px;border-color:rgba(212,181,102,.38);color:#e1c979;background:rgba(212,181,102,.05);border-radius:999px;padding:9px 13px;font-size:13px;font-weight:700;}
      nav{grid-area:nav;display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:6px;overflow:visible;}
      .nav{grid-column:span 2;min-height:46px;display:grid;place-items:center;text-align:center;white-space:normal;padding:8px 6px;border:1px solid #20242c;background:#111319;border-radius:11px;color:#929aa8;font-size:12px;line-height:1.15;}
      .nav:nth-child(4),.nav:nth-child(5){grid-column:span 3;}
      .nav.active{color:#f7e4ae;background:linear-gradient(145deg,rgba(212,181,102,.14),#15181e);border-color:rgba(212,181,102,.45);box-shadow:inset 0 0 0 1px rgba(212,181,102,.08);}
      .nav:hover{color:#fff;background:#171a21;}
      main{padding:18px 14px calc(46px + env(safe-area-inset-bottom));}
      .top{align-items:flex-start;gap:10px;margin-bottom:16px;}
      .top h1{font-size:30px;line-height:1.05;}
      .sub{font-size:12px;line-height:1.35;margin-top:5px;}
      .refresh{padding:8px 10px;border-radius:10px;font-size:12px;flex:0 0 auto;}
      .data-freshness{margin-top:10px!important;padding:10px 11px;border:1px solid #1f242d;border-radius:12px;background:#0d0f14;display:grid!important;grid-template-columns:1fr 1fr;gap:6px 10px!important;font-size:10px!important;line-height:1.3;}
      .data-freshness span{white-space:normal!important;min-width:0;}
      .data-freshness span:last-child:nth-child(odd){grid-column:1/-1;}
      .grid,#metrics,.accounts-metrics{grid-template-columns:1fr 1fr!important;gap:10px;}
      .metric{min-height:118px;padding:14px;border-radius:14px;}
      .metric .label{font-size:11px;margin-bottom:10px;line-height:1.2;}
      .metric .value{font-size:29px;}
      .metric .hint{font-size:10px;line-height:1.35;margin-top:6px;}
      .grid>.metric:last-child:nth-child(odd),#metrics>.metric:last-child:nth-child(odd),.accounts-metrics>.metric:last-child:nth-child(odd){grid-column:1/-1;min-height:104px;}
      .section{margin-top:14px;border-radius:14px;}
      .sectionhead{padding:13px 14px;gap:8px;align-items:flex-start;}
      .sectionhead h2{font-size:14px;line-height:1.25;}
      .sectionhead span{font-size:10px;line-height:1.3;text-align:right;}
      .accounts-daily-head{display:grid;grid-template-columns:1fr;gap:9px;}
      .accounts-daily-controls{justify-content:space-between;width:100%;gap:8px;}
      .account-range button{padding:6px 10px;}
      .accounts-chart,.revenue-trend-chart{padding:10px 8px 8px;min-height:230px;}
      #breakdownChart,#accountsDailyChart,#accountsChart,#revenueTrendChart{overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;}
      #breakdownChart::-webkit-scrollbar,#accountsDailyChart::-webkit-scrollbar,#accountsChart::-webkit-scrollbar,#revenueTrendChart::-webkit-scrollbar{display:none;}
      #breakdownChart svg{min-width:680px!important;}
      #accountsDailyChart svg{min-width:900px!important;}
      .tablewrap{overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;}
      .tablewrap::-webkit-scrollbar{display:none;}
      table{font-size:12px;}
      th{font-size:10px;padding:10px 11px;}
      td{padding:11px;}
      .toolbar{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;}
      .toolbar input{grid-column:1/-1;min-width:0!important;width:100%;}
      .toolbar select,.toolbar button{min-width:0;width:100%;}
      .toolbar button:last-child{grid-column:1/-1;}
      .drawerback.open{display:block!important;overflow:hidden;overscroll-behavior:contain;}
      .drawerback.open .drawer{display:block!important;position:fixed!important;inset:0!important;width:100%!important;max-width:100%!important;height:100dvh!important;max-height:100dvh!important;margin:0!important;padding:0 14px calc(24px + env(safe-area-inset-bottom))!important;border:0!important;overflow-y:auto!important;overflow-x:hidden!important;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;background:#0e1014;grid-template-columns:none!important;grid-template-rows:none!important;grid-template-areas:none!important;gap:0!important;}
      .drawer>.drawerhead{display:flex!important;flex-direction:row!important;justify-content:space-between!important;align-items:center!important;position:sticky!important;top:0!important;width:calc(100% + 28px)!important;max-width:none!important;margin:0 -14px 14px!important;padding:calc(14px + env(safe-area-inset-top)) 14px 12px!important;background:#0e1014;border-bottom:1px solid var(--line);z-index:5;box-shadow:0 8px 18px rgba(0,0,0,.18);grid-column:1/-1!important;grid-row:auto!important;}
      .drawer>.drawerhead>div{min-width:0!important;width:auto!important;max-width:calc(100% - 90px)!important;flex:1 1 auto!important;}
      .drawer h2{display:block!important;margin:0!important;max-width:100%!important;font-size:18px;line-height:1.25;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important;word-break:normal!important;}
      .drawerhead .sub{display:block!important;max-width:100%!important;font-size:11px;line-height:1.35;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important;word-break:normal!important;margin-top:4px;}
      .close{display:inline-flex!important;align-items:center;justify-content:center;position:static!important;float:none!important;flex:0 0 auto!important;align-self:center!important;margin:0 0 0 10px!important;padding:8px 12px!important;border-radius:10px;white-space:nowrap;}
      .drawer>.detailgrid,.drawer>.timeline{width:100%!important;max-width:100%!important;min-width:0!important;grid-column:1/-1!important;grid-row:auto!important;}
      .detailgrid{display:grid!important;grid-template-columns:minmax(0,1fr)!important;gap:10px!important;margin-top:0!important;}
      .detail{display:block!important;padding:14px;border-radius:14px;min-width:0!important;width:100%!important;max-width:100%!important;overflow:hidden;}
      .detail b{display:block;font-size:10px;margin-bottom:7px;}
      .detail span{display:block;max-width:100%;font-size:15px;line-height:1.45;white-space:normal;overflow-wrap:anywhere;word-break:break-word;}
      .timeline{display:block!important;margin-top:24px!important;overflow:visible!important;}
      .timeline+.timeline{margin-top:30px!important;}
      .timeline h3{display:block;font-size:16px;margin:0 0 12px;line-height:1.25;}
      .event{display:block!important;width:100%!important;max-width:100%!important;min-width:0!important;margin:0 0 10px!important;border:1px solid #242832;border-left:3px solid #3a404b;border-radius:12px;background:#111318;padding:12px 13px!important;overflow:hidden;}
      .event strong{display:block;font-size:13px;line-height:1.4;white-space:normal;overflow-wrap:anywhere;word-break:break-word;}
      .event small{display:block;font-size:11px;line-height:1.45;margin-top:6px;white-space:normal;overflow-wrap:anywhere;word-break:break-word;}
      .drawer .empty{padding:18px 12px;}
      .twocol{grid-template-columns:1fr;gap:10px;margin-top:14px;}
      .revenue-settlements-summary{padding:14px;align-items:flex-start;}
    }
    @media (max-width:360px){
      .grid,#metrics,.accounts-metrics{grid-template-columns:1fr!important;}
      .grid>.metric:last-child:nth-child(odd),#metrics>.metric:last-child:nth-child(odd),.accounts-metrics>.metric:last-child:nth-child(odd){grid-column:auto;}
      nav{grid-template-columns:1fr 1fr;}
      .nav,.nav:nth-child(4),.nav:nth-child(5){grid-column:auto;}
      .nav:last-child:nth-child(odd){grid-column:1/-1;}
      .data-freshness{grid-template-columns:1fr;}
      .data-freshness span:last-child:nth-child(odd){grid-column:auto;}
    }`;

const MOBILE_CURRENT_CHART_SCRIPT = `<script>
(() => {
  const chartIds = ['breakdownChart','accountsDailyChart','accountsChart','revenueTrendChart'];
  const isMobile = () => window.matchMedia('(max-width:760px)').matches;
  const alignCurrent = (element) => {
    if (!element || !isMobile() || !element.querySelector('svg')) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      element.scrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
    }));
  };
  const alignAll = () => chartIds.forEach(id => alignCurrent(document.getElementById(id)));
  const boot = () => {
    chartIds.forEach(id => {
      const element = document.getElementById(id);
      if (!element) return;
      new MutationObserver(() => alignCurrent(element)).observe(element, { childList: true, subtree: true });
      alignCurrent(element);
    });
    document.addEventListener('click', event => {
      if (event.target.closest('[data-view],[data-account-range]')) setTimeout(alignAll, 0);
    });
    window.addEventListener('orientationchange', () => setTimeout(alignAll, 80));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
</script>`;

export function enhanceSubscriptionAdminMobileHtml(html) {
  let output = String(html);

  output = output
    .replaceAll(
      '<meta name="viewport" content="width=device-width,initial-scale=1" />',
      '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />\n  <meta name="theme-color" content="#08090c" />\n  <meta name="apple-mobile-web-app-capable" content="yes" />\n  <meta name="mobile-web-app-capable" content="yes" />\n  <meta name="application-name" content="Agora Admin" />\n  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />\n  <meta name="apple-mobile-web-app-title" content="Agora Admin" />\n  <link rel="manifest" href="/subscription-admin.webmanifest?v=3" />'
    )
    .replaceAll(
      '<link rel="apple-touch-icon" sizes="180x180" href="/subscription-admin-icon.png?v=1" />',
      ''
    )
    .replaceAll(
      '<link rel="icon" type="image/png" sizes="180x180" href="/subscription-admin-icon.png?v=1" />',
      '<link rel="icon" type="image/svg+xml" href="/subscription-admin-icon.svg?v=5" />'
    );

  if (output.includes('<div class="shell">') && !output.includes('/* subscription-admin-mobile-v1 */')) {
    output = output.replace(
      '</style>',
      `    /* subscription-admin-mobile-v1 */\n${MOBILE_DASHBOARD_CSS}\n  </style>`
    );
  }

  if (output.includes('<div class="shell">') && !output.includes("const chartIds = ['breakdownChart'")) {
    output = output.replace('</body>', `${MOBILE_CURRENT_CHART_SCRIPT}\n</body>`);
  }

  return output;
}

export default enhanceSubscriptionAdminMobileHtml;
