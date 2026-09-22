# Changelog

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
