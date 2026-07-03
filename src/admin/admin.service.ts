import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Prisma, TransactionStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ConfigService } from '@nestjs/config';
import { NetwalletpayProvider } from '../payment/providers/netwalletpay.provider.js';
import { ZikoPayProvider } from '../payment/providers/zikopay.provider.js';
import { UserStatusCacheService } from '../redis/user-status-cache.service.js';
import { getXafRates, toXaf } from '../common/fx-convert.js';
import { bucketInvoice, classifyFailure, explainOutcome } from '../common/failure-category.js';

type AdminActionTarget = 'USER' | 'INVOICE' | 'KYC' | 'PRICING' | 'SYSTEM' | 'REFUND' | 'WITHDRAWAL' | 'MERCHANT';

type FeeConfigInput = {
  baseCurrencyCode?: string | null;
  targetCurrencyCode?: string | null;
  paymentMethod?: string | null;
  payoutMethod?: string | null;
  flow?: string | null;
  feePercent?: number;
  spreadPercent?: number;
  priority?: number;
  isActive?: boolean;
};

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private netwalletpay: NetwalletpayProvider,
    private zikopay: ZikoPayProvider,
    private userStatusCache: UserStatusCacheService,
  ) {}

  // ── Platform settings (merchant payout routing) ─────────────────────────────

  private shapeMerchantSettings(cfg: { merchantAutoRoutePayout: boolean; minWithdrawalAmount: number }) {
    return {
      merchantAutoRoutePayout: cfg.merchantAutoRoutePayout,
      minWithdrawalAmount: cfg.minWithdrawalAmount,
    };
  }

  async getMerchantSettings() {
    const cfg = await this.prisma.platformConfig.upsert({
      where: { id: 'singleton' },
      update: {},
      create: { id: 'singleton' },
    });
    return this.shapeMerchantSettings(cfg);
  }

  async setMerchantAutoRoute(enabled: boolean) {
    const cfg = await this.prisma.platformConfig.upsert({
      where: { id: 'singleton' },
      update: { merchantAutoRoutePayout: enabled },
      create: { id: 'singleton', merchantAutoRoutePayout: enabled },
    });
    return this.shapeMerchantSettings(cfg);
  }

  async setMinWithdrawal(amount: number) {
    const min = Math.max(0, Math.round(Number(amount) || 0));
    const cfg = await this.prisma.platformConfig.upsert({
      where: { id: 'singleton' },
      update: { minWithdrawalAmount: min },
      create: { id: 'singleton', minWithdrawalAmount: min },
    });
    return this.shapeMerchantSettings(cfg);
  }

  // ── Audit ─────────────────────────────────────────────────────────────────

  async log(
    adminId: string,
    action: string,
    targetType: AdminActionTarget,
    targetId?: string,
    metadata?: Record<string, unknown>,
    ipAddress?: string,
  ) {
    await this.prisma.adminAuditLog.create({
      data: { adminId, action, targetType, targetId, metadata, ipAddress },
    });
    this.logger.log(`[ADMIN] ${action} by ${adminId} → ${targetType}:${targetId ?? '*'}`);
  }

  // ── Dashboard stats ────────────────────────────────────────────────────────

  async getStats() {
    const [
      totalUsers,
      activeUsers,
      adminUsers,
      totalInvoices,
      successInvoices,
      failedInvoices,
      pendingInvoices,
      failedRows,
      pendingKyc,
      totalVolumeCm,
      recentInvoices,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { isActive: true } }),
      this.prisma.user.count({ where: { role: 'ADMIN' } }),
      this.prisma.paymentInvoice.count(),
      this.prisma.paymentInvoice.count({ where: { status: 'SUCCESS' } }),
      this.prisma.paymentInvoice.count({ where: { status: 'FAILED' } }),
      this.prisma.paymentInvoice.count({
        where: { status: { in: ['PENDING', 'PROCESSING'] } },
      }),
      // Failed invoices with enough info to tell system faults from customer
      // behaviour (stored category, or heuristic on the latest attempt reason).
      this.prisma.paymentInvoice.findMany({
        where: { status: 'FAILED' },
        select: {
          failureCategory: true,
          attempts: { orderBy: { createdAt: 'desc' }, take: 1, select: { failureReason: true } },
        },
      }),
      this.prisma.kyc.count({ where: { status: 'PENDING' } }),
      // Total volume in XAF (successful invoices)
      this.prisma.paymentInvoice.aggregate({
        where: { status: 'SUCCESS' },
        _sum: { amount: true },
      }),
      // Last 10 invoices
      this.prisma.paymentInvoice.findMany({
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: {
          currency: { select: { code: true, symbol: true } },
          createdBy: { select: { firstName: true, lastName: true } },
        },
      }),
    ]);

    // Failures we/our providers caused — the ones that reflect on reliability.
    const systemFailed = failedRows.filter(
      (r) =>
        (r.failureCategory ?? classifyFailure(r.attempts[0]?.failureReason)) === 'SYSTEM',
    ).length;

    return {
      users: { total: totalUsers, active: activeUsers, admins: adminUsers },
      invoices: {
        total: totalInvoices,
        success: successInvoices,
        failed: failedInvoices,
        pending: pendingInvoices,
        systemFailed,
        successRate:
          totalInvoices > 0 ? Math.round((successInvoices / totalInvoices) * 100) : 0,
        // True reliability: successes vs only the failures we caused.
        systemSuccessRate:
          successInvoices + systemFailed > 0
            ? Math.round((successInvoices / (successInvoices + systemFailed)) * 100)
            : 0,
      },
      kyc: { pending: pendingKyc },
      volume: {
        total: Number(totalVolumeCm._sum.amount ?? 0),
      },
      recentInvoices: recentInvoices.map((inv) => ({
        id: inv.id,
        reference: inv.reference,
        amount: Number(inv.amount),
        currency: inv.currency.code,
        status: inv.status,
        flow: inv.flow,
        paymentMethod: inv.paymentMethod,
        payoutMethod: inv.payoutMethod,
        country: inv.country,
        createdBy: inv.createdBy
          ? `${inv.createdBy.firstName} ${inv.createdBy.lastName}`.trim()
          : 'Guest',
        createdAt: inv.createdAt,
      })),
    };
  }

  // ── Users ─────────────────────────────────────────────────────────────────

  async listUsers(params: {
    page: number;
    limit: number;
    search?: string;
    role?: string;
    isActive?: boolean;
    kycStatus?: string;
  }) {
    const { page, limit, search, role, isActive, kycStatus } = params;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};
    if (role) where.role = role;
    if (isActive !== undefined) where.isActive = isActive;
    if (kycStatus) where.kycStatus = kycStatus;
    if (search) {
      where.OR = [
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
        { contacts: { some: { value: { contains: search, mode: 'insensitive' } } } },
      ];
    }

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          profilePicture: true,
          isActive: true,
          role: true,
          kycStatus: true,
          createdAt: true,
          contacts: { select: { type: true, value: true, isVerified: true, isPrimary: true } },
          paymentIdentity: { select: { handle: true } },
          _count: { select: { createdInvoices: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      data: users.map((u) => ({
        ...u,
        displayName: `${u.firstName} ${u.lastName}`.trim(),
        handle: u.paymentIdentity?.handle ?? null,
        invoiceCount: u._count.createdInvoices,
      })),
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    };
  }

  async getUserDetail(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        contacts: true,
        kyc: true,
        paymentIdentity: true,
        wallets: { include: { currency: true } },
        _count: { select: { createdInvoices: true, recipientInvoices: true } },
      },
    });
    if (!user) throw new NotFoundException('User not found');
    const { password, refreshToken, ...safe } = user;
    return safe;
  }

  async setUserRole(adminId: string, userId: string, role: 'USER' | 'ADMIN', ip?: string) {
    const target = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (!target) throw new NotFoundException('User not found');

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { role },
      select: { id: true, firstName: true, lastName: true, role: true },
    });

    await this.log(adminId, 'ROLE_CHANGED', 'USER', userId, { from: target.role, to: role }, ip);
    return updated;
  }

  async setUserStatus(adminId: string, userId: string, isActive: boolean, ip?: string) {
    if (userId === adminId) throw new BadRequestException('Cannot change your own status');
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { isActive },
      select: { id: true, firstName: true, lastName: true, isActive: true },
    });
    await this.log(adminId, isActive ? 'USER_ACTIVATED' : 'USER_BANNED', 'USER', userId, {}, ip);
    // Invalidate the JWT auth cache so a ban/unban takes effect on the user's
    // very next request instead of waiting up to the cache TTL.
    await this.userStatusCache.invalidate(userId);
    return updated;
  }

  // ── Invoices ──────────────────────────────────────────────────────────────

  /**
   * Failed + stalled payments with full diagnostic detail for debugging.
   * FAILED  = invoice.status FAILED.
   * STALLED = invoice.status PROCESSING and untouched for >5 min (stuck in flight).
   * Each row carries every pay-in attempt with its failureReason + raw
   * providerResponse (the "why") and exact timestamps.
   */
  async getPaymentIssues(params: {
    page: number;
    limit: number;
    type?: string;
    search?: string;
  }) {
    const { page, limit, search } = params;
    const type = (params.type || 'ALL').toUpperCase();
    const skip = (page - 1) * limit;
    const stalledCutoff = new Date(Date.now() - 5 * 60_000);

    // `type` doubles as a failure-category filter so admins can zero in on the
    // debugging queue (SYSTEM) vs customer drop-offs (ABANDONED/DECLINED).
    const CATEGORY_FILTERS = ['SYSTEM', 'DECLINED', 'ABANDONED'];
    const statusOr: Record<string, unknown>[] = [];
    if (CATEGORY_FILTERS.includes(type)) {
      statusOr.push({ status: 'FAILED', failureCategory: type });
    } else {
      if (type === 'FAILED' || type === 'ALL') statusOr.push({ status: 'FAILED' });
      if (type === 'STALLED' || type === 'ALL') {
        statusOr.push({ status: 'PROCESSING', updatedAt: { lt: stalledCutoff } });
      }
    }

    const where: Record<string, unknown> = { OR: statusOr };
    if (search) {
      where.AND = [
        {
          OR: [
            { reference: { contains: search, mode: 'insensitive' } },
            { description: { contains: search, mode: 'insensitive' } },
            { payerEmail: { contains: search, mode: 'insensitive' } },
          ],
        },
      ];
    }

    const [invoices, total] = await Promise.all([
      this.prisma.paymentInvoice.findMany({
        where,
        skip,
        take: limit,
        orderBy: { updatedAt: 'desc' },
        include: {
          currency: { select: { code: true, symbol: true } },
          createdBy: { select: { firstName: true, lastName: true } },
          merchantPaymentLink: {
            select: { kind: true, title: true, merchantProfile: { select: { businessName: true } } },
          },
          attempts: {
            orderBy: { createdAt: 'desc' },
            include: { currency: { select: { code: true } } },
          },
          payout: {
            select: {
              status: true,
              amount: true,
              currency: true,
              attempts: {
                orderBy: { createdAt: 'desc' },
                select: { status: true, provider: true, externalRef: true, createdAt: true },
              },
            },
          },
        },
      }),
      this.prisma.paymentInvoice.count({ where }),
    ]);

    return {
      data: invoices.map((inv) => {
        const isFailed = inv.status === 'FAILED';
        const latest = inv.attempts[0] ?? null;
        const reason = isFailed
          ? latest?.failureReason || 'Failed — no reason recorded by the provider'
          : inv.attempts.length === 0
            ? 'Stalled — payer never started the payment'
            : 'Stalled — pay-in attempted but never confirmed (lost webhook/poll)';
        // Classify who caused it so bug-fixers can separate our faults from
        // customer drop-offs.
        const insight = explainOutcome({
          status: inv.status,
          failureCategory: inv.failureCategory,
          latestFailureReason: latest?.failureReason,
          expired: new Date() > inv.expiresAt,
          hasAttempt: inv.attempts.length > 0,
        });
        return {
          id: inv.id,
          reference: inv.reference,
          type: isFailed ? 'FAILED' : 'STALLED',
          status: inv.status,
          category: insight.category,
          categoryLabel: insight.label,
          blame: insight.blame,
          explanation: insight.detail,
          headline: insight.headline,
          flow: inv.flow,
          kind: inv.merchantPaymentLink?.kind ?? null,
          title: inv.merchantPaymentLink?.title ?? inv.description ?? null,
          businessName: inv.merchantPaymentLink?.merchantProfile?.businessName ?? null,
          amount: Number(inv.amount),
          currency: inv.currency.code,
          payerName:
            inv.payerName ||
            (inv.createdBy ? `${inv.createdBy.firstName ?? ''} ${inv.createdBy.lastName ?? ''}`.trim() : null) ||
            null,
          payerEmail: inv.payerEmail ?? null,
          method: inv.paymentMethod,
          payoutMethod: inv.payoutMethod,
          country: inv.country,
          reason,
          createdAt: inv.createdAt,
          updatedAt: inv.updatedAt,
          expiresAt: inv.expiresAt,
          attempts: inv.attempts.map((a) => ({
            id: a.id,
            status: a.status,
            provider: a.provider,
            method: a.method,
            externalRef: a.externalRef,
            amount: Number(a.amount),
            currency: a.currency.code,
            failureReason: a.failureReason,
            providerResponse: a.providerResponse,
            metadata: a.metadata,
            createdAt: a.createdAt,
            updatedAt: a.updatedAt,
          })),
          payout: inv.payout
            ? {
                status: inv.payout.status,
                amount: Number(inv.payout.amount),
                currency: inv.payout.currency,
                attempts: inv.payout.attempts,
              }
            : null,
        };
      }),
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    };
  }

  async listInvoices(params: {
    page: number;
    limit: number;
    status?: string;
    flow?: string;
    country?: string;
    category?: string;
    search?: string;
  }) {
    const { page, limit, status, flow, country, category, search } = params;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (flow) where.flow = flow;
    if (country) where.country = country;
    // Filter to a specific failure category (the debugging queue).
    if (category && ['SYSTEM', 'DECLINED', 'ABANDONED'].includes(category.toUpperCase())) {
      where.status = 'FAILED';
      where.failureCategory = category.toUpperCase();
    }
    if (search) {
      where.OR = [
        { reference: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { recipientPhone: { contains: search } },
      ];
    }

    const [invoices, total] = await Promise.all([
      this.prisma.paymentInvoice.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          currency: { select: { code: true, symbol: true } },
          createdBy: { select: { id: true, firstName: true, lastName: true } },
          recipient: { select: { id: true, firstName: true, lastName: true } },
          payout: { select: { status: true, amount: true, currency: true } },
          attempts: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      }),
      this.prisma.paymentInvoice.count({ where }),
    ]);

    return {
      data: invoices.map((inv) => {
        const insight = explainOutcome({
          status: inv.status,
          failureCategory: inv.failureCategory,
          latestFailureReason: inv.attempts[0]?.failureReason,
          expired: new Date() > inv.expiresAt,
          hasAttempt: inv.attempts.length > 0,
        });
        return {
          id: inv.id,
          reference: inv.reference,
          amount: Number(inv.amount),
          currency: inv.currency,
          description: inv.description,
          status: inv.status,
          flow: inv.flow,
          paymentMethod: inv.paymentMethod,
          payoutMethod: inv.payoutMethod,
          country: inv.country,
          recipientPhone: inv.recipientPhone,
          recipientName: inv.recipientName,
          createdBy: inv.createdBy,
          recipient: inv.recipient,
          payout: inv.payout,
          latestAttempt: inv.attempts[0] ?? null,
          // Outcome classification (system vs customer) for at-a-glance triage.
          outcome: { category: insight.category, label: insight.label, blame: insight.blame },
          expiresAt: inv.expiresAt,
          createdAt: inv.createdAt,
          updatedAt: inv.updatedAt,
        };
      }),
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    };
  }

  async getInvoiceDetail(invoiceId: string) {
    const inv = await this.prisma.paymentInvoice.findUnique({
      where: { id: invoiceId },
      include: {
        currency: true,
        quote: { include: { baseCurrency: true, targetCurrency: true } },
        createdBy: { select: { id: true, firstName: true, lastName: true } },
        recipient: { select: { id: true, firstName: true, lastName: true } },
        attempts: { orderBy: { createdAt: 'desc' }, include: { currency: true } },
        payout: { include: { attempts: { orderBy: { createdAt: 'desc' } } } },
        paymentLink: true,
      },
    });
    if (!inv) throw new NotFoundException('Invoice not found');

    const transaction = await this.prisma.transaction.findUnique({
      where: { reference: inv.reference },
      include: {
        currency: { select: { code: true, symbol: true, name: true } },
        quote: { include: { baseCurrency: true, targetCurrency: true } },
        refunds: true,
        user: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    const invoiceRefundLogs = await this.prisma.adminAuditLog.findMany({
      where: { action: 'ADMIN_REFUND', targetType: 'INVOICE', targetId: inv.reference },
    });

    return this.serializeInvoiceDetail(inv, transaction, invoiceRefundLogs);
  }

  private serializeInvoiceDetail(inv: any, transaction: any, invoiceRefundLogs: any[] = []) {
    const latestAttempt = inv.attempts?.[0] ?? null;
    const latestPayoutAttempt = inv.payout?.attempts?.[0] ?? null;
    const quote = inv.quote ?? transaction?.quote ?? null;
    const baseCurrency = quote?.baseCurrency ?? latestAttempt?.currency ?? transaction?.currency ?? null;
    const targetCurrency = quote?.targetCurrency ?? inv.currency ?? null;
    const paidAmount = this.numberValue(quote?.baseAmount ?? latestAttempt?.amount ?? transaction?.baseAmount ?? inv.amount) ?? 0;
    const receivedAmount = this.numberValue(quote?.targetAmount ?? inv.payout?.amount ?? inv.amount) ?? 0;
    const fee = this.numberValue(quote?.fee ?? latestAttempt?.fee ?? transaction?.fee ?? 0) ?? 0;
    const netAmount = this.numberValue(latestAttempt?.netAmount ?? transaction?.netAmount ?? (paidAmount - fee)) ?? 0;
    const successfulRefunds = transaction?.refunds?.filter((refund: any) => refund.status === TransactionStatus.SUCCESS) ?? [];
    const refundedAmount = successfulRefunds.reduce((sum: number, refund: any) => sum + (this.numberValue(refund.amount) ?? 0), 0);
    const paymentInstrument = this.paymentInstrumentFromAttempt(latestAttempt);
    const refundCandidate = this.serializeRefundableInvoice(inv, transaction, invoiceRefundLogs);

    // Plain-English "what happened and whose fault" — separates our/provider
    // faults (needs engineering) from customer drop-offs.
    const insight = explainOutcome({
      status: inv.status,
      failureCategory: inv.failureCategory,
      latestFailureReason: latestAttempt?.failureReason,
      expired: inv.expiresAt ? new Date() > new Date(inv.expiresAt) : false,
      hasAttempt: (inv.attempts?.length ?? 0) > 0,
    });

    return {
      id: inv.id,
      reference: inv.reference,
      description: inv.description,
      status: inv.status,
      failureInsight: {
        category: insight.category,
        label: insight.label,
        blame: insight.blame,
        headline: insight.headline,
        detail: insight.detail,
      },
      country: inv.country,
      flow: inv.flow,
      paymentMethod: inv.paymentMethod,
      payoutMethod: inv.payoutMethod,
      payoutProviderCode: inv.payoutProviderCode,
      recipientPhone: inv.recipientPhone,
      recipientName: inv.recipientName,
      expiresAt: inv.expiresAt,
      createdAt: inv.createdAt,
      updatedAt: inv.updatedAt,
      currency: {
        code: inv.currency?.code,
        symbol: inv.currency?.symbol ?? null,
        name: inv.currency?.name ?? null,
      },
      payer: inv.createdBy
        ? { type: 'USER', ...inv.createdBy }
        : { type: 'GUEST', id: null, firstName: 'Guest', lastName: 'payer' },
      recipient: inv.recipient
        ? { type: 'USER', ...inv.recipient, phone: inv.recipientPhone }
        : {
            type: inv.recipientPhone || inv.recipientName ? 'GUEST' : 'UNKNOWN',
            id: null,
            firstName: inv.recipientName || 'External',
            lastName: inv.recipientPhone ? 'recipient' : '',
            phone: inv.recipientPhone,
          },
      financial: {
        paidAmount,
        paidCurrency: baseCurrency
          ? { code: baseCurrency.code, symbol: baseCurrency.symbol ?? null, name: baseCurrency.name ?? null }
          : null,
        receivedAmount,
        receivedCurrency: targetCurrency
          ? { code: targetCurrency.code, symbol: targetCurrency.symbol ?? null, name: targetCurrency.name ?? null }
          : null,
        fee,
        feeCurrency: baseCurrency
          ? { code: baseCurrency.code, symbol: baseCurrency.symbol ?? null, name: baseCurrency.name ?? null }
          : null,
        netAmount,
        exchangeRate: this.numberValue(quote?.exchangeRate ?? transaction?.exchangeRate ?? null, null),
        rateSource: quote?.rateSource ?? transaction?.rateSource ?? null,
      },
      payment: latestAttempt
        ? {
            id: latestAttempt.id,
            status: latestAttempt.status,
            method: latestAttempt.method,
            flow: latestAttempt.flow,
            provider: latestAttempt.provider,
            externalRef: latestAttempt.externalRef,
            amount: this.numberValue(latestAttempt.amount),
            currency: {
              code: latestAttempt.currency?.code,
              symbol: latestAttempt.currency?.symbol ?? null,
              name: latestAttempt.currency?.name ?? null,
            },
            fee: this.numberValue(latestAttempt.fee ?? null, null),
            netAmount: this.numberValue(latestAttempt.netAmount ?? null, null),
            failureReason: latestAttempt.failureReason,
            instrument: paymentInstrument,
            createdAt: latestAttempt.createdAt,
            updatedAt: latestAttempt.updatedAt,
          }
        : null,
      payout: inv.payout
        ? {
            id: inv.payout.id,
            status: inv.payout.status,
            amount: this.numberValue(inv.payout.amount),
            // Withdrawal fee withheld from a merchant auto-payout (0 otherwise).
            fee: this.numberValue(inv.payout.fee ?? 0) ?? 0,
            isMerchant: !!inv.merchantProfileId,
            currency: inv.payout.currency,
            method: inv.payout.method,
            provider: latestPayoutAttempt?.provider ?? inv.payoutMethod,
            providerCode: inv.payoutProviderCode,
            phone: inv.recipientPhone,
            country: inv.country,
            externalRef: latestPayoutAttempt?.externalRef ?? null,
            createdAt: inv.payout.createdAt,
            updatedAt: inv.payout.updatedAt,
            attempts: inv.payout.attempts.map((attempt: any) => ({
              id: attempt.id,
              status: attempt.status,
              provider: attempt.provider,
              externalRef: attempt.externalRef,
              createdAt: attempt.createdAt,
            })),
          }
        : null,
      attempts: inv.attempts.map((attempt: any) => ({
        id: attempt.id,
        status: attempt.status,
        method: attempt.method,
        flow: attempt.flow,
        provider: attempt.provider,
        externalRef: attempt.externalRef,
        amount: this.numberValue(attempt.amount),
        currency: {
          code: attempt.currency?.code,
          symbol: attempt.currency?.symbol ?? null,
          name: attempt.currency?.name ?? null,
        },
        fee: this.numberValue(attempt.fee ?? null, null),
        netAmount: this.numberValue(attempt.netAmount ?? null, null),
        failureReason: attempt.failureReason,
        // Raw provider payload + attempt metadata for deep debugging.
        providerResponse: attempt.providerResponse ?? null,
        metadata: attempt.metadata ?? null,
        instrument: this.paymentInstrumentFromAttempt(attempt),
        createdAt: attempt.createdAt,
        updatedAt: attempt.updatedAt,
      })),
      ledgerTransaction: transaction
        ? {
            id: transaction.id,
            reference: transaction.reference,
            status: transaction.status,
            amount: this.numberValue(transaction.amount),
            fee: this.numberValue(transaction.fee ?? null, null),
            netAmount: this.numberValue(transaction.netAmount ?? null, null),
            refundedAmount,
            refundStatus: this.metadataObject(transaction.metadata).refundStatus ?? null,
            user: transaction.user,
            createdAt: transaction.createdAt,
            updatedAt: transaction.updatedAt,
          }
        : null,
      paymentLink: inv.paymentLink
        ? {
            id: inv.paymentLink.id,
            url: inv.paymentLink.url,
            isActive: inv.paymentLink.isActive,
            expiresAt: inv.paymentLink.expiresAt,
          }
        : null,
      refund: {
        isRefundable: refundCandidate.isRefundable,
        eligibilityStatus: refundCandidate.eligibilityStatus,
        maxRefundable: refundCandidate.maxRefundable,
        refundedAmount: refundCandidate.refundedAmount,
        remainingRefundable: refundCandidate.remainingRefundable,
        refundStatus: refundCandidate.refundStatus,
        currency: refundCandidate.currency,
        suggestedPhone:
          refundCandidate.payment?.instrument?.phone
          ?? refundCandidate.payment?.instrument?.account
          ?? null,
        suggestedCountry:
          refundCandidate.payment?.instrument?.country
          ?? refundCandidate.payout?.country
          ?? inv.country
          ?? null,
        suggestedProviderCode:
          refundCandidate.payment?.instrument?.providerCode
          ?? refundCandidate.payout?.providerCode
          ?? null,
      },
    };
  }

  private numberValue(value: unknown, fallback: number | null = 0) {
    if (value === null || value === undefined) return fallback;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  private paymentInstrumentFromAttempt(attempt: any) {
    if (!attempt) return null;
    const metadata = this.metadataObject(attempt.metadata);
    const response = this.metadataObject(attempt.providerResponse);
    const data = this.metadataObject(response.data as Prisma.JsonValue);
    const paymentRequest = this.metadataObject(response.paymentRequest as Prisma.JsonValue);
    const customer = this.metadataObject(response.customer as Prisma.JsonValue);

    return {
      phone: this.firstString(
        metadata.payerPhone,
        metadata.phone,
        response.phone,
        response.formattedPhone,
        response.PhoneNumber,
        response.phoneNumber,
        data.phone,
        data.formattedPhone,
        data.PhoneNumber,
        data.phoneNumber,
        paymentRequest.phone,
        paymentRequest.PhoneNumber,
        paymentRequest.phoneNumber,
        customer.phone,
      ),
      account: this.firstString(
        metadata.account,
        metadata.accountNumber,
        response.account,
        response.accountNumber,
        response.paymentRequest,
        data.account,
        data.accountNumber,
        paymentRequest.request,
        paymentRequest.paymentRequest,
      ),
      country: this.firstString(metadata.payerCountry, metadata.country, response.country, data.country),
      providerCode: this.firstString(metadata.providerCode, response.providerCode, data.providerCode),
      reference: this.firstString(attempt.externalRef, response.transactionId, response.reference, data.transactionId, data.reference),
    };
  }

  private firstString(...values: unknown[]) {
    const found = values.find((value) => typeof value === 'string' && value.trim().length > 0);
    return typeof found === 'string' ? found : null;
  }

  // ── KYC ──────────────────────────────────────────────────────────────────

  async listKyc(params: { page: number; limit: number; status?: string }) {
    const { page, limit, status } = params;
    const skip = (page - 1) * limit;
    const where = status ? { status: status as any } : {};

    const [items, total] = await Promise.all([
      this.prisma.kyc.findMany({
        where,
        skip,
        take: limit,
        orderBy: { submittedAt: 'desc' },
        include: { user: { select: { firstName: true, lastName: true, contacts: true } } },
      }),
      this.prisma.kyc.count({ where }),
    ]);

    return {
      data: items,
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    };
  }

  async reviewKyc(
    adminId: string,
    kycId: string,
    decision: 'VERIFIED' | 'REJECTED',
    reason?: string,
    ip?: string,
  ) {
    const kyc = await this.prisma.kyc.findUnique({ where: { id: kycId } });
    if (!kyc) throw new NotFoundException('KYC record not found');
    if (kyc.status !== 'PENDING') throw new BadRequestException('KYC is not pending');

    const [updatedKyc] = await this.prisma.$transaction([
      this.prisma.kyc.update({
        where: { id: kycId },
        data: {
          status: decision,
          reviewedAt: new Date(),
          reviewedBy: adminId,
          rejectionReason: decision === 'REJECTED' ? reason : null,
        },
      }),
      this.prisma.user.update({
        where: { id: kyc.userId },
        data: { kycStatus: decision },
      }),
    ]);

    await this.log(
      adminId,
      decision === 'VERIFIED' ? 'KYC_APPROVED' : 'KYC_REJECTED',
      'KYC',
      kycId,
      { userId: kyc.userId, reason },
      ip,
    );

    return updatedKyc;
  }

  // ── Merchants ────────────────────────────────────────────────────────────

  async listMerchants(params: { page: number; limit: number; status?: string }) {
    const { page, limit, status } = params;
    const skip = (page - 1) * limit;
    const where = status ? { status: status as any } : {};

    const [items, total] = await Promise.all([
      this.prisma.merchantProfile.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { user: { select: { firstName: true, lastName: true, contacts: true } } },
      }),
      this.prisma.merchantProfile.count({ where }),
    ]);

    return {
      data: items,
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    };
  }

  async reviewMerchant(
    adminId: string,
    merchantId: string,
    decision: 'APPROVED' | 'REJECTED',
    reason?: string,
    ip?: string,
  ) {
    const profile = await this.prisma.merchantProfile.findUnique({ where: { id: merchantId } });
    if (!profile) throw new NotFoundException('Merchant application not found');
    if (profile.status !== 'PENDING') throw new BadRequestException('Application is not pending');

    const updated = await this.prisma.merchantProfile.update({
      where: { id: merchantId },
      data: {
        status: decision,
        reviewedAt: new Date(),
        reviewedById: adminId,
        rejectionReason: decision === 'REJECTED' ? reason : null,
      },
    });

    await this.log(
      adminId,
      decision === 'APPROVED' ? 'MERCHANT_APPROVED' : 'MERCHANT_REJECTED',
      'MERCHANT',
      merchantId,
      { userId: profile.userId, reason },
      ip,
    );

    return updated;
  }

  /** Suspend (ban) or reactivate an already-reviewed merchant. */
  async setMerchantStatus(
    adminId: string,
    merchantId: string,
    action: 'SUSPEND' | 'REACTIVATE',
    reason?: string,
    ip?: string,
  ) {
    const profile = await this.prisma.merchantProfile.findUnique({ where: { id: merchantId } });
    if (!profile) throw new NotFoundException('Merchant not found');

    if (action === 'SUSPEND' && profile.status !== 'APPROVED') {
      throw new BadRequestException('Only approved merchants can be suspended');
    }
    if (action === 'REACTIVATE' && profile.status !== 'SUSPENDED') {
      throw new BadRequestException('Only suspended merchants can be reactivated');
    }

    const updated = await this.prisma.merchantProfile.update({
      where: { id: merchantId },
      data: {
        status: action === 'SUSPEND' ? 'SUSPENDED' : 'APPROVED',
        rejectionReason: action === 'SUSPEND' ? reason ?? null : null,
        reviewedById: adminId,
        reviewedAt: new Date(),
      },
    });

    await this.log(
      adminId,
      action === 'SUSPEND' ? 'MERCHANT_SUSPENDED' : 'MERCHANT_REACTIVATED',
      'MERCHANT',
      merchantId,
      { userId: profile.userId, reason },
      ip,
    );

    return updated;
  }

  /** Full admin view of one merchant: profile + storefront + activity stats. */
  async getMerchantDetail(merchantId: string) {
    const profile = await this.prisma.merchantProfile.findUnique({
      where: { id: merchantId },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, isActive: true, contacts: true } },
        paymentIdentity: {
          select: {
            handle: true,
            payoutSetting: { select: { phone: true, paymentMethod: true, isVerified: true } },
          },
        },
      },
    });
    if (!profile) throw new NotFoundException('Merchant not found');

    // Merchant-fee rules loaded once, matched in memory (same logic as the
    // payout executor: highest priority rule whose currency/method matches).
    const feeConfigs = await this.prisma.feeConfig.findMany({
      where: { isActive: true, flow: 'WITHDRAWAL' },
      orderBy: { priority: 'desc' },
    });
    const feePercentFor = (payerCurrency: string | null, method: string | null): number => {
      const m = (method || '').toUpperCase() || null;
      const cfg = feeConfigs.find(
        (c) =>
          (c.baseCurrencyCode === payerCurrency || c.baseCurrencyCode === null) &&
          (c.paymentMethod === m || c.paymentMethod === null),
      );
      return cfg ? Number(cfg.feePercent) : 0;
    };

    const [linkCount, eventCount, cashoutCount, wallets, statusGroups, successLite, recent] =
      await Promise.all([
        this.prisma.merchantPaymentLink.count({ where: { merchantProfileId: merchantId, kind: 'LINK' } }),
        this.prisma.merchantPaymentLink.count({ where: { merchantProfileId: merchantId, kind: 'EVENT' } }),
        this.prisma.merchantCashout.count({ where: { merchantProfileId: merchantId } }),
        this.prisma.wallet.findMany({
          where: { userId: profile.userId },
          select: { availableBalance: true, currency: { select: { code: true } } },
        }),
        this.prisma.paymentInvoice.groupBy({
          by: ['status'],
          where: { merchantProfileId: merchantId },
          _count: { _all: true },
        }),
        // Lightweight all-time SUCCESS set for accurate volume + earnings.
        this.prisma.paymentInvoice.findMany({
          where: { merchantProfileId: merchantId, status: 'SUCCESS' },
          select: {
            amount: true,
            paymentMethod: true,
            createdById: true,
            currency: { select: { code: true } },
            quote: { select: { fee: true, baseCurrency: { select: { code: true } } } },
          },
        }),
        // Recent transactions (full detail) for the list.
        this.prisma.paymentInvoice.findMany({
          where: { merchantProfileId: merchantId },
          orderBy: { createdAt: 'desc' },
          take: 100,
          include: {
            currency: { select: { code: true, symbol: true } },
            quote: { include: { baseCurrency: true, targetCurrency: true } },
            createdBy: { select: { firstName: true, lastName: true } },
            payout: { select: { status: true, amount: true, currency: true, fee: true } },
            attempts: { orderBy: { createdAt: 'desc' }, take: 1, select: { provider: true, status: true } },
            merchantPaymentLink: { select: { kind: true, title: true } },
          },
        }),
      ]);

    // ── All-time analysis. Payments settle in the payer's currency, so totals
    // are converted to an APPROXIMATE single XAF figure for display (the per-
    // currency reality lives in the wallet cards / transaction rows). ──
    const fxRates = await getXafRates();
    const settlementCurrency = 'XAF';
    const approx = successLite.some((i) => i.currency.code !== 'XAF');
    let volume = 0;
    let earnings = 0;          // platform's merchant-fee take
    let platformFees = 0;      // payer-side platform fee (quote.fee)
    const payers = new Set<string>();
    for (const inv of successLite) {
      const code = inv.currency.code;
      const s = Number(inv.amount);
      volume += toXaf(s, code, fxRates);
      const fee = (s * feePercentFor(inv.quote?.baseCurrency?.code ?? null, inv.paymentMethod)) / 100;
      earnings += toXaf(fee, code, fxRates);
      if (inv.quote?.fee != null) platformFees += toXaf(Number(inv.quote.fee), inv.quote.baseCurrency?.code ?? code, fxRates);
      if (inv.createdById) payers.add(inv.createdById);
    }
    volume = Math.round(volume);
    earnings = Math.round(earnings);
    platformFees = Math.round(platformFees);
    const counts = Object.fromEntries(statusGroups.map((g) => [g.status, g._count._all]));

    // ── Recent transactions with per-tx profit ──
    const transactions = recent.map((inv) => {
      const settlement = Number(inv.amount);
      const payerCurrency = inv.quote?.baseCurrency?.code ?? null;
      const feePercent = inv.status === 'SUCCESS' ? feePercentFor(payerCurrency, inv.paymentMethod) : 0;
      const merchantFee = Math.round((settlement * feePercent) / 100);
      const platformFee = inv.quote?.fee != null ? Number(inv.quote.fee) : 0;
      const payer =
        inv.payerName ||
        (inv.createdBy ? `${inv.createdBy.firstName ?? ''} ${inv.createdBy.lastName ?? ''}`.trim() : '') ||
        null;
      return {
        id: inv.id,
        reference: inv.reference,
        status: inv.status,
        kind: inv.merchantPaymentLink?.kind ?? null,
        title: inv.merchantPaymentLink?.title ?? inv.description ?? null,
        createdAt: inv.createdAt,
        payerName: payer,
        payerEmail: inv.payerEmail ?? null,
        method: inv.paymentMethod,
        provider: inv.attempts[0]?.provider ?? null,
        payinStatus: inv.attempts[0]?.status ?? null,
        payoutStatus: inv.payout?.status ?? null,
        // what the merchant receives (gross settlement) + currency
        settlementAmount: settlement,
        settlementCurrency: inv.currency.code,
        // what the payer actually paid + currency
        payerAmount: inv.quote ? Number(inv.quote.baseAmount) : null,
        payerCurrency,
        // profit breakdown
        merchantFeePercent: feePercent,
        merchantFee,
        netToMerchant: settlement - merchantFee,
        platformFee,
        platformFeeCurrency: payerCurrency,
      };
    });

    return {
      profile,
      balance: wallets
        .map((w) => ({ availableBalance: Number(w.availableBalance), currency: w.currency.code }))
        .filter((w) => w.availableBalance > 0),
      analysis: {
        settlementCurrency,
        approx,              // true when totals are XAF-converted from other currencies
        volume,
        earnings,            // platform earnings from merchant fees (settlement currency)
        platformFees,        // payer-side platform fees collected (payer currency, may be mixed)
        paymentsCount: counts['SUCCESS'] ?? 0,
        successCount: counts['SUCCESS'] ?? 0,
        failedCount: counts['FAILED'] ?? 0,
        pendingCount: (counts['PENDING'] ?? 0) + (counts['PROCESSING'] ?? 0),
        totalCount: statusGroups.reduce((s, g) => s + g._count._all, 0),
        uniquePayers: payers.size,
        links: linkCount,
        events: eventCount,
        cashouts: cashoutCount,
      },
      transactions,
    };
  }

  // ── Audit log ─────────────────────────────────────────────────────────────

  async getAuditLog(params: { page: number; limit: number; adminId?: string; action?: string }) {
    const { page, limit, adminId, action } = params;
    const skip = (page - 1) * limit;
    const where: Record<string, unknown> = {};
    if (adminId) where.adminId = adminId;
    if (action) where.action = { contains: action, mode: 'insensitive' };

    const [logs, total] = await Promise.all([
      this.prisma.adminAuditLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.adminAuditLog.count({ where }),
    ]);

    return { data: logs, meta: { total, page, limit, pages: Math.ceil(total / limit) } };
  }

  // ── Analytics ─────────────────────────────────────────────────────────────

  async getAnalytics(period: '7d' | '30d' | '90d' = '30d') {
    const days = period === '7d' ? 7 : period === '30d' ? 30 : 90;
    const since = new Date();
    since.setDate(since.getDate() - days);

    const [invoices, newUsers, totalUsers] = await Promise.all([
      this.prisma.paymentInvoice.findMany({
        where: { createdAt: { gte: since } },
        select: {
          status: true,
          flow: true,
          paymentMethod: true,
          payoutMethod: true,
          country: true,
          amount: true,
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
      }),
      this.prisma.user.findMany({
        where: { createdAt: { gte: since } },
        select: { createdAt: true },
      }),
      this.prisma.user.count(),
    ]);

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
    const userMap = new Map<string, number>(dates.map((d) => [d, 0]));

    let totalVolume = 0, totalFees = 0, successCount = 0, failedCount = 0;
    const methodMap = new Map<string, { count: number; volume: number }>();
    const countryMap = new Map<string, { count: number; volume: number }>();
    const corridorMap = new Map<string, { count: number; volume: number }>();
    // Outcome buckets — separate customer behaviour from real system reliability.
    const outcomes = { success: 0, abandoned: 0, declined: 0, system: 0, inprogress: 0 };
    const now = new Date();

    // Volumes are converted to an approximate XAF figure since payments settle
    // in many currencies (display-only single total).
    const fxRates = await getXafRates();

    for (const inv of invoices) {
      const day = inv.createdAt.toISOString().slice(0, 10);
      const row = txMap.get(day) ?? { success: 0, failed: 0, total: 0, volume: 0, fees: 0 };
      const ccy = inv.quote?.baseCurrency?.code ?? 'XAF';
      const amount = toXaf(Number(inv.quote?.baseAmount ?? inv.amount), ccy, fxRates);
      const fee = toXaf(Number(inv.quote?.fee ?? 0), ccy, fxRates);

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

    for (const u of newUsers) {
      const day = u.createdAt.toISOString().slice(0, 10);
      userMap.set(day, (userMap.get(day) ?? 0) + 1);
    }

    return {
      period,
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
        newUsers: newUsers.length,
        totalUsers,
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
      userChart: dates.map((date) => ({ date, count: userMap.get(date) ?? 0 })),
      byPaymentMethod: Array.from(methodMap.entries())
        .map(([method, data]) => ({ method, ...data }))
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

  // ── Admin-audited Pricing CRUD ────────────────────────────────────────────

  async listAdminPricing() {
    return this.prisma.feeConfig.findMany({ orderBy: { priority: 'desc' } });
  }

  async createPricing(adminId: string, dto: FeeConfigInput, ip?: string) {
    const config = await this.prisma.feeConfig.create({
      data: {
        baseCurrencyCode: dto.baseCurrencyCode ?? null,
        targetCurrencyCode: dto.targetCurrencyCode ?? null,
        paymentMethod: dto.paymentMethod ?? null,
        payoutMethod: dto.payoutMethod ?? null,
        flow: dto.flow ?? null,
        feePercent: dto.feePercent ?? 0,
        spreadPercent: dto.spreadPercent ?? 0,
        priority: dto.priority ?? 0,
        isActive: dto.isActive ?? true,
      },
    });
    await this.log(adminId, 'PRICING_CREATED', 'PRICING', config.id, { dto }, ip);
    return config;
  }

  async updatePricing(adminId: string, id: string, dto: FeeConfigInput, ip?: string) {
    const existing = await this.prisma.feeConfig.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Pricing rule not found');
    const updated = await this.prisma.feeConfig.update({ where: { id }, data: dto });
    await this.log(adminId, 'PRICING_UPDATED', 'PRICING', id, { changes: dto }, ip);
    return updated;
  }

  async deletePricing(adminId: string, id: string, ip?: string) {
    const existing = await this.prisma.feeConfig.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Pricing rule not found');
    await this.prisma.feeConfig.delete({ where: { id } });
    await this.log(adminId, 'PRICING_DELETED', 'PRICING', id, {}, ip);
    return { message: 'Deleted' };
  }

  async togglePricing(adminId: string, id: string, ip?: string) {
    const existing = await this.prisma.feeConfig.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Pricing rule not found');
    const updated = await this.prisma.feeConfig.update({
      where: { id },
      data: { isActive: !existing.isActive },
    });
    await this.log(adminId, 'PRICING_TOGGLED', 'PRICING', id, { isActive: updated.isActive }, ip);
    return updated;
  }

  // ── Aggregator Management ─────────────────────────────────────────────────

  async listAggregators() {
    const aggregators = await this.prisma.paymentAggregator.findMany({
      orderBy: { priority: 'asc' },
    });
    // Attach provider/country counts per aggregator
    const counts = await Promise.all(
      aggregators.map(async (a) => {
        const providers = await this.prisma.paymentProvider.count({ where: { aggregatorId: a.id, isActive: true } });
        const countries = await this.prisma.paymentProvider.findMany({
          where: { aggregatorId: a.id, isActive: true },
          distinct: ['countryId'],
          select: { country: { select: { iso2: true, name: true } } },
        });
        return {
          ...a,
          activeProviders: providers,
          countries: countries.map((c) => c.country),
        };
      }),
    );
    return counts;
  }

  async toggleAggregator(adminId: string, code: string, ip?: string) {
    const agg = await this.prisma.paymentAggregator.findUnique({ where: { code } });
    if (!agg) throw new NotFoundException(`Aggregator not found: ${code}`);
    const updated = await this.prisma.paymentAggregator.update({
      where: { code },
      data: { isActive: !agg.isActive },
    });
    await this.log(adminId, agg.isActive ? 'AGGREGATOR_DISABLED' : 'AGGREGATOR_ENABLED', 'SYSTEM', code, { name: agg.name }, ip);
    return updated;
  }

  async setAggregatorPriority(adminId: string, code: string, priority: number, ip?: string) {
    if (priority < 1) throw new BadRequestException('Priority must be ≥ 1');
    const agg = await this.prisma.paymentAggregator.findUnique({ where: { code } });
    if (!agg) throw new NotFoundException(`Aggregator not found: ${code}`);
    const updated = await this.prisma.paymentAggregator.update({
      where: { code },
      data: { priority },
    });
    await this.log(adminId, 'AGGREGATOR_PRIORITY_CHANGED', 'SYSTEM', code, { from: agg.priority, to: priority }, ip);
    return updated;
  }

  // ── Transaction Limits ────────────────────────────────────────────────────

  async listLimits() {
    return this.prisma.transactionLimit.findMany({
      include: { currency: { select: { code: true, name: true, symbol: true, isCrypto: true } } },
      orderBy: { currencyCode: 'asc' },
    });
  }

  async upsertLimit(
    adminId: string,
    currencyCode: string,
    minAmount: number,
    maxAmount: number,
    ip?: string,
  ) {
    if (minAmount <= 0) throw new BadRequestException('minAmount must be greater than 0');
    if (maxAmount <= minAmount) throw new BadRequestException('maxAmount must be greater than minAmount');

    const currency = await this.prisma.currency.findUnique({ where: { code: currencyCode.toUpperCase() } });
    if (!currency) throw new NotFoundException(`Currency not found: ${currencyCode}`);

    const limit = await this.prisma.transactionLimit.upsert({
      where: { currencyCode: currencyCode.toUpperCase() },
      create: { currencyCode: currencyCode.toUpperCase(), minAmount, maxAmount },
      update: { minAmount, maxAmount, isActive: true },
    });
    await this.log(adminId, 'LIMIT_UPDATED', 'SYSTEM', currencyCode, { minAmount, maxAmount }, ip);
    return limit;
  }

  async toggleLimit(adminId: string, currencyCode: string, ip?: string) {
    const limit = await this.prisma.transactionLimit.findUnique({ where: { currencyCode: currencyCode.toUpperCase() } });
    if (!limit) throw new NotFoundException(`No limit configured for: ${currencyCode}`);
    const updated = await this.prisma.transactionLimit.update({
      where: { currencyCode: currencyCode.toUpperCase() },
      data: { isActive: !limit.isActive },
    });
    await this.log(adminId, limit.isActive ? 'LIMIT_DISABLED' : 'LIMIT_ENABLED', 'SYSTEM', currencyCode, {}, ip);
    return updated;
  }

  // ── Country & Provider Management ────────────────────────────────────────

  async listCountriesWithProviders() {
    return this.prisma.country.findMany({
      include: {
        currency: { select: { code: true, symbol: true } },
        providers: {
          where: { aggregator: { code: 'netwalletpay' } },
          include: { method: { select: { code: true, name: true } } },
          orderBy: { providerCode: 'asc' },
        },
      },
      orderBy: { iso2: 'asc' },
    });
  }

  async toggleCountry(adminId: string, iso2: string, ip?: string) {
    const country = await this.prisma.country.findUnique({ where: { iso2 } });
    if (!country) throw new NotFoundException('Country not found');
    const updated = await this.prisma.country.update({
      where: { iso2 },
      data: { isActive: !country.isActive },
      include: { currency: { select: { code: true } } },
    });
    await this.log(adminId, country.isActive ? 'COUNTRY_DISABLED' : 'COUNTRY_ENABLED', 'SYSTEM', iso2, { name: country.name }, ip);
    return updated;
  }

  async toggleProvider(adminId: string, providerCode: string, ip?: string) {
    const provider = await this.prisma.paymentProvider.findUnique({
      where: { providerCode },
      include: { country: true, method: true },
    });
    if (!provider) throw new NotFoundException('Provider not found');
    const updated = await this.prisma.paymentProvider.update({
      where: { providerCode },
      data: { isActive: !provider.isActive },
      include: { country: true, method: true },
    });
    await this.log(adminId, provider.isActive ? 'PROVIDER_DISABLED' : 'PROVIDER_ENABLED', 'SYSTEM', providerCode, { name: provider.name, country: provider.country.iso2 }, ip);
    return updated;
  }

  /** Add (or re-activate) a single provider — used to pull a provider that
   *  exists upstream but is missing from our DB (e.g. netwallet_gh) straight
   *  from the live lookup, with no hardcoding. */
  async importProvider(
    adminId: string,
    dto: { country: string; method: string; providerCode: string; name: string; aggregator?: string },
    ip?: string,
  ) {
    const iso2 = dto.country.toUpperCase();
    if (!dto.providerCode?.trim() || !dto.name?.trim()) {
      throw new BadRequestException('providerCode and name are required');
    }
    const countryRec = await this.prisma.country.findUnique({ where: { iso2 } });
    if (!countryRec) throw new NotFoundException(`Country ${iso2} not found`);
    const methodRec = await this.prisma.paymentMethodRef.findUnique({ where: { code: dto.method } });
    if (!methodRec) throw new NotFoundException(`Method ${dto.method} not found`);
    const aggregatorCode = dto.aggregator ?? 'netwalletpay';
    const aggregator = await this.prisma.paymentAggregator.findUnique({ where: { code: aggregatorCode } });
    if (!aggregator) throw new NotFoundException(`Aggregator ${aggregatorCode} not found`);

    const provider = await this.prisma.paymentProvider.upsert({
      where: { providerCode: dto.providerCode },
      create: {
        providerCode: dto.providerCode,
        name: dto.name,
        aggregatorId: aggregator.id,
        countryId: countryRec.id,
        methodId: methodRec.id,
        requiresType: false,
        isActive: true,
      },
      update: { name: dto.name, isActive: true },
      include: { country: true, method: { select: { code: true, name: true } } },
    });

    // A provider is useless while its country is disabled — bring it online.
    if (!countryRec.isActive) {
      await this.prisma.country.update({ where: { iso2 }, data: { isActive: true } });
    }

    await this.log(adminId, 'PROVIDER_IMPORTED', 'SYSTEM', dto.providerCode, { name: dto.name, country: iso2, aggregator: aggregatorCode }, ip);
    return provider;
  }

  /** Remove a provider that no longer exists upstream (e.g. a stale code).
   *  Falls back to deactivation if saved payout settings still reference it. */
  async deleteProvider(adminId: string, providerCode: string, ip?: string) {
    const provider = await this.prisma.paymentProvider.findUnique({ where: { providerCode } });
    if (!provider) throw new NotFoundException('Provider not found');
    const refs = await this.prisma.userPaymentPhoneSettings.count({ where: { providerId: provider.id } });
    if (refs > 0) {
      await this.prisma.paymentProvider.update({ where: { providerCode }, data: { isActive: false } });
      await this.log(adminId, 'PROVIDER_DISABLED', 'SYSTEM', providerCode, { reason: 'referenced; deactivated instead of deleted' }, ip);
      return { deleted: false, deactivated: true };
    }
    await this.prisma.paymentProvider.delete({ where: { providerCode } });
    await this.log(adminId, 'PROVIDER_DELETED', 'SYSTEM', providerCode, { name: provider.name }, ip);
    return { deleted: true, deactivated: false };
  }

  /** Calls Netwalletpay live API to check what providers they have for a given country/method.
   *  Returns a diff: what Netwalletpay has vs what our DB has. */
  async testProvider(country: string, method: string, paymentType: 'COLLECTION' | 'PAYOUT') {
    const primaryKey = this.config.get<string>('NETWALLETPAY_PRIMARY_KEY', '');
    const email      = this.config.get<string>('NETWALLETPAY_EMAIL', '');
    const baseUrl    = (this.config.get<string>('NETWALLETPAY_BASE_URL', 'https://netwalletpay.com') || '').replace(/\/+$/, '');

    if (!primaryKey || !email) {
      throw new BadRequestException('Netwalletpay credentials not configured in environment');
    }

    // ── 1. Fetch access token ────────────────────────────────────────────────
    const form = new URLSearchParams();
    form.append('primary_key', primaryKey);
    form.append('email', email);
    form.append('grant_type', 'primary_key');

    const tokenRes = await fetch(`${baseUrl}/api/v1/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      throw new BadRequestException(`Netwalletpay auth failed (${tokenRes.status}): ${body}`);
    }
    const tokenData = (await tokenRes.json()) as { access_token: string };
    const token = tokenData.access_token;

    // ── 2. Call provider lookup ───────────────────────────────────────────────
    const endpoint = `/api/v1/lookup/get-providers/${paymentType}/${method}/${country}`;
    const lookupRes = await fetch(`${baseUrl}${endpoint}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });

    let netwalletpayProviders: Array<{ id: string; name: string; transactionCurrency?: string }> = [];
    let rawResponse: unknown = null;

    if (lookupRes.ok) {
      rawResponse = await lookupRes.json();
      netwalletpayProviders = (rawResponse as any)?.data ?? [];
    } else {
      rawResponse = { error: await lookupRes.text(), status: lookupRes.status };
    }

    // ── 3. Compare with our DB ────────────────────────────────────────────────
    const dbProviders = await this.prisma.paymentProvider.findMany({
      where: {
        country: { iso2: country },
        method: { code: method },
        aggregator: { code: 'netwalletpay' },
      },
      orderBy: { providerCode: 'asc' },
    });

    const nwCodes = new Set(netwalletpayProviders.map((p) => p.id));
    const dbCodes = new Set(dbProviders.map((p) => p.providerCode));

    return {
      country,
      method,
      paymentType,
      endpoint: `${baseUrl}${endpoint}`,
      netwalletpay: {
        count: netwalletpayProviders.length,
        providers: netwalletpayProviders,
        raw: rawResponse,
      },
      database: {
        count: dbProviders.length,
        providers: dbProviders.map((p) => ({
          providerCode: p.providerCode,
          name:         p.name,
          isActive:     p.isActive,
          requiresType: p.requiresType,
          inNetwalletpay: nwCodes.has(p.providerCode),
        })),
      },
      diff: {
        onlyInNetwalletpay: netwalletpayProviders.filter((p) => !dbCodes.has(p.id)).map((p) => p.id),
        onlyInDatabase:     dbProviders.filter((p) => !nwCodes.has(p.providerCode)).map((p) => p.providerCode),
      },
    };
  }

  // ── Live transaction test — delegates to the shared NetwalletpayProvider ──

  /**
   * Tests a COLLECTION (payin) or PAYOUT against a specific provider by
   * delegating to the same NetwalletpayProvider used in real payments.
   * This means it gets all the same retry logic, phone formatting,
   * MethodType handling, and fallback provider selection — no duplication.
   *
   * COLLECTION → triggers a payment prompt on the test phone.
   * PAYOUT     → attempts to transfer real funds. Use with care.
   */
  async testTransaction(params: {
    country: string;
    providerCode: string;
    paymentType: 'COLLECTION' | 'PAYOUT';
    phone: string;
    amount: number;
    adminId: string;
  }, ip?: string) {
    const { country, providerCode, paymentType, phone, amount, adminId } = params;
    const sep  = '─'.repeat(60);
    const sep2 = '═'.repeat(60);

    this.logger.log(sep2);
    this.logger.log(`🧪  ADMIN TRANSACTION TEST  —  ${paymentType}`);
    this.logger.log(sep2);
    this.logger.log(`  Admin ID   : ${adminId}`);
    this.logger.log(`  Country    : ${country}`);
    this.logger.log(`  Provider   : ${providerCode}`);
    this.logger.log(`  Phone/Acct : ${phone}`);
    this.logger.log(`  Amount     : ${amount}`);
    this.logger.log(`  IP         : ${ip ?? 'unknown'}`);
    this.logger.log(sep);

    // ── 1. Resolve provider from DB ───────────────────────────────────────────
    this.logger.log('📋  STEP 1 — Resolve provider from DB');
    const provider = await this.prisma.paymentProvider.findUnique({
      where: { providerCode },
      include: { country: { include: { currency: true } }, method: true },
    });
    if (!provider) {
      this.logger.error(`  ❌ Provider not found in DB: ${providerCode}`);
      throw new NotFoundException(`Provider not found: ${providerCode}`);
    }
    const currency   = provider.country.currency?.code ?? 'XAF';
    const methodCode = provider.method.code; // MOBILE_MONEY | BANK | CARD
    this.logger.log(`  ✔ Provider : ${provider.name} (${providerCode})`);
    this.logger.log(`  ✔ Country  : ${provider.country.name} (${provider.country.iso2})`);
    this.logger.log(`  ✔ Method   : ${methodCode}  Currency: ${currency}`);

    // ── 2. Derive raw method hint ─────────────────────────────────────────────
    // NetwalletpayProvider.getProviderFromDb uses this hint to pick the right
    // sub-network (e.g. 'ORANGE' → orange_cm, 'MOMO' → mtn_cm).
    this.logger.log(sep);
    this.logger.log('🔧  STEP 2 — Derive method hint for provider selection');
    const id = providerCode.toLowerCase();
    let methodHint: string;
    if (methodCode === 'BANK') {
      methodHint = 'BANK';
    } else if (id.includes('orange')) {
      methodHint = 'ORANGE';
    } else {
      methodHint = 'MOMO'; // MTN, Airtel, M-Pesa, Vodacom, Tigo, AzamPesa, HaloPesa …
    }
    this.logger.log(`  providerCode : ${providerCode}`);
    this.logger.log(`  methodHint   : ${methodHint}  (passed as metadata.method)`);
    this.logger.log(`  preferredCode: ${providerCode}  (forces exact provider selection)`);

    // ── 3. Build reference + DTO ─────────────────────────────────────────────
    this.logger.log(sep);
    this.logger.log('📦  STEP 3 — Build PayinDto / PayoutDto');
    // Use the same INV- prefix so normalizeOrderId strips it to a pure numeric
    // OrderID — matching exactly what real payments send to Netwalletpay.
    const reference = `INV-${Date.now()}`;
    const dto = {
      amount,
      currency,
      phone,
      reference,
      description: `Admin test - ${paymentType} via ${providerCode}`,
      metadata: {
        country,
        method:       methodHint,   // drives mapMethod + getProviderFromDb hint
        providerCode,               // preferred provider — bypasses priority selection
      },
    };
    this.logger.log(`  reference   : ${reference}`);
    this.logger.log(`  amount      : ${amount} ${currency}`);
    this.logger.log(`  phone       : ${phone}`);
    this.logger.log(`  metadata    : ${JSON.stringify(dto.metadata)}`);

    // ── 4. Delegate to the shared NetwalletpayProvider ────────────────────────
    // This uses the identical token, phone-formatting, hash, MethodType, and
    // retry logic as a real payment — no separate HTTP stack.
    this.logger.log(sep);
    this.logger.log(`🚀  STEP 4 — Calling NetwalletpayProvider.${paymentType === 'COLLECTION' ? 'payin' : 'payout'}()`);
    this.logger.log(`  (phone formatting, hash, MethodType, retries all handled internally)`);

    let result: { status: string; transactionId?: string; error?: string; provider?: string };
    if (paymentType === 'COLLECTION') {
      result = await this.netwalletpay.payin(dto);
    } else {
      if (paymentType === 'PAYOUT') this.logger.warn('  ⚠️  PAYOUT — real funds will be transferred');
      result = await this.netwalletpay.payout(dto);
    }

    // ── 5. Log result ─────────────────────────────────────────────────────────
    this.logger.log(sep);
    this.logger.log('📊  STEP 5 — Result');
    this.logger.log(`  status         : ${result.status}`);
    this.logger.log(`  transactionId  : ${result.transactionId ?? '(none)'}`);
    if (result.error) this.logger.log(`  error          : ${result.error}`);
    if (result.provider) this.logger.log(`  providerUsed   : ${result.provider}`);

    const ok = result.status === 'SUCCESS';
    if (ok) {
      this.logger.log(sep2);
      this.logger.log(`✅  TEST PASSED  —  ${paymentType}  |  ${providerCode}  |  ${amount} ${currency}`);
      this.logger.log(sep2);
    } else {
      this.logger.error(sep2);
      this.logger.error(`❌  TEST FAILED  —  ${paymentType}  |  ${providerCode}  |  ${result.error ?? 'unknown error'}`);
      this.logger.error(sep2);
    }

    // ── 6. Audit log ──────────────────────────────────────────────────────────
    await this.log(adminId, `PROVIDER_TX_TEST_${paymentType}`, 'SYSTEM', providerCode, {
      country, phone, amount, currency, ok,
      transactionId: result.transactionId ?? null,
      error: result.error ?? null,
    }, ip);

    return {
      ok,
      paymentType,
      country,
      providerCode,
      providerName:  provider.name,
      currency,
      amount,
      phone,
      orderId:       reference,
      transactionId: result.transactionId ?? null,
      message:       ok ? 'Transaction accepted' : (result.error ?? 'Transaction failed'),
      raw:           result,
    };
  }

  // -- Refunds & admin withdrawals -----------------------------------------

  async listPayoutRails() {
    const countries = await this.prisma.country.findMany({
      where: {
        isActive: true,
        providers: {
          some: {
            isActive: true,
            aggregator: { isActive: true, code: { in: ['netwalletpay', 'zikopay'] } },
            method: { isActive: true },
          },
        },
      },
      include: {
        currency: { select: { code: true, symbol: true, name: true } },
        providers: {
          where: {
            isActive: true,
            aggregator: { isActive: true, code: { in: ['netwalletpay', 'zikopay'] } },
            method: { isActive: true },
          },
          include: {
            aggregator: { select: { code: true, name: true, priority: true } },
            method: { select: { code: true, name: true } },
          },
          orderBy: [{ aggregator: { priority: 'asc' } }, { name: 'asc' }],
        },
      },
      orderBy: { name: 'asc' },
    });

    return countries.map((country) => ({
      id: country.id,
      iso2: country.iso2,
      name: country.name,
      dialCode: country.dialCode,
      currency: country.currency,
      providers: country.providers.map((provider) => ({
        id: provider.id,
        providerCode: provider.providerCode,
        name: provider.name,
        requiresType: provider.requiresType,
        aggregator: provider.aggregator,
        method: provider.method,
      })),
    }));
  }

  async listRefundableTransactions(params: { search?: string; limit?: number }) {
    const search = params.search?.trim();
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);

    const searchWhere = search
      ? {
          OR: [
              { id: { contains: search, mode: 'insensitive' } },
              { reference: { contains: search, mode: 'insensitive' } },
              { recipientPhone: { contains: search } },
              { attempts: { some: { externalRef: { contains: search, mode: 'insensitive' } } } },
            ],
        }
      : {};

    const invoices = await this.prisma.paymentInvoice.findMany({
      where: {
        AND: [
          searchWhere,
          { attempts: { some: { status: TransactionStatus.SUCCESS } } },
          {
            OR: [
              { payout: { is: { status: TransactionStatus.FAILED } } },
              { payout: { is: { attempts: { some: { status: TransactionStatus.FAILED } } } } },
            ],
          },
        ],
      },
      take: limit * 2,
      orderBy: { createdAt: 'desc' },
      include: {
        currency: { select: { code: true, symbol: true, name: true } },
        quote: { include: { baseCurrency: true, targetCurrency: true } },
        createdBy: { select: { id: true, firstName: true, lastName: true } },
        recipient: { select: { id: true, firstName: true, lastName: true } },
        attempts: { orderBy: { createdAt: 'desc' }, include: { currency: true } },
        payout: { include: { attempts: { orderBy: { createdAt: 'desc' } } } },
      },
    });

    const references = invoices.map((invoice) => invoice.reference);
    const [transactions, invoiceRefundLogs] = await Promise.all([
      this.prisma.transaction.findMany({
        where: { reference: { in: references } },
        include: {
          currency: { select: { code: true, symbol: true } },
          refunds: true,
          user: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
      this.prisma.adminAuditLog.findMany({
        where: {
          action: 'ADMIN_REFUND',
          targetType: 'INVOICE',
          targetId: { in: references },
        },
      }),
    ]);

    const transactionByReference = new Map(transactions.map((transaction) => [transaction.reference, transaction]));
    const logsByReference = new Map<string, typeof invoiceRefundLogs>();
    for (const log of invoiceRefundLogs) {
      if (!log.targetId) continue;
      logsByReference.set(log.targetId, [...(logsByReference.get(log.targetId) ?? []), log]);
    }

    return invoices
      .map((invoice) => this.serializeRefundableInvoice(
        invoice,
        transactionByReference.get(invoice.reference) ?? null,
        logsByReference.get(invoice.reference) ?? [],
      ))
      .filter((invoice) => invoice.isRefundable)
      .slice(0, limit);
  }

  async listRefunds(params: { page: number; limit: number }) {
    const page = Math.max(params.page, 1);
    const limit = Math.min(Math.max(params.limit, 1), 100);
    const skip = (page - 1) * limit;

    const take = skip + limit;
    const [refunds, refundTotal, invoiceRefundLogs, invoiceRefundTotal] = await Promise.all([
      this.prisma.refund.findMany({
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          transaction: {
            include: {
              currency: { select: { code: true, symbol: true } },
              user: { select: { id: true, firstName: true, lastName: true } },
            },
          },
        },
      }),
      this.prisma.refund.count(),
      this.prisma.adminAuditLog.findMany({
        where: { action: 'ADMIN_REFUND', targetType: 'INVOICE' },
        take,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.adminAuditLog.count({ where: { action: 'ADMIN_REFUND', targetType: 'INVOICE' } }),
    ]);

    const refundRows = refunds.map((refund) => ({
      id: refund.id,
      transactionId: refund.transactionId,
      amount: Number(refund.amount),
      reason: refund.reason,
      status: refund.status,
      provider: refund.provider,
      externalRef: refund.externalRef,
      createdAt: refund.createdAt,
      transaction: {
        id: refund.transaction.id,
        reference: refund.transaction.reference,
        amount: Number(refund.transaction.amount),
        fee: Number(refund.transaction.fee ?? 0),
        netAmount: Number(refund.transaction.netAmount ?? 0),
        currency: refund.transaction.currency,
        user: refund.transaction.user,
      },
    }));

    const invoiceRows = invoiceRefundLogs.map((entry) => {
      const currency = this.readMetadataString(entry.metadata, 'originalCurrency')
        ?? this.readMetadataString(entry.metadata, 'currency')
        ?? '';
      const amount = this.readMetadataNumber(entry.metadata, 'amount') ?? 0;
      return {
        id: entry.id,
        transactionId: this.readMetadataString(entry.metadata, 'invoiceId') ?? entry.targetId ?? entry.id,
        amount,
        reason: null,
        status: this.readMetadataString(entry.metadata, 'status') ?? 'UNKNOWN',
        provider: this.readMetadataString(entry.metadata, 'providerCode'),
        externalRef: this.readMetadataString(entry.metadata, 'externalRef'),
        createdAt: entry.createdAt,
        transaction: {
          id: this.readMetadataString(entry.metadata, 'invoiceId') ?? entry.targetId ?? entry.id,
          reference: this.readMetadataString(entry.metadata, 'invoiceReference') ?? entry.targetId ?? '',
          amount,
          fee: 0,
          netAmount: amount,
          currency: { code: currency, symbol: null },
          user: null,
        },
      };
    });

    const rows = [...refundRows, ...invoiceRows]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(skip, skip + limit);

    return {
      data: rows,
      meta: { total: refundTotal + invoiceRefundTotal, page, limit, pages: Math.ceil((refundTotal + invoiceRefundTotal) / limit) },
    };
  }

  async listAdminWithdrawals(params: { page: number; limit: number }) {
    const page = Math.max(params.page, 1);
    const limit = Math.min(Math.max(params.limit, 1), 100);
    const skip = (page - 1) * limit;

    const where = { action: 'ADMIN_WITHDRAWAL' };
    const [items, total] = await Promise.all([
      this.prisma.adminAuditLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.adminAuditLog.count({ where }),
    ]);

    return {
      data: items.map((entry) => ({
        id: entry.id,
        adminId: entry.adminId,
        status: this.readMetadataString(entry.metadata, 'status') ?? 'UNKNOWN',
        amount: this.readMetadataNumber(entry.metadata, 'amount') ?? 0,
        currency: this.readMetadataString(entry.metadata, 'currency') ?? '',
        country: this.readMetadataString(entry.metadata, 'country') ?? '',
        phone: this.readMetadataString(entry.metadata, 'phone') ?? '',
        providerCode: this.readMetadataString(entry.metadata, 'providerCode') ?? '',
        providerName: this.readMetadataString(entry.metadata, 'providerName') ?? '',
        aggregator: this.readMetadataString(entry.metadata, 'aggregator') ?? '',
        externalRef: this.readMetadataString(entry.metadata, 'externalRef'),
        message: this.readMetadataString(entry.metadata, 'message'),
        createdAt: entry.createdAt,
      })),
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    };
  }

  async createRefund(
    adminId: string,
    dto: {
      transactionId: string;
      amount: number;
      phone: string;
      country: string;
      providerCode: string;
      aggregator?: string;
      reason?: string;
    },
    ip?: string,
  ) {
    const amount = this.parsePositiveAmount(dto.amount, 'amount');
    const transactionKey = dto.transactionId?.trim();
    if (!transactionKey) throw new BadRequestException('transactionId is required');
    if (!dto.phone?.trim()) throw new BadRequestException('phone is required');
    if (!dto.country?.trim()) throw new BadRequestException('country is required');
    if (!dto.providerCode?.trim()) throw new BadRequestException('providerCode is required');

    const invoice = await this.prisma.paymentInvoice.findFirst({
      where: {
        OR: [
          { id: transactionKey },
          { reference: transactionKey },
          { attempts: { some: { externalRef: transactionKey } } },
        ],
      },
      include: {
        currency: { select: { code: true, symbol: true, name: true } },
        quote: { include: { baseCurrency: true, targetCurrency: true } },
        createdBy: { select: { id: true, firstName: true, lastName: true } },
        recipient: { select: { id: true, firstName: true, lastName: true } },
        attempts: { orderBy: { createdAt: 'desc' }, include: { currency: true } },
        payout: { include: { attempts: { orderBy: { createdAt: 'desc' } } } },
      },
    });

    const transaction = await this.prisma.transaction.findFirst({
      where: {
        OR: [
          { id: transactionKey },
          { reference: transactionKey },
          { externalRef: transactionKey },
          ...(invoice ? [{ reference: invoice.reference }] : []),
        ],
      },
      include: {
        currency: { select: { code: true, symbol: true } },
        refunds: true,
        user: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    if (!invoice && !transaction) throw new NotFoundException('Transaction not found');

    if (invoice) {
      const invoiceRefundLogs = await this.prisma.adminAuditLog.findMany({
        where: { action: 'ADMIN_REFUND', targetType: 'INVOICE', targetId: invoice.reference },
      });
      const candidate = this.serializeRefundableInvoice(invoice, transaction, invoiceRefundLogs);
      if (!candidate.isRefundable) {
        throw new BadRequestException('Only payments with a successful pay-in can be refunded');
      }
      if (amount.gt(candidate.remainingRefundable)) {
        throw new BadRequestException(
          `Refund exceeds available amount. Max refundable is ${candidate.remainingRefundable} ${candidate.currency.code}`,
        );
      }

      const refund = transaction
        ? await this.prisma.refund.create({
            data: {
              transaction: { connect: { id: transaction.id } },
              amount,
              reason: dto.reason?.trim() || null,
              status: TransactionStatus.PROCESSING,
              provider: dto.providerCode.trim(),
            },
          })
        : null;

      const reference = this.buildProviderReference();
      const payout = await this.dispatchAdminPayout({
        country: dto.country,
        providerCode: dto.providerCode,
        phone: dto.phone,
        amount: Number(amount),
        reference,
        description: 'TchokoPay refund',
        aggregator: dto.aggregator,
      });

      const ok = payout.result.status !== 'FAILED';
      const finalStatus = ok ? TransactionStatus.SUCCESS : TransactionStatus.FAILED;
      const externalRef = payout.result.transactionId ?? null;
      const updatedRefund = refund
        ? await this.prisma.refund.update({
            where: { id: refund.id },
            data: {
              status: finalStatus,
              provider: payout.provider.providerCode,
              externalRef,
            },
          })
        : null;

      if (ok) {
        const refundedAmount = new Prisma.Decimal(candidate.refundedAmount).add(amount);
        const refundStatus = refundedAmount.gte(candidate.maxRefundable) ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
        if (transaction) {
          const metadata = this.metadataObject(transaction.metadata);
          metadata.refundStatus = refundStatus;
          metadata.refundedAmount = Number(refundedAmount);
          metadata.refundableAmount = candidate.maxRefundable;
          metadata.lastRefundId = updatedRefund?.id ?? reference;
          metadata.lastRefundAt = new Date().toISOString();

          await this.prisma.transaction.update({
            where: { id: transaction.id },
            data: { metadata },
          });
        } else {
          const paidAttempt = invoice.attempts.find((attempt: any) => attempt.status === TransactionStatus.SUCCESS) ?? invoice.attempts[0];
          if (paidAttempt) {
            const metadata = this.metadataObject(paidAttempt.metadata);
            metadata.refundStatus = refundStatus;
            metadata.refundedAmount = Number(refundedAmount);
            metadata.refundableAmount = candidate.maxRefundable;
            metadata.lastRefundReference = reference;
            metadata.lastRefundAt = new Date().toISOString();
            await this.prisma.paymentAttempt.update({
              where: { id: paidAttempt.id },
              data: { metadata },
            });
          }
        }
      }

      await this.log(adminId, 'ADMIN_REFUND', updatedRefund ? 'REFUND' : 'INVOICE', updatedRefund?.id ?? invoice.reference, {
        status: finalStatus,
        invoiceId: invoice.id,
        invoiceReference: invoice.reference,
        transactionId: transaction?.id ?? null,
        refundId: updatedRefund?.id ?? null,
        amount: Number(amount),
        currency: payout.currency,
        originalCurrency: candidate.currency.code,
        country: payout.country,
        phone: dto.phone,
        providerCode: payout.provider.providerCode,
        providerName: payout.provider.name,
        aggregator: payout.aggregator.code,
        externalRef,
        message: ok ? 'Refund payout accepted' : (payout.result.error ?? 'Refund payout failed'),
      }, ip);

      return {
        ok,
        refund: {
          id: updatedRefund?.id ?? reference,
          transactionId: updatedRefund?.transactionId ?? transaction?.id ?? invoice.id,
          amount: Number(amount),
          reason: dto.reason?.trim() || null,
          status: finalStatus,
          provider: payout.provider.providerCode,
          externalRef,
          createdAt: updatedRefund?.createdAt ?? new Date(),
        },
        transaction: candidate,
        payout: {
          reference,
          externalRef,
          providerCode: payout.provider.providerCode,
          providerName: payout.provider.name,
          aggregator: payout.aggregator.code,
          status: payout.result.status,
          message: ok ? 'Refund payout accepted' : (payout.result.error ?? 'Refund payout failed'),
          raw: payout.result,
        },
      };
    }

    if (!transaction || transaction.status !== TransactionStatus.SUCCESS) {
      throw new BadRequestException('Only successful transactions can be refunded');
    }

    const refundSummary = this.calculateRefundSummary(transaction);
    if (amount.gt(refundSummary.remaining)) {
      throw new BadRequestException(
        `Refund exceeds available amount. Max refundable is ${refundSummary.remaining.toString()} ${transaction.currency.code}`,
      );
    }

    const refund = await this.prisma.refund.create({
      data: {
        transaction: { connect: { id: transaction.id } },
        amount,
        reason: dto.reason?.trim() || null,
        status: TransactionStatus.PROCESSING,
        provider: dto.providerCode.trim(),
      },
    });

    const reference = this.buildProviderReference();
    const payout = await this.dispatchAdminPayout({
      country: dto.country,
      providerCode: dto.providerCode,
      phone: dto.phone,
      amount: Number(amount),
      reference,
      description: 'TchokoPay refund',
      aggregator: dto.aggregator,
    });

    const ok = payout.result.status !== 'FAILED';
    const finalStatus = ok ? TransactionStatus.SUCCESS : TransactionStatus.FAILED;
    const externalRef = payout.result.transactionId ?? null;

    const updatedRefund = await this.prisma.refund.update({
      where: { id: refund.id },
      data: {
        status: finalStatus,
        provider: payout.provider.providerCode,
        externalRef,
      },
    });

    if (ok) {
      const refundedAmount = refundSummary.refunded.add(amount);
      const status = refundedAmount.gte(refundSummary.maxRefundable)
        ? 'REFUNDED'
        : 'PARTIALLY_REFUNDED';
      const metadata = this.metadataObject(transaction.metadata);
      metadata.refundStatus = status;
      metadata.refundedAmount = Number(refundedAmount);
      metadata.refundableAmount = Number(refundSummary.maxRefundable);
      metadata.lastRefundId = refund.id;
      metadata.lastRefundAt = new Date().toISOString();

      await this.prisma.transaction.update({
        where: { id: transaction.id },
        data: { metadata },
      });
    }

    await this.log(adminId, 'ADMIN_REFUND', 'REFUND', refund.id, {
      status: finalStatus,
      transactionId: transaction.id,
      transactionReference: transaction.reference,
      amount: Number(amount),
      currency: payout.currency,
      country: payout.country,
      phone: dto.phone,
      providerCode: payout.provider.providerCode,
      providerName: payout.provider.name,
      aggregator: payout.aggregator.code,
      externalRef,
      message: ok ? 'Refund payout accepted' : (payout.result.error ?? 'Refund payout failed'),
    }, ip);

    return {
      ok,
      refund: {
        id: updatedRefund.id,
        transactionId: updatedRefund.transactionId,
        amount: Number(updatedRefund.amount),
        reason: updatedRefund.reason,
        status: updatedRefund.status,
        provider: updatedRefund.provider,
        externalRef: updatedRefund.externalRef,
        createdAt: updatedRefund.createdAt,
      },
      transaction: this.serializeRefundableTransaction({
        ...transaction,
        refunds: [...transaction.refunds, updatedRefund],
      }),
      payout: {
        reference,
        externalRef,
        providerCode: payout.provider.providerCode,
        providerName: payout.provider.name,
        aggregator: payout.aggregator.code,
        status: payout.result.status,
        message: ok ? 'Refund payout accepted' : (payout.result.error ?? 'Refund payout failed'),
        raw: payout.result,
      },
    };
  }

  async declareRefunded(
    adminId: string,
    dto: {
      reference: string;
      amount?: number;
      note?: string;
    },
    ip?: string,
  ) {
    const transactionKey = dto.reference?.trim();
    if (!transactionKey) throw new BadRequestException('reference is required');

    const invoice = await this.prisma.paymentInvoice.findFirst({
      where: {
        OR: [
          { id: transactionKey },
          { reference: transactionKey },
          { attempts: { some: { externalRef: transactionKey } } },
        ],
      },
      include: {
        currency: { select: { code: true, symbol: true, name: true } },
        quote: { include: { baseCurrency: true, targetCurrency: true } },
        createdBy: { select: { id: true, firstName: true, lastName: true } },
        recipient: { select: { id: true, firstName: true, lastName: true } },
        attempts: { orderBy: { createdAt: 'desc' }, include: { currency: true } },
        payout: { include: { attempts: { orderBy: { createdAt: 'desc' } } } },
      },
    });

    const transaction = await this.prisma.transaction.findFirst({
      where: {
        OR: [
          { id: transactionKey },
          { reference: transactionKey },
          { externalRef: transactionKey },
          ...(invoice ? [{ reference: invoice.reference }] : []),
        ],
      },
      include: {
        currency: { select: { code: true, symbol: true } },
        refunds: true,
        user: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    if (!invoice && !transaction) throw new NotFoundException('Transaction not found');

    if (invoice) {
      const invoiceRefundLogs = await this.prisma.adminAuditLog.findMany({
        where: { action: 'ADMIN_REFUND', targetType: 'INVOICE', targetId: invoice.reference },
      });
      const candidate = this.serializeRefundableInvoice(invoice, transaction, invoiceRefundLogs);
      if (!candidate.isRefundable) {
        throw new BadRequestException('Only payments with successful pay-in and failed payout can be declared refunded');
      }

      const amount = dto.amount == null
        ? new Prisma.Decimal(candidate.remainingRefundable)
        : this.parsePositiveAmount(dto.amount, 'amount');
      if (amount.gt(candidate.remainingRefundable)) {
        throw new BadRequestException(
          `Refund exceeds available amount. Max refundable is ${candidate.remainingRefundable} ${candidate.currency.code}`,
        );
      }

      const providerCode = candidate.payment?.instrument?.providerCode
        ?? candidate.payment?.provider
        ?? 'manual';
      const refund = transaction
        ? await this.prisma.refund.create({
            data: {
              transaction: { connect: { id: transaction.id } },
              amount,
              reason: dto.note?.trim() || 'Marked refunded by admin',
              status: TransactionStatus.SUCCESS,
              provider: providerCode,
            },
          })
        : null;

      const refundedAmount = new Prisma.Decimal(candidate.refundedAmount).add(amount);
      const refundStatus = refundedAmount.gte(candidate.maxRefundable) ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
      const timestamp = new Date().toISOString();

      if (transaction) {
        const metadata = this.metadataObject(transaction.metadata);
        metadata.refundStatus = refundStatus;
        metadata.refundedAmount = Number(refundedAmount);
        metadata.refundableAmount = candidate.maxRefundable;
        metadata.lastRefundId = refund?.id ?? invoice.reference;
        metadata.lastRefundAt = timestamp;
        metadata.lastRefundMode = 'DECLARED';

        await this.prisma.transaction.update({
          where: { id: transaction.id },
          data: { metadata },
        });
      } else {
        const paidAttempt = invoice.attempts.find((attempt: any) => attempt.status === TransactionStatus.SUCCESS) ?? invoice.attempts[0];
        if (paidAttempt) {
          const metadata = this.metadataObject(paidAttempt.metadata);
          metadata.refundStatus = refundStatus;
          metadata.refundedAmount = Number(refundedAmount);
          metadata.refundableAmount = candidate.maxRefundable;
          metadata.lastRefundReference = invoice.reference;
          metadata.lastRefundAt = timestamp;
          metadata.lastRefundMode = 'DECLARED';
          await this.prisma.paymentAttempt.update({
            where: { id: paidAttempt.id },
            data: { metadata },
          });
        }
      }

      await this.log(adminId, 'ADMIN_REFUND', refund ? 'REFUND' : 'INVOICE', refund?.id ?? invoice.reference, {
        status: TransactionStatus.SUCCESS,
        declared: true,
        invoiceId: invoice.id,
        invoiceReference: invoice.reference,
        transactionId: transaction?.id ?? null,
        refundId: refund?.id ?? null,
        amount: Number(amount),
        currency: candidate.currency.code,
        originalCurrency: candidate.currency.code,
        country: candidate.payment?.instrument?.country ?? invoice.country,
        phone: candidate.payment?.instrument?.phone ?? candidate.payment?.instrument?.account ?? null,
        providerCode,
        message: dto.note?.trim() || 'Refund marked as completed by admin',
      }, ip);

      const remaining = new Prisma.Decimal(candidate.maxRefundable).sub(refundedAmount);
      return {
        ok: true,
        declared: true,
        status: TransactionStatus.SUCCESS,
        message: 'Refund marked as completed',
        refund: {
          id: refund?.id ?? invoice.reference,
          transactionId: refund?.transactionId ?? transaction?.id ?? invoice.id,
          amount: Number(amount),
          reason: dto.note?.trim() || 'Marked refunded by admin',
          status: TransactionStatus.SUCCESS,
          provider: providerCode,
          externalRef: null,
          createdAt: refund?.createdAt ?? new Date(),
        },
        transaction: {
          ...candidate,
          refundedAmount: Number(refundedAmount),
          remainingRefundable: Number(remaining.gt(0) ? remaining : new Prisma.Decimal(0)),
          refundStatus,
        },
      };
    }

    if (!transaction || transaction.status !== TransactionStatus.SUCCESS) {
      throw new BadRequestException('Only successful transactions can be declared refunded');
    }

    const refundSummary = this.calculateRefundSummary(transaction);
    const amount = dto.amount == null
      ? refundSummary.remaining
      : this.parsePositiveAmount(dto.amount, 'amount');
    if (amount.gt(refundSummary.remaining)) {
      throw new BadRequestException(
        `Refund exceeds available amount. Max refundable is ${refundSummary.remaining.toString()} ${transaction.currency.code}`,
      );
    }

    const refund = await this.prisma.refund.create({
      data: {
        transaction: { connect: { id: transaction.id } },
        amount,
        reason: dto.note?.trim() || 'Marked refunded by admin',
        status: TransactionStatus.SUCCESS,
        provider: 'manual',
      },
    });

    const refundedAmount = refundSummary.refunded.add(amount);
    const refundStatus = refundedAmount.gte(refundSummary.maxRefundable) ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    const metadata = this.metadataObject(transaction.metadata);
    metadata.refundStatus = refundStatus;
    metadata.refundedAmount = Number(refundedAmount);
    metadata.refundableAmount = Number(refundSummary.maxRefundable);
    metadata.lastRefundId = refund.id;
    metadata.lastRefundAt = new Date().toISOString();
    metadata.lastRefundMode = 'DECLARED';

    await this.prisma.transaction.update({
      where: { id: transaction.id },
      data: { metadata },
    });

    await this.log(adminId, 'ADMIN_REFUND', 'REFUND', refund.id, {
      status: TransactionStatus.SUCCESS,
      declared: true,
      transactionId: transaction.id,
      transactionReference: transaction.reference,
      amount: Number(amount),
      currency: transaction.currency.code,
      providerCode: 'manual',
      message: dto.note?.trim() || 'Refund marked as completed by admin',
    }, ip);

    return {
      ok: true,
      declared: true,
      status: TransactionStatus.SUCCESS,
      message: 'Refund marked as completed',
      refund: {
        id: refund.id,
        transactionId: refund.transactionId,
        amount: Number(refund.amount),
        reason: refund.reason,
        status: refund.status,
        provider: refund.provider,
        externalRef: refund.externalRef,
        createdAt: refund.createdAt,
      },
      transaction: this.serializeRefundableTransaction({
        ...transaction,
        refunds: [...transaction.refunds, refund],
      }),
    };
  }

  async createAdminWithdrawal(
    adminId: string,
    dto: {
      amount: number;
      phone: string;
      country: string;
      providerCode: string;
      aggregator?: string;
      note?: string;
    },
    ip?: string,
  ) {
    const amount = this.parsePositiveAmount(dto.amount, 'amount');
    if (!dto.phone?.trim()) throw new BadRequestException('phone is required');
    if (!dto.country?.trim()) throw new BadRequestException('country is required');
    if (!dto.providerCode?.trim()) throw new BadRequestException('providerCode is required');

    const reference = this.buildProviderReference();
    const payout = await this.dispatchAdminPayout({
      country: dto.country,
      providerCode: dto.providerCode,
      phone: dto.phone,
      amount: Number(amount),
      reference,
      description: 'Admin withdrawal',
      aggregator: dto.aggregator,
    });

    const ok = payout.result.status !== 'FAILED';
    const status = ok ? 'SUCCESS' : 'FAILED';
    const externalRef = payout.result.transactionId ?? null;
    const message = ok ? 'Withdrawal payout accepted' : (payout.result.error ?? 'Withdrawal payout failed');

    await this.log(adminId, 'ADMIN_WITHDRAWAL', 'WITHDRAWAL', reference, {
      status,
      amount: Number(amount),
      currency: payout.currency,
      country: payout.country,
      phone: dto.phone,
      providerCode: payout.provider.providerCode,
      providerName: payout.provider.name,
      aggregator: payout.aggregator.code,
      externalRef,
      message,
      note: dto.note?.trim() || null,
    }, ip);

    return {
      ok,
      status,
      reference,
      amount: Number(amount),
      currency: payout.currency,
      country: payout.country,
      phone: dto.phone,
      providerCode: payout.provider.providerCode,
      providerName: payout.provider.name,
      aggregator: payout.aggregator.code,
      externalRef,
      message,
      raw: payout.result,
    };
  }

  private async dispatchAdminPayout(params: {
    country: string;
    providerCode: string;
    phone: string;
    amount: number;
    reference: string;
    description: string;
    aggregator?: string;
  }) {
    const provider = await this.resolvePayoutProvider(params.country, params.providerCode, params.aggregator);
    const adapter = this.getAggregatorAdapter(provider.aggregator.code);
    const methodHint = this.methodHintForProvider(provider.providerCode, provider.method.code);
    const currency = provider.country.currency?.code ?? 'XAF';

    const result = await adapter.payout({
      amount: params.amount,
      currency,
      phone: params.phone.trim(),
      reference: params.reference,
      description: params.description,
      metadata: {
        country: provider.country.iso2,
        method: methodHint,
        providerCode: provider.providerCode,
        type: 'PAYOUT',
      },
    });

    return {
      result,
      provider,
      aggregator: provider.aggregator,
      country: provider.country.iso2,
      currency,
    };
  }

  private async resolvePayoutProvider(country: string, providerCode: string, aggregatorCode?: string) {
    const aggregator = aggregatorCode?.trim().toLowerCase();
    const provider = await this.prisma.paymentProvider.findFirst({
      where: {
        providerCode: providerCode.trim(),
        country: { iso2: country.trim().toUpperCase(), isActive: true },
        method: { isActive: true },
        aggregator: {
          isActive: true,
          ...(aggregator ? { code: aggregator } : { code: { in: ['netwalletpay', 'zikopay'] } }),
        },
        isActive: true,
      },
      include: {
        country: { include: { currency: true } },
        method: true,
        aggregator: true,
      },
    });
    if (!provider) {
      throw new NotFoundException('Active payout provider not found for this country');
    }
    return provider;
  }

  private getAggregatorAdapter(code?: string | null) {
    switch (code) {
      case 'netwalletpay':
        return this.netwalletpay;
      case 'zikopay':
        return this.zikopay;
      default:
        throw new BadRequestException(`Unsupported payout aggregator: ${code ?? 'unknown'}`);
    }
  }

  private methodHintForProvider(providerCode: string, methodCode: string): string {
    const provider = providerCode.toLowerCase();
    const method = methodCode.toUpperCase();
    if (method === 'BANK') return 'BANK';
    if (method === 'CARD') return 'CARD';
    if (provider.includes('orange')) return 'ORANGE';
    return 'MOMO';
  }

  private buildProviderReference(): string {
    return `INV-${Date.now()}`;
  }

  private parsePositiveAmount(value: number, field: string): Prisma.Decimal {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      throw new BadRequestException(`${field} must be greater than 0`);
    }
    return new Prisma.Decimal(numeric);
  }

  private calculateRefundSummary(transaction: {
    amount: Prisma.Decimal;
    fee: Prisma.Decimal | null;
    netAmount: Prisma.Decimal | null;
    refunds: Array<{ amount: Prisma.Decimal; status: TransactionStatus }>;
  }) {
    const zero = new Prisma.Decimal(0);
    const amount = new Prisma.Decimal(transaction.amount);
    const fee = transaction.fee ? new Prisma.Decimal(transaction.fee) : zero;
    const net = transaction.netAmount
      ? new Prisma.Decimal(transaction.netAmount)
      : amount.sub(fee);
    const maxRefundable = net.gt(zero) ? net : zero;
    const refunded = transaction.refunds
      .filter((refund) =>
        refund.status === TransactionStatus.SUCCESS ||
        refund.status === TransactionStatus.PROCESSING,
      )
      .reduce((sum, refund) => sum.add(refund.amount), zero);
    const remaining = maxRefundable.sub(refunded);

    return {
      originalAmount: amount,
      fee,
      maxRefundable,
      refunded,
      remaining: remaining.gt(zero) ? remaining : zero,
    };
  }

  private serializeRefundableInvoice(invoice: any, transaction: any, invoiceRefundLogs: any[]) {
    const latestAttempt = invoice.attempts?.[0] ?? null;
    const paidAttempt = invoice.attempts?.find((attempt: any) => attempt.status === TransactionStatus.SUCCESS) ?? latestAttempt;
    const latestPayoutAttempt = invoice.payout?.attempts?.[0] ?? null;
    const quote = invoice.quote ?? transaction?.quote ?? null;
    const paidCurrency = quote?.baseCurrency ?? paidAttempt?.currency ?? transaction?.currency ?? invoice.currency;
    const paidInSuccess =
      invoice.status === TransactionStatus.SUCCESS ||
      transaction?.status === TransactionStatus.SUCCESS ||
      invoice.attempts?.some((attempt: any) => attempt.status === TransactionStatus.SUCCESS);
    const payoutStatus = invoice.payout?.status ?? null;
    const payoutFailed =
      payoutStatus === TransactionStatus.FAILED ||
      payoutStatus === TransactionStatus.CANCELLED ||
      latestPayoutAttempt?.status === TransactionStatus.FAILED ||
      latestPayoutAttempt?.status === TransactionStatus.CANCELLED;
    const paidAmount = new Prisma.Decimal(this.numberValue(quote?.baseAmount ?? paidAttempt?.amount ?? transaction?.amount ?? invoice.amount) ?? 0);
    const fee = new Prisma.Decimal(this.numberValue(quote?.fee ?? paidAttempt?.fee ?? transaction?.fee ?? 0) ?? 0);
    const maxRefundable = paidAmount.sub(fee).gt(0) ? paidAmount.sub(fee) : new Prisma.Decimal(0);
    const refunded = transaction
      ? this.calculateRefundSummary(transaction).refunded
      : invoiceRefundLogs
          .filter((log) => {
            const status = this.readMetadataString(log.metadata, 'status');
            return status === TransactionStatus.SUCCESS || status === TransactionStatus.PROCESSING;
          })
          .reduce((sum, log) => sum.add(this.readMetadataNumber(log.metadata, 'amount') ?? 0), new Prisma.Decimal(0));
    const remaining = maxRefundable.sub(refunded);
    const isRefundable = Boolean(paidInSuccess && payoutFailed && remaining.gt(0));
    const metadata = transaction
      ? this.metadataObject(transaction.metadata)
      : this.metadataObject(paidAttempt?.metadata);

    return {
      id: transaction?.id ?? invoice.id,
      invoiceId: invoice.id,
      reference: invoice.reference,
      externalRef: paidAttempt?.externalRef ?? transaction?.externalRef ?? null,
      status: invoice.status,
      paymentStatus: paidAttempt?.status ?? null,
      payoutStatus: payoutStatus ?? latestPayoutAttempt?.status ?? null,
      eligibilityStatus: payoutFailed ? 'PAYOUT_FAILED' : invoice.status === TransactionStatus.SUCCESS ? 'COMPLETED' : paidInSuccess ? 'PAID_IN' : 'NOT_PAID',
      isRefundable,
      amount: Number(paidAmount),
      fee: Number(fee),
      maxRefundable: Number(maxRefundable),
      refundedAmount: Number(refunded),
      remainingRefundable: Number(remaining.gt(0) ? remaining : new Prisma.Decimal(0)),
      refundStatus: typeof metadata.refundStatus === 'string' ? metadata.refundStatus : null,
      currency: { code: paidCurrency?.code ?? invoice.currency?.code, symbol: paidCurrency?.symbol ?? null },
      user: invoice.createdBy ?? transaction?.user ?? null,
      recipient: {
        user: invoice.recipient ?? null,
        name: invoice.recipientName,
        phone: invoice.recipientPhone,
      },
      payment: paidAttempt
        ? {
            status: paidAttempt.status,
            method: paidAttempt.method,
            provider: paidAttempt.provider,
            externalRef: paidAttempt.externalRef,
            amount: this.numberValue(paidAttempt.amount),
            currency: paidAttempt.currency ? { code: paidAttempt.currency.code, symbol: paidAttempt.currency.symbol ?? null } : null,
            instrument: this.paymentInstrumentFromAttempt(paidAttempt),
          }
        : null,
      payout: invoice.payout
        ? {
            status: invoice.payout.status,
            amount: this.numberValue(invoice.payout.amount),
            currency: invoice.payout.currency,
            method: invoice.payout.method,
            provider: latestPayoutAttempt?.provider ?? invoice.payoutMethod,
            providerCode: invoice.payoutProviderCode,
            phone: invoice.recipientPhone,
            country: invoice.country,
            externalRef: latestPayoutAttempt?.externalRef ?? null,
          }
        : {
            status: null,
            amount: this.numberValue(quote?.targetAmount ?? invoice.amount),
            currency: invoice.currency?.code,
            method: invoice.payoutMethod,
            provider: invoice.payoutMethod,
            providerCode: invoice.payoutProviderCode,
            phone: invoice.recipientPhone,
            country: invoice.country,
            externalRef: null,
          },
      createdAt: invoice.createdAt,
    };
  }

  private serializeRefundableTransaction(transaction: {
    id: string;
    reference: string;
    externalRef: string | null;
    amount: Prisma.Decimal;
    fee: Prisma.Decimal | null;
    netAmount: Prisma.Decimal | null;
    status: TransactionStatus;
    createdAt: Date;
    currency: { code: string; symbol: string | null };
    user?: { id: string; firstName: string; lastName: string } | null;
    refunds: Array<{ amount: Prisma.Decimal; status: TransactionStatus }>;
    metadata?: Prisma.JsonValue | null;
  }) {
    const summary = this.calculateRefundSummary(transaction);
    const metadata = this.metadataObject(transaction.metadata);

    return {
      id: transaction.id,
      reference: transaction.reference,
      externalRef: transaction.externalRef,
      status: transaction.status,
      amount: Number(summary.originalAmount),
      fee: Number(summary.fee),
      maxRefundable: Number(summary.maxRefundable),
      refundedAmount: Number(summary.refunded),
      remainingRefundable: Number(summary.remaining),
      refundStatus: typeof metadata.refundStatus === 'string' ? metadata.refundStatus : null,
      currency: transaction.currency,
      user: transaction.user ?? null,
      createdAt: transaction.createdAt,
    };
  }

  private metadataObject(metadata: Prisma.JsonValue | null | undefined): Record<string, unknown> {
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      return { ...(metadata as Record<string, unknown>) };
    }
    return {};
  }

  private readMetadataString(metadata: Prisma.JsonValue | null | undefined, key: string) {
    const value = this.metadataObject(metadata)[key];
    return typeof value === 'string' ? value : null;
  }

  private readMetadataNumber(metadata: Prisma.JsonValue | null | undefined, key: string) {
    const value = this.metadataObject(metadata)[key];
    return typeof value === 'number' ? value : null;
  }

  // ── Bootstrap (create first admin) ───────────────────────────────────────

  async bootstrapAdmin(email: string, bootstrapToken: string) {
    const expectedToken = this.config.get<string>('ADMIN_BOOTSTRAP_TOKEN');
    if (!expectedToken || bootstrapToken !== expectedToken) {
      throw new ForbiddenException('Invalid bootstrap token');
    }

    const contact = await this.prisma.userContact.findFirst({
      where: { value: email, type: 'EMAIL' },
    });
    if (!contact) throw new NotFoundException('No account found with that email');

    const updated = await this.prisma.user.update({
      where: { id: contact.userId },
      data: { role: 'ADMIN' },
      select: { id: true, firstName: true, lastName: true, role: true },
    });

    this.logger.warn(`🛡️ Admin bootstrapped: ${updated.firstName} ${updated.lastName} (${email})`);
    return updated;
  }
}

