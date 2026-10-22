import { inspect } from 'util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    baseOrderReference,
    formatWayForPayDate,
    isRecurringRemoved,
    normalizeRegularMode,
    WayForPayError,
    WayForPayGateway,
    wayForPaySignature,
} from '../src/index.js';
import * as subpath from '../src/wayforpay-gateway.js';
import { jsonBody, mockFetch } from './fetch-mock.js';

const API_KEY = 'api-key-SECRET-123';
const SECRET = 'test-secret';
const config = { merchantAccount: 'test_merch', merchantSecret: SECRET, merchantDomain: 'shop.example', merchantApiKey: API_KEY };
const gw = new WayForPayGateway();

const V = {
    oneOff450: 'a12abbf8c6860164923bb7b540c34950',
    oneOff1050: 'c8242204f877e1bb34c8ca3094fb7ec3',
    recurring450: '001ab338f1b48c6509d62f7b789a8ea8',
    recurring0: 'c223ad16970f354453770a01482b194b',
    approved: '8beac4cc99c2b7a00068ab0c2d55bae9',
    declinedBare: '5e2eef71b7a47c800834d5563c7d2d41',
    authCodeNull: '678336203ff1b24c79654da7b9fe24e1',
    regularCharge: 'ff8db9bd6d1a7670965a29be00329d1d',
    ruleRemoved: 'b9d9ceb736ab3cde2bc4040169baa081',
    ruleSuspended: '1110ec6f0c9d47ae90a45a699b15fa23',
    accept: '6bab346c76d2d62d96a8e5f42cf6aa13',
};

const approved = () => ({ merchantAccount: 'test_merch', orderReference: 'ORD-7', amount: 450, currency: 'UAH', authCode: '541963', cardPan: '53****4242', transactionStatus: 'Approved', reasonCode: 1100, merchantSignature: V.approved });
const declinedBare = () => ({ merchantAccount: 'test_merch', orderReference: 'ORD-7', amount: 450, currency: 'UAH', transactionStatus: 'Declined', reasonCode: 1104, merchantSignature: V.declinedBare });
const authCodeNull = () => ({ merchantAccount: 'test_merch', orderReference: 'ORD-7', amount: 450, currency: 'UAH', authCode: null, cardPan: '53****4242', transactionStatus: 'Declined', reasonCode: 1104, merchantSignature: V.authCodeNull });
const regularCharge = () => ({ merchantAccount: 'test_merch', orderReference: 'ORD-7_WFPREG-1', amount: 450, currency: 'UAH', authCode: '541963', cardPan: '53****4242', transactionStatus: 'Approved', reasonCode: 1100, recToken: 'tok', merchantSignature: V.regularCharge });
const ruleRemoved = () => ({ merchantAccount: 'test_merch', orderReference: 'ORD-7', processingDate: 1789269263, status: 'Removed', reasonCode: 4107, reason: 'Regular payment is removed', merchantSignature: V.ruleRemoved });
const ruleSuspended = () => ({ merchantAccount: 'test_merch', orderReference: 'ORD-7', processingDate: 1789269263, status: 'Suspended', reasonCode: 4108, reason: 'Suspended', merchantSignature: V.ruleSuspended });

const timeout = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');
const aborted = () => new DOMException('This operation was aborted', 'AbortError');
const offline = () => new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:9999') });

async function caught(promise: Promise<unknown>): Promise<WayForPayError> {
    try {
        await promise;
    } catch (error) {
        expect(error).toBeInstanceOf(WayForPayError);
        return error as WayForPayError;
    }
    throw new Error('expected a rejection');
}

