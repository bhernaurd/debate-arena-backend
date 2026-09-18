import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const routeSource = await readFile(
  new URL('../founderFeedbackRoutes.js', import.meta.url),
  'utf8'
);
const serverSource = await readFile(
  new URL('../server.js', import.meta.url),
  'utf8'
);
const migrationSource = await readFile(
  new URL('../migrations/041_founder_feedback.sql', import.meta.url),
  'utf8'
);

test('founder feedback requires signed-in account authentication', () => {
  assert.match(routeSource, /X-Installation-ID header is required/);
  assert.match(routeSource, /authorizeAccessToken\(\{/);
  assert.match(routeSource, /Bearer access token is required/);
});

test('founder feedback validates type and message length', () => {
  assert.match(routeSource, /feature_idea/);
  assert.match(routeSource, /MAX_MESSAGE_LENGTH = 2_000/);
  assert.match(routeSource, /Please enter feedback before sending/);
});

test('founder feedback is stored before Telegram delivery', () => {
  const insert = routeSource.indexOf('INSERT INTO founder_feedback');
  const telegram = routeSource.indexOf('await telegramSender');

  assert.notEqual(insert, -1);
  assert.notEqual(telegram, -1);
  assert.ok(insert < telegram);
  assert.match(
    routeSource,
    /Telegram delivery failed; feedback is stored/
  );
});

test('founder feedback error logging excludes request body and access token', () => {
  const start = routeSource.indexOf("logger?.error?.(");
  assert.notEqual(start, -1);
  const logBlock = routeSource.slice(start, start + 450);

  assert.doesNotMatch(logBlock, /req\.body/);
  assert.doesNotMatch(logBlock, /accessToken/);
  assert.doesNotMatch(logBlock, /message,/);
});

test('migration links feedback to the account and deletes it with the account', () => {
  assert.match(
    migrationSource,
    /account_id UUID NOT NULL REFERENCES accounts\(id\) ON DELETE CASCADE/
  );
  assert.match(migrationSource, /message TEXT NOT NULL/);
  assert.match(migrationSource, /created_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
});

test('server mounts feedback route before generic account auth router', () => {
  const feedbackMount = serverSource.indexOf("'/api/account/feedback'");
  const genericMount = serverSource.indexOf(
    "app.use('/api/account', accountAuthRouter);"
  );

  assert.notEqual(feedbackMount, -1);
  assert.notEqual(genericMount, -1);
  assert.ok(feedbackMount < genericMount);
  assert.match(
    serverSource,
    /const founderFeedbackLimiter = rateLimit\(\{/
  );
});
