export type ConfirmationMode = 'webhook' | 'manual';

export type GatewayPaymentStatus = 'pending' | 'authorized' | 'settled' | 'declined' | 'error';

export interface CreatePaymentInput {
    orderCode: string;
    amountMinor: number;
    currencyCode: string;
    description: string;
    customerEmail?: string;
    returnUrl?: string;
    webhookUrl?: string;
}

export interface RedirectInstruction {
    url: string;
    method: 'GET' | 'POST';
    fields?: Record<string, string>;
}

export interface CreatePaymentResult {
    transactionId: string;
    status: GatewayPaymentStatus;
    publicMetadata?: Record<string, unknown>;
    privateMetadata?: Record<string, unknown>;
    redirect?: RedirectInstruction;
}

export interface WebhookEvent {
    transactionId: string;
    status: GatewayPaymentStatus;
    amountMinor?: number;
    raw: unknown;
}

export interface WebhookHandler<C> {
    readonly signatureHeaderName?: string;
    parse(rawBody: string): unknown | null;
    verify(payload: unknown, config: C): boolean;
    extract(payload: unknown): WebhookEvent;
    respond?(payload: unknown, config: C): unknown;
}

export interface PaymentGateway<C = Record<string, string>> {
    readonly code: string;
    readonly confirmation: ConfirmationMode;
    createPayment(input: CreatePaymentInput, config: C): Promise<CreatePaymentResult>;
    readonly webhook?: WebhookHandler<C>;
}