function expectNoSecrets(value: unknown) {
    const text = inspect(value, { depth: 10, showHidden: true }) + (() => { try { return JSON.stringify(value) ?? ''; } catch { return ''; } })();
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(SECRET);
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('test environment', () => {
    it('runs in a non-UTC timezone so local-time bugs surface', () => {
        expect(new Date('2026-10-22T23:30:00Z').getDate()).toBe(23);
    });
});

describe('wayForPaySignature reproduces shp-back vectors', () => {
    it('one-off invoice', () => {
        expect(wayForPaySignature(['test_merch', 'shop.example', 'ORD-7', 1790071200, '450.00', 'UAH', 'Книга', '1', 450], SECRET)).toBe(V.oneOff450);
        expect(wayForPaySignature(['test_merch', 'shop.example', 'ORD-7', 1790071200, '10.50', 'UAH', 'Книга', '1', 10.5], SECRET)).toBe(V.oneOff1050);
    });

    it('recurring invoice signs prices as strings', () => {
        expect(wayForPaySignature(['test_merch', 'shop.example', 'ORD-7', 1790071200, '450.00', 'UAH', 'Книга', '1', '450.00'], SECRET)).toBe(V.recurring450);
        expect(wayForPaySignature(['test_merch', 'shop.example', 'ORD-7', 1790071200, '0.00', 'UAH', 'Книга', '1', '0.00'], SECRET)).toBe(V.recurring0);
    });

    it('accept response', () => {
        expect(wayForPaySignature(['ORD-7', 'accept', '1790071200'], SECRET)).toBe(V.accept);
    });
});

describe('WayForPayError', () => {
    it('is an Error with a kind and is exported from the wayforpay subpath', () => {
        const error = new WayForPayError('api', 'WayForPay: x', { reasonCode: 1113, reason: 'x', requestType: 'CREATE_INVOICE' });
        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe('WayForPayError');
        expect(error.kind).toBe('api');
        expect(error.reasonCode).toBe(1113);
        expect(error.requestType).toBe('CREATE_INVOICE');
        expect(subpath.WayForPayError).toBe(WayForPayError);
        expect(subpath.isRecurringRemoved).toBe(isRecurringRemoved);
    });
});

describe('createPayment transport', () => {
    const input = { orderCode: 'ORD-7', amountMinor: 45000, currencyCode: 'UAH', description: 'Книга' };

    it('posts to the default api url', async () => {
        const calls = mockFetch({ body: { invoiceUrl: 'u', reasonCode: 1100 } });
        await gw.createPayment(input, config);
        expect(calls[0].url).toBe('https://api.wayforpay.com/api');
    });

    it('posts to config.apiUrl when set', async () => {
        const calls = mockFetch({ body: { invoiceUrl: 'u', reasonCode: 1100 } });
        await gw.createPayment(input, { ...config, apiUrl: 'http://localhost:9999/api' });
        expect(calls[0].url).toBe('http://localhost:9999/api');
    });

    it('keeps the signed body byte-identical to shp', async () => {
        vi.useFakeTimers({ now: new Date('2026-09-22T10:00:00Z'), toFake: ['Date'] });
        const calls = mockFetch({ body: { invoiceUrl: 'u' } }, { body: { invoiceUrl: 'u' } });
        await gw.createPayment(input, config);
        await gw.createPayment({ ...input, amountMinor: 1050 }, config);
        const expected = {
            transactionType: 'CREATE_INVOICE', apiVersion: 1, merchantAccount: 'test_merch', merchantDomainName: 'shop.example',
            merchantAuthType: 'SimpleSignature', orderReference: 'ORD-7', orderDate: 1790071200, amount: '450.00', currency: 'UAH',
            productName: ['Книга'], productCount: [1], productPrice: [450], language: 'UA', merchantSignature: V.oneOff450,
        };
        expect(jsonBody(calls[0])).toEqual(expected);
        expect(jsonBody(calls[1])).toEqual({ ...expected, amount: '10.50', productPrice: [10.5], merchantSignature: V.oneOff1050 });
    });

    it('classifies a gateway refusal as api', async () => {
        mockFetch({ body: { reason: 'Invalid signature', reasonCode: 1113 } });
        const error = await caught(gw.createPayment(input, config));
        expect(error.kind).toBe('api');
        expect(error.reasonCode).toBe(1113);
        expect(error.reason).toBe('Invalid signature');
        expect(error.message).toBe('WayForPay: Invalid signature (code 1113)');
    });

    it('classifies a non-2xx reply as http', async () => {
        mockFetch({ status: 502, body: '<html>bad gateway</html>' });
        const error = await caught(gw.createPayment(input, config));
        expect(error.kind).toBe('http');
        expect(error.status).toBe(502);
        expect(error.message).toMatch(/HTTP 502/);
    });

    it('classifies a 200 without invoiceUrl or reason as parse', async () => {
        mockFetch({ body: 'plain text' });
        expect((await caught(gw.createPayment(input, config))).kind).toBe('parse');
    });

    it('maps timeouts, aborts and network failures', async () => {
        mockFetch(timeout());
        expect((await caught(gw.createPayment(input, config))).kind).toBe('timeout');
        mockFetch(aborted());
        expect((await caught(gw.createPayment(input, config))).kind).toBe('timeout');
        mockFetch(offline());
        const error = await caught(gw.createPayment(input, config));
        expect(error.kind).toBe('network');
        expect(error.cause).toBeInstanceOf(TypeError);
    });

    it('never leaks the secret or the api key', async () => {
        mockFetch({ body: { reason: `bad ${SECRET} ${API_KEY}`, reasonCode: 1113 } });
        expectNoSecrets(await caught(gw.createPayment(input, config)));
    });
});

describe('webhook.verify, payment callbacks', () => {
    it('accepts a fully populated callback', () => {
        expect(gw.webhook.verify(approved(), config)).toBe(true);
    });

    it('signs missing fields as empty strings', () => {
        expect(gw.webhook.verify(declinedBare(), config)).toBe(true);
    });

    it('signs null fields as empty strings', () => {
        expect(gw.webhook.verify(authCodeNull(), config)).toBe(true);
    });

    it('rejects tampering and a wrong secret', () => {
        expect(gw.webhook.verify({ ...approved(), amount: 1 }, config)).toBe(false);
        expect(gw.webhook.verify({ ...approved(), transactionStatus: 'Declined' }, config)).toBe(false);
        expect(gw.webhook.verify(approved(), { ...config, merchantSecret: 'other' })).toBe(false);
    });

    it('accepts an uppercase signature', () => {
        expect(gw.webhook.verify({ ...approved(), merchantSignature: V.approved.toUpperCase() }, config)).toBe(true);
    });

    it('rejects a missing or non-string signature', () => {
        const { merchantSignature: _, ...unsigned } = approved();
        expect(gw.webhook.verify(unsigned, config)).toBe(false);
        expect(gw.webhook.verify({ ...approved(), merchantSignature: 12345 }, config)).toBe(false);
        expect(gw.webhook.verify({ ...approved(), merchantSignature: '' }, config)).toBe(false);
    });

    it('never throws on non-object payloads', () => {
        for (const payload of [null, undefined, 'x', 42, [], true]) {
            expect(gw.webhook.verify(payload, config)).toBe(false);
        }
    });

    it('rejects a signed field that contains the separator', () => {
        const body: Record<string, unknown> = { ...approved(), cardPan: '53****4242;x' };
        const fields = ['merchantAccount', 'orderReference', 'amount', 'currency', 'authCode', 'cardPan', 'transactionStatus', 'reasonCode'].map(k => String(body[k]));
        body.merchantSignature = wayForPaySignature(fields, SECRET);
        expect(gw.webhook.verify(body, config)).toBe(false);
    });
});

describe('webhook.verify, rule status callbacks', () => {
    it('accepts Removed and Suspended rule callbacks', () => {
        expect(gw.webhook.verify(ruleRemoved(), config)).toBe(true);
        expect(gw.webhook.verify(ruleSuspended(), config)).toBe(true);
    });

    it('rejects tampering with status or processingDate', () => {
        expect(gw.webhook.verify({ ...ruleRemoved(), status: 'Active' }, config)).toBe(false);
        expect(gw.webhook.verify({ ...ruleRemoved(), processingDate: 1789269264 }, config)).toBe(false);
    });

    it('uses the payment field set when transactionStatus is present', () => {
        expect(gw.webhook.verify({ ...approved(), status: 'Active' }, config)).toBe(true);
    });

    it('rejects a rule callback signed over the payment fields', () => {
        const body: Record<string, unknown> = { ...ruleRemoved() };
        const fields = ['merchantAccount', 'orderReference', 'amount', 'currency', 'authCode', 'cardPan', 'transactionStatus', 'reasonCode'].map(k => (body[k] == null ? '' : String(body[k])));
        body.merchantSignature = wayForPaySignature(fields, SECRET);
        expect(gw.webhook.verify(body, config)).toBe(false);
    });

    it('rejects a payment callback reshaped into a rule callback', () => {
        const forged = { merchantAccount: 'test_merch', orderReference: 'ORD-7', processingDate: '450;UAH;541963;53****4242', status: 'Approved', reasonCode: 1100, merchantSignature: V.approved };
        expect(wayForPaySignature(['test_merch', 'ORD-7', forged.processingDate, 'Approved', '1100'], SECRET)).toBe(V.approved);
        expect(gw.webhook.verify(forged, config)).toBe(false);
    });
});

describe('webhook.extract', () => {
    it('describes a first payment', () => {
        expect(gw.webhook.extract(approved())).toMatchObject({
            kind: 'payment', transactionId: 'ORD-7', status: 'settled', amountMinor: 45000,
            isRegular: false, baseReference: 'ORD-7', reasonCode: 1100,
        });
    });

    it('describes a regular charge', () => {
        const event = gw.webhook.extract(regularCharge());
        expect(event).toMatchObject({ kind: 'payment', transactionId: 'ORD-7_WFPREG-1', isRegular: true, baseReference: 'ORD-7', recToken: 'tok', status: 'settled' });
    });

    it('leaves recToken out when absent or empty', () => {
        expect(gw.webhook.extract(approved()).recToken).toBeUndefined();
        expect(gw.webhook.extract({ ...approved(), recToken: '' }).recToken).toBeUndefined();
    });

    it('describes a rule status change without pretending it is a payment', () => {
        const event = gw.webhook.extract(ruleRemoved());
        expect(event).toMatchObject({
            kind: 'rule-status', transactionId: 'ORD-7', status: 'pending', ruleStatus: 'Removed',
            reasonCode: 4107, reason: 'Regular payment is removed', baseReference: 'ORD-7', isRegular: false,
        });
        expect(event.amountMinor).toBeUndefined();
    });

    it('passes unknown rule statuses through', () => {
        expect(gw.webhook.extract({ ...ruleRemoved(), status: 'Confirmed' }).ruleStatus).toBe('Confirmed');
    });

    it('coerces reasonCode to a number and drops unusable ones', () => {
        expect(gw.webhook.extract({ ...approved(), reasonCode: '1100' }).reasonCode).toBe(1100);
        const { reasonCode: _, ...noCode } = approved();
        expect(gw.webhook.extract(noCode).reasonCode).toBeUndefined();
        expect(gw.webhook.extract({ ...approved(), reasonCode: 'abc' }).reasonCode).toBeUndefined();
    });

    it('keeps the payment status mapping', () => {
        expect(gw.webhook.extract({ ...approved(), transactionStatus: 'Declined' }).status).toBe('declined');
        expect(gw.webhook.extract({ ...approved(), transactionStatus: 'WaitingAuthComplete' }).status).toBe('authorized');
        expect(gw.webhook.extract({ ...approved(), transactionStatus: 'Brand new' }).status).toBe('pending');
    });

    it('does not throw on a non-object payload', () => {
        expect(gw.webhook.extract(null)).toMatchObject({ kind: 'payment', transactionId: '', status: 'pending' });
    });
});

describe('webhook.respond', () => {
    it('signs orderReference;accept;time', () => {
        vi.useFakeTimers({ now: new Date('2026-09-22T10:00:00Z'), toFake: ['Date'] });
        expect(gw.webhook.respond(ruleRemoved(), config)).toEqual({ orderReference: 'ORD-7', status: 'accept', time: 1790071200, signature: V.accept });
    });

    it('signs an empty reference instead of "undefined"', () => {
        vi.useFakeTimers({ now: new Date('2026-09-22T10:00:00Z'), toFake: ['Date'] });
        const reply = gw.webhook.respond({}, config) as { signature: string };
        expect(reply.signature).toBe(wayForPaySignature(['', 'accept', '1790071200'], SECRET));
    });
});

describe('webhook.parse', () => {
    it('returns valid json untouched, empty strings included', () => {
        const body = { ...approved(), authCode: '', cardPan: '' };
        expect(gw.webhook.parse(JSON.stringify(body))).toEqual(body);
    });

    it('keeps callbacks with absent fields verifiable', () => {
        expect(gw.webhook.verify(gw.webhook.parse(JSON.stringify(declinedBare())), config)).toBe(true);
    });

    it('repairs an empty products value', () => {
        const raw = JSON.stringify(approved()).replace(/}$/, ',"products":,}');
        expect(() => JSON.parse(raw)).toThrow();
        expect(gw.webhook.verify(gw.webhook.parse(raw), config)).toBe(true);
    });

    it('unwraps a body that arrived as the only key of a form-parsed object', () => {
        const raw = JSON.stringify({ [JSON.stringify(approved())]: '' });
        const parsed = gw.webhook.parse(raw);
        expect(parsed).toMatchObject({ orderReference: 'ORD-7' });
        expect(gw.webhook.verify(parsed, config)).toBe(true);
    });

    it('collapses a body with doubled quotes', () => {
        const raw = JSON.stringify(approved()).replace(/"/g, '""');
        expect(raw.startsWith('{""')).toBe(true);
        expect(gw.webhook.verify(gw.webhook.parse(raw), config)).toBe(true);
    });

    it('cleans a backslash-escaped body', () => {
        const raw = JSON.stringify(JSON.stringify(approved())).slice(1, -1);
        expect(raw.startsWith('{\\"')).toBe(true);
        const parsed = gw.webhook.parse(raw);
        expect(gw.webhook.verify(parsed, config)).toBe(true);
    });

    it('extracts products from a broken body', () => {
        const products = [{ name: 'Книга', price: 450, count: 1 }];
        const raw = JSON.stringify(approved()).replace(/}$/, `,"products":${JSON.stringify(products)},"fee":,}`);
        expect(() => JSON.parse(raw)).toThrow();
        const parsed = gw.webhook.parse(raw) as Record<string, unknown>;
        expect(parsed.products).toEqual(products);
        expect(parsed.fee).toBeNull();
        expect(gw.webhook.verify(parsed, config)).toBe(true);
    });

    it('drops an unreadable products segment and keeps the rest', () => {
        const raw = JSON.stringify(approved()).replace(/}$/, ',"products":[{"name":"Книга",price:}],"fee":,}');
        const parsed = gw.webhook.parse(raw) as Record<string, unknown>;
        expect(parsed).not.toBeNull();
        expect(parsed).not.toHaveProperty('products');
        expect(parsed.orderReference).toBe('ORD-7');
        expect(gw.webhook.verify(parsed, config)).toBe(true);
    });

    it('turns a numeric authCode into a string without breaking the signature', () => {
        const parsed = gw.webhook.parse(JSON.stringify({ ...approved(), authCode: 541963 })) as Record<string, unknown>;
        expect(parsed.authCode).toBe('541963');
        expect(gw.webhook.verify(parsed, config)).toBe(true);
    });

    it('returns null for garbage and non-object json, never throws', () => {
        for (const raw of ['not json {{{', '', '{', 'null', '[]', '1', '"x"', '{"a":']) {
            expect(gw.webhook.parse(raw)).toBeNull();
        }
    });
});

