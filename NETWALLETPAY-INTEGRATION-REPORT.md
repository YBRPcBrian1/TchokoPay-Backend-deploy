# NetwalletPay Integration — Diagnostic Report

**From:** TchokoPay engineering
**Subject:** Collections return `errorCode 5000` for every country except Cameroon
**Prepared:** live tests run back-to-back on the same merchant account

---

## 1. Executive summary

Our integration works. Using the **same account, same code, and the same payload structure**, a **Cameroon (MTN)** collection succeeds and delivers a MoMo prompt, while **Kenya, Tanzania, Ghana and Rwanda** all fail **instantly** with your internal **`errorCode 5000` ("An internal server error occurred")** — the mobile operator is never engaged (`financialTransactionId: null`).

This report contains the exact requests we send, the exact responses you return, and every transaction ID so your team can trace them. **All evidence points to a provisioning/routing issue on the NetwalletPay side for the non‑Cameroon GEOs**, not our implementation.

---

## 2. Endpoints we use (as documented)

| Purpose | Method & path |
|---|---|
| Auth token | `POST /api/v1/token` — `application/x-www-form-urlencoded`: `primary_key`, `email`, `grant_type=primary_key` → `{ access_token, expires_in }` |
| Collection (pay‑in) | `POST /api/v1/global/collection/request-payment` — `Bearer <access_token>` |
| Transaction status | `GET /api/v1/global/transaction-status/{transactionId}` — `Bearer` |
| Provider lookup | `GET /api/v1/lookup/get-providers/{COLLECTION\|PAYOUT}/{method}/{countryCode}` — `Bearer` |

Base URL in use: **`https://netwalletpay.com`**.

### Collection request body we send

```json
{
  "CurrencyCode": "<ISO currency>",
  "OrderID": "<unique alphanumeric>",
  "Amount": <number>,
  "Method": "MOBILE_MONEY",
  "CountryCode": "<ISO2>",
  "MethodProvider": "<provider id>",
  "PhoneNumber": "<countrycode+local, no +>",
  "Description": "…",
  "CallbackUrl": "https://api.tchokopay.com/api/v1/webhooks/netwalletpay",
  "Hash": "sha256(OrderID + '_' + secondary_key)",
  "MethodType": "MOMO"   // sent ONLY for CountryCode == CM, per your docs
}
```

Phone is normalised to `countrycode + local digits` (leading `0` stripped), e.g. `+255 785 554 324 → 255785554324`.

---

## 3. Result matrix

| GEO | Operator / provider id(s) tested | HTTP | Result |
|---|---|---|---|
| 🇨🇲 **Cameroon** | `mtn_cm` | **200** | ✅ **PENDING** — prompt delivered, operator engaged |
| 🇰🇪 Kenya | `mpesa_ke` | 400 | ❌ `5000` FAILED — operator never engaged |
| 🇹🇿 Tanzania | `airtel_tz` | 400 | ❌ `5000` FAILED |
| 🇬🇭 Ghana | `netwallet_gh`, `vodafone_gh` | 400 | ❌ `5000` FAILED |
| 🇷🇼 Rwanda | `netwallet_rw`, `mtn_rw`, `airtel_rw` | 400 | ❌ `5000` FAILED |

In **every** failing case: you **accept the request, create a transaction, and echo our exact payload back**, then the transaction resolves to `FAILED` with `financialTransactionId: null` — i.e. the operator was never reached.

---

## 4. The decisive comparison (same account, same integration, seconds apart)

**✅ Cameroon — WORKS**

Request `MethodProvider: mtn_cm`, `MethodType: MOMO`, phone `237674981914`, 200 XAF →
```json
{ "statusCode": 200, "data": "MMW17344150236", "message": null, "errorCode": null }
```
Status →
```json
{ "financialTransactionId": null, "transactionId": "MMW17344150236",
  "amount": 200, "currency": "XAF", "phone": "237674981914",
  "orderId": "TESTCM…", "status": "PENDING" }
```
→ A real MTN MoMo prompt was delivered to the phone; `PENDING` awaiting approval.

**❌ Everything else — FAILS**

Representative failure (Kenya, `mpesa_ke`, phone `254721746500`, 100 KES) →
```json
{ "statusCode": 400, "data": "DSD17344024852",
  "message": "An internal server error occurred.", "errorCode": 5000 }
```
Status →
```json
{ "financialTransactionId": null, "transactionId": "DSD17344024852",
  "amount": 100, "currency": "KES", "phone": "254721746500",
  "orderId": "TESTKE…", "status": "FAILED" }
```
→ No prompt; failed immediately.

---

## 5. Full evidence — transaction IDs to trace on your side

All phone numbers used are **real, active** mobile‑money lines.

