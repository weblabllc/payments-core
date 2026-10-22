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
import { WayForPayError, WayForPayRequestType } from './wayforpay-error.js';

export * from './wayforpay-error.js';

export interface WayForPayConfig {
    merchantAccount: string;
    merchantSecret: string;
    merchantDomain: string;
    merchantApiKey?: string;
    apiUrl?: string;
}

export type WayForPayRegularMode = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'halfyearly' | 'yearly';

export type WayForPayRegularModeInput = WayForPayRegularMode | 'day' | 'week' | 'month' | 'year' | (string & {});

export interface WayForPayRecurringInput {
    orderCode: string;
    amountMinor: number;
    regularAmountMinor?: number;
    currencyCode: string;
    description: string;
    regularMode: WayForPayRegularModeInput;
    dateNext: Date;
    regularCount: number;
    webhookUrl?: string;
    returnUrl?: string;
}

export interface WayForPayRecurringResult extends CreatePaymentResult {
    raw: unknown;
}

export interface WayForPayRecurringChange {
    regularMode: WayForPayRegularModeInput;
    amountMinor: number;
    currencyCode: string;
    dateBegin: Date;
    dateEnd: Date;
}

export type RecurringRemoveOutcome = 'removed' | 'not-found' | 'already-closed' | 'refused';
export type RecurringChangeOutcome = 'changed' | 'not-found' | 'already-closed' | 'refused';

export interface RecurringResult<O extends string> {
    ok: boolean;
    outcome: O;
    code: number;
    reason: string;
    orderReference: string;
    raw: unknown;
}

export type RecurringRemoveResult = RecurringResult<RecurringRemoveOutcome>;
export type RecurringChangeResult = RecurringResult<RecurringChangeOutcome>;

export interface WayForPayWebhookEvent extends WebhookEvent {
    kind: 'payment' | 'rule-status';
    baseReference: string;
    isRegular: boolean;
    reasonCode?: number;
    reason?: string;
    recToken?: string;
    ruleStatus?: string;
    processingDate?: number | string;
}

export interface WayForPayAcceptResponse {
    orderReference: unknown;
    status: 'accept';
    time: number;
    signature: string;
}

const DEFAULT_API_URL = 'https://api.wayforpay.com/api';
const API_PATH = /\/api\/?$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const REGULAR_SUFFIX = '_WFPREG';
const INVOICE_OK = 1100;
const REGULAR_OK = 4100;
const RULE_NOT_FOUND = 4102;
const RULE_CLOSED = new Set([4106, 4107]);

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

const REGULAR_MODES: Record<string, WayForPayRegularMode> = {
    day: 'daily',
    daily: 'daily',
    week: 'weekly',
    weekly: 'weekly',
    month: 'monthly',
    monthly: 'monthly',
    quarterly: 'quarterly',
    halfyearly: 'halfyearly',
    year: 'yearly',
    yearly: 'yearly',
};

const PAYMENT_FIELDS = ['merchantAccount', 'orderReference', 'amount', 'currency', 'authCode', 'cardPan', 'transactionStatus', 'reasonCode'] as const;
const RULE_FIELDS = ['merchantAccount', 'orderReference', 'processingDate', 'status', 'reasonCode'] as const;

export function wayForPaySignature(fields: Array<string | number>, secret: string): string {
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

export function baseOrderReference(orderReference: string): string {
    return String(orderReference).split(REGULAR_SUFFIX)[0];
}

export function formatWayForPayDate(date: Date): string {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
        throw new WayForPayError('validation', 'WayForPay: invalid date');
    }
    const dd = String(date.getUTCDate()).padStart(2, '0');
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    return `${dd}.${mm}.${date.getUTCFullYear()}`;
}

export function normalizeRegularMode(mode: string): WayForPayRegularMode {
    const key = String(mode).toLowerCase();
    if (!Object.hasOwn(REGULAR_MODES, key)) {
        throw new WayForPayError('validation', `WayForPay: unsupported regularMode "${mode}"`);
    }
    return REGULAR_MODES[key];
}

export function isRecurringRemoved(result: RecurringRemoveResult | number): boolean {
    return (typeof result === 'number' ? regularOutcome(result, 'removed') : result.outcome) !== 'refused';
}

