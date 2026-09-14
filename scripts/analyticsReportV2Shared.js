export function toNumber(value) {
  return Number(value || 0);
}

export function percent(numerator, denominator) {
  const n = Number(numerator || 0);
  const d = Number(denominator || 0);
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '—';
}

export function growth(current, previous) {
  const c = Number(current || 0);
  const p = Number(previous || 0);
  if (p <= 0) return '—';
  const value = ((c - p) / p) * 100;
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

export function stageLine(label, times, users, noun = 'times') {
  const count = toNumber(times);
  const userCount = toNumber(users);
  const unit = noun === 'times'
    ? (count === 1 ? 'time' : 'times')
    : (count === 1 ? noun.replace(/s$/, '') : noun);
  const usersLabel = userCount === 1 ? 'user' : 'users';
  return `${label}: ${count} ${unit} • ${userCount} ${usersLabel}`;
}

export function platformLine({ platform, activeUsers, debateStarts, philosopherFlows, matchedFlows }) {
  const label = platform === 'ios' ? 'iOS' : platform === 'android' ? 'Android' : 'Unknown';
  return `${label}: ${toNumber(activeUsers)} active • ${toNumber(debateStarts)} debates • ${percent(matchedFlows, philosopherFlows)} Philosopher → Debate`;
}

function stripHtml(value = '') {
  return String(value)
    .replaceAll('<b>', '')
    .replaceAll('</b>', '')
    .replaceAll('<i>', '')
    .replaceAll('</i>', '')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

export async function sendTelegramMessage(text, {
  botToken = process.env.TELEGRAM_BOT_TOKEN,
  chatId = process.env.TELEGRAM_CHAT_ID,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!botToken || !chatId) {
    throw new Error('Telegram analytics delivery is not configured.');
  }

  const chunks = [];
  const lines = String(text || '').split('\n');
  let current = '';

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= 3800) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    current = line.length <= 3800 ? line : stripHtml(line).slice(0, 3800);
  }
  if (current) chunks.push(current);

  for (const chunk of chunks.length ? chunks : ['']) {
    const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.ok) {
      throw new Error(`Telegram send failed: ${JSON.stringify(body)}`);
    }
  }

  return { success: true, chunksSent: chunks.length || 1 };
}

export function plainText(html) {
  return stripHtml(html);
}

// Pure contract helper used by regression tests. Production reports aggregate
// the same identity rules in SQL: people are account IDs, setup attempts are
// flow IDs, and debates are debate IDs.
export function summarizeNormalFlowEvents(events = []) {
  const philosopherFlows = new Set();
  const philosopherUsers = new Set();
  const topicUsers = new Set();
  const modeFlows = new Set();
  const modeUsers = new Set();
  const debateIds = new Set();
  const debateUsers = new Set();
  const startedFlows = new Set();
  let topicTimes = 0;

  for (const event of events) {
    const accountId = String(event.accountId || '').trim();
    const flowId = String(event.flowId || '').trim();
    if (!accountId) continue;
    const flowKey = flowId ? `${accountId}:${flowId}` : null;

    switch (event.eventName) {
      case 'philosopher_selected':
        if (flowKey) {
          philosopherFlows.add(flowKey);
          philosopherUsers.add(accountId);
        }
        break;
      case 'topic_selected':
        if (flowKey) {
          topicTimes += 1;
          topicUsers.add(accountId);
        }
        break;
      case 'difficulty_selected':
        if (flowKey) {
          modeFlows.add(flowKey);
          modeUsers.add(accountId);
        }
        break;
      case 'debate_started':
        if (event.isDailyChallenge === true) break;
        if (event.debateId) debateIds.add(String(event.debateId));
        debateUsers.add(accountId);
        if (flowKey) startedFlows.add(flowKey);
        break;
      default:
        break;
    }
  }

  const matchedFlows = [...philosopherFlows]
    .filter((flowKey) => startedFlows.has(flowKey)).length;

  return {
    philosopherTimes: philosopherFlows.size,
    philosopherUsers: philosopherUsers.size,
    topicTimes,
    topicUsers: topicUsers.size,
    modeTimes: modeFlows.size,
    modeUsers: modeUsers.size,
    debateStarts: debateIds.size,
    debateUsers: debateUsers.size,
    matchedFlows,
  };
}
