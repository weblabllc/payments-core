import { CreatePaymentInput, CreatePaymentResult, PaymentGateway } from './gateway.js';

export interface InvoiceConfig {
    recipientName: string;
    iban: string;
    taxId: string;
    bankName?: string;
    purposeTemplate?: string;
}

export class InvoiceGateway implements PaymentGateway<InvoiceConfig> {
    readonly code = 'invoice';
    readonly confirmation = 'manual' as const;

    async createPayment(input: CreatePaymentInput, config: InvoiceConfig): Promise<CreatePaymentResult> {
        const template = config.purposeTemplate || 'Оплата замовлення {orderCode}';
        const purpose = template.replace('{orderCode}', input.orderCode);
        return {
            transactionId: input.orderCode,
            status: 'authorized',
            publicMetadata: {
                method: 'invoice',
                recipientName: config.recipientName,
                iban: config.iban,
                taxId: config.taxId,
                ...(config.bankName ? { bankName: config.bankName } : {}),
                amount: (input.amountMinor / 100).toFixed(2),
                currencyCode: input.currencyCode,
                purpose,
            },
        };
    }
}