function regularOutcome<S extends string>(code: number, success: S): S | 'not-found' | 'already-closed' | 'refused' {
    if (code === REGULAR_OK) return success;
    if (code === RULE_NOT_FOUND) return 'not-found';
    if (RULE_CLOSED.has(code)) return 'already-closed';
    return 'refused';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function toCode(value: unknown): number | undefined {
    if (typeof value === 'number') return Number.isInteger(value) ? value : undefined;
    if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value);
        return Number.isInteger(n) ? n : undefined;
    }
    return undefined;
}

function isSignable(value: unknown): boolean {
    return value === undefined || value === null || typeof value === 'string' || typeof value === 'number';
}

function isHttpsUrl(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    try {
        return new URL(value).protocol === 'https:';
    } catch {
        return false;
    }
}

function signedValue(value: unknown): string {
    return value === undefined || value === null ? '' : String(value);
}

function money(amountMinor: number): string {
    return (amountMinor / 100).toFixed(2);
}

function secretsOf(config: WayForPayConfig): string[] {
    return [config.merchantSecret, config.merchantApiKey].filter(isNonEmptyString);
}

function redactText(text: string, secrets: string[]): string {
    return secrets.reduce((t, secret) => t.split(secret).join('***'), text);
}

function redactValue(value: unknown, secrets: string[]): unknown {
    if (typeof value === 'string') return redactText(value, secrets);
    if (Array.isArray(value)) return value.map(v => redactValue(v, secrets));
    if (isPlainObject(value)) {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v, secrets)]));
    }
    return value;
}

function reasonOf(body: Record<string, unknown>, secrets: string[]): string | undefined {
    return body.reason != null ? redactText(String(body.reason), secrets) : undefined;
}

function redactedRaw(body: Record<string, unknown>, secrets: string[], reasonCode: number | undefined): unknown {
    try {
        return redactValue(body, secrets);
    } catch {
        return { reasonCode, reason: reasonOf(body, secrets) };
    }
}

function invalid(message: string, requestType?: WayForPayRequestType): WayForPayError {
    return new WayForPayError('validation', `WayForPay: ${message}`, { requestType });
}

function apiUrlOf(config: WayForPayConfig, requestType: WayForPayRequestType): URL {
    const apiUrl = config.apiUrl || DEFAULT_API_URL;
    let url: URL;
    try {
        url = new URL(apiUrl);
    } catch {
        throw invalid('apiUrl is not a valid URL', requestType);
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) {
        throw invalid('apiUrl must use https', requestType);
    }
    if (url.username || url.password) throw invalid('apiUrl must not carry credentials', requestType);
    if (url.search || url.hash) throw invalid('apiUrl must not carry a query or fragment', requestType);
    return url;
}

function regularApiUrlOf(config: WayForPayConfig, requestType: WayForPayRequestType): string {
    const url = apiUrlOf(config, requestType);
    if (!API_PATH.test(url.pathname)) throw invalid('apiUrl must end with /api to derive regularApi', requestType);
    url.pathname = url.pathname.replace(API_PATH, '/regularApi');
    return url.href;
}

async function send(url: string, body: unknown, requestType: WayForPayRequestType) {
    try {
        return await postJson(url, body, {}, { redirect: 'manual' });
    } catch (error) {
        const name = error instanceof Error ? error.name : '';
        if (name === 'TimeoutError' || name === 'AbortError') {
            throw new WayForPayError('timeout', `WayForPay: ${requestType} timed out`, { requestType, cause: error });
        }
        throw new WayForPayError('network', `WayForPay: ${requestType} request failed`, { requestType, cause: error });
    }
}

function httpFailure(requestType: WayForPayRequestType, res: { status: number; body: unknown }, secrets: string[]): WayForPayError {
    const body = isPlainObject(res.body) ? res.body : {};
    const reasonCode = toCode(body.reasonCode);
    const reason = reasonOf(body, secrets);
    return new WayForPayError('http', `WayForPay: ${requestType} failed, HTTP ${res.status}`, { requestType, status: res.status, reasonCode, reason });
}

function invoiceRefusal(res: { ok: boolean; status: number }, body: Record<string, unknown>, config: WayForPayConfig): WayForPayError {
    const reasonCode = toCode(body.reasonCode);
    const reason = reasonOf(body, secretsOf(config));
    const message = `WayForPay: ${reason ?? `no invoiceUrl, HTTP ${res.status}`} (code ${reasonCode ?? '?'})`;
    const kind = !res.ok ? 'http' : reason !== undefined || reasonCode !== undefined ? 'api' : 'parse';
    return new WayForPayError(kind, message, { requestType: 'CREATE_INVOICE', status: res.status, reasonCode, reason });
}

