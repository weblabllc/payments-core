export const REQUEST_TIMEOUT_MS = 20_000;

export async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ ok: boolean; status: number; body: any }> {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch {
        parsed = text;
    }
    return { ok: res.ok, status: res.status, body: parsed };
}
