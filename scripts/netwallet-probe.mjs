/**
 * Generic live NetwalletPay collection (pay-in) probe — mirrors
 * NetwalletpayProvider.payin exactly (phone format, payload, hash, MethodType
 * only for CM). Prints request + response, then the resolved status. No DB writes.
 *
 * Run:  node --env-file=.env scripts/netwallet-probe.mjs <COUNTRY> <provider> <CURRENCY> <phone> [amount]
 *   e.g. node --env-file=.env scripts/netwallet-probe.mjs RW netwallet_rw RWF +250787826778 500
 */
import { createHash } from 'node:crypto';

const [, , countryArg, provider, currency, phoneArg, amountArg] = process.argv;
if (!countryArg || !provider || !currency || !phoneArg) {
  console.error('Usage: netwallet-probe.mjs <COUNTRY> <provider> <CURRENCY> <phone> [amount]');
  process.exit(1);
}
const country = countryArg.toUpperCase();

const DIAL = { CM: '237', KE: '254', TZ: '255', GH: '233', RW: '250', UG: '256', ZM: '260', BI: '257', NG: '234', ZA: '27' };
const cc = DIAL[country];
if (!cc) { console.error(`Unknown country ${country}`); process.exit(1); }

const baseUrl = (process.env.NETWALLETPAY_BASE_URL ?? 'https://netwalletpay.com').replace(/\/+$/, '');
const primaryKey = process.env.NETWALLETPAY_PRIMARY_KEY ?? '';
const secondaryKey = process.env.NETWALLETPAY_SECONDARY_KEY ?? '';
const email = process.env.NETWALLETPAY_EMAIL ?? '';
const webhookBase = process.env.NETWALLETPAY_WEBHOOK_BASE_URL ?? '';

async function getToken() {
  const form = new URLSearchParams();
  form.append('primary_key', primaryKey);
  form.append('email', email);
  form.append('grant_type', 'primary_key');
  const res = await fetch(`${baseUrl}/api/v1/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form.toString(),
  });
  if (!res.ok) throw new Error(`Token failed ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

// Mirrors formatPhoneNumber(phone, country)
function formatPhone(raw) {
  let d = raw.replace(/[\s+\-()]/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith(cc)) d = d.slice(cc.length);
  if (d.startsWith('0')) d = d.slice(1);
  return cc + d;
}

const amount = Math.ceil(Number(amountArg ?? 500));
const orderId = `TEST${country}${Date.now()}`;
const hash = createHash('sha256').update(`${orderId}_${secondaryKey}`).digest('hex');
const phone = formatPhone(phoneArg);

const payload = {
  CurrencyCode: currency.toUpperCase(),
  OrderID: orderId,
  Amount: amount,
  Method: 'MOBILE_MONEY',
  CountryCode: country,
  MethodProvider: provider,
  PhoneNumber: phone,
  Description: `TchokoPay ${country} test ${orderId}`,
  CallbackUrl: `${webhookBase}/api/v1/webhooks/netwalletpay`,
  Hash: hash,
};
// MethodType only for MOBILE_MONEY + CM (per docs).
if (country === 'CM') payload.MethodType = 'MOMO';

const token = await getToken();
console.log(`\n══════ ${country} · ${provider} · ${currency} ══════`);
console.log('Phone   :', phoneArg, '->', phone);
console.log('Payload :', JSON.stringify(payload));

const res = await fetch(`${baseUrl}/api/v1/global/collection/request-payment`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload),
});
const text = await res.text();
let body; try { body = JSON.parse(text); } catch { body = text; }
console.log(`← HTTP ${res.status}:`, typeof body === 'string' ? body : JSON.stringify(body));

const txId = body?.data;
if (typeof txId === 'string' && txId) {
  await new Promise((r) => setTimeout(r, 2500));
  const st = await fetch(`${baseUrl}/api/v1/global/transaction-status/${txId}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  const sd = await st.json().catch(() => null);
  console.log('Status  :', JSON.stringify(sd?.data ?? sd));
}