function buildInvoice(
    config: WayForPayConfig,
    orderReference: string,
    amountMinor: number,
    currencyCode: string,
    description: string,
    pricesAsStrings: boolean,
    webhookUrl?: string,
    returnUrl?: string,
) {
    const orderDate = Math.floor(Date.now() / 1000);
    const amount = money(amountMinor);
    const productNames = [description];
    const productCounts = [1];
    const productPrices = [pricesAsStrings ? amount : Number(amount)];

    const merchantSignature = wayForPaySignature(
        [
            config.merchantAccount,
            config.merchantDomain,
            orderReference,
            orderDate,
            amount,
            currencyCode,
            ...productNames,
            ...productCounts.map(String),
            ...productPrices,
        ],
        config.merchantSecret,
    );

    return {
        transactionType: 'CREATE_INVOICE',
        apiVersion: 1,
        merchantAccount: config.merchantAccount,
        merchantDomainName: config.merchantDomain,
        merchantAuthType: 'SimpleSignature',
        orderReference,
        orderDate,
        amount,
        currency: currencyCode,
        productName: productNames,
        productCount: productCounts,
        productPrice: productPrices,
        language: 'UA',
        ...(webhookUrl ? { serviceUrl: webhookUrl } : {}),
        ...(returnUrl ? { returnUrl } : {}),
        merchantSignature,
    };
}

export interface WayForPayCallbackPayload {
    merchantAccount?: string;
    orderReference?: string;
    amount?: number | string;
    currency?: string;
    authCode?: string;
    cardPan?: string;
    transactionStatus?: string;
    reasonCode?: string | number;
    reason?: string;
    processingDate?: number | string;
    status?: string;
    recToken?: string;
    merchantSignature?: string;
    [key: string]: unknown;
}

function isRuleStatusCallback(p: WayForPayCallbackPayload): boolean {
    return p.status !== undefined && p.transactionStatus === undefined;
}

function tryJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function isFormWrapper(value: Record<string, unknown>): boolean {
    const keys = Object.keys(value);
    return keys.length === 1 && value[keys[0]] === '';
}

function normalizeCallback(data: Record<string, unknown>): WayForPayCallbackPayload {
    if (data.authCode !== undefined && data.authCode !== null) data.authCode = String(data.authCode);
    return data as WayForPayCallbackPayload;
}

function repairCallback(text: string): WayForPayCallbackPayload | null {
    let cleaned = text;
    if (cleaned.includes('\\"')) cleaned = cleaned.replace(/\\/g, '');
    cleaned = cleaned.replace(/[\n\r\t]/g, '');
    if (cleaned.startsWith('{""')) cleaned = cleaned.replace(/""/g, '"');

    let productsText: string | undefined;
    const start = cleaned.search(/"products":\s*\[/);
    if (start !== -1) {
        const open = cleaned.indexOf('[', start);
        const close = cleaned.indexOf(']', open);
        if (close !== -1) {
            productsText = cleaned.slice(open, close + 1);
            cleaned = cleaned.slice(0, start).replace(/,\s*$/, '') + cleaned.slice(close + 1);
        }
    }

    cleaned = cleaned.replace(/:\s*(?=(,|}))/g, ':null').replace(/,(\s*[}\]])/g, '$1');
    const data = tryJson(cleaned) ?? repairBrokenJson(cleaned);
    if (!isPlainObject(data)) return null;

    if (productsText !== undefined) {
        const products = tryJson(productsText) ?? repairBrokenJson(productsText);
        if (Array.isArray(products)) data.products = products;
    }
    return normalizeCallback(data);
}

function parseCallback(rawBody: string): WayForPayCallbackPayload | null {
    let text = String(rawBody ?? '').trim();
    const direct = tryJson(text);
    if (isPlainObject(direct)) {
        if (!isFormWrapper(direct)) return normalizeCallback(direct);
        text = Object.keys(direct)[0].trim();
        const inner = tryJson(text);
        if (isPlainObject(inner)) return normalizeCallback(inner);
    }
    return repairCallback(text);
}

