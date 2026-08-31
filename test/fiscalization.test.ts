import { describe, expect, it } from 'vitest';
import { Fiscalizer, InMemoryFiscalizationStore } from '../src/fiscalization.js';

const payload = () => ({ goods: [], payments: [{ type: 'CASHLESS' as const, value: 45000 }] });

function stubApi(failTimes: number) {
    let remaining = failTimes;
    return {
        calls: { openShift: 0 },
        async signin() { return 'tok'; },
        async currentShift() { return { status: 'CLOSED' }; },
        async openShift() { this.calls.openShift++; return {}; },
        async sellReceipt() {
            if (remaining-- > 0) throw new Error('checkbox 502');
            return { id: 'receipt-1' };
        },
    };
}

describe('Fiscalizer', () => {
    it('retries automatically, then demands manual resend, then succeeds manually', async () => {
        const api = stubApi(2);
        const f = new Fiscalizer(api, new InMemoryFiscalizationStore(), { maxAutoAttempts: 2 });

        const first = await f.fiscalize('order-1', payload);
        expect(first.status).toBe('pending');
        expect(first.retryable).toBe(true);

        const second = await f.fiscalize('order-1', payload);
        expect(second.status).toBe('failed');
        expect(second.retryable).toBe(false);

        const blocked = await f.fiscalize('order-1', payload);
        expect(blocked.status).toBe('failed');

        expect(await f.listUnfiscalized()).toHaveLength(1);

        const manual = await f.resendManually('order-1', payload);
        expect(manual.status).toBe('done');
        expect(manual.receiptId).toBe('receipt-1');

        const idempotent = await f.fiscalize('order-1', payload);
        expect(idempotent.status).toBe('done');
        expect(await f.listUnfiscalized()).toHaveLength(0);
    });

    it('opens a shift when none is open', async () => {
        const api = stubApi(0);
        const f = new Fiscalizer(api, new InMemoryFiscalizationStore());
        const result = await f.fiscalize('order-2', payload);
        expect(result.status).toBe('done');
        expect(api.calls.openShift).toBe(1);
    });
});
