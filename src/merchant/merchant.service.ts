/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { UserSettingsService } from '../users/services/user-settings.service.js';
import { ApplyMerchantDto } from './dto/apply-merchant.dto.js';
import { getXafRates, toXaf } from '../common/fx-convert.js';
import { bucketInvoice } from '../common/failure-category.js';

type AnalyticsPeriod = '7d' | '30d' | '90d';

/** Shape returned for a merchant payout setting (a UserPaymentPhoneSettings row). */
const PAYOUT_SELECT = {
  id: true,
  paymentMethod: true,
  phone: true,
  isPrimary: true,
  isVerified: true,
  country: { select: { iso2: true, name: true, dialCode: true } },
  provider: { select: { providerCode: true, name: true } },
} as const;

@Injectable()
export class MerchantService {
  constructor(
    private prisma: PrismaService,
    private userSettings: UserSettingsService,
  ) {}

  // =====================================================
  // 🏪 MERCHANT HANDLE (BUSINESS STOREFRONT IDENTITY)
  // =====================================================

  /** APPROVED-merchant guard shared by all storefront actions. */
  private async requireApprovedProfile(userId: string) {
    const profile = await this.prisma.merchantProfile.findUnique({ where: { userId } });
    if (!profile || profile.status !== 'APPROVED') {
      throw new ForbiddenException('Merchant access required');
    }
    return profile;
  }

  private cleanForHandle(name: string): string {
    return name.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  }

  private async generateBusinessHandle(businessName: string): Promise<string> {
    const clean = this.cleanForHandle(businessName) || 'business';
    const base = `@tchoko-${clean}`;
    let handle = base;
    let counter = 1;
    while (await this.prisma.paymentIdentity.findUnique({ where: { handle } })) {
      handle = `${base}${counter}`;
      counter++;
    }
    return handle;
  }

  /** Resolve & validate the payout setting the merchant handle should route to. */
  private async resolvePayoutSetting(userId: string, payoutSettingId?: string) {
    if (payoutSettingId) {
      const setting = await this.prisma.userPaymentPhoneSettings.findFirst({
        where: { id: payoutSettingId, userId, isVerified: true, isUserConfirmed: true },
      });
      if (!setting) {
        throw new BadRequestException('That payout number is not valid or not verified');
      }
      return setting;
    }

    // Inherit: fall back to the user's primary verified payout setting.
    const primary = await this.userSettings.getPrimaryVerifiedPayoutSetting(userId);
    if (!primary) {
      throw new BadRequestException(
        'Verify a payout number before creating your business handle',
      );
    }
    return primary;
  }

  /** Merchant wallet: held balance available for cash-out, per settlement currency. */
  async getWallet(userId: string) {
    await this.requireApprovedProfile(userId);
    const wallets = await this.prisma.wallet.findMany({
      where: { userId },
      select: {
        availableBalance: true,
        currency: { select: { code: true, symbol: true, name: true } },
      },
    });
    return wallets
      .map((w) => ({ availableBalance: Number(w.availableBalance), currency: w.currency }))
      .filter((w) => w.availableBalance > 0);
  }

  /** Returns the merchant's storefront identity (handle + payout), or null. */
  async getMyHandle(userId: string) {
    const profile = await this.prisma.merchantProfile.findUnique({ where: { userId } });
    if (!profile) return null;

    return this.prisma.paymentIdentity.findUnique({
      where: { merchantProfileId: profile.id },
      include: { payoutSetting: { select: PAYOUT_SELECT } },
    });
  }

  /**
   * Create the business storefront handle for an APPROVED merchant.
   * - payoutSettingId omitted -> inherit the user's primary verified payout.
   * - payoutSettingId provided -> route business money to that verified number.
   * Idempotent: returns the existing handle if one already exists.
   */
  async createHandle(userId: string, payoutSettingId?: string) {
    const profile = await this.requireApprovedProfile(userId);

    const existing = await this.prisma.paymentIdentity.findUnique({
      where: { merchantProfileId: profile.id },
      include: { payoutSetting: { select: PAYOUT_SELECT } },
    });
    if (existing) return existing;

    const payout = await this.resolvePayoutSetting(userId, payoutSettingId);
    const handle = await this.generateBusinessHandle(profile.businessName);

    return this.prisma.paymentIdentity.create({
      data: {
        kind: 'MERCHANT',
        handle,
        merchantProfile: { connect: { id: profile.id } },
        payoutSetting: { connect: { id: payout.id } },
      },
      include: { payoutSetting: { select: PAYOUT_SELECT } },
    });
  }

  /** Switch which payout number the business handle settles to. */
  async updateHandlePayout(userId: string, payoutSettingId: string) {
    const profile = await this.requireApprovedProfile(userId);

    const identity = await this.prisma.paymentIdentity.findUnique({
      where: { merchantProfileId: profile.id },
    });
    if (!identity) {
      throw new BadRequestException('Create your business handle first');
    }

    const payout = await this.resolvePayoutSetting(userId, payoutSettingId);

    return this.prisma.paymentIdentity.update({
      where: { id: identity.id },
      data: { payoutSetting: { connect: { id: payout.id } } },
      include: { payoutSetting: { select: PAYOUT_SELECT } },
    });
  }