const webhook = {
    parse(rawBody: string): WayForPayCallbackPayload | null {
        return parseCallback(rawBody);
    },

    verify(payload: unknown, config: WayForPayConfig): boolean {
        if (!isPlainObject(payload)) return false;
        const p = payload as WayForPayCallbackPayload;
        if (!isNonEmptyString(p.merchantSignature)) return false;
        const fields = (isRuleStatusCallback(p) ? RULE_FIELDS : PAYMENT_FIELDS).map(field => p[field]);
        if (!fields.every(isSignable)) return false;
        const values = fields.map(signedValue);
        if (values.some(value => value.includes(';'))) return false;
        const expected = wayForPaySignature(values, config.merchantSecret);
        return safeEqual(expected, p.merchantSignature.toLowerCase());
    },

    extract(payload: unknown): WayForPayWebhookEvent {
        const p: WayForPayCallbackPayload = isPlainObject(payload) ? payload : {};
        const transactionId = signedValue(p.orderReference);
        const reasonCode = toCode(p.reasonCode);
        const common = {
            transactionId,
            baseReference: baseOrderReference(transactionId),
            isRegular: transactionId.includes(REGULAR_SUFFIX),
            raw: payload,
            ...(reasonCode !== undefined ? { reasonCode } : {}),
            ...(typeof p.reason === 'string' ? { reason: p.reason } : {}),
        };
        if (isRuleStatusCallback(p)) {
            return {
                ...common,
                kind: 'rule-status',
                status: 'pending',
                ruleStatus: String(p.status),
                ...(typeof p.processingDate === 'number' || isNonEmptyString(p.processingDate) ? { processingDate: p.processingDate } : {}),
            };
        }
        const status = String(p.transactionStatus);
        const amount = p.amount != null ? Number(p.amount) : Number.NaN;
        return {
            ...common,
            kind: 'payment',
            status: Object.hasOwn(STATUS_MAP, status) ? STATUS_MAP[status] : 'pending',
            amountMinor: Number.isFinite(amount) ? Math.round(amount * 100) : undefined,
            ...(isNonEmptyString(p.recToken) ? { recToken: p.recToken } : {}),
        };
    },

    respond(payload: unknown, config: WayForPayConfig): WayForPayAcceptResponse {
        const p: WayForPayCallbackPayload = isPlainObject(payload) ? payload : {};
        if (signedValue(p.orderReference).includes(';')) throw invalid('orderReference must not contain ";"');
        const time = Math.floor(Date.now() / 1000);
        return {
            orderReference: p.orderReference,
            status: 'accept',
            time,
            signature: wayForPaySignature([signedValue(p.orderReference), 'accept', String(time)], config.merchantSecret),
        };
    },
} satisfies WebhookHandler<WayForPayConfig>;

export class WayForPayGateway implements PaymentGateway<WayForPayConfig> {
    readonly code = 'wayforpay';
    readonly confirmation = 'webhook' as const;
    readonly webhook = webhook;

    async createPayment(input: CreatePaymentInput, config: WayForPayConfig): Promise<CreatePaymentResult> {
        const orderReference = input.orderCode;
        const payload = buildInvoice(config, orderReference, input.amountMinor, input.currencyCode, input.description, false, input.webhookUrl, input.returnUrl);

        const res = await send(apiUrlOf(config, 'CREATE_INVOICE').href, payload, 'CREATE_INVOICE');
        const body = isPlainObject(res.body) ? res.body : {};
        if (!body.invoiceUrl) throw invoiceRefusal(res, body, config);
        return {
            transactionId: orderReference,
            status: 'pending',
            redirect: { url: String(body.invoiceUrl), method: 'GET' },
            publicMetadata: { method: 'wayforpay' },
        };
    }

