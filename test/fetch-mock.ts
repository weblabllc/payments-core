import { vi } from 'vitest';

export type Call = { url: string; init: RequestInit };

export type MockResponse = { status?: number; body: unknown } | Error;

export function mockFetch(...responses: MockResponse[]) {
    const calls: Call[] = [];
    const queue = [...responses];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        const next = queue.shift() ?? { status: 500, body: '' };
        if (next instanceof Error) throw next;
        const text = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
        return new Response(text, { status: next.status ?? 200 });
    }));
    return calls;
}

export const jsonBody = (call: Call) => JSON.parse(String(call.init.body));
