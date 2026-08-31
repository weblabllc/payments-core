import { CheckboxReceiptPayload } from './checkbox.js';

export type FiscalizationStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface FiscalizationRecord {
    key: string;
    status: FiscalizationStatus;
    attempts: number;
    receiptId: string | null;
    lastError: string | null;
    updatedAt: Date;
}

export interface FiscalizationStore {
    get(key: string): Promise<FiscalizationRecord | null>;
    save(record: FiscalizationRecord): Promise<void>;
    listUnfiscalized(limit?: number): Promise<FiscalizationRecord[]>;
}

export interface FiscalCheckboxApi {
    signin(): Promise<string>;
    currentShift(): Promise<unknown>;
    openShift(): Promise<unknown>;
    sellReceipt(payload: CheckboxReceiptPayload): Promise<{ id: string } & Record<string, unknown>>;
}

export interface FiscalizeOptions {
    manual?: boolean;
    force?: boolean;
}

export interface FiscalizeResult {
    status: FiscalizationStatus;
    receiptId: string | null;
    attempts: number;
    retryable: boolean;
    error?: string;
}

export interface FiscalizerOptions {
    maxAutoAttempts?: number;
}

export class InMemoryFiscalizationStore implements FiscalizationStore {
    private records = new Map<string, FiscalizationRecord>();

    async get(key: string): Promise<FiscalizationRecord | null> {
        return this.records.get(key) ?? null;
    }

    async save(record: FiscalizationRecord): Promise<void> {
        this.records.set(record.key, { ...record });
    }

    async listUnfiscalized(limit = 100): Promise<FiscalizationRecord[]> {
        return [...this.records.values()]
            .filter(r => r.status === 'pending' || r.status === 'failed')
            .slice(0, limit);
    }
}

function shiftIsOpen(shift: unknown): boolean {
    if (!shift || typeof shift !== 'object') return false;
    const status = (shift as { status?: string }).status;
    return status === 'OPENED' || status === 'opened';
}

export class Fiscalizer {
    private maxAutoAttempts: number;

    constructor(
        private client: FiscalCheckboxApi,
        private store: FiscalizationStore,
        options: FiscalizerOptions = {},
    ) {
        this.maxAutoAttempts = options.maxAutoAttempts ?? 5;
    }

    async fiscalize(
        key: string,
        buildPayload: () => CheckboxReceiptPayload | Promise<CheckboxReceiptPayload>,
        options: FiscalizeOptions = {},
    ): Promise<FiscalizeResult> {
        const existing = await this.store.get(key);
        if (existing?.status === 'done' && !options.force) {
            return { status: 'done', receiptId: existing.receiptId, attempts: existing.attempts, retryable: false };
        }
        if (existing?.status === 'processing') {
            return {
                status: 'processing',
                receiptId: null,
                attempts: existing.attempts,
                retryable: false,
                error: 'already processing',
            };
        }
        if (
            existing?.status === 'failed' &&
            !options.manual &&
            !options.force &&
            existing.attempts >= this.maxAutoAttempts
        ) {
            return {
                status: 'failed',
                receiptId: null,
                attempts: existing.attempts,
                retryable: false,
                error: existing.lastError ?? 'max auto attempts reached, manual resend required',
            };
        }

        const record: FiscalizationRecord = {
            key,
            status: 'processing',
            attempts: (existing?.attempts ?? 0) + 1,
            receiptId: existing?.receiptId ?? null,
            lastError: null,
            updatedAt: new Date(),
        };
        await this.store.save(record);

        try {
            const payload = await buildPayload();
            await this.client.signin();
            let shift: unknown = null;
            try {
                shift = await this.client.currentShift();
            } catch {
                shift = null;
            }
            if (!shiftIsOpen(shift)) {
                await this.client.openShift();
            }
            const receipt = await this.client.sellReceipt(payload);
            record.status = 'done';
            record.receiptId = receipt.id;
            record.updatedAt = new Date();
            await this.store.save(record);
            return { status: 'done', receiptId: receipt.id, attempts: record.attempts, retryable: false };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const retryable = options.manual ? true : record.attempts < this.maxAutoAttempts;
            record.status = retryable && !options.manual ? 'pending' : 'failed';
            record.lastError = message;
            record.updatedAt = new Date();
            await this.store.save(record);
            return { status: record.status, receiptId: null, attempts: record.attempts, retryable, error: message };
        }
    }

    async resendManually(
        key: string,
        buildPayload: () => CheckboxReceiptPayload | Promise<CheckboxReceiptPayload>,
    ): Promise<FiscalizeResult> {
        return this.fiscalize(key, buildPayload, { manual: true });
    }

    async listUnfiscalized(limit?: number): Promise<FiscalizationRecord[]> {
        return this.store.listUnfiscalized(limit);
    }
}
