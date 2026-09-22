import { createHmac } from 'crypto';

import { postJson } from './http.js';
import { safeEqual } from './safe-equal.js';
import {
    CreatePaymentInput,
    CreatePaymentResult,
    GatewayPaymentStatus,
    PaymentGateway,
    WebhookEvent,
    WebhookHandler,
} from './gateway.js';

export interface NowPaymentsConfig {
    apiKey: string;
    ipnSecret: string;
    sandbox?: boolean;
}

const STATUS_MAP: Record<string, GatewayPaymentStatus> = {
    waiting: 'pending',
    confirming: 'pending',
    sending: 'pending',
    partially_paid: 'pending',
    confirmed: 'authorized',
    finished: 'settled',
    failed: 'declined',
    refunded: 'declined',
    expired: 'declined',
};

function apiBase(config: NowPaymentsConfig): string {
    return config.sandbox ? 'https://api-sandbox.nowpayments.io/v1' : 'https://api.nowpayments.io/v1';
}

function sortKeysDeep(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeysDeep);
    if (value !== null && typeof value === 'object') {
        return Object.keys(value as Record<string, unknown>)
            .sort()
            .reduce<Record<string, unknown>>((acc, key) => {
                acc[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
                return acc;
            }, {});
    }
    return value;
}

export function nowPaymentsSignature(payload: unknown, ipnSecret: string): string {
    return createHmac('sha512', ipnSecret)
        .update(JSON.stringify(sortKeysDeep(payload)), 'utf8')
        .digest('hex');
}

interface NowPaymentsIpnPayload {
    payment_id?: number | string;
    payment_status?: string;
    order_id?: string;
    pay_amount?: number;
    actually_paid?: number;
    price_amount?: number;
    price_currency?: string;
    pay_currency?: string;
    __signature?: string;
    [key: string]: unknown;
}

const webhook: WebhookHandler<NowPaymentsConfig> = {
    signatureHeaderName: 'x-nowpayments-sig',
    parse(rawBody: string): NowPaymentsIpnPayload | null {
        try {
            return JSON.parse(rawBody);
        } catch {
            return null;
        }
    },
    verify(payload: unknown, config: NowPaymentsConfig, headerSignature?: string): boolean {
        const p = payload as NowPaymentsIpnPayload;
        const signature = headerSignature ?? p.__signature;
        if (!signature) return false;
        const { __signature, ...body } = p;
        const expected = nowPaymentsSignature(body, config.ipnSecret);
        return safeEqual(signature.toLowerCase(), expected);
    },
    extract(payload: unknown): WebhookEvent {
        const p = payload as NowPaymentsIpnPayload;
        return {
            transactionId: p.order_id ?? '',
            status: STATUS_MAP[p.payment_status ?? ''] ?? 'error',
            amountMinor: typeof p.price_amount === 'number' ? Math.round(p.price_amount * 100) : undefined,
            raw: payload,
        };
    },
};

export class NowPaymentsGateway implements PaymentGateway<NowPaymentsConfig> {
    readonly code = 'nowpayments';
    readonly confirmation = 'webhook' as const;
    readonly webhook = webhook;

    async createPayment(input: CreatePaymentInput, config: NowPaymentsConfig): Promise<CreatePaymentResult> {
        const res = await postJson(
            `${apiBase(config)}/invoice`,
            {
                price_amount: input.amountMinor / 100,
                price_currency: input.currencyCode.toLowerCase(),
                order_id: input.orderCode,
                order_description: input.description,
                ipn_callback_url: input.webhookUrl,
                success_url: input.returnUrl,
                cancel_url: input.returnUrl,
            },
            { 'x-api-key': config.apiKey },
        );
        const body: any = res.body && typeof res.body === 'object' ? res.body : null;
        if (!res.ok || !body?.invoice_url) {
            return {
                transactionId: input.orderCode,
                status: 'error',
                privateMetadata: { nowpaymentsError: body ?? res.status },
            };
        }
        return {
            transactionId: input.orderCode,
            status: 'pending',
            publicMetadata: {
                method: 'nowpayments',
                redirect: { url: body.invoice_url, method: 'GET' },
            },
            privateMetadata: { invoiceId: body.id },
            redirect: { url: body.invoice_url, method: 'GET' },
        };
    }
}

export const nowPaymentsGateway = new NowPaymentsGateway();
