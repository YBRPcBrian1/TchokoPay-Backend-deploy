/**
 * One-off backfill: set PaymentInvoice.failureCategory on existing FAILED
 * invoices that don't have it yet, using the heuristic classifier over the
 * latest attempt's failureReason. After this, admin filtering/sorting by
 * category is reliable at the SQL level (new failures store it at write time).
 *
 * Run: npx tsx scripts/backfill-failure-category.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { classifyFailure } from '../src/common/failure-category.js';

const adapter = new PrismaPg({ connectionString: process.env.DIRECT_URL });
const prisma = new PrismaClient({ adapter } as any);

async function main() {
  const failed = await prisma.paymentInvoice.findMany({
    where: { status: 'FAILED', failureCategory: null },
    select: {
      id: true,
      attempts: { orderBy: { createdAt: 'desc' }, take: 1, select: { failureReason: true } },
    },
  });

  console.log(`Found ${failed.length} FAILED invoice(s) without a category.`);

  const tally: Record<string, number> = { SYSTEM: 0, DECLINED: 0, ABANDONED: 0 };
  for (const inv of failed) {
    const category = classifyFailure(inv.attempts[0]?.failureReason);
    tally[category] = (tally[category] ?? 0) + 1;
    await prisma.paymentInvoice.update({
      where: { id: inv.id },
      data: { failureCategory: category },
    });
  }

  console.log('Backfill complete:', tally);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
