/**
 * Live NetwalletPay Kenya M-Pesa collection (pay-in) probe — mirrors
 * NetwalletpayProvider.payin exactly (phone format, payload, hash, no MethodType
 * for non-CM). Prints request + response. No DB writes.
 *
 * Run:  node --env-file=.env scripts/netwallet-ke-test.mjs [amountKES]
 */
import { createHash } from 'node:crypto';

const baseUrl = (process.env.NETWALLETPAY_BASE_URL ?? 'https://netwalletpay.com').replace(/\/+$/, '');
const primaryKey = process.env.NETWALLETPAY_PRIMARY_KEY ?? '';
const secondaryKey = process.env.NETWALLETPAY_SECONDARY_KEY ?? '';
const email = process.env.NETWALLETPAY_EMAIL ?? '';
const webhookBase = process.env.NETWALLETPAY_WEBHOOK_BASE_URL ?? '';

console.log('Base URL    :', baseUrl);
console.log('Credentials :', primaryKey && secondaryKey && email ? `loaded (primary ${primaryKey.length}, secondary ${secondaryKey.length})` : 'MISSING');

async function getToken() {
  const form = new URLSearchParams();
  form.append('primary_key', primaryKey);
  form.append('email', email);
  form.append('grant_type', 'primary_key');
  const res = await fetch(`${baseUrl}/api/v1/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form.toString(),
  });
  if (!res.ok) throw new Error(`Token failed ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

// Mirrors formatPhoneNumber(phone, 'KE'): cc=254 → 254721746500
function formatKePhone(raw) {
  let d = raw.replace(/[\s+\-()]/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('254')) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  return '254' + d;
}

const amount = Math.ceil(Number(process.argv[2] ?? 100)); // KES; ceil like the provider does for payin
const orderId = `TESTKE${Date.now()}`;
const hash = createHash('sha256').update(`${orderId}_${secondaryKey}`).digest('hex');
const phone = formatKePhone('+254721746500');

// NOTE: no MethodType — required only for MOBILE_MONEY + CM.
const payload = {
  CurrencyCode: 'KES',
  OrderID: orderId,
  Amount: amount,
  Method: 'MOBILE_MONEY',
  CountryCode: 'KE',
  MethodProvider: 'mpesa_ke',
  PhoneNumber: phone,
  Description: `TchokoPay KE test ${orderId}`,
  CallbackUrl: `${webhookBase}/api/v1/webhooks/netwalletpay`,
  Hash: hash,
};

const token = await getToken();
console.log('Token       : obtained');
console.log('\nPhone       :', '+254721746500', '->', phone);
console.log('POST', `${baseUrl}/api/v1/global/collection/request-payment`);
console.log('Payload:', JSON.stringify(payload, null, 2));

const res = await fetch(`${baseUrl}/api/v1/global/collection/request-payment`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
  body: JSON.stringify(payload),
});
const text = await res.text();
let body;
try { body = JSON.parse(text); } catch { body = text; }

console.log(`\n← HTTP ${res.status}`);
console.log('Response:', typeof body === 'string' ? body : JSON.stringify(body, null, 2));
const txId = body?.data;
if (res.ok && typeof txId === 'string') console.log(`\nTransactionId: ${txId} — approve the M-Pesa prompt on the phone; poll with scripts/netwallet-status.mjs ${txId}`);
else console.log('\nNo transaction id — see the response above for the real error.');
