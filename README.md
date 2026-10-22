# @weblabllc/payments-core

[![npm](https://img.shields.io/npm/v/@weblabllc/payments-core)](https://www.npmjs.com/package/@weblabllc/payments-core) [![ci](https://github.com/weblabllc/payments-core/actions/workflows/ci.yml/badge.svg)](https://github.com/weblabllc/payments-core/actions/workflows/ci.yml) [![license](https://img.shields.io/npm/l/@weblabllc/payments-core)](LICENSE)

Framework-free payment layer for Ukrainian e-commerce: one `PaymentGateway` interface, four gateways (invoice / LiqPay / WayForPay / NOWPayments), Checkbox (ПРРО) fiscalization client and an orchestrator with auto-retries and manual resend. Zero framework imports — adapters for Vendure/Express/Nest live in your app.

## Install

```bash
npm install @weblabllc/payments-core
```

## Enable only what you need

```ts
import { PaymentsRegistry } from '@weblabllc/payments-core/registry'

const payments = await PaymentsRegistry.create({ gateways: ['invoice', 'nowpayments'] })
payments.get('liqpay') // throws: not enabled
```

Or import a single gateway directly:

```ts
import { LiqPayGateway } from '@weblabllc/payments-core/liqpay'
```

## Create a payment

```ts
const result = await payments.get('nowpayments').createPayment(
  { orderCode: 'ORD-1', amountMinor: 45000, currencyCode: 'UAH', description: 'Замовлення ORD-1',
    returnUrl: 'https://shop.ua/thanks/ORD-1', webhookUrl: 'https://api.shop.ua/payments/nowpayments/callback' },
  { apiKey: '...', ipnSecret: '...' },
)
// result.redirect → { url, method } ; result.publicMetadata → safe for the storefront
```

## Webhooks

Every webhook-confirmed gateway exposes `webhook: { parse, verify, extract, respond? }`.
If `webhook.signatureHeaderName` is set (NOWPayments), pass that header's value as the third argument: `webhook.verify(payload, config, req.headers['x-nowpayments-sig'])`.

Outgoing requests time out after 20 s; a non-JSON gateway reply becomes a clear error.

## Subscriptions (WayForPay)

```ts
import { WayForPayGateway, isRecurringRemoved } from '@weblabllc/payments-core/wayforpay'

const wfp = new WayForPayGateway()
const config = {
  merchantAccount: '...', merchantSecret: '...', merchantDomain: 'shop.ua',
  merchantApiKey: '...',
  apiUrl: 'https://api.wayforpay.com/api',
}

const invoice = await wfp.createRecurringPayment({
  orderCode: 'ORD-1', amountMinor: 0, regularAmountMinor: 45000, currencyCode: 'UAH',
  description: 'Підписка', regularMode: 'monthly', dateNext: new Date('2026-11-22T08:57:00Z'),
  regularCount: 60, webhookUrl: 'https://api.shop.ua/wayforpay/webhook', returnUrl: 'https://shop.ua/thanks',
}, config)
redirectTo(invoice.redirect!.url)

const removed = await wfp.cancelRecurring(subscription.orderReference, config)
if (isRecurringRemoved(removed)) markCancelled()

const changed = await wfp.changeRecurring(subscription.orderReference, {
  regularMode: 'yearly', amountMinor: 450000, currencyCode: 'UAH',
  dateBegin: new Date('2027-01-05T08:57:00Z'), dateEnd: new Date('2032-01-05T08:57:00Z'),
}, config)
if (!changed.ok) keepOldRule(changed.outcome)
```

`merchantApiKey` is the merchant password; only `cancelRecurring` and `changeRecurring` need it. `apiUrl` is optional. It must use https (plain http is accepted only for `localhost`, `127.0.0.1` and `[::1]` stubs), must not carry credentials, a query or a fragment, and must end with `/api`: the regularApi URL is derived by replacing that with `/regularApi`. Redirects are never followed, so a 3xx reply is an `http` error and the merchant password never travels to another host. Treat `apiUrl` as operator configuration: never take it from tenant or user input, because the merchant password is sent to that host. `createRecurringPayment` succeeds only on reasonCode 1100 with an https `invoiceUrl`.

The package talks to WayForPay and normalizes replies. Billing dates, the database, idempotent crediting and mapping to your own subscription statuses stay in the app. Dates are sent as `DD.MM.YYYY` in UTC (`formatWayForPayDate`). `regularMode` accepts `daily | weekly | monthly | quarterly | halfyearly | yearly` and `day | week | month | year`; anything else is a validation error.

Both `cancelRecurring` and `changeRecurring` strip the `_WFPREG…` suffix (`baseOrderReference`), because WayForPay identifies a rule by the order of its first successful payment.

### regularApi result

Every answered request resolves to `{ ok, outcome, code, reason, orderReference, raw }`. `isRecurringRemoved` takes a REMOVE result or a bare WayForPay code and applies the REMOVE column. If `raw` is too deeply nested to redact, it is reduced to `{ reasonCode, reason }`.

| code | REMOVE | CHANGE |
|---|---|---|
| 4100 | `ok: true`, `removed` | `ok: true`, `changed` |
| 4102 rule not found | `ok: true`, `not-found` | `ok: false`, `not-found` |
| 4106 completed, 4107 closed | `ok: true`, `already-closed` | `ok: false`, `already-closed` |
| anything else | `ok: false`, `refused` | `ok: false`, `refused` |

A network error, timeout, non-2xx status or unreadable reply never resolves: it throws `WayForPayError` with `kind` `network | timeout | http | parse`, meaning the state at WayForPay is unknown. Retrying REMOVE is safe: a retry that answers 4102, 4106 or 4107 still counts as `ok: true`. An `http` error keeps WayForPay's `reasonCode` and `reason` when the body had them, but the state is still unknown.

4102 means WayForPay has no rule under that reference. With the suffix stripped this is the normal answer for a rule that is already gone, but it is also what a wrong reference gets, so log `outcome: 'not-found'` separately from `removed`. Bad input throws `kind: 'validation'` before any request. The merchant secret and API key are replaced with `***` in errors, `reason` and `raw`.

### Two kinds of callbacks

WayForPay posts payment callbacks and rule-status callbacks to the same URL. `webhook.verify` checks either signature, and `webhook.extract` tells them apart:

```ts
const event = wfp.webhook.extract(payload)
if (event.kind === 'rule-status') applyRuleStatus(event.baseReference, event.ruleStatus)
else if (event.isRegular) creditRenewal(event.baseReference, event.recToken, event.amountMinor)
return wfp.webhook.respond(payload, config)
```

`ruleStatus` is WayForPay's rule status (`Active`, `Suspended`, `Removed`, `Completed` or anything new, passed through), and `status` is always `'pending'` for rule events, so code that only settles on `'settled'` ignores them. For a scheduled charge `isRegular` is true, `baseReference` is the first order and `recToken` the card token.

Rule events also carry `processingDate`. Payment callbacks carry no signed timestamp, so a captured callback stays valid: apply events idempotently per `orderReference`.

Missing signed fields count as empty strings; a signed field that contains `;` or is not a string or number is rejected. `respond` throws for an `orderReference` containing `;`, so call it only after `verify`.

## Fiscalization (Checkbox ПРРО)

```ts
import { CheckboxClient } from '@weblabllc/payments-core/checkbox'
import { Fiscalizer, InMemoryFiscalizationStore } from '@weblabllc/payments-core/fiscalization'

const client = new CheckboxClient({ licenseKey: '...', login: '...', password: '...' })
const fiscal = new Fiscalizer(client, myStore, { maxAutoAttempts: 5 })

await fiscal.fiscalize(payment.id, buildReceipt)      // auto mode: call from a queue job
await fiscal.resendManually(payment.id, buildReceipt) // manual resend after auto attempts exhausted
await fiscal.listUnfiscalized()                        // feed for the "unfiscalized payments" screen
```

`Fiscalizer` is idempotent (a receipt is never issued twice), opens the shift when needed, and persists state through the `FiscalizationStore` port — implement it over your DB (an in-memory reference ships in the box). Payment entries are online-first: `{ type: 'CASHLESS', value, label? }`.

## Test

```bash
npm test
```