    async createRecurringPayment(input: WayForPayRecurringInput, config: WayForPayConfig): Promise<WayForPayRecurringResult> {
        const requestType = 'CREATE_INVOICE';
        const regularAmountMinor = input.regularAmountMinor ?? input.amountMinor;
        if (!isNonEmptyString(input.orderCode) || input.orderCode.includes(';') || input.orderCode.includes(REGULAR_SUFFIX)) {
            throw invalid(`orderCode must be non-empty and contain neither ";" nor "${REGULAR_SUFFIX}"`, requestType);
        }
        if (!Number.isInteger(input.amountMinor) || input.amountMinor < 0) throw invalid('amountMinor must be a non-negative integer', requestType);
        if (!Number.isInteger(regularAmountMinor) || regularAmountMinor <= 0) throw invalid('regularAmountMinor must be a positive integer', requestType);
        if (!Number.isInteger(input.regularCount) || input.regularCount <= 0) throw invalid('regularCount must be a positive integer', requestType);
        if (!isNonEmptyString(input.currencyCode)) throw invalid('currencyCode is required', requestType);
        if (!isNonEmptyString(input.description)) throw invalid('description is required', requestType);
        const regularMode = normalizeRegularMode(input.regularMode);
        const dateNext = formatWayForPayDate(input.dateNext);

        const payload = {
            ...buildInvoice(config, input.orderCode, input.amountMinor, input.currencyCode, input.description, true, input.webhookUrl, input.returnUrl),
            regularBehavior: 'preset',
            regularOn: 1,
            regularMode,
            dateNext,
            regularAmount: money(regularAmountMinor),
            regularCount: input.regularCount,
        };

        const res = await send(apiUrlOf(config, requestType).href, payload, requestType);
        const secrets = secretsOf(config);
        if (!res.ok) throw httpFailure(requestType, res, secrets);
        if (!isPlainObject(res.body)) {
            throw new WayForPayError('parse', `WayForPay: ${requestType} returned an unreadable reply (HTTP ${res.status})`, { requestType, status: res.status });
        }
        const body = res.body;
        const reasonCode = toCode(body.reasonCode);
        const reason = reasonOf(body, secrets);
        if (reasonCode !== INVOICE_OK) {
            const kind = reasonCode === undefined && reason === undefined ? 'parse' : 'api';
            throw new WayForPayError(kind, `WayForPay: ${reason ?? 'invoice refused'} (code ${reasonCode ?? '?'})`, { requestType, status: res.status, reasonCode, reason });
        }
        if (!isHttpsUrl(body.invoiceUrl)) {
            throw new WayForPayError('parse', `WayForPay: ${requestType} succeeded without an https invoiceUrl`, { requestType, status: res.status, reasonCode });
        }
        return {
            transactionId: input.orderCode,
            status: 'pending',
            redirect: { url: body.invoiceUrl, method: 'GET' },
            publicMetadata: { method: 'wayforpay' },
            raw: redactedRaw(body, secrets, reasonCode),
        };
    }

    async cancelRecurring(orderReference: string, config: WayForPayConfig): Promise<RecurringRemoveResult> {
        const reply = await this.regularApi('REMOVE', orderReference, {}, config);
        const outcome = regularOutcome(reply.code, 'removed');
        return { ok: outcome !== 'refused', outcome, ...reply };
    }

    async changeRecurring(orderReference: string, change: WayForPayRecurringChange, config: WayForPayConfig): Promise<RecurringChangeResult> {
        const requestType = 'CHANGE';
        if (!Number.isInteger(change.amountMinor) || change.amountMinor <= 0) throw invalid('amountMinor must be a positive integer', requestType);
        if (!isNonEmptyString(change.currencyCode)) throw invalid('currencyCode is required', requestType);
        const fields = {
            regularMode: normalizeRegularMode(change.regularMode),
            amount: money(change.amountMinor),
            currency: change.currencyCode,
            dateBegin: formatWayForPayDate(change.dateBegin),
            dateEnd: formatWayForPayDate(change.dateEnd),
        };
        const reply = await this.regularApi(requestType, orderReference, fields, config);
        const outcome = regularOutcome(reply.code, 'changed');
        return { ok: outcome === 'changed', outcome, ...reply };
    }

    private async regularApi(requestType: 'REMOVE' | 'CHANGE', orderReference: string, fields: Record<string, unknown>, config: WayForPayConfig) {
        if (!isNonEmptyString(config.merchantApiKey)) throw invalid('merchantApiKey is required for regularApi', requestType);
        const url = regularApiUrlOf(config, requestType);
        const reference = baseOrderReference(orderReference ?? '');
        if (!isNonEmptyString(reference)) throw invalid('orderReference is required', requestType);

        const res = await send(url, {
            requestType,
            merchantAccount: config.merchantAccount,
            merchantPassword: config.merchantApiKey,
            orderReference: reference,
            ...fields,
        }, requestType);

        const secrets = secretsOf(config);
        if (!res.ok) throw httpFailure(requestType, res, secrets);
        const code = isPlainObject(res.body) ? toCode(res.body.reasonCode) : undefined;
        if (!isPlainObject(res.body) || code === undefined) {
            throw new WayForPayError('parse', `WayForPay: ${requestType} returned an unreadable reply (HTTP ${res.status})`, { requestType, status: res.status });
        }
        return {
            code,
            reason: reasonOf(res.body, secrets) ?? '',
            orderReference: reference,
            raw: redactedRaw(res.body, secrets, code),
        };
    }
}