  /** Returns the caller's merchant profile, or null if they've never applied. */
  async getMyProfile(userId: string) {
    return this.prisma.merchantProfile.findUnique({ where: { userId } });
  }

  /**
   * Submit (or resubmit) a merchant application.
   * - No existing profile  -> create as PENDING.
   * - Existing REJECTED     -> edit & resubmit (reset to PENDING, clear review fields).
   * - Existing PENDING/APPROVED/SUSPENDED -> rejected, applicant must wait/contact support.
   */
  async apply(userId: string, dto: ApplyMerchantDto) {
    const existing = await this.prisma.merchantProfile.findUnique({ where: { userId } });

    if (existing) {
      switch (existing.status) {
        case 'PENDING':
          throw new BadRequestException('Your merchant application is already pending review.');
        case 'APPROVED':
          throw new BadRequestException('You are already an approved merchant.');
        case 'SUSPENDED':
          throw new BadRequestException('Your merchant account is suspended. Please contact support.');
        case 'REJECTED':
          return this.prisma.merchantProfile.update({
            where: { userId },
            data: {
              businessName: dto.businessName,
              businessType: dto.businessType,
              description: dto.description ?? null,
              status: 'PENDING',
              rejectionReason: null,
              reviewedById: null,
              reviewedAt: null,
            },
          });
      }
    }

    return this.prisma.merchantProfile.create({
      data: {
        userId,
        businessName: dto.businessName,
        businessType: dto.businessType,
        description: dto.description ?? null,
      },
    });
  }

  /**
   * Lifetime revenue across ALL currencies, summed to one APPROXIMATE XAF figure
   * for the dashboard headline (payments settle in the payer's currency). The
   * per-currency split is returned too.
   */
  async getRevenueXaf(userId: string) {
    const profile = await this.prisma.merchantProfile.findUnique({ where: { userId }, select: { id: true } });
    if (!profile) return { xafTotal: 0, approx: false, byCurrency: [] as Array<{ currency: string; amount: number; count: number }> };

    const grouped = await this.prisma.paymentInvoice.groupBy({
      by: ['currencyId'],
      where: { merchantProfileId: profile.id, status: 'SUCCESS' },
      _sum: { amount: true },
      _count: { _all: true },
    });
    const currencies = await this.prisma.currency.findMany({
      where: { id: { in: grouped.map((g) => g.currencyId) } },
      select: { id: true, code: true },
    });
    const codeById = Object.fromEntries(currencies.map((c) => [c.id, c.code]));
    const rates = await getXafRates();

    let xafTotal = 0;
    const byCurrency = grouped.map((g) => {
      const currency = codeById[g.currencyId] ?? 'XAF';
      const amount = Number(g._sum.amount ?? 0);
      xafTotal += toXaf(amount, currency, rates);
      return { currency, amount: Math.round(amount), count: g._count._all };
    }).sort((a, b) => b.amount - a.amount);

    return { xafTotal: Math.round(xafTotal), approx: byCurrency.some((b) => b.currency !== 'XAF'), byCurrency };
  }

