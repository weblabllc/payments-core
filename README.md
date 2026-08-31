# @risklight/payments-core

Framework-free payment layer for Ukrainian e-commerce: one `PaymentGateway` interface, four gateways (invoice / LiqPay / WayForPay / NOWPayments), Checkbox (ПРРО) fiscalization client and an orchestrator with auto-retries and manual resend. Zero framework imports — adapters for Vendure/Express/Nest live in your app.

## Install

```bash
npm install @risklight/payments-core
```

## Enable only what you need

```ts
import { PaymentsRegistry } from '@risklight/payments-core/registry'

const payments = await PaymentsRegistry.create({ gateways: ['invoice', 'nowpayments'] })
payments.get('liqpay') // throws: not enabled
```

Or import a single gateway directly:

```ts
import { LiqPayGateway } from '@risklight/payments-core/liqpay'
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
If `webhook.signatureHeaderName` is set (NOWPayments), inject the header value as `payload.__signature` before `verify`.

## Fiscalization (Checkbox ПРРО)

```ts
import { CheckboxClient } from '@risklight/payments-core/checkbox'
import { Fiscalizer, InMemoryFiscalizationStore } from '@risklight/payments-core/fiscalization'

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
