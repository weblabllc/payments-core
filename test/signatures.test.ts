import { describe, expect, it } from 'vitest';
import { nowPaymentsSignature } from '../src/nowpayments-gateway.js';
import { repairBrokenJson } from '../src/wayforpay-gateway.js';
import { InvoiceGateway } from '../src/invoice-gateway.js';
import { LiqPayGateway } from '../src/liqpay-gateway.js';

describe('nowPaymentsSignature', () => {
    it('is independent of key order', () => {
        const a = nowPaymentsSignature({ b: 1, a: { d: 2, c: 3 } }, 'secret');
        const b = nowPaymentsSignature({ a: { c: 3, d: 2 }, b: 1 }, 'secret');
        expect(a).toBe(b);
        expect(a).toMatch(/^[0-9a-f]{128}$/);
    });
});

describe('repairBrokenJson', () => {
    it('parses valid json', () => {
        expect(repairBrokenJson('{"a":1}')).toEqual({ a: 1 });
    });
    it('repairs trailing commas and empty values', () => {
        expect(repairBrokenJson('{"a":1,}')).toEqual({ a: 1 });
        expect(repairBrokenJson('{"a":,"b":2}')).toEqual({ a: null, b: 2 });
    });
    it('returns null for garbage', () => {
        expect(repairBrokenJson('not json at all {{{')).toBeNull();
    });
});

describe('InvoiceGateway', () => {
    it('returns requisites in public metadata and authorizes manually', async () => {
        const gw = new InvoiceGateway();
        const result = await gw.createPayment(
            { orderCode: 'ORD1', amountMinor: 45000, currencyCode: 'UAH', description: 'x' },
            { recipientName: 'FOP Test', iban: 'UA123', taxId: '123', bankName: 'Bank', purposeTemplate: 'Оплата {orderCode}' },
        );
        expect(gw.confirmation).toBe('manual');
        expect(result.status).toBe('authorized');
        expect(result.publicMetadata).toMatchObject({ iban: 'UA123', purpose: 'Оплата ORD1' });
    });
});

describe('LiqPayGateway webhook', () => {
    const { createHash } = require('crypto') as typeof import('crypto');
    const sign = (data: string, key: string) => createHash('sha1').update(key + data + key).digest('base64');
    const callback = (status: string, key: string) => {
        const data = Buffer.from(JSON.stringify({ order_id: 'ORD1', status, amount: 250 })).toString('base64');
        return `data=${encodeURIComponent(data)}&signature=${encodeURIComponent(sign(data, key))}`;
    };

    it('accepts a valid signature and rejects a forged one in constant time', () => {
        const gw = new LiqPayGateway();
        const config = { publicKey: 'i12345', privateKey: 'secret' };
        const ok = gw.webhook.parse(callback('success', 'secret'))!;
        expect(gw.webhook.verify(ok, config)).toBe(true);
        const forged = gw.webhook.parse(callback('success', 'wrong'))!;
        expect(gw.webhook.verify(forged, config)).toBe(false);
    });

    it('does not treat sandbox status as paid under a live key', () => {
        const gw = new LiqPayGateway();
        const sandbox = gw.webhook.parse(callback('sandbox', 'secret'))!;
        expect(gw.webhook.verify(sandbox, { publicKey: 'i12345', privateKey: 'secret' })).toBe(false);
        expect(gw.webhook.verify(sandbox, { publicKey: 'sandbox_i12345', privateKey: 'secret' })).toBe(true);
    });
});