describe('helpers', () => {
    it('baseOrderReference strips the regular suffix', () => {
        expect(baseOrderReference('ORD-7_WFPREG-3')).toBe('ORD-7');
        expect(baseOrderReference('ORD-7')).toBe('ORD-7');
    });

    it('formatWayForPayDate uses UTC calendar days', () => {
        expect(formatWayForPayDate(new Date('2026-10-22T23:30:00Z'))).toBe('22.10.2026');
        expect(formatWayForPayDate(new Date('2026-10-23T00:30:00Z'))).toBe('23.10.2026');
        expect(formatWayForPayDate(new Date('2027-01-05T08:57:00Z'))).toBe('05.01.2027');
    });

    it('formatWayForPayDate rejects an invalid date', () => {
        expect(() => formatWayForPayDate(new Date('nope'))).toThrow(WayForPayError);
    });

    it('normalizeRegularMode accepts modes and synonyms, case-insensitively', () => {
        expect(normalizeRegularMode('month')).toBe('monthly');
        expect(normalizeRegularMode('Monthly')).toBe('monthly');
        expect(normalizeRegularMode('year')).toBe('yearly');
        expect(normalizeRegularMode('week')).toBe('weekly');
        expect(normalizeRegularMode('day')).toBe('daily');
        expect(normalizeRegularMode('quarterly')).toBe('quarterly');
        expect(normalizeRegularMode('halfyearly')).toBe('halfyearly');
    });

    it('normalizeRegularMode refuses unknown modes instead of guessing', () => {
        for (const mode of ['fortnightly', 'once', '', 'monthly ']) {
            const error = (() => { try { normalizeRegularMode(mode); } catch (e) { return e; } })();
            expect(error).toBeInstanceOf(WayForPayError);
            expect((error as WayForPayError).kind).toBe('validation');
        }
    });
});

