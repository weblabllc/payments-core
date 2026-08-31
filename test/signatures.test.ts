import { describe, expect, it } from 'vitest';
import { nowPaymentsSignature } from '../src/nowpayments-gateway.js';
import { repairBrokenJson } from '../src/wayforpay-gateway.js';
import { InvoiceGateway } from '../src/invoice-gateway.js';

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
