import { createHmac } from 'crypto';
import {
    CreatePaymentInput,
    CreatePaymentResult,
    GatewayPaymentStatus,
    PaymentGateway,
    WebhookEvent,
    WebhookHandler,
} from './gateway.js';

export interface WayForPayConfig {
    merchantAccount: string;
    merchantSecret: string;
    merchantDomain: string;
}

const API_URL = 'https://api.wayforpay.com/api';

const STATUS_MAP: Record<string, GatewayPaymentStatus> = {
    Approved: 'settled',
    Pending: 'pending',
    InProcessing: 'pending',
    WaitingAuthComplete: 'authorized',
    Declined: 'declined',
    Expired: 'declined',
    Refunded: 'declined',
    Voided: 'declined',
};

function sign(fields: Array<string | number>, secret: string): string {
    return createHmac('md5', secret).update(fields.join(';'), 'utf8').digest('hex');
}

export function repairBrokenJson(rawString: string): unknown | null {
    let t = String(rawString).trim();
    t = t.replace(/:",\s*"/g, ':",", "');
    t = t.replace(/:\s*(?=(,|}))/g, ':null');
    t = t.replace(/,(\s*[}\]])/g, '$1');
    try {
        return JSON.parse(t);
    } catch {
        return null;
    }
}

interface WfpCallbackPayload {
    merchantAccount?: string;
    orderReference?: string;
    amount?: number | string;
    currency?: string;
    authCode?: string;
    cardPan?: string;
    transactionStatus?: string;
    reasonCode?: string | number;
    merchantSignature?: string;
    [key: string]: unknown;
}

const webhook: WebhookHandler<WayForPayConfig> = {
    parse(rawBody: string): WfpCallbackPayload | null {
        try {
            return JSON.parse(rawBody);
        } catch {
            return repairBrokenJson(rawBody) as WfpCallbackPayload | null;
        }
    },

    verify(payload: unknown, config: WayForPayConfig): boolean {
        const p = payload as WfpCallbackPayload;
        if (!p.merchantSignature) return false;
        const expected = sign(
            [
                String(p.merchantAccount),
                String(p.orderReference),
                String(p.amount),
                String(p.currency),
                String(p.authCode),
                String(p.cardPan),
                String(p.transactionStatus),
                String(p.reasonCode),
            ],
            config.merchantSecret,
        );
        return expected.toLowerCase() === String(p.merchantSignature).toLowerCase();
    },

    extract(payload: unknown): WebhookEvent {
        const p = payload as WfpCallbackPayload;
        return {
            transactionId: String(p.orderReference ?? ''),
            status: STATUS_MAP[String(p.transactionStatus)] ?? 'pending',
            amountMinor: p.amount != null ? Math.round(Number(p.amount) * 100) : undefined,
            raw: p,
        };
    },

    respond(payload: unknown, config: WayForPayConfig): unknown {
        const p = payload as WfpCallbackPayload;
        const time = Math.floor(Date.now() / 1000);
        return {
            orderReference: p.orderReference,
            status: 'accept',
            time,
            signature: sign([String(p.orderReference), 'accept', String(time)], config.merchantSecret),
        };
    },
};

export class WayForPayGateway implements PaymentGateway<WayForPayConfig> {
    readonly code = 'wayforpay';
    readonly confirmation = 'webhook' as const;
    readonly webhook = webhook;

    async createPayment(input: CreatePaymentInput, config: WayForPayConfig): Promise<CreatePaymentResult> {
        const orderReference = input.orderCode;
        const orderDate = Math.floor(Date.now() / 1000);
        const amount = (input.amountMinor / 100).toFixed(2);
        const productNames = [input.description];
        const productCounts = ['1'];
        const productPrices = [amount];

        const signature = sign(
            [
                config.merchantAccount,
                config.merchantDomain,
                orderReference,
                orderDate,
                amount,
                input.currencyCode,
                ...productNames,
                ...productCounts,
                ...productPrices,
            ],
            config.merchantSecret,
        );

        const payload = {
            transactionType: 'CREATE_INVOICE',
            apiVersion: 1,
            merchantAccount: config.merchantAccount,
            merchantDomainName: config.merchantDomain,
            merchantAuthType: 'SimpleSignature',
            orderReference,
            orderDate,
            amount,
            currency: input.currencyCode,
            productName: productNames,
            productCount: productCounts.map(Number),
            productPrice: productPrices.map(Number),
            language: 'UA',
            ...(input.webhookUrl ? { serviceUrl: input.webhookUrl } : {}),
            ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
            merchantSignature: signature,
        };

        const res = await fetch(API_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const body = (await res.json()) as { invoiceUrl?: string; reason?: string; reasonCode?: number };
        if (!body.invoiceUrl) {
            throw new Error(`WayForPay: ${body.reason ?? 'no invoiceUrl'} (code ${body.reasonCode ?? '?'})`);
        }
        return {
            transactionId: orderReference,
            status: 'pending',
            redirect: { url: body.invoiceUrl, method: 'GET' },
            publicMetadata: { method: 'wayforpay' },
        };
    }
}
