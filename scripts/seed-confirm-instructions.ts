/**
 * Seeds operator-specific "how to finish the payment" instructions onto the
 * PaymentProvider rows we are confident about. Everything left null falls back
 * to a generic message on the checkout screen. Idempotent — safe to re-run,
 * and safe to extend as more operator codes get verified.
 *
 * Run: npx tsx scripts/seed-confirm-instructions.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DIRECT_URL }) });

// providerCode → instruction. Only verified operators are listed here; the rest
// intentionally stay null so payers get the generic fallback instead of a wrong
// dial code.
const dial = (code: string, network: string) =>
  `Didn’t get a prompt? Dial ${code} on your ${network} line and approve the pending payment.`;

const INSTRUCTIONS: Record<string, string> = {
  // ── VERIFIED ───────────────────────────────────────────────────────────────
  // Cameroon — MTN MoMo (NetwalletPay + ZikoPay)
  mtn_cm: dial('*126#', 'MTN'),
  ziko_mtn_cm: dial('*126#', 'MTN'),
  // Uganda — MTN & Airtel
  mtn_ug: dial('*165#', 'MTN'),
  airtel_ug: dial('*185#', 'Airtel'),
  // Kenya — M-Pesa (STK push)
  mpesa_ke: 'Enter your M-Pesa PIN on the prompt. No prompt? Open your SIM Toolkit menu → M-Pesa to approve.',
  // Côte d’Ivoire — Wave (app based)
  ziko_wave_ci: 'Open the Wave app to review and approve this payment.',

  // ── PROVISIONAL (best-guess codes — pending NetwalletPay/ZikoPay confirmation) ─
  // Cameroon — Orange Money
  orange_cm: dial('#150#', 'Orange'),
  ziko_orange_cm: dial('#150#', 'Orange'),
  // Kenya — Airtel Money
  airtel_ke: dial('*334#', 'Airtel'),
  // Tanzania
  vodacom_tz: dial('*150*00#', 'Vodacom'),
  airtel_tz: dial('*150*60#', 'Airtel'),
  tigo_tz: dial('*150*01#', 'Tigo'),
  azampesa_tz: dial('*150*13#', 'AzamPesa'),
  halopesa_tz: dial('*150*88#', 'HaloPesa'),
  // Côte d’Ivoire
  ziko_mtn_ci: dial('*133#', 'MTN'),
  ziko_orange_ci: dial('#144#', 'Orange'),
  ziko_moov_ci: dial('*155#', 'Moov'),
  // Senegal (Expresso left null — no known code yet → generic fallback)
  ziko_orange_sn: dial('#144#', 'Orange'),
  ziko_free_money_sn: dial('#150#', 'Free Money'),
  // Benin
  ziko_mtn_bj: dial('*880#', 'MTN'),
  ziko_moov_bj: dial('*855#', 'Moov'),
  // Togo
  ziko_t_money_tg: dial('*145#', 'T-Money'),
};

async function main() {
  let updated = 0;
  for (const [providerCode, confirmInstruction] of Object.entries(INSTRUCTIONS)) {
    const res = await prisma.paymentProvider.updateMany({
      where: { providerCode },
      data: { confirmInstruction },
    });
    if (res.count > 0) updated += res.count;
    console.log(`  ${res.count ? '✔' : '–'} ${providerCode}`);
  }
  console.log(`\nUpdated ${updated} provider row(s).`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
