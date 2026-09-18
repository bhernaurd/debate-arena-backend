const FEEDBACK_SECTION = `
    <section id="view-feedback" class="hidden">
      <div class="grid feedback-metrics" id="feedbackMetrics"><div class="loading">Loading feedback...</div></div>

      <div class="section">
        <div class="sectionhead">
          <div>
            <h2>Community feedback</h2>
            <span>Messages sent directly from The Agora</span>
          </div>
          <span id="feedbackCount"></span>
        </div>
        <div class="toolbar feedback-toolbar">
          <input id="feedbackSearch" type="search" placeholder="Search feedback, name, email, or account ID" autocomplete="off" />
          <select id="feedbackStatus" aria-label="Feedback status">
            <option value="all">All statuses</option>
            <option value="new">New</option>
            <option value="reviewed">Reviewed</option>
          </select>
          <select id="feedbackCategory" aria-label="Feedback type">
            <option value="all">All types</option>
            <option value="general">General</option>
            <option value="feature_idea">Feature ideas</option>
            <option value="bug">Bugs</option>
            <option value="other">Other</option>
          </select>
          <button type="button" id="feedbackRefresh">Apply</button>
        </div>
        <div class="tablewrap feedback-tablewrap" id="feedbackTable">
          <div class="loading">Loading feedback...</div>
        </div>
      </div>
    </section>
`;

const FEEDBACK_CSS = `
    .feedback-nav-button { border:0;background:transparent;color:#969dab;text-align:left;padding:11px 12px;border-radius:10px;display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;font:inherit;cursor:pointer; }
    .feedback-nav-button.active,.feedback-nav-button:hover { color:#fff;background:#171a21; }
    .feedback-nav-badge { min-width:20px;height:20px;padding:0 6px;border-radius:999px;background:#3a2415;border:1px solid #6b4825;color:#f0ce80;font-size:10px;font-weight:800;display:inline-flex;align-items:center;justify-content:center; }
    .feedback-nav-badge.hidden { display:none; }
    .feedback-metrics { grid-template-columns:repeat(4,minmax(0,1fr)); }
    .feedback-toolbar { display:grid;grid-template-columns:minmax(260px,1fr) minmax(130px,auto) minmax(140px,auto) auto;align-items:center;padding:14px 16px;margin:0;border-bottom:1px solid #20242c;gap:8px; }
    .feedback-toolbar input,.feedback-toolbar select,.feedback-toolbar button { min-height:38px; }
    .feedback-table { min-width:980px; }
    .feedback-status-new { color:#f0ce80;font-weight:780; }
    .feedback-status-reviewed { color:#8de1bd;font-weight:720; }
    .feedback-message-button { width:100%;max-width:560px;border:0;background:transparent;color:#e9e7df;padding:0;font:inherit;text-align:left;cursor:pointer; }
    .feedback-message-button:hover { color:#fff; }
    .feedback-preview { display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.38;white-space:normal; }
    .feedback-user { display:flex;flex-direction:column;gap:3px;min-width:170px; }
    .feedback-user strong { color:#f1f3f6;font-size:12px; }
    .feedback-user span { color:#737b89;font-size:10px;overflow-wrap:anywhere; }
    .feedback-action { border:1px solid #303641;background:#171a20;color:#dfe3e8;border-radius:9px;padding:7px 9px;font-size:11px;font-weight:720;white-space:nowrap; }
    .feedback-action:hover { background:#20242c; }
    .feedback-detail-message { margin-top:18px;border:1px solid var(--line);border-radius:14px;background:#111318;padding:16px;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.55;font-size:14px; }
    .feedback-detail-actions { display:flex;gap:8px;flex-wrap:wrap;margin-top:14px; }
    .feedback-detail-actions button { border:1px solid var(--line);background:#171a20;color:#f3f1eb;border-radius:10px;padding:9px 12px;font:inherit;font-size:12px;font-weight:720; }
    @media (max-width:900px){ .feedback-toolbar{grid-template-columns:1fr 1fr}.feedback-toolbar input{grid-column:1/-1}.feedback-toolbar button{grid-column:1/-1}.feedback-metrics{grid-template-columns:1fr 1fr} }
    @media (max-width:620px){ .feedback-metrics{grid-template-columns:1fr} }
`;