describe('createRecurringPayment', () => {
    const recurring = {
        orderCode: 'ORD-7', amountMinor: 45000, currencyCode: 'UAH', description: 'Книга', regularMode: 'monthly',
        dateNext: new Date('2026-10-22T08:57:00Z'), regularCount: 60, webhookUrl: 'https://api/hook', returnUrl: 'https://shop/ok',
    };
    const ok = { reasonCode: 1100, reason: 'Ok', invoiceUrl: 'https://secure.wayforpay.com/invoice/r1' };

    it('sends the exact shp request body', async () => {
        vi.useFakeTimers({ now: new Date('2026-09-22T10:00:00Z'), toFake: ['Date'] });
        const calls = mockFetch({ body: ok });
        await gw.createRecurringPayment(recurring, config);
        expect(calls[0].url).toBe('https://api.wayforpay.com/api');
        expect(jsonBody(calls[0])).toEqual({
            transactionType: 'CREATE_INVOICE', apiVersion: 1, merchantAccount: 'test_merch', merchantDomainName: 'shop.example',
            merchantAuthType: 'SimpleSignature', orderReference: 'ORD-7', orderDate: 1790071200, amount: '450.00', currency: 'UAH',
            productName: ['Книга'], productCount: [1], productPrice: ['450.00'], language: 'UA',
            serviceUrl: 'https://api/hook', returnUrl: 'https://shop/ok', merchantSignature: V.recurring450,
            regularBehavior: 'preset', regularOn: 1, regularMode: 'monthly', dateNext: '22.10.2026', regularAmount: '450.00', regularCount: 60,
        });
    });

    it('omits urls that were not given', async () => {
        const calls = mockFetch({ body: ok });
        const { webhookUrl: _w, returnUrl: _r, ...bare } = recurring;
        await gw.createRecurringPayment(bare, config);
        expect(jsonBody(calls[0])).not.toHaveProperty('serviceUrl');
        expect(jsonBody(calls[0])).not.toHaveProperty('returnUrl');
    });

    it('uses a separate regular amount', async () => {
        const calls = mockFetch({ body: ok });
        await gw.createRecurringPayment({ ...recurring, regularAmountMinor: 39900 }, config);
        expect(jsonBody(calls[0])).toMatchObject({ amount: '450.00', regularAmount: '399.00', productPrice: ['450.00'] });
    });

    it('supports a free first payment', async () => {
        vi.useFakeTimers({ now: new Date('2026-09-22T10:00:00Z'), toFake: ['Date'] });
        const calls = mockFetch({ body: ok });
        await gw.createRecurringPayment({ ...recurring, amountMinor: 0, regularAmountMinor: 45000 }, config);
        expect(jsonBody(calls[0])).toMatchObject({ amount: '0.00', productPrice: ['0.00'], regularAmount: '450.00', merchantSignature: V.recurring0 });
    });

    it('formats dateNext in UTC and normalizes the mode', async () => {
        const calls = mockFetch({ body: ok }, { body: ok });
        await gw.createRecurringPayment({ ...recurring, dateNext: new Date('2026-10-22T23:30:00Z'), regularMode: 'Year' }, config);
        await gw.createRecurringPayment({ ...recurring, dateNext: new Date('2026-10-23T00:30:00Z') }, config);
        expect(jsonBody(calls[0])).toMatchObject({ dateNext: '22.10.2026', regularMode: 'yearly' });
        expect(jsonBody(calls[1]).dateNext).toBe('23.10.2026');
    });

    it('returns the redirect and the raw reply on 1100', async () => {
        mockFetch({ body: ok });
        expect(await gw.createRecurringPayment(recurring, config)).toEqual({
            transactionId: 'ORD-7', status: 'pending', redirect: { url: ok.invoiceUrl, method: 'GET' },
            publicMetadata: { method: 'wayforpay' }, raw: ok,
        });
    });

    it('accepts 1100 sent as a string', async () => {
        mockFetch({ body: { ...ok, reasonCode: '1100' } });
        expect((await gw.createRecurringPayment(recurring, config)).redirect?.url).toBe(ok.invoiceUrl);
    });

    it('refuses any other code even with an invoiceUrl', async () => {
        mockFetch({ body: { reasonCode: 1113, reason: 'Invalid signature', invoiceUrl: 'x' } });
        const error = await caught(gw.createRecurringPayment(recurring, config));
        expect(error).toMatchObject({ kind: 'api', reasonCode: 1113, reason: 'Invalid signature', requestType: 'CREATE_INVOICE' });
        expect(error.message).toBe('WayForPay: Invalid signature (code 1113)');
    });

    it('treats 1100 without invoiceUrl as unreadable', async () => {
        mockFetch({ body: { reasonCode: 1100 } });
        expect((await caught(gw.createRecurringPayment(recurring, config))).kind).toBe('parse');
        mockFetch({ body: 'plain text' });
        expect((await caught(gw.createRecurringPayment(recurring, config))).kind).toBe('parse');
        mockFetch({ body: {} });
        expect((await caught(gw.createRecurringPayment(recurring, config))).kind).toBe('parse');
    });

    it('maps transport failures', async () => {
        mockFetch({ status: 500, body: { reasonCode: 1100, invoiceUrl: 'x' } });
        expect((await caught(gw.createRecurringPayment(recurring, config))).kind).toBe('http');
        mockFetch(timeout());
        expect((await caught(gw.createRecurringPayment(recurring, config))).kind).toBe('timeout');
        mockFetch(offline());
        expect((await caught(gw.createRecurringPayment(recurring, config))).kind).toBe('network');
    });

    it('validates input before calling WayForPay', async () => {
        const calls = mockFetch();
        const bad = [
            { amountMinor: -1 }, { amountMinor: 1.5 }, { amountMinor: Number.NaN },
            { amountMinor: 0 },
            { regularAmountMinor: 0 }, { regularAmountMinor: 10.5 },
            { regularCount: 0 }, { regularCount: 2.5 },
            { dateNext: new Date('nope') },
            { orderCode: '' }, { orderCode: 'ORD_WFPREG-1' }, { orderCode: 'ORD;7' },
            { description: '' }, { currencyCode: '' },
            { regularMode: 'fortnightly' },
        ];
        for (const patch of bad) {
            const error = await caught(gw.createRecurringPayment({ ...recurring, ...patch }, config));
            expect(error.kind).toBe('validation');
        }
        expect(calls).toHaveLength(0);
    });

    it('never leaks the secret or the api key', async () => {
        mockFetch({ body: { ...ok, echo: `${SECRET}/${API_KEY}` } });
        expectNoSecrets(await gw.createRecurringPayment(recurring, config));
        mockFetch({ body: { reasonCode: 1113, reason: `bad ${SECRET}` } });
        expectNoSecrets(await caught(gw.createRecurringPayment(recurring, config)));
    });
});

