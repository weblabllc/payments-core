export interface CheckboxConfig {
    licenseKey: string;
    login: string;
    password: string;
    baseUrl?: string;
}

export interface CheckboxPaymentEntry {
    type: 'CASHLESS' | 'CASH';
    value: number;
    label?: string;
    [extra: string]: unknown;
}

export interface CheckboxGoodEntry {
    good: {
        code: string;
        name: string;
        price: number;
        tax?: number[];
    };
    quantity: number;
}

export interface CheckboxReceiptPayload {
    departament?: string;
    goods: CheckboxGoodEntry[];
    payments: CheckboxPaymentEntry[];
    header?: string;
    footer?: string;
    barcode?: string;
    delivery?: { emails: string[] };
}

export interface CheckboxResponse<T = unknown> {
    ok: boolean;
    status: number;
    body: T;
}

import { REQUEST_TIMEOUT_MS } from './http.js';

const DEFAULT_BASE_URL = 'https://api.checkbox.ua/api/v1';

export class CheckboxError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly body: unknown,
    ) {
        super(message);
    }
}

export class CheckboxClient {
    private accessToken: string | null = null;

    constructor(private config: CheckboxConfig) {}

    private base(): string {
        return (this.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    }

    private async request<T = unknown>(
        method: string,
        path: string,
        options: { json?: unknown; headers?: Record<string, string>; auth?: boolean } = {},
    ): Promise<CheckboxResponse<T>> {
        const headers: Record<string, string> = {
            accept: 'application/json',
            ...(options.json !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(options.auth !== false && this.accessToken
                ? { authorization: `Bearer ${this.accessToken}` }
                : {}),
            ...options.headers,
        };
        const res = await fetch(`${this.base()}/${path}`, {
            method,
            headers,
            body: options.json !== undefined ? JSON.stringify(options.json) : undefined,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const text = await res.text();
        let body: unknown = null;
        try {
            body = text ? JSON.parse(text) : null;
        } catch {
            body = text;
        }
        return { ok: res.ok, status: res.status, body: body as T };
    }

    private ensure<T>(res: CheckboxResponse<T>, action: string): T {
        if (!res.ok) throw new CheckboxError(`checkbox ${action} failed (${res.status})`, res.status, res.body);
        return res.body;
    }

    async signin(): Promise<string> {
        const res = await this.request<{ access_token?: string }>('POST', 'cashier/signin', {
            json: { login: this.config.login, password: this.config.password },
            auth: false,
        });
        const body = this.ensure(res, 'signin');
        if (!body.access_token) throw new CheckboxError('checkbox signin: no access_token', res.status, body);
        this.accessToken = body.access_token;
        return this.accessToken;
    }

    async openShift(): Promise<unknown> {
        const res = await this.request('POST', 'shifts', {
            headers: { 'X-License-Key': this.config.licenseKey },
        });
        return this.ensure(res, 'openShift');
    }

    async closeShift(): Promise<unknown> {
        return this.ensure(await this.request('POST', 'shifts/close'), 'closeShift');
    }

    async currentShift(): Promise<unknown> {
        return this.ensure(await this.request('GET', 'cashier/shift'), 'currentShift');
    }

    async sellReceipt(payload: CheckboxReceiptPayload): Promise<{ id: string } & Record<string, unknown>> {
        const res = await this.request<{ id: string } & Record<string, unknown>>('POST', 'receipts/sell', {
            json: payload,
        });
        return this.ensure(res, 'sellReceipt');
    }

    async serviceReceipt(value: number): Promise<unknown> {
        return this.ensure(
            await this.request('POST', 'receipts/service', { json: { payment: { value } } }),
            'serviceReceipt',
        );
    }

    async receiptHtml(receiptId: string): Promise<string> {
        const res = await this.request<string>('GET', `receipts/${receiptId}/html`);
        return this.ensure(res, 'receiptHtml');
    }

    async receiptText(receiptId: string): Promise<string> {
        const res = await this.request<string>('GET', `receipts/${receiptId}/text`);
        return this.ensure(res, 'receiptText');
    }

    async createXReport(): Promise<{ id: string } & Record<string, unknown>> {
        const res = await this.request<{ id: string } & Record<string, unknown>>('POST', 'reports');
        return this.ensure(res, 'createXReport');
    }

    async reportText(reportId: string): Promise<string> {
        const res = await this.request<string>('GET', `reports/${reportId}/text`);
        return this.ensure(res, 'reportText');
    }
}
