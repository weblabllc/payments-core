import { createHash } from 'crypto';
import {
    CreatePaymentInput,
    CreatePaymentResult,
    GatewayPaymentStatus,
    PaymentGateway,
    WebhookEvent,
    WebhookHandler,
} from './gateway.js';

export interface LiqPayConfig {
    publicKey: string;
    privateKey: string;
}

const STATUS_MAP: Record<string, GatewayPaymentStatus> = {
    success: 'settled',
    sandbox: 'settled',
    wait_accept: 'authorized',
    processing: 'pending',
    prepared: 'pending',
    wait_secure: 'pending',
    '3ds_verify': 'pending',
    failure: 'declined',
    reversed: 'declined',
    error: 'error',
};

function sign(data: string, privateKey: string): string {
    return createHash('sha1')
        .update(privateKey + data + privateKey, 'utf8')
        .digest('base64');
}

interface LiqPayCallbackPayload {
    data: string;
    signature: string;
    decoded: {
        status?: string;
        order_id?: string;
        amount?: number;
        [key: string]: unknown;
    };
}

const webhook: WebhookHandler<LiqPayConfig> = {
    parse(rawBody: string): LiqPayCallbackPayload | null {
        const params = new URLSearchParams(rawBody);
        const data = params.get('data');
        const signature = params.get('signature');
        if (!data || !signature) return null;
        try {
            const decoded = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
            return { data, signature, decoded };
        } catch {
            return null;
        }
    },

    verify(payload: unknown, config: LiqPayConfig): boolean {
        const p = payload as LiqPayCallbackPayload;
        return sign(p.data, config.privateKey) === p.signature;
    },

    extract(payload: unknown): WebhookEvent {
        const { decoded } = payload as LiqPayCallbackPayload;
        return {
            transactionId: String(decoded.order_id ?? ''),
            status: STATUS_MAP[String(decoded.status)] ?? 'pending',
            amountMinor: decoded.amount != null ? Math.round(Number(decoded.amount) * 100) : undefined,
            raw: decoded,
        };
    },
};

export class LiqPayGateway implements PaymentGateway<LiqPayConfig> {
    readonly code = 'liqpay';
    readonly confirmation = 'webhook' as const;
    readonly webhook = webhook;

    async createPayment(input: CreatePaymentInput, config: LiqPayConfig): Promise<CreatePaymentResult> {
        const params = {
            public_key: config.publicKey,
            version: '3',
            action: 'pay',
            amount: (input.amountMinor / 100).toFixed(2),
            currency: input.currencyCode,
            description: input.description,
            order_id: input.orderCode,
            ...(input.returnUrl ? { result_url: input.returnUrl } : {}),
            ...(input.webhookUrl ? { server_url: input.webhookUrl } : {}),
            sandbox: config.publicKey.startsWith('sandbox') ? 1 : 0,
        };
        const data = Buffer.from(JSON.stringify(params)).toString('base64');
        const signature = sign(data, config.privateKey);
        return {
            transactionId: input.orderCode,
            status: 'pending',
            redirect: {
                url: 'https://www.liqpay.ua/api/3/checkout',
                method: 'POST',
                fields: { data, signature },
            },
            publicMetadata: { method: 'liqpay' },
        };
    }
}
