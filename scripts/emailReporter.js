// scripts/emailReporter.js
import { Resend } from "resend";

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const ANALYTICS_EMAIL_TO = process.env.ANALYTICS_EMAIL_TO;
const ANALYTICS_EMAIL_FROM =
  process.env.ANALYTICS_EMAIL_FROM || "The Agora <onboarding@resend.dev>";

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function reportTextToHtml(reportText) {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.5; color: #111827;">
      <h1 style="font-size: 22px; margin-bottom: 16px;">The Agora Analytics Report</h1>
      <pre style="white-space: pre-wrap; font-family: inherit; background: #f9fafb; padding: 16px; border-radius: 12px; border: 1px solid #e5e7eb;">${escapeHtml(reportText)}</pre>
    </div>
  `;
}

export async function sendAnalyticsEmail({ subject, reportText }) {
  if (!resend) {
    console.warn("[emailReporter] RESEND_API_KEY is missing. Skipping email.");
    return { skipped: true, reason: "missing_resend_api_key" };
  }

  if (!ANALYTICS_EMAIL_TO) {
    console.warn("[emailReporter] ANALYTICS_EMAIL_TO is missing. Skipping email.");
    return { skipped: true, reason: "missing_analytics_email_to" };
  }

  try {
    const { data, error } = await resend.emails.send({
      from: ANALYTICS_EMAIL_FROM,
      to: [ANALYTICS_EMAIL_TO],
      subject,
      text: reportText,
      html: reportTextToHtml(reportText),
    });

    if (error) {
      console.error("[emailReporter] Email send failed:", error);
      return { success: false, error };
    }

    console.log("[emailReporter] Email sent:", data?.id);
    return { success: true, id: data?.id };
  } catch (error) {
    console.error("[emailReporter] Email send crashed:", error);
    return { success: false, error };
  }
}