| GEO | Provider id | Phone | Amount | Txn ID | Result |
|---|---|---|---|---|---|
| 🇨🇲 CM | `mtn_cm` | 237674981914 | 200 XAF | **MMW17344150236** | ✅ 200 / PENDING |
| 🇰🇪 KE | `mpesa_ke` | 254721746500 | 100 KES | DSD17344024852 | ❌ 5000 / FAILED |
| 🇹🇿 TZ | `airtel_tz` | 255785554324 | 1000 TZS | DSG17343961045 | ❌ 5000 / FAILED |
| 🇹🇿 TZ | `airtel_tz` | 255785554324 | 1000 TZS | DSU17344051967 | ❌ 5000 / FAILED |
| 🇹🇿 TZ | `airtel_tz` | 255785554324 | 1000 TZS | DSR17344134478 | ❌ 5000 / FAILED |
| 🇬🇭 GH | `netwallet_gh` | 233205649687 | — | DSU17256736335 | ❌ 5000 / FAILED |
| 🇬🇭 GH | `netwallet_gh` | 233205649687 | 5 GHS | DSK17344072761 | ❌ 5000 / FAILED |
| 🇬🇭 GH | `vodafone_gh` | 233205649687 | 5 GHS | DSI17344133960 | ❌ 5000 / FAILED |
| 🇷🇼 RW | `netwallet_rw` | 250787826778 | 500 RWF | DSD17344073357 | ❌ 5000 / FAILED |
| 🇷🇼 RW | `mtn_rw` | 250787826778 | 500 RWF | DST17344134968 | ❌ 5000 / FAILED |
| 🇷🇼 RW | `netwallet_rw` | 250739894417 | 500 RWF | DSX17344073836 | ❌ 5000 / FAILED |
| 🇷🇼 RW | `airtel_rw` | 250739894417 | 500 RWF | DSS17344135478 | ❌ 5000 / FAILED |

We tested **both the named operator codes you listed and the generic `netwallet_*` codes** — all fail identically.

---

## 6. Provider‑lookup discrepancy

Your `GET /api/v1/lookup/get-providers/COLLECTION/MOBILE_MONEY/{country}` currently returns **fewer/different operators** than the GEO list you gave us:

| GEO | Your `get-providers` API returns | GEO list you sent us |
|---|---|---|
| CM | `netwallet_cm, mtn_cm, orange_cm, eu_cm` | Orange, MTN |
| KE | `mpesa_ke, airtel_ke, netwallet_ke` | M‑Pesa |
| TZ | `airtel_tz, vodacom_tz, azampesa_tz, halopesa_tz, netwallet_tz` | Airtel, **Tigo**, Vodacom |
| GH | **`netwallet_gh` only** | Airtel, MTN, Vodafone |
| RW | **`netwallet_rw` only** | MTN |
| UG | `mtn_ug, airtel_ug, netwallet_ug` | MTN, Airtel |

So for GH and RW the API exposes only the generic `netwallet_*` wallet, and TZ shows no `tigo_tz` — which does not match the operators you say are live.

---

## 7. Questions for NetwalletPay

1. **Provisioning:** CM works; **KE, TZ, GH, RW return `errorCode 5000`**. Are collections actually enabled for these countries on **our** account? If not, please enable them.
2. **5000 root cause:** For the transaction IDs in §5, what does your internal log show as the real failure reason (the message we receive is only "An internal server error occurred")?
3. **Exact provider ids:** What is the **exact `MethodProvider` id** to send per country/operator? We need the canonical codes for GH (Airtel/MTN/Vodafone), RW (MTN), TZ (Airtel/Tigo/Vodacom), UG (MTN/Airtel), KE (M‑Pesa).
4. **Stale lookup:** Is `get-providers` up to date? It returns only `netwallet_gh` / `netwallet_rw` and omits `tigo_tz`, which conflicts with your GEO list.
5. **MethodType:** Your docs say `MethodType` is required **only** for CM (`MOMO`/`ORANGE_MONEY`/`EU`). Confirm no other country needs it.
6. **Amount limits:** Min/max amount per currency (UGX, KES, RWF, GHS, XAF, TZS, NGN, ZAR)?
7. **Payouts:** Are payouts provisioned per country the same as collections? Any different provider ids / payload?
8. **Bank GEOs:** For **Nigeria (instant e‑banking)** and **South Africa (EFT)** — collection is bank‑based, not `MOBILE_MONEY`. What is the exact `Method`, `MethodProvider`, and any extra bank fields (account, bank code, etc.) for these?
9. **Currency mapping:** Your GEO note lists **Tanzania** processing currency as **UGX** — please confirm it is **TZS** (assumed a typo).
10. **Webhooks:** For a successful collection, what is the exact callback payload and the field that carries the final status + `financialTransactionId`?

---

*Prepared by TchokoPay. Our integration is verified working against Cameroon on the same account and code path; we are ready to go live in the remaining GEOs the moment they are enabled on your side.*
