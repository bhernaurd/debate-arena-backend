// subscriptionAdminEnv.js
// Subscription admin alerts use their own Telegram bot/chat variables so the
// existing Daily Analytics Telegram integration remains untouched.

import './env.js';

const subscriptionBotToken =
    process.env.SUBSCRIPTION_ADMIN_TELEGRAM_BOT_TOKEN?.trim();
const subscriptionChatId =
    process.env.SUBSCRIPTION_ADMIN_TELEGRAM_CHAT_ID?.trim();

if (subscriptionBotToken) {
    process.env.TELEGRAM_BOT_TOKEN = subscriptionBotToken;
}

if (subscriptionChatId) {
    process.env.TELEGRAM_ADMIN_CHAT_ID = subscriptionChatId;
}
