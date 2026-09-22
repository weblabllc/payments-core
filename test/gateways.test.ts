import { createHash, createHmac } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    CheckboxClient,
    CheckboxError,
    LiqPayGateway,
    NowPaymentsGateway,
    nowPaymentsSignature,
    PaymentGateway,
    PaymentsRegistry,
    WayForPayGateway,
    wayForPaySignature,
} from '../src/index.js';

type Call = { url: string; init: RequestInit };

function mockFetch(...responses: Array<{ status?: number; body: unknown }>) {
    const calls: Call[] = [];
    const queue = [...responses];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        const next = queue.shift() ?? { status: 500, body: '' };
        const text = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
        return new Response(text, { status: next.status ?? 200 });
    }));
    return calls;
}

const jsonBody = (call: Call) => JSON.parse(String(call.init.body));

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

const input = { orderCode: 'ORD-7', amountMinor: 45000, currencyCode: 'UAH', description: 'Книга', returnUrl: 'https://shop/ok', webhookUrl: 'https://api/hook' };

describe('LiqPay', () => {
    const gw = new LiqPayGateway();
    const config = { publicKey: 'i000', privateKey: 'priv' };
    const liqSign = (data: string) => createHash('sha1').update('priv' + data + 'priv').digest('base64');

    it('builds a signed checkout form', async () => {
        const result = await gw.createPayment(input, config);
        const { data, signature } = result.redirect!.fields!;
        expect(signature).toBe(liqSign(data));
        expect(JSON.parse(Buffer.from(data, 'base64').toString())).toMatchObject({
            public_key: 'i000', version: '3', action: 'pay', amount: '450.00', currency: 'UAH',
            order_id: 'ORD-7', result_url: 'https://shop/ok', server_url: 'https://api/hook', sandbox: 0,
        });
        expect(result.redirect).toMatchObject({ url: 'https://www.liqpay.ua/api/3/checkout', method: 'POST' });
    });

    it('maps callback statuses and amounts', () => {
        const event = (status: string, amount: number) => {
            const data = Buffer.from(JSON.stringify({ order_id: 'ORD-7', status, amount })).toString('base64');
            return gw.webhook.extract(gw.webhook.parse(`data=${encodeURIComponent(data)}&signature=${encodeURIComponent(liqSign(data))}`));
        };
        expect(event('success', 450.1)).toMatchObject({ transactionId: 'ORD-7', status: 'settled', amountMinor: 45010 });
        expect(event('wait_compensation', 1).status).toBe('settled');
        expect(event('hold_wait', 1).status).toBe('authorized');
        expect(event('failure', 1).status).toBe('declined');
        expect(event('something_new', 1).status).toBe('pending');
    });

    it('ignores bodies without data or with broken base64 json', () => {
        expect(gw.webhook.parse('signature=x')).toBeNull();
        expect(gw.webhook.parse('data=bm90IGpzb24=&signature=x')).toBeNull();
    });
});