describe('cancelRecurring (REMOVE)', () => {
    it('posts to regularApi with the base reference', async () => {
        const calls = mockFetch({ body: { reasonCode: 4100, reason: 'Ok' } }, { body: { reasonCode: 4100, reason: 'Ok' } });
        await gw.cancelRecurring('ORD-7_WFPREG-3', config);
        await gw.cancelRecurring('ORD-7', config);
        expect(calls[0].url).toBe('https://api.wayforpay.com/regularApi');
        for (const call of calls) {
            expect(jsonBody(call)).toEqual({ requestType: 'REMOVE', merchantAccount: 'test_merch', merchantPassword: API_KEY, orderReference: 'ORD-7' });
        }
    });

    it('derives the regularApi url from apiUrl', async () => {
        const calls = mockFetch({ body: { reasonCode: 4100 } }, { body: { reasonCode: 4100 } });
        await gw.cancelRecurring('ORD-7', { ...config, apiUrl: 'http://localhost:9999/api/' });
        await gw.cancelRecurring('ORD-7', { ...config, apiUrl: 'http://localhost:9999/api' });
        expect(calls.map(c => c.url)).toEqual(['http://localhost:9999/regularApi', 'http://localhost:9999/regularApi']);
    });

    it('refuses an apiUrl that does not end in /api', async () => {
        const calls = mockFetch();
        const error = await caught(gw.cancelRecurring('ORD-7', { ...config, apiUrl: 'http://localhost:9999/invoice' }));
        expect(error.kind).toBe('validation');
        expect(calls).toHaveLength(0);
    });

    it.each([
        [4100, true, 'removed'],
        [4102, true, 'not-found'],
        [4106, true, 'already-closed'],
        [4107, true, 'already-closed'],
        [4101, false, 'refused'],
        [4103, false, 'refused'],
        [4104, false, 'refused'],
    ] as const)('maps %i to ok=%s outcome=%s', async (code, ok, outcome) => {
        mockFetch({ body: { reasonCode: code, reason: 'r' } });
        const result = await gw.cancelRecurring('ORD-7_WFPREG-1', config);
        expect(result).toEqual({ ok, outcome, code, reason: 'r', orderReference: 'ORD-7', raw: { reasonCode: code, reason: 'r' } });
        expect(isRecurringRemoved(result)).toBe(ok);
        expect(isRecurringRemoved(code)).toBe(ok);
    });

    it('coerces a string reasonCode', async () => {
        mockFetch({ body: { reasonCode: '4100', reason: 'Ok' } });
        expect(await gw.cancelRecurring('ORD-7', config)).toMatchObject({ ok: true, code: 4100 });
    });

    it('defaults a missing reason to an empty string', async () => {
        mockFetch({ body: { reasonCode: 4100 } });
        expect((await gw.cancelRecurring('ORD-7', config)).reason).toBe('');
    });

    it('throws when the reply cannot be read, never returns success', async () => {
        for (const body of [{}, { reason: 'Ok' }, { reasonCode: 'abc' }, 'plain text', '', [4100]]) {
            mockFetch({ body });
            expect((await caught(gw.cancelRecurring('ORD-7', config))).kind).toBe('parse');
        }
    });

    it('throws on non-2xx even when the body looks successful', async () => {
        mockFetch({ status: 500, body: { reasonCode: 4100, reason: 'Ok' } });
        const error = await caught(gw.cancelRecurring('ORD-7', config));
        expect(error).toMatchObject({ kind: 'http', status: 500, requestType: 'REMOVE' });
    });

    it('keeps the gateway code and reason on an http error without resolving', async () => {
        mockFetch({ status: 400, body: { reasonCode: 4104, reason: `Validation error ${API_KEY}` } });
        const error = await caught(gw.cancelRecurring('ORD-7', config));
        expect(error).toMatchObject({ kind: 'http', status: 400, reasonCode: 4104, reason: 'Validation error ***' });
        expectNoSecrets(error);
        mockFetch({ status: 502, body: '<html>bad gateway</html>' });
        const bare = await caught(gw.cancelRecurring('ORD-7', config));
        expect(bare.reasonCode).toBeUndefined();
        expect(bare.reason).toBeUndefined();
    });

    it('throws on timeout and network failure', async () => {
        mockFetch(timeout());
        expect((await caught(gw.cancelRecurring('ORD-7', config))).kind).toBe('timeout');
        mockFetch(aborted());
        expect((await caught(gw.cancelRecurring('ORD-7', config))).kind).toBe('timeout');
        mockFetch(offline());
        const error = await caught(gw.cancelRecurring('ORD-7', config));
        expect(error.kind).toBe('network');
        expect(error.cause).toBeInstanceOf(TypeError);
    });

    it('validates before calling WayForPay', async () => {
        const calls = mockFetch();
        const { merchantApiKey: _, ...withoutKey } = config;
        expect((await caught(gw.cancelRecurring('ORD-7', withoutKey))).kind).toBe('validation');
        expect((await caught(gw.cancelRecurring('ORD-7', { ...config, merchantApiKey: '' }))).kind).toBe('validation');
        expect((await caught(gw.cancelRecurring('', config))).kind).toBe('validation');
        expect((await caught(gw.cancelRecurring('_WFPREG-1', config))).kind).toBe('validation');
        expect(calls).toHaveLength(0);
    });

    it('never leaks the api key or the secret', async () => {
        mockFetch({ body: { reasonCode: 4100, reason: `Ok ${API_KEY}`, merchantPassword: API_KEY, nested: { s: SECRET } } });
        const result = await gw.cancelRecurring('ORD-7', config);
        expectNoSecrets(result);
        expect(result.reason).toBe('Ok ***');
        expect(result.raw).toMatchObject({ merchantPassword: '***', nested: { s: '***' } });

        mockFetch({ body: { reasonCode: 4104, reason: `bad ${API_KEY}` } });
        expectNoSecrets(await gw.cancelRecurring('ORD-7', config));

        for (const failure of [{ status: 500, body: `oops ${API_KEY}` }, { body: `oops ${API_KEY}` }, timeout(), offline()]) {
            mockFetch(failure);
            expectNoSecrets(await caught(gw.cancelRecurring('ORD-7', config)));
        }
    });
});

