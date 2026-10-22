# Changelog

## 0.3.0 — 2026-10-22

- WayForPay subscriptions: `createRecurringPayment` (CREATE_INVOICE with `regularBehavior: 'preset'`, prices signed as sent, success only on reasonCode 1100), `cancelRecurring` (REMOVE) and `changeRecurring` (CHANGE) over `regularApi`.
- `regularApi` replies resolve to `{ ok, outcome, code, reason, orderReference, raw }`; transport failures, non-2xx and unreadable replies throw instead of resolving. `isRecurringRemoved` takes a REMOVE result or a bare code and treats 4100, 4102, 4106 and 4107 as removed. CHANGE is `ok` only on 4100.
- Both regularApi calls send the base order reference without the `_WFPREG…` suffix, as WayForPay documents.
- New `WayForPayError` with `kind`: `validation | api | http | network | timeout | parse`. `http` errors keep WayForPay's `reasonCode` and `reason` when the body had them.
- `WayForPayConfig` gains optional `merchantApiKey` (required by regularApi calls) and `apiUrl` (default `https://api.wayforpay.com/api`; https only, plain http only for localhost stubs, no credentials, no query or fragment, must end with `/api` for regularApi). The merchant secret and API key never appear in errors or `raw`.
- WayForPay requests never follow redirects; a 3xx reply is an `http` error.
- Helpers: `baseOrderReference`, `formatWayForPayDate` (UTC `DD.MM.YYYY`), `normalizeRegularMode`.
- Webhooks: `verify` accepts rule-status callbacks (`merchantAccount;orderReference;processingDate;status;reasonCode`). `extract` returns `WayForPayWebhookEvent` with `kind`, `ruleStatus`, `processingDate`, `reasonCode`, `reason`, `recToken`, `isRegular`, `baseReference`. `WebhookEvent` gains optional `kind`.
- Behaviour changes:
  - `createPayment` no longer follows redirects either, and still accepts any `invoiceUrl` as before; only `createRecurringPayment` requires an https one.
  - `createPayment` wraps transport failures in `WayForPayError` (`network` or `timeout`, original error in `cause`) instead of letting the raw `TypeError` or `TimeoutError` through; gateway refusals keep their old messages. A set `apiUrl` that is not https, carries credentials, a query or a fragment is a `validation` error.
  - `verify` signs missing or null fields as empty strings, not `"undefined"`, so declined callbacks without `authCode` or `cardPan` now verify.
  - `verify` rejects a signed field containing `;` or holding a non-primitive value, and returns false instead of throwing on non-object payloads.
  - `parse` also handles a body wrapped as the only key of a form-parsed object, backslash-escaped bodies and a separate `products` array. It returns `null` for JSON that is not an object, and turns a numeric `authCode` into a string.
  - `respond` signs an empty `orderReference` instead of `"undefined"`, and throws for one containing `;`.
  - `parse` keeps `authCode: null` as `null` (signed as an empty string); shp's fallback parser turned it into the text `"null"`.

## 0.2.1 — 2026-09-22

- README badges: npm version, CI status, license.
- Published from GitHub Actions via npm trusted publishing with provenance.

## 0.2.0 — 2026-09-22

- Package renamed to `@weblabllc/payments-core`.
- WayForPay: the invoice signature now covers `productPrice` exactly as sent (a number), so prices like `450.00` no longer produce a signature mismatch; `wayForPaySignature` is exported.
- NOWPayments: `webhook.verify(payload, config, signature)` takes the `x-nowpayments-sig` header value directly; the `__signature` field still works.
- LiqPay: `wait_compensation` maps to settled, `hold_wait` to authorized, `invoice_wait`, `cash_wait` and `wait_reserve` to pending.
- All outgoing requests (WayForPay, NOWPayments, Checkbox) time out after 20 s; non-JSON gateway replies become a clear error instead of a parse exception.
- Tests for every gateway with a mocked `fetch`: exact request payloads and signatures, callback verification and tampering, status mapping, Checkbox auth flow and errors.

## 0.1.1
- Constant-time signature comparison in LiqPay, WayForPay and NOWPayments webhooks
- LiqPay: `sandbox` callback status is only accepted under a sandbox public key

## 0.1.0 — 2026-09-01

Initial release, extracted and hardened from production projects.
