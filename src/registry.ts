import { PaymentGateway } from './gateway.js';

export type BuiltinGatewayCode = 'invoice' | 'liqpay' | 'wayforpay' | 'nowpayments';

const BUILTIN_LOADERS: Record<BuiltinGatewayCode, () => Promise<PaymentGateway<any>>> = {
    invoice: async () => new (await import('./invoice-gateway.js')).InvoiceGateway(),
    liqpay: async () => new (await import('./liqpay-gateway.js')).LiqPayGateway(),
    wayforpay: async () => new (await import('./wayforpay-gateway.js')).WayForPayGateway(),
    nowpayments: async () => new (await import('./nowpayments-gateway.js')).NowPaymentsGateway(),
};

export interface PaymentsRegistryConfig {
    gateways: Array<BuiltinGatewayCode | PaymentGateway<any>>;
}

export class PaymentsRegistry {
    private constructor(private byCode: Map<string, PaymentGateway<any>>) {}

    static async create(config: PaymentsRegistryConfig): Promise<PaymentsRegistry> {
        if (!config.gateways.length) {
            throw new Error('PaymentsRegistry requires at least one gateway');
        }
        const byCode = new Map<string, PaymentGateway<any>>();
        for (const entry of config.gateways) {
            const gateway =
                typeof entry === 'string'
                    ? await (BUILTIN_LOADERS[entry] ?? unknownGateway(entry))()
                    : entry;
            if (byCode.has(gateway.code)) {
                throw new Error(`Duplicate payment gateway code: ${gateway.code}`);
            }
            byCode.set(gateway.code, gateway);
        }
        return new PaymentsRegistry(byCode);
    }

    codes(): string[] {
        return [...this.byCode.keys()];
    }

    has(code: string): boolean {
        return this.byCode.has(code);
    }

    get(code: string): PaymentGateway<any> {
        const gateway = this.byCode.get(code);
        if (!gateway) {
            throw new Error(`Payment gateway "${code}" is not enabled (enabled: ${this.codes().join(', ')})`);
        }
        return gateway;
    }

    withWebhook(): PaymentGateway<any>[] {
        return [...this.byCode.values()].filter(g => g.webhook);
    }
}

function unknownGateway(code: string): () => Promise<never> {
    return async () => {
        throw new Error(`Unknown builtin payment gateway "${code}" (builtin: ${Object.keys(BUILTIN_LOADERS).join(', ')})`);
    };
}