describe('changeRecurring (CHANGE)', () => {
    const change = { regularMode: 'monthly', amountMinor: 39900, currencyCode: 'UAH', dateBegin: new Date('2026-10-22T08:57:00Z'), dateEnd: new Date('2031-10-22T08:57:00Z') };

    it('posts the documented body with the base reference', async () => {
        const calls = mockFetch({ body: { reasonCode: 4100, reason: 'Ok', orderReference: 'ORD-7' } });
        await gw.changeRecurring('ORD-7_WFPREG-2', change, config);
        expect(calls[0].url).toBe('https://api.wayforpay.com/regularApi');
        expect(jsonBody(calls[0])).toEqual({
            requestType: 'CHANGE', merchantAccount: 'test_merch', merchantPassword: API_KEY, orderReference: 'ORD-7',
            regularMode: 'monthly', amount: '399.00', currency: 'UAH', dateBegin: '22.10.2026', dateEnd: '22.10.2031',
        });
    });

    it('normalizes the mode', async () => {
        const calls = mockFetch({ body: { reasonCode: 4100 } });
        await gw.changeRecurring('ORD-7', { ...change, regularMode: 'year' }, config);
        expect(jsonBody(calls[0]).regularMode).toBe('yearly');
    });

    it.each([
        [4100, true, 'changed'],
        [4102, false, 'not-found'],
        [4106, false, 'already-closed'],
        [4107, false, 'already-closed'],
        [4104, false, 'refused'],
        [4103, false, 'refused'],
    ] as const)('maps %i to ok=%s outcome=%s', async (code, ok, outcome) => {
        mockFetch({ body: { reasonCode: code, reason: 'r' } });
        expect(await gw.changeRecurring('ORD-7', change, config)).toEqual({ ok, outcome, code, reason: 'r', orderReference: 'ORD-7', raw: { reasonCode: code, reason: 'r' } });
    });

    it('throws on unreadable replies and transport failures', async () => {
        mockFetch({ body: {} });
        expect((await caught(gw.changeRecurring('ORD-7', change, config))).kind).toBe('parse');
        mockFetch({ status: 500, body: { reasonCode: 4100 } });
        expect((await caught(gw.changeRecurring('ORD-7', change, config)))).toMatchObject({ kind: 'http', requestType: 'CHANGE' });
        mockFetch(timeout());
        expect((await caught(gw.changeRecurring('ORD-7', change, config))).kind).toBe('timeout');
    });

    it('validates before calling WayForPay', async () => {
        const calls = mockFetch();
        const bad = [
            { currencyCode: '' }, { amountMinor: 0 }, { amountMinor: -100 }, { amountMinor: 10.5 },
            { dateBegin: new Date('nope') }, { dateEnd: new Date('nope') }, { regularMode: 'fortnightly' },
        ];
        for (const patch of bad) {
            expect((await caught(gw.changeRecurring('ORD-7', { ...change, ...patch }, config))).kind).toBe('validation');
        }
        expect((await caught(gw.changeRecurring('ORD-7', { ...change, currencyCode: undefined as unknown as string }, config))).kind).toBe('validation');
        const { merchantApiKey: _, ...withoutKey } = config;
        expect((await caught(gw.changeRecurring('ORD-7', change, withoutKey))).kind).toBe('validation');
        expect(calls).toHaveLength(0);
    });

    it('never leaks the api key or the secret', async () => {
        mockFetch({ body: { reasonCode: 4104, reason: `bad ${API_KEY}`, merchantPassword: API_KEY } });
        expectNoSecrets(await gw.changeRecurring('ORD-7', change, config));
        mockFetch({ status: 502, body: API_KEY });
        expectNoSecrets(await caught(gw.changeRecurring('ORD-7', change, config)));
    });
});

