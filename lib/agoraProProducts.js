export const AGORA_PRO_MONTHLY_PRODUCT_ID =
    'agora_pro_monthly';

export const AGORA_PRO_YEARLY_PRODUCT_ID =
    'agora_pro_yearly';

export const AGORA_PRO_LIFETIME_PRODUCT_ID =
    'agora_pro_lifetime';

export const AGORA_RECURRING_PRO_PRODUCT_IDS = new Set([
    AGORA_PRO_MONTHLY_PRODUCT_ID,
    AGORA_PRO_YEARLY_PRODUCT_ID,
]);

export const AGORA_PRO_PRODUCT_IDS = new Set([
    ...AGORA_RECURRING_PRO_PRODUCT_IDS,
    AGORA_PRO_LIFETIME_PRODUCT_ID,
]);

const PRODUCT_CLASSIFICATIONS = new Map([
    [
        AGORA_PRO_MONTHLY_PRODUCT_ID,
        Object.freeze({
            productId: AGORA_PRO_MONTHLY_PRODUCT_ID,
            accessSource: 'monthly',
            isRecurring: true,
            isLifetime: false,
        }),
    ],
    [
        AGORA_PRO_YEARLY_PRODUCT_ID,
        Object.freeze({
            productId: AGORA_PRO_YEARLY_PRODUCT_ID,
            accessSource: 'annual',
            isRecurring: true,
            isLifetime: false,
        }),
    ],
    [
        AGORA_PRO_LIFETIME_PRODUCT_ID,
        Object.freeze({
            productId: AGORA_PRO_LIFETIME_PRODUCT_ID,
            accessSource: 'lifetime',
            isRecurring: false,
            isLifetime: true,
        }),
    ],
]);

export function classifyAgoraProProduct(productId) {
    if (typeof productId !== 'string') {
        return null;
    }

    return PRODUCT_CLASSIFICATIONS.get(productId.trim()) || null;
}

export function isAgoraRecurringProProduct(productId) {
    return AGORA_RECURRING_PRO_PRODUCT_IDS.has(
        String(productId || '').trim()
    );
}

export function isAgoraLifetimeProProduct(productId) {
    return String(productId || '').trim() ===
        AGORA_PRO_LIFETIME_PRODUCT_ID;
}
