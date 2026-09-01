export function enhanceSubscriptionAdminLifetimeHtml(html) {
  let output = String(html);

  output = output
    .replace(
      "metric('Active Pro',m.active_pro_entitlements||0,'All production Pro entitlements')",
      "metric('Active subscriptions',Math.max(0,Number(m.active_pro_entitlements||0)-Number(m.active_lifetime_pro||0)),Number(m.active_paid_subscribers||0)+' paid · '+Number(m.active_trials||0)+' trial'+(Number(m.active_trials||0)===1?'':'s'))"
    )
    .replace(
      "metric('Paid subscribers',m.active_paid_subscribers||0,'Monthly + annual, excluding trials'),",
      "metric('Paid subscribers',m.active_paid_subscribers||0,'Monthly + annual, excluding trials'),\n        metric('Lifetime Pro',m.active_lifetime_pro||0,'Permanent access · no renewal'),"
    )
    .replace(
      '.grid { display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px; }',
      '.grid { display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px; }\n    #metrics { grid-template-columns:repeat(5,minmax(0,1fr)); }\n    @media (max-width:1200px){ #metrics{grid-template-columns:repeat(3,1fr)} }\n    @media (max-width:760px){ #metrics{grid-template-columns:1fr 1fr} }'
    )
    .replace(
      '<h2>Active Pro growth</h2><span id="breakdownChartSummary">Active Pro over time</span>',
      '<h2>Active subscription growth</h2><span id="breakdownChartSummary">Subscriptions over time</span>'
    )
    .replaceAll('Loading Active Pro growth...', 'Loading subscription growth...')
    .replaceAll('No Active Pro history yet.', 'No subscription history yet.')
    .replaceAll("summary.textContent='Active Pro over time'", "summary.textContent='Subscriptions over time'")
    .replaceAll('aria-label="Active Pro growth by month"', 'aria-label="Active subscription growth by month"')
    .replace(
      'const currentTotal=Number(overview.metrics?.active_pro_entitlements||0);',
      'const currentTotal=Math.max(0,Number(overview.metrics?.active_pro_entitlements||0)-Number(overview.metrics?.active_lifetime_pro||0));'
    )
    .replaceAll('activeProAtMonthEnd', 'activeSubscriptionsAtMonthEnd')
    .replace(
      "metric('Total subscribers',m.active_pro_entitlements||0,'All active production Pro access')",
      "metric('Active subscriptions',Math.max(0,Number(m.active_pro_entitlements||0)-Number(m.active_lifetime_pro||0)),'Monthly + annual subscriptions and trials')"
    )
    .replace(
      "metric('Total subscribers',row.activeSubscriptionsAtMonthEnd==null?'N/A':row.activeSubscriptionsAtMonthEnd,'Active Pro at the end of '+subscriberMonthLabel(row.month))",
      "metric('Active subscriptions',row.activeSubscriptionsAtMonthEnd==null?'N/A':row.activeSubscriptionsAtMonthEnd,'Monthly + annual subscriptions active at the end of '+subscriberMonthLabel(row.month))"
    )
    .replaceAll('<th>Active Pro at end</th>', '<th>Active subscriptions at end</th>')
    .replaceAll('month-end subscriber total.', 'month-end subscription total.');

  return output;
}

export default enhanceSubscriptionAdminLifetimeHtml;
