import crypto from 'node:crypto';
import express from 'express';

function cleanAdminKey(value) {
    return typeof value === 'string'
        ? value.trim()
        : '';
}

function isAuthorizedAdmin(req, expectedKey) {
    if (expectedKey.length < 32) {
        return false;
    }

    const supplied = cleanAdminKey(
        req.get('x-admin-key')
    );

    const left = Buffer.from(supplied, 'utf8');
    const right = Buffer.from(expectedKey, 'utf8');

    return (
        left.length === right.length &&
        crypto.timingSafeEqual(left, right)
    );
}

export function createSubscriptionAdminNotificationRouter({
    service,
    adminKey = process.env.ANALYTICS_ADMIN_KEY,
} = {}) {
    if (
        !service ||
        typeof service.enqueueTestNotification !== 'function' ||
        typeof service.kick !== 'function'
    ) {
        throw new Error(
            'A valid subscription admin notification service is required.'
        );
    }

    const expectedKey = cleanAdminKey(adminKey);
    const router = express.Router();

    router.post(
        '/api/admin/subscription-alerts/test',
        async (req, res) => {
            if (!isAuthorizedAdmin(req, expectedKey)) {
                return res.status(401).json({
                    success: false,
                    error: 'Unauthorized.',
                });
            }

            try {
                const result =
                    await service.enqueueTestNotification({
                        title:
                            req.body?.title ||
                            'Agora subscription alerts are connected',
                        body:
                            req.body?.body ||
                            'APNs is primary. Telegram is ready as fallback.',
                    });

                void service.kick();

                return res.json({
                    success: true,
                    notificationId: result.id,
                });
            } catch (error) {
                console.error(
                    '[SubscriptionAdminAlerts] Test enqueue failed:',
                    error?.message || error
                );

                return res.status(500).json({
                    success: false,
                    error:
                        'Unable to queue the test subscription alert.',
                });
            }
        }
    );

    return router;
}

export default createSubscriptionAdminNotificationRouter;