const FEEDBACK_SCRIPT = `
<script>
(() => {
  const nav = document.getElementById('feedbackNav');
  const section = document.getElementById('view-feedback');
  if (!nav || !section) return;

  const badge = document.getElementById('feedbackNavBadge');
  const table = document.getElementById('feedbackTable');
  const metrics = document.getElementById('feedbackMetrics');
  const count = document.getElementById('feedbackCount');
  const search = document.getElementById('feedbackSearch');
  const status = document.getElementById('feedbackStatus');
  const category = document.getElementById('feedbackCategory');
  const applyButton = document.getElementById('feedbackRefresh');
  let rows = [];

  const escFeedback = (value) => String(value == null ? '' : value)
    .replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[char]));
  const fmtFeedbackDate = (value) => value ? new Date(value).toLocaleString() : 'N/A';
  const titleFeedback = (value) => String(value || 'general').replaceAll('_',' ').replace(/\\b\\w/g, (m) => m.toUpperCase());
  const shortFeedbackId = (value) => {
    const text = String(value || '');
    return text.length > 18 ? text.slice(0,8) + '…' + text.slice(-5) : (text || 'N/A');
  };
  const userLabel = (row) => row.displayName || row.email || shortFeedbackId(row.accountId);

  async function feedbackApi(path, options = {}) {
    const response = await fetch('/subscription-admin/data' + path, {
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        ...(options.body ? {'content-type':'application/json'} : {}),
      },
      ...options,
    });
    if (response.status === 401) {
      location.href = '/subscription-admin/login';
      throw new Error('Session expired');
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.success === false) {
      throw new Error(body?.error?.message || body?.error || 'Request failed');
    }
    return body;
  }

  function setBadge(newCount) {
    const value = Number(newCount || 0);
    badge.textContent = value > 99 ? '99+' : String(value);
    badge.classList.toggle('hidden', value <= 0);
  }

  function metricCard(label, value, hint) {
    return '<div class="metric"><div class="label">' + escFeedback(label) + '</div><div class="value">' + escFeedback(value) + '</div><div class="hint">' + escFeedback(hint || '') + '</div></div>';
  }

  function renderMetrics(summary) {
    metrics.innerHTML = [
      metricCard('Total feedback', Number(summary.total || 0), 'All submitted feedback'),
      metricCard('New', Number(summary.new || 0), 'Waiting for review'),
      metricCard('Feature ideas', Number(summary.featureIdeas || 0), 'All-time suggestions'),
      metricCard('Bugs', Number(summary.bugs || 0), 'All-time bug reports'),
    ].join('');
    setBadge(summary.new || 0);
  }

  function statusHtml(row) {
    return row.reviewedAt
      ? '<span class="feedback-status-reviewed">Reviewed</span>'
      : '<span class="feedback-status-new">New</span>';
  }

  function typeHtml(row) {
    const cls = row.category === 'bug' ? 'bad' : (row.category === 'feature_idea' ? 'warn' : '');
    return '<span class="pill ' + cls + '">' + escFeedback(titleFeedback(row.category)) + '</span>';
  }

  function tableHtml(items) {
    if (!items.length) return '<div class="empty">No feedback matches these filters.</div>';
    return '<table class="feedback-table"><thead><tr><th>Status</th><th>Type</th><th>User</th><th>Feedback</th><th>App</th><th>Submitted</th><th></th></tr></thead><tbody>' +
      items.map((row) => {
        const app = row.appVersion
          ? String(row.clientPlatform || 'iOS').toUpperCase() + ' ' + row.appVersion + (row.appBuild ? ' (' + row.appBuild + ')' : '')
          : String(row.clientPlatform || 'iOS').toUpperCase();
        return '<tr>' +
          '<td>' + statusHtml(row) + '</td>' +
          '<td>' + typeHtml(row) + '</td>' +
          '<td><div class="feedback-user"><strong>' + escFeedback(userLabel(row)) + '</strong><span>' + escFeedback(row.email || shortFeedbackId(row.accountId)) + '</span></div></td>' +
          '<td><button type="button" class="feedback-message-button" data-feedback-open="' + escFeedback(row.id) + '"><span class="feedback-preview">' + escFeedback(row.message) + '</span></button></td>' +
          '<td>' + escFeedback(app) + '</td>' +
          '<td>' + escFeedback(fmtFeedbackDate(row.createdAt)) + '</td>' +
          '<td><button type="button" class="feedback-action" data-feedback-review="' + escFeedback(row.id) + '" data-reviewed="' + (row.reviewedAt ? 'true' : 'false') + '">' + (row.reviewedAt ? 'Mark new' : 'Mark reviewed') + '</button></td>' +
          '</tr>';
      }).join('') +
      '</tbody></table>';
  }

  function bindRows() {
    table.querySelectorAll('[data-feedback-open]').forEach((button) => {
      button.addEventListener('click', () => openFeedback(button.dataset.feedbackOpen));
    });
    table.querySelectorAll('[data-feedback-review]').forEach((button) => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await setReviewed(button.dataset.feedbackReview, button.dataset.reviewed !== 'true');
          await loadFeedback();
        } catch (error) {
          alert(error.message || error);
        } finally {
          button.disabled = false;
        }
      });
    });
  }

  function params() {
    const query = new URLSearchParams({
      status: status.value,
      category: category.value,
      limit: '200',
    });
    const q = search.value.trim();
    if (q) query.set('q', q);
    return query;
  }

  async function loadFeedback() {
    table.innerHTML = '<div class="loading">Loading feedback...</div>';
    try {
      const data = await feedbackApi('/feedback?' + params().toString());
      rows = data.feedback || [];
      renderMetrics(data.summary || {});
      count.textContent = rows.length + (rows.length === 1 ? ' result' : ' results');
      table.innerHTML = tableHtml(rows);
      bindRows();
    } catch (error) {
      table.innerHTML = '<div class="error">' + escFeedback(error.message || error) + '</div>';
    }
  }

  async function refreshBadge() {
    try {
      const data = await feedbackApi('/feedback?status=all&category=all&limit=1');
      setBadge(data.summary?.new || 0);
    } catch {}
  }

  async function setReviewed(id, reviewed) {
    return feedbackApi('/feedback/' + encodeURIComponent(id) + '/reviewed', {
      method: 'POST',
      body: JSON.stringify({ reviewed: Boolean(reviewed) }),
    });
  }

  function closeFeedbackDrawer() {
    document.getElementById('drawerBack')?.classList.remove('open');
  }

  function openFeedback(id) {
    const row = rows.find((item) => String(item.id) === String(id));
    if (!row) return;
    const back = document.getElementById('drawerBack');
    const drawer = document.getElementById('drawer');
    if (!back || !drawer) return;

    const details = [
      ['Status', row.reviewedAt ? 'Reviewed' : 'New'],
      ['Type', titleFeedback(row.category)],
      ['User', userLabel(row)],
      ['Email', row.email || 'N/A'],
      ['Account ID', row.accountId || 'N/A'],
      ['Feedback ID', row.id || 'N/A'],
      ['Submitted', fmtFeedbackDate(row.createdAt)],
      ['Reviewed', row.reviewedAt ? fmtFeedbackDate(row.reviewedAt) : 'Not yet'],
      ['Platform', row.clientPlatform || 'iOS'],
      ['App version', row.appVersion ? row.appVersion + (row.appBuild ? ' (' + row.appBuild + ')' : '') : 'N/A'],
      ['Installation ID', row.installationId || 'N/A'],
    ];

    back.classList.add('open');
    drawer.innerHTML =
      '<div class="drawerhead"><div><h2>' + escFeedback(titleFeedback(row.category)) + '</h2><div class="sub">Feedback #' + escFeedback(row.id) + '</div></div><button class="close" id="feedbackDrawerClose" type="button">Close</button></div>' +
      '<div class="detailgrid">' +
      details.map((entry) => '<div class="detail"><b>' + escFeedback(entry[0]) + '</b><span>' + escFeedback(entry[1]) + '</span></div>').join('') +
      '</div>' +
      '<div class="feedback-detail-message">' + escFeedback(row.message) + '</div>' +
      '<div class="feedback-detail-actions"><button type="button" id="feedbackDrawerReview">' + (row.reviewedAt ? 'Mark as new' : 'Mark as reviewed') + '</button><button type="button" id="feedbackDrawerCopy">Copy feedback</button></div>';

    document.getElementById('feedbackDrawerClose')?.addEventListener('click', closeFeedbackDrawer);
    document.getElementById('feedbackDrawerCopy')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(row.message);
      } catch {}
    });
    document.getElementById('feedbackDrawerReview')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await setReviewed(row.id, !row.reviewedAt);
        closeFeedbackDrawer();
        await loadFeedback();
      } catch (error) {
        alert(error.message || error);
        button.disabled = false;
      }
    });
  }

  function showFeedback() {
    document.querySelectorAll('main > section[id^="view-"]').forEach((el) => el.classList.add('hidden'));
    document.querySelectorAll('.nav').forEach((el) => el.classList.remove('active'));
    section.classList.remove('hidden');
    nav.classList.add('active');
    const title = document.getElementById('pageTitle');
    const sub = document.getElementById('pageSub');
    if (title) title.textContent = 'Feedback';
    if (sub) sub.textContent = 'Direct messages from The Agora community';
    loadFeedback();
  }

  function hideFeedback() {
    section.classList.add('hidden');
    nav.classList.remove('active');
  }

  nav.addEventListener('click', showFeedback);
  document.querySelectorAll('.nav').forEach((button) => button.addEventListener('click', hideFeedback));
  applyButton?.addEventListener('click', loadFeedback);
  search?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') loadFeedback();
  });

  document.getElementById('refreshButton')?.addEventListener('click', (event) => {
    if (!section.classList.contains('hidden')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      loadFeedback();
    }
  }, true);

  refreshBadge();
})();
</script>
`;

export function enhanceSubscriptionAdminFeedbackHtml(html) {
  let output = String(html);

  if (
    !output.includes('id="pageTitle"') ||
    output.includes('id="feedbackNav"')
  ) {
    return output;
  }

  output = output
    .replace(
      '</nav>',
      '      <button class="feedback-nav-button" id="feedbackNav" type="button"><span>Feedback</span><span class="feedback-nav-badge hidden" id="feedbackNavBadge">0</span></button>\\n    </nav>'
    )
    .replace(
      '  </main>',
      FEEDBACK_SECTION + '\\n  </main>'
    )
    .replace(
      '</style>',
      FEEDBACK_CSS + '\\n  </style>'
    )
    .replace(
      '</body>',
      FEEDBACK_SCRIPT + '\\n</body>'
    );

  return output;
}

export default enhanceSubscriptionAdminFeedbackHtml;
