import express from 'express';
import { createFounderFeedbackTelegramService } from './lib/founderFeedbackTelegramService.js';

const MAX_AUTHORIZATION_HEADER_LENGTH = 16_512;
const MAX_MESSAGE_LENGTH = 2_000;
const INSTALLATION_ID_RE = /^[A-Za-z0-9-]{8,128}$/;
const CATEGORIES = new Set([
  'general',
  'feature_idea',
  'bug',
  'other',
]);

function routeError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function requireBearerToken(req) {
  const authorization = req.get('Authorization');

  if (
    typeof authorization !== 'string' ||
    authorization.length > MAX_AUTHORIZATION_HEADER_LENGTH
  ) {
    throw routeError(
      'missing_access_token',
      'A Bearer access token is required.',
      401
    );
  }

  const match =
    /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/
      .exec(authorization.trim());

  if (!match) {
    throw routeError(
      'invalid_access_token',
      'The access token is invalid or expired.',
      401
    );
  }

  return match[1];
}

function requireInstallationId(req) {
  const value = String(req.get('X-Installation-ID') || '').trim();

  if (!INSTALLATION_ID_RE.test(value)) {
    throw routeError(
      'missing_installation_id',
      'X-Installation-ID header is required.',
      400
    );
  }

  return value;
}

function normalizeCategory(value) {
  const category = String(value || '').trim().toLowerCase();

  if (!CATEGORIES.has(category)) {
    throw routeError(
      'invalid_feedback_category',
      'Feedback type is not supported.',
      400
    );
  }

  return category;
}

function normalizeMessage(value) {
  if (typeof value !== 'string') {
    throw routeError(
      'invalid_feedback_message',
      'Feedback must be text.',
      400
    );
  }

  const message = value.trim();

  if (!message) {
    throw routeError(
      'invalid_feedback_message',
      'Please enter feedback before sending.',
      400
    );
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    throw routeError(
      'feedback_message_too_long',
      `Feedback must be ${MAX_MESSAGE_LENGTH} characters or fewer.`,
      413
    );
  }

  return message;
}

function optionalHeader(req, name, maxLength) {
  const value = req.get(name);

  if (typeof value !== 'string') return null;

  const cleaned = value.trim();
  if (!cleaned) return null;

  return cleaned.slice(0, maxLength);
}

function optionalPositiveIntegerHeader(req, name) {
  const value = optionalHeader(req, name, 20);
  if (value == null) return null;

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function createFounderFeedbackRouter({
  pool,
  accountAuthService,
  logger = console,
  feedbackNotifier = null,
} = {}) {
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('A PostgreSQL pool is required.');
  }

  if (
    !accountAuthService ||
    typeof accountAuthService.authorizeAccessToken !== 'function'
  ) {
    throw new Error('A valid account authentication service is required.');
  }

  const notificationService = feedbackNotifier ||
    createFounderFeedbackTelegramService({ pool, logger });

  const router = express.Router();

  router.use((_, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  router.post('/', async (req, res) => {
    try {
      const installationId = requireInstallationId(req);
      const accessToken = requireBearerToken(req);
      const category = normalizeCategory(req.body?.category);
      const message = normalizeMessage(req.body?.message);

      const authorization =
        await accountAuthService.authorizeAccessToken({
          installationId,
          accessToken,
        });

      const platformHeader =
        optionalHeader(req, 'X-Client-Platform', 20)?.toLowerCase();
      const clientPlatform = platformHeader === 'android'
        ? 'android' : platformHeader === 'ios' ? 'ios' : 'ios';
      const appVersion = optionalHeader(
        req,
        clientPlatform === 'android' ? 'X-Android-Version' : 'X-iOS-Version',
        32
      );
      const appBuild = optionalPositiveIntegerHeader(
        req,
        clientPlatform === 'android' ? 'X-Android-Build' : 'X-iOS-Build'
      );

      const result = await pool.query(
        `
          INSERT INTO founder_feedback (
            account_id,
            installation_id,
            category,
            message,
            client_platform,
            app_version,
            app_build
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING id, created_at
        `,
        [
          authorization.accountId,
          installationId,
          category,
          message,
          clientPlatform,
          appVersion,
          appBuild,
        ]
      );

      const row = result.rows[0];
      const feedbackId = String(row.id);

      // Feedback is committed before attempting Telegram delivery.
      // If Telegram is unavailable, the background worker retries the
      // durable outbox row instead of silently losing the notification.
      let notificationStatus = 'queued';
      try {
        const delivery = await notificationService.deliverId(feedbackId);
        notificationStatus = delivery.notificationStatus;
      } catch (error) {
        logger?.warn?.('[FounderFeedback] Telegram dispatch deferred.', {
          feedbackId,
          errorName: error?.name || 'Error',
        });
      }

      logger?.info?.('[FounderFeedback] Feedback saved.', {
        feedbackId,
        platform: clientPlatform,
        notificationStatus,
      });

      return res.status(201).json({
        success: true,
        feedbackId,
        notificationStatus,
        createdAt: new Date(row.created_at).toISOString(),
      });
    } catch (error) {
      const status =
        Number.isInteger(error?.status) &&
        error.status >= 400 &&
        error.status < 600
          ? error.status
          : 503;

      if (status >= 500) {
        logger?.error?.(
          '[FounderFeedback] Submission failed.',
          {
            method: req.method,
            path: req.originalUrl ?? req.url,
            errorName: error?.name || 'Error',
            errorCode: error?.code || 'unknown_error',
          }
        );
      }

      return res.status(status).json({
        error: {
          code:
            status >= 500
              ? 'feedback_unavailable'
              : error?.code || 'feedback_rejected',
          message:
            status >= 500
              ? 'Feedback is temporarily unavailable. Please try again.'
              : error?.message || 'Feedback could not be sent.',
          retryable: status >= 500,
        },
      });
    }
  });

  return router;
}