describe('WayForPay', () => {
    const gw = new WayForPayGateway();
    const config = { merchantAccount: 'test_merch', merchantSecret: 'secret', merchantDomain: 'shop.example' };

    it('signs the invoice exactly over the values it sends', async () => {
        vi.useFakeTimers({ now: new Date('2026-09-22T10:00:00Z'), toFake: ['Date'] });
        const calls = mockFetch({ body: { invoiceUrl: 'https://secure.wayforpay.com/invoice/abc', reason: 'Ok', reasonCode: 1100 } });
        const result = await gw.createPayment(input, config);
        const sent = jsonBody(calls[0]);
        expect(sent).toMatchObject({ transactionType: 'CREATE_INVOICE', amount: '450.00', productPrice: [450], productCount: [1], serviceUrl: 'https://api/hook' });
        const fields = [sent.merchantAccount, sent.merchantDomainName, sent.orderReference, sent.orderDate, sent.amount, sent.currency, ...sent.productName, ...sent.productCount, ...sent.productPrice];
        expect(fields.join(';')).toBe('test_merch;shop.example;ORD-7;1790071200;450.00;UAH;Книга;1;450');
        expect(sent.merchantSignature).toBe(wayForPaySignature(fields, 'secret'));
        expect(result.redirect).toEqual({ url: 'https://secure.wayforpay.com/invoice/abc', method: 'GET' });
    });

    it('keeps kopecks in the signed price', async () => {
        const calls = mockFetch({ body: { invoiceUrl: 'u' } });
        await gw.createPayment({ ...input, amountMinor: 1050 }, config);
        expect(jsonBody(calls[0])).toMatchObject({ amount: '10.50', productPrice: [10.5] });
    });

    it('surfaces the gateway reason and survives non-json errors', async () => {
        mockFetch({ body: { reason: 'Invalid signature', reasonCode: 1113 } });
        await expect(gw.createPayment(input, config)).rejects.toThrow('WayForPay: Invalid signature (code 1113)');
        mockFetch({ status: 502, body: '<html>bad gateway</html>' });
        await expect(gw.createPayment(input, config)).rejects.toThrow(/HTTP 502/);
    });

    const callback = (overrides: Record<string, unknown> = {}) => {
        const body: Record<string, unknown> = {
            merchantAccount: 'test_merch', orderReference: 'ORD-7', amount: 450, currency: 'UAH', authCode: '541963',
            cardPan: '53****4242', transactionStatus: 'Approved', reasonCode: 1100, ...overrides,
        };
        const fields = ['merchantAccount', 'orderReference', 'amount', 'currency', 'authCode', 'cardPan', 'transactionStatus', 'reasonCode'].map(k => String(body[k]));
        body.merchantSignature = wayForPaySignature(fields, 'secret');
        return body;
    };

    it('verifies callbacks and rejects tampering', () => {
        const ok = gw.webhook.parse(JSON.stringify(callback()));
        expect(gw.webhook.verify(ok, config)).toBe(true);
        expect(gw.webhook.verify({ ...(ok as object), amount: 1 }, config)).toBe(false);
        expect(gw.webhook.verify({ ...(ok as object), merchantSignature: undefined }, config)).toBe(false);
        expect(gw.webhook.verify(ok, { ...config, merchantSecret: 'other' })).toBe(false);
    });

    it('accepts the malformed json WayForPay sometimes posts', () => {
        const raw = JSON.stringify(callback()).replace('}', ',"products":,}');
        expect(() => JSON.parse(raw)).toThrow();
        const parsed = gw.webhook.parse(raw);
        expect(gw.webhook.verify(parsed, config)).toBe(true);
    });

    it('maps statuses and answers with a signed accept', () => {
        vi.useFakeTimers({ now: new Date('2026-09-22T10:00:00Z'), toFake: ['Date'] });
        expect(gw.webhook.extract(callback())).toMatchObject({ transactionId: 'ORD-7', status: 'settled', amountMinor: 45000 });
        expect(gw.webhook.extract(callback({ transactionStatus: 'Declined' })).status).toBe('declined');
        expect(gw.webhook.extract(callback({ transactionStatus: 'WaitingAuthComplete' })).status).toBe('authorized');
        expect(gw.webhook.respond!(callback(), config)).toEqual({
            orderReference: 'ORD-7', status: 'accept', time: 1790071200,
            signature: createHmac('md5', 'secret').update('ORD-7;accept;1790071200').digest('hex'),
        });
    });
});