describe('hardening', () => {
    const recurring = {
        orderCode: 'ORD-7', amountMinor: 45000, currencyCode: 'UAH', description: 'Книга', regularMode: 'monthly',
        dateNext: new Date('2026-10-22T08:57:00Z'), regularCount: 60,
    };
    const change = { regularMode: 'monthly', amountMinor: 39900, currencyCode: 'UAH', dateBegin: new Date('2026-10-22T08:57:00Z'), dateEnd: new Date('2031-10-22T08:57:00Z') };

    it('never follows redirects', async () => {
        const calls = mockFetch({ body: { invoiceUrl: 'u' } }, { body: { reasonCode: 1100, invoiceUrl: 'https://secure.wayforpay.com/i' } }, { body: { reasonCode: 4100 } }, { body: { reasonCode: 4100 } });
        await gw.createPayment({ orderCode: 'ORD-7', amountMinor: 100, currencyCode: 'UAH', description: 'x' }, config);
        await gw.createRecurringPayment(recurring, config);
        await gw.cancelRecurring('ORD-7', config);
        await gw.changeRecurring('ORD-7', change, config);
        expect(calls.map(c => c.init.redirect)).toEqual(['manual', 'manual', 'manual', 'manual']);
    });

    it('treats a redirect reply as an http failure', async () => {
        mockFetch({ status: 307, body: '' });
        expect(await caught(gw.cancelRecurring('ORD-7', config))).toMatchObject({ kind: 'http', status: 307 });
    });

    it.each([
        'not a url', 'ftp://api.wayforpay.com/api', 'http://api.wayforpay.com/api', 'https://user:pass@api.wayforpay.com/api', 'https://api.wayforpay.com/invoice',
        'https://api.wayforpay.com/api?x=/api', 'https://api.wayforpay.com/api#/api', 'https://api.wayforpay.com/x?y=/api',
    ])('rejects apiUrl %s as validation before sending', async (apiUrl) => {
        const calls = mockFetch();
        expect((await caught(gw.cancelRecurring('ORD-7', { ...config, apiUrl }))).kind).toBe('validation');
        expect((await caught(gw.changeRecurring('ORD-7', change, { ...config, apiUrl }))).kind).toBe('validation');
        expect(calls).toHaveLength(0);
    });

    it('rejects an unusable apiUrl for invoices too', async () => {
        const calls = mockFetch();
        for (const apiUrl of ['not a url', 'http://api.wayforpay.com/api', 'https://user:pass@api.wayforpay.com/api']) {
            expect((await caught(gw.createRecurringPayment(recurring, { ...config, apiUrl }))).kind).toBe('validation');
            expect((await caught(gw.createPayment({ orderCode: 'ORD-7', amountMinor: 100, currencyCode: 'UAH', description: 'x' }, { ...config, apiUrl }))).kind).toBe('validation');
        }
        expect(calls).toHaveLength(0);
    });

    it('allows plain http only for a local stub', async () => {
        const calls = mockFetch({ body: { reasonCode: 4100 } }, { body: { reasonCode: 4100 } }, { body: { reasonCode: 4100 } });
        await gw.cancelRecurring('ORD-7', { ...config, apiUrl: 'http://localhost:9999/api' });
        await gw.cancelRecurring('ORD-7', { ...config, apiUrl: 'http://127.0.0.1:9999/api' });
        await gw.cancelRecurring('ORD-7', { ...config, apiUrl: 'http://[::1]:9999/api' });
        expect(calls).toHaveLength(3);
    });

    it('refuses a non-https invoiceUrl for a recurring invoice', async () => {
        for (const invoiceUrl of ['javascript:alert(1)', 'http://secure.wayforpay.com/i', 'not a url']) {
            mockFetch({ body: { reasonCode: 1100, invoiceUrl } });
            expect((await caught(gw.createRecurringPayment(recurring, config))).kind).toBe('parse');
        }
    });

    it('respond refuses a reference containing the separator', () => {
        expect(() => gw.webhook.respond({ orderReference: 'A;B;C' }, config)).toThrow(WayForPayError);
    });

    it('extract exposes processingDate of a rule callback', () => {
        expect(gw.webhook.extract(ruleRemoved()).processingDate).toBe(1789269263);
        expect(gw.webhook.extract(approved()).processingDate).toBeUndefined();
    });

    it('verify rejects non-primitive signed fields', () => {
        expect(gw.webhook.verify({ ...approved(), orderReference: ['ORD-7'] }, config)).toBe(false);
        expect(gw.webhook.verify({ ...ruleRemoved(), status: { toString: () => 'Removed' } }, config)).toBe(false);
    });

    it('keeps a REMOVE result usable when raw cannot be redacted', async () => {
        const depth = 5000;
        mockFetch({ body: `{"reasonCode":4100,"reason":"Ok ${API_KEY}","d":${'['.repeat(depth)}${']'.repeat(depth)}}` });
        const result = await gw.cancelRecurring('ORD-7', config);
        expect(result).toMatchObject({ ok: true, outcome: 'removed', code: 4100, reason: 'Ok ***' });
        expect(result.raw).toEqual({ reasonCode: 4100, reason: 'Ok ***' });
    });

    it('isRecurringRemoved agrees for results and codes', async () => {
        for (const code of [4100, 4102, 4104, 4106, 4107]) {
            mockFetch({ body: { reasonCode: code } });
            expect(isRecurringRemoved(await gw.cancelRecurring('ORD-7', config))).toBe(isRecurringRemoved(code));
        }
    });
});
