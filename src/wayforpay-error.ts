export type WayForPayErrorKind = 'validation' | 'api' | 'http' | 'network' | 'timeout' | 'parse';

export type WayForPayRequestType = 'CREATE_INVOICE' | 'REMOVE' | 'CHANGE';

export interface WayForPayErrorDetails {
    requestType?: WayForPayRequestType;
    status?: number;
    reasonCode?: number;
    reason?: string;
    cause?: unknown;
}

export class WayForPayError extends Error {
    readonly requestType: WayForPayRequestType | undefined;
    readonly status: number | undefined;
    readonly reasonCode: number | undefined;
    readonly reason: string | undefined;

    constructor(
        readonly kind: WayForPayErrorKind,
        message: string,
        details: WayForPayErrorDetails = {},
    ) {
        super(message, details.cause !== undefined ? { cause: details.cause } : undefined);
        this.name = 'WayForPayError';
        this.requestType = details.requestType;
        this.status = details.status;
        this.reasonCode = details.reasonCode;
        this.reason = details.reason;
    }
}
