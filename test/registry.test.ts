import { describe, expect, it } from 'vitest';
import { PaymentsRegistry } from '../src/registry.js';

describe('PaymentsRegistry', () => {
    it('enables only the chosen combination', async () => {
        const registry = await PaymentsRegistry.create({ gateways: ['invoice', 'nowpayments'] });
        expect(registry.codes().sort()).toEqual(['invoice', 'nowpayments']);
        expect(registry.has('liqpay')).toBe(false);
        expect(() => registry.get('liqpay')).toThrow(/not enabled/);
    });

    it('rejects unknown builtin codes', async () => {
        await expect(PaymentsRegistry.create({ gateways: ['stripe' as never] })).rejects.toThrow(/Unknown builtin/);
    });

    it('requires at least one gateway', async () => {
        await expect(PaymentsRegistry.create({ gateways: [] })).rejects.toThrow(/at least one/);
    });
});
