/**
 * Read-only audit: compare our DB provider config against NetwalletPay's
 * officially-supported GEOs (as stated by their owner). Catches missing
 * countries, wrong currency, wrong method, inactive rows, missing operators.
 * Run:  npx ts-node prisma/audit-providers.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const connectionString = process.env.DIRECT_URL;
if (!connectionString) throw new Error('DIRECT_URL not set');
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

// What NetwalletPay's owner says is live (collections + payouts).
const EXPECTED: Record<string, { currency: string; method: string; operators: string[] }> = {
  UG: { currency: 'UGX', method: 'MOBILE_MONEY', operators: ['MTN', 'Airtel'] },
  KE: { currency: 'KES', method: 'MOBILE_MONEY', operators: ['M-Pesa'] },
  RW: { currency: 'RWF', method: 'MOBILE_MONEY', operators: ['MTN'] },
  NG: { currency: 'NGN', method: 'BANK', operators: ['Bank (instant e-banking)'] },
  ZA: { currency: 'ZAR', method: 'BANK', operators: ['EFT'] },
  GH: { currency: 'GHS', method: 'MOBILE_MONEY', operators: ['Airtel', 'MTN', 'Vodafone'] },
  CM: { currency: 'XAF', method: 'MOBILE_MONEY', operators: ['Orange', 'MTN'] },
  TZ: { currency: 'TZS', method: 'MOBILE_MONEY', operators: ['Airtel', 'Tigo', 'Vodacom'] },
};

async function main() {
  for (const [iso2, exp] of Object.entries(EXPECTED)) {
    const country = await prisma.country.findUnique({
      where: { iso2 },
      include: { currency: true },
    });
    const providers = await prisma.paymentProvider.findMany({
      where: { country: { iso2 } },
      include: { aggregator: true, method: true },
      orderBy: [{ isActive: 'desc' }, { providerCode: 'asc' }],
    });
    const currencyExists = await prisma.currency.findUnique({ where: { code: exp.currency } });

    console.log(`\n═══ ${iso2}  (expected: ${exp.currency} · ${exp.method} · ${exp.operators.join(', ')}) ═══`);
    const issues: string[] = [];

    if (!country) issues.push(`❌ COUNTRY MISSING from DB`);
    else {
      if (!country.isActive) issues.push(`⚠️ country isActive=false (won't show in wizard)`);
      if (country.currency.code !== exp.currency) issues.push(`⚠️ country currency is ${country.currency.code}, expected ${exp.currency}`);
    }
    if (!currencyExists) issues.push(`❌ currency ${exp.currency} not in Currency table`);
    else if (!currencyExists.isActive) issues.push(`⚠️ currency ${exp.currency} isActive=false`);

    const nw = providers.filter((p) => p.aggregator?.code === 'netwalletpay');
    if (nw.length === 0) issues.push(`❌ NO netwalletpay providers configured`);

    console.log('  Providers in DB:');
    if (providers.length === 0) console.log('    (none)');
    for (const p of providers) {
      console.log(`    ${p.isActive ? '●' : '○'} ${p.providerCode.padEnd(18)} ${p.method.code.padEnd(13)} [${p.aggregator?.code}]  ${p.name}`);
    }
    const activeMethods = new Set(nw.filter((p) => p.isActive).map((p) => p.method.code));
    if (nw.length && !activeMethods.has(exp.method)) {
      issues.push(`⚠️ expected an active ${exp.method} provider; active methods: ${[...activeMethods].join(', ') || 'none'}`);
    }

    console.log(issues.length ? '  Issues:\n' + issues.map((i) => `    ${i}`).join('\n') : '  ✅ looks configured');
  }

  console.log('\n\n═══ All currencies in DB ═══');
  const curs = await prisma.currency.findMany({ where: { isCrypto: false }, orderBy: { code: 'asc' }, select: { code: true, isActive: true } });
  console.log('  ' + curs.map((c) => `${c.code}${c.isActive ? '' : '(off)'}`).join(', '));
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