describe('NOWPayments', () => {
    const gw = new NowPaymentsGateway();
    const config = { apiKey: 'key', ipnSecret: 'ipn', sandbox: true };
    const ipn = { payment_id: 5077, payment_status: 'finished', order_id: 'ORD-7', price_amount: 450, price_currency: 'uah', pay_currency: 'usdttrc20', actually_paid: 11.2 };

    it('creates an invoice in the sandbox', async () => {
        const calls = mockFetch({ body: { id: 'inv1', invoice_url: 'https://sandbox.nowpayments.io/payment/?iid=inv1' } });
        const result = await gw.createPayment(input, config);
        expect(calls[0].url).toBe('https://api-sandbox.nowpayments.io/v1/invoice');
        expect((calls[0].init.headers as Record<string, string>)['x-api-key']).toBe('key');
        expect(jsonBody(calls[0])).toMatchObject({ price_amount: 450, price_currency: 'uah', order_id: 'ORD-7', ipn_callback_url: 'https://api/hook' });
        expect(result).toMatchObject({ status: 'pending', redirect: { url: 'https://sandbox.nowpayments.io/payment/?iid=inv1' }, privateMetadata: { invoiceId: 'inv1' } });
    });

    it('returns an error result instead of throwing on API failure', async () => {
        mockFetch({ status: 401, body: { message: 'Invalid api key' } });
        expect(await gw.createPayment(input, config)).toMatchObject({ status: 'error', privateMetadata: { nowpaymentsError: { message: 'Invalid api key' } } });
        mockFetch({ status: 502, body: 'upstream down' });
        expect(await gw.createPayment(input, config)).toMatchObject({ status: 'error', privateMetadata: { nowpaymentsError: 502 } });
    });

    it('verifies the header signature over sorted keys', () => {
        const signature = nowPaymentsSignature(ipn, 'ipn');
        const reordered = gw.webhook.parse(JSON.stringify(Object.fromEntries(Object.entries(ipn).reverse())));
        expect(gw.webhook.verify(reordered, config, signature)).toBe(true);
        expect(gw.webhook.verify(reordered, config, signature.toUpperCase())).toBe(true);
        expect(gw.webhook.verify({ ...ipn, __signature: signature }, config)).toBe(true);
        expect(gw.webhook.verify({ ...ipn, price_amount: 1 }, config, signature)).toBe(false);
        expect(gw.webhook.verify(ipn, config)).toBe(false);
    });

    it('maps statuses, unknown ones are errors', () => {
        expect(gw.webhook.extract(ipn)).toMatchObject({ transactionId: 'ORD-7', status: 'settled', amountMinor: 45000 });
        expect(gw.webhook.extract({ ...ipn, payment_status: 'partially_paid' }).status).toBe('pending');
        expect(gw.webhook.extract({ ...ipn, payment_status: 'expired' }).status).toBe('declined');
        expect(gw.webhook.extract({ ...ipn, payment_status: 'weird' }).status).toBe('error');
        expect(gw.webhook.parse('not json')).toBeNull();
    });
});

describe('Checkbox', () => {
    const client = () => new CheckboxClient({ licenseKey: 'lic', login: 'cashier', password: 'pw', baseUrl: 'https://dev-api.checkbox.in.ua/api/v1/' });
    const header = (call: Call, name: string) => (call.init.headers as Record<string, string>)[name];

    it('signs in once and sends the bearer token and license key', async () => {
        const calls = mockFetch({ body: { access_token: 'tok' } }, { body: { id: 'shift1' } }, { body: { id: 'r1', status: 'CREATED' } });
        const cb = client();
        await cb.signin();
        await cb.openShift();
        const receipt = await cb.sellReceipt({ goods: [{ good: { code: 'b1', name: 'Книга', price: 45000 }, quantity: 1000 }], payments: [{ type: 'CASHLESS', value: 45000 }] });
        expect(calls[0].url).toBe('https://dev-api.checkbox.in.ua/api/v1/cashier/signin');
        expect(header(calls[0], 'authorization')).toBeUndefined();
        expect(header(calls[1], 'authorization')).toBe('Bearer tok');
        expect(header(calls[1], 'X-License-Key')).toBe('lic');
        expect(jsonBody(calls[2]).goods[0].quantity).toBe(1000);
        expect(receipt.id).toBe('r1');
    });

    it('throws CheckboxError with status and body', async () => {
        mockFetch({ status: 400, body: { message: 'Зміну не відкрито' } });
        const error = await client().sellReceipt({ goods: [], payments: [] }).catch(e => e);
        expect(error).toBeInstanceOf(CheckboxError);
        expect(error).toMatchObject({ status: 400, body: { message: 'Зміну не відкрито' } });
        mockFetch({ body: {} });
        await expect(client().signin()).rejects.toThrow(/no access_token/);
    });

    it('returns text receipts as strings', async () => {
        mockFetch({ body: 'ФІСКАЛЬНИЙ ЧЕК' });
        expect(await client().receiptText('r1')).toBe('ФІСКАЛЬНИЙ ЧЕК');
    });
});

describe('PaymentsRegistry with custom gateways', () => {
    const custom: PaymentGateway = { code: 'cod', confirmation: 'manual', createPayment: async () => ({ transactionId: 'x', status: 'authorized' }) };

    it('mixes builtin and custom gateways and lists webhook ones', async () => {
        const registry = await PaymentsRegistry.create({ gateways: ['liqpay', custom] });
        expect(registry.get('cod')).toBe(custom);
        expect(registry.withWebhook().map(g => g.code)).toEqual(['liqpay']);
    });

    it('rejects duplicate codes', async () => {
        await expect(PaymentsRegistry.create({ gateways: ['invoice', { ...custom, code: 'invoice' }] })).rejects.toThrow(/Duplicate/);
    });
});