  /**
   * Scoped analytics over the payments this merchant has received
   * (PaymentInvoice rows where they are the recipient), mirroring
   * AdminService.getAnalytics() but filtered to a single user.
   */
  async getAnalytics(userId: string, period: AnalyticsPeriod = '30d') {
    const profile = await this.prisma.merchantProfile.findUnique({ where: { userId } });
    if (!profile || profile.status !== 'APPROVED') {
      throw new ForbiddenException('Merchant access required');
    }

    const days = period === '7d' ? 7 : period === '30d' ? 30 : 90;
    const since = new Date();
    since.setDate(since.getDate() - days);

    const invoices = await this.prisma.paymentInvoice.findMany({
      // Business money only — invoices tagged with this merchant profile
      // (paid to the business storefront handle), not personal receipts.
      where: { merchantProfileId: profile.id, createdAt: { gte: since } },
      select: {
        status: true,
        flow: true,
        paymentMethod: true,
        country: true,
        amount: true,
        createdById: true,
        createdAt: true,
        expiresAt: true,
        failureCategory: true,
        attempts: { orderBy: { createdAt: 'desc' }, take: 1, select: { failureReason: true } },
        quote: {
          select: {
            baseAmount: true,
            fee: true,
            baseCurrency: { select: { code: true } },
            targetCurrency: { select: { code: true } },
          },
        },
        currency: { select: { code: true } },
      },
    });

    // Generate date array (ISO yyyy-mm-dd)
    const dates: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().slice(0, 10));
    }

    type TxDay = { success: number; failed: number; total: number; volume: number; fees: number };
    const txMap = new Map<string, TxDay>(
      dates.map((d) => [d, { success: 0, failed: 0, total: 0, volume: 0, fees: 0 }]),
    );

    let totalVolume = 0, totalFees = 0, successCount = 0, failedCount = 0;
    const methodMap = new Map<string, { count: number; volume: number }>();
    const flowMap = new Map<string, { count: number; volume: number }>();
    const countryMap = new Map<string, { count: number; volume: number }>();
    const corridorMap = new Map<string, { count: number; volume: number }>();
    const payerIds = new Set<string>();
    // Outcome buckets — separate customer behaviour from real system reliability.
    const outcomes = { success: 0, abandoned: 0, declined: 0, system: 0, inprogress: 0 };
    const now = new Date();

    // Payments settle in the payer's currency — convert each to an approximate
    // XAF figure so the single volume total is meaningful (display-only).
    const fxRates = await getXafRates();

    for (const inv of invoices) {
      const day = inv.createdAt.toISOString().slice(0, 10);
      const row = txMap.get(day) ?? { success: 0, failed: 0, total: 0, volume: 0, fees: 0 };
      const ccy = inv.currency?.code ?? 'XAF';
      const amount = toXaf(Number(inv.amount), ccy, fxRates);
      const fee = toXaf(Number(inv.quote?.fee ?? 0), inv.quote?.baseCurrency?.code ?? ccy, fxRates);

      outcomes[bucketInvoice({
        status: inv.status,
        failureCategory: inv.failureCategory,
        latestFailureReason: inv.attempts[0]?.failureReason ?? null,
        expired: inv.expiresAt ? inv.expiresAt < now : false,
      })] += 1;

      row.total++;
      row.volume += amount;
      totalVolume += amount;

      if (inv.status === 'SUCCESS') {
        row.success++;
        row.fees += fee;
        totalFees += fee;
        successCount++;
        if (inv.createdById) payerIds.add(inv.createdById);
      } else if (inv.status === 'FAILED') {
        row.failed++;
        failedCount++;
      }
      txMap.set(day, row);

      const method = inv.paymentMethod ?? 'UNKNOWN';
      const mRow = methodMap.get(method) ?? { count: 0, volume: 0 };
      mRow.count++;
      mRow.volume += amount;
      methodMap.set(method, mRow);

      const flow = inv.flow ?? 'UNKNOWN';
      const fRow = flowMap.get(flow) ?? { count: 0, volume: 0 };
      fRow.count++;
      fRow.volume += amount;
      flowMap.set(flow, fRow);

      const country = inv.country ?? 'UNKNOWN';
      const cRow = countryMap.get(country) ?? { count: 0, volume: 0 };
      cRow.count++;
      cRow.volume += amount;
      countryMap.set(country, cRow);

      const from = inv.quote?.baseCurrency?.code ?? inv.currency.code;
      const to = inv.quote?.targetCurrency?.code ?? inv.currency.code;
      const corridor = `${from}→${to}`;
      const corrRow = corridorMap.get(corridor) ?? { count: 0, volume: 0 };
      corrRow.count++;
      corrRow.volume += amount;
      corridorMap.set(corridor, corrRow);
    }

    return {
      period,
      // Volumes are summed to an approximate XAF figure across currencies.
      currency: 'XAF',
      approx: invoices.some((inv) => (inv.currency?.code ?? 'XAF') !== 'XAF'),
      summary: {
        totalVolume: Math.round(totalVolume),
        totalFees: Math.round(totalFees),
        totalTransactions: invoices.length,
        successCount,
        failedCount,
        successRate:
          invoices.length > 0 ? Math.round((successCount / invoices.length) * 100) : 0,
        avgTransactionValue:
          invoices.length > 0 ? Math.round(totalVolume / invoices.length) : 0,
        uniquePayers: payerIds.size,
        // Four-bucket outcome breakdown — separates customer behaviour from
        // real reliability. `systemSuccessRate` is the true strength of the
        // system (successes vs only the failures we/our providers caused).
        outcomes,
        systemSuccessRate:
          outcomes.success + outcomes.system > 0
            ? Math.round((outcomes.success / (outcomes.success + outcomes.system)) * 100)
            : 0,
        // Of everything that reached a final state, how many succeeded.
        overallConversion:
          invoices.length - outcomes.inprogress > 0
            ? Math.round(
                (outcomes.success / (invoices.length - outcomes.inprogress)) * 100,
              )
            : 0,
      },
      txChart: dates.map((date) => ({ date, ...(txMap.get(date)!) })),
      byPaymentMethod: Array.from(methodMap.entries())
        .map(([method, data]) => ({ method, ...data }))
        .sort((a, b) => b.count - a.count),
      byFlow: Array.from(flowMap.entries())
        .map(([flow, data]) => ({ flow, ...data }))
        .sort((a, b) => b.count - a.count),
      byCountry: Array.from(countryMap.entries())
        .map(([country, data]) => ({ country, ...data }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
      topCorridors: Array.from(corridorMap.entries())
        .map(([corridor, data]) => ({ corridor, ...data }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5),
    };
  }
}
