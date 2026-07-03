import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { TransactionStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { NetwalletpayProvider } from '../providers/netwalletpay.provider.js';
import { ZikoPayProvider } from '../providers/zikopay.provider.js';
import { classifyFailure } from '../../common/failure-category.js';
import { BlinkApiService } from '../providers/services/blink-api.service.js';
import { PayoutExecutorService } from './payout-executor.service.js';
import { PaymentEventService } from './payment-event.service.js';

export type PollingProvider = 'netwalletpay' | 'blink';

export interface PayinPollJob {
  invoiceId: string;
  attemptId: string;
  externalRef: string;
  provider: PollingProvider;
  /** Blink only: BOLT11 payment request string needed for lnInvoicePaymentStatus query */
  blinkPaymentRequest?: string;
  maxAttempts?: number;
  intervalMs?: number;
}

export interface PayoutPollJob {
  invoiceId: string;
  payoutId: string;
  payoutAttemptId: string;
  externalRef: string;
  provider: PollingProvider;
  maxAttempts?: number;
  intervalMs?: number;
}

/** Alias kept for backwards compatibility */
export type PollJob = PayinPollJob;

/**
 * PaymentPollingService
 *
 * Sequentially polls provider status for BOTH the payin and the payout.
 * Works alongside the webhook path — whichever confirms first wins.
 * All DB writes are idempotent (re-checks status before writing).
 *
 * Default cadence: 24 polls × 5 s = 2 minutes per job.
 */
@Injectable()
export class PaymentPollingService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PaymentPollingService.name);
  private reconcileRunning = false;

  constructor(
    private prisma: PrismaService,
    private netwalletpay: NetwalletpayProvider,
    private zikopay: ZikoPayProvider,
    private blinkApi: BlinkApiService,
    private payoutExecutor: PayoutExecutorService,
    private paymentEventService: PaymentEventService,
  ) {}

  /**
   * Self-healing reconciliation. The in-memory polls above do not survive a
   * restart, so any payin left PROCESSING (lost poll / missed webhook) would sit
   * stuck forever. This sweep re-resolves them against the provider — runs once
   * shortly after boot (to catch restart orphans) then on a fixed interval.
   */
  onApplicationBootstrap(): void {
    setTimeout(() => void this.safeReconcile(), 30_000);
    setInterval(() => void this.safeReconcile(), 2 * 60_000);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PUBLIC — PAYIN POLLING
  // ─────────────────────────────────────────────────────────────────────────

  /** Fire-and-forget: poll until payin is confirmed or times out. */
  start(job: PayinPollJob): void {
    const max = job.maxAttempts ?? 24;
    const interval = job.intervalMs ?? 5_000;
    this.logger.log(
      `Payin poll started | ${job.provider} | ref: ${job.externalRef} | up to ${max}×${interval / 1000}s`,
    );
    this.runPayinLoop(job, max, interval, 1).catch(err =>
      this.logger.error(`Payin poll crashed for ${job.externalRef}:`, err),
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PUBLIC — PAYOUT POLLING
  // ─────────────────────────────────────────────────────────────────────────

  /** Fire-and-forget: poll until payout is confirmed or times out. */
  startPayoutPoll(job: PayoutPollJob): void {
    const max = job.maxAttempts ?? 24;
    const interval = job.intervalMs ?? 5_000;
    this.logger.log(
      `Payout poll started | ${job.provider} | ref: ${job.externalRef} | up to ${max}×${interval / 1000}s`,
    );
    this.runPayoutLoop(job, max, interval, 1).catch(err =>
      this.logger.error(`Payout poll crashed for ${job.externalRef}:`, err),
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PRIVATE — PAYIN LOOP
  // ─────────────────────────────────────────────────────────────────────────

  private async runPayinLoop(
    job: PayinPollJob,
    maxAttempts: number,
    intervalMs: number,
    attempt: number,
  ): Promise<void> {
    // Stop if webhook already confirmed/failed
    const current = await this.prisma.paymentAttempt.findUnique({
      where: { id: job.attemptId },
      select: { status: true },
    });

    if (!current) return;

    if (current.status === TransactionStatus.SUCCESS) {
      this.logger.log(`Payin poll: ${job.attemptId} already SUCCESS (webhook confirmed first)`);
      return;
    }
    if (current.status === TransactionStatus.FAILED) {
      this.logger.log(`Payin poll: ${job.attemptId} already FAILED — stopping`);
      return;
    }

    const result = await this.checkProviderStatus(job.provider, job.externalRef, job.blinkPaymentRequest);

    if (result === 'SUCCESS') {
      this.logger.log(`Payin poll SUCCESS: ${job.externalRef} (check ${attempt}/${maxAttempts})`);
      await this.confirmPayin(job);
      return;
    }

    if (result === 'FAILED') {
      this.logger.log(`Payin poll FAILED: ${job.externalRef} (check ${attempt}/${maxAttempts})`);
      await this.failPayin(job, 'Provider returned FAILED');
      return;
    }

    if (attempt >= maxAttempts) {
      this.logger.warn(`Payin poll timed out after ${maxAttempts} checks for ${job.externalRef}`);
      await this.failPayin(job, 'Polling timed out — no confirmation received');
      return;
    }

    this.logger.log(`Payin poll PENDING: ${job.externalRef} (${attempt}/${maxAttempts}) — retry in ${intervalMs / 1000}s`);
    await this.sleep(intervalMs);
    await this.runPayinLoop(job, maxAttempts, intervalMs, attempt + 1);
  }

  private async confirmPayin(job: PayinPollJob): Promise<void> {
    // Guard: webhook may have fired between last check and now
    const current = await this.prisma.paymentAttempt.findUnique({
      where: { id: job.attemptId },
      select: { status: true },
    });
    if (current?.status === TransactionStatus.SUCCESS) return;

    await this.prisma.paymentAttempt.update({
      where: { id: job.attemptId },
      data: { status: TransactionStatus.SUCCESS },
    });

    const attempt = await this.prisma.paymentAttempt.findUnique({
      where: { id: job.attemptId },
      include: {
        currency: true,
        invoice: {
          include: {
            quote: {
              include: { baseCurrency: true, targetCurrency: true },
            },
          },
        },
      },
    });

    if (attempt) {
      await this.paymentEventService.emitPaymentComplete({
        invoiceId: attempt.invoiceId,
        invoiceReference: attempt.invoice.reference,
        status: 'PROCESSING',
        stage: 'PAYER_CONFIRMED',
        paymentMethod: attempt.method as string,
        payoutMethod: attempt.invoice.payoutMethod,
        amount: Number(attempt.amount),
        currency: attempt.currency.code,
        paymentDetails: { status: 'PAID', transactionId: job.externalRef },
        timestamp: new Date(),
        userId: attempt.invoice.createdById ?? undefined,
      });
    }

    // Trigger payout — idempotent, safe even if webhook also fires
    const payoutResult = await this.payoutExecutor.execute(job.invoiceId);

    // If the payout has an async transactionId, start payout polling.
    // IMPORTANT: use the *payout* method to resolve the provider, NOT the payin provider.
    // For Lightning payments the payin is via Blink but the payout (MOMO) is via Netwalletpay.
    // Using job.provider (Blink) for a MOMO payout would poll the wrong API → times out.
    if (payoutResult?.payoutAttemptId && payoutResult.payoutExternalRef) {
      const payoutPollingProvider = this.resolvePayoutProvider(
        attempt?.invoice?.payoutMethod ?? '',
      );
      this.startPayoutPoll({
        invoiceId: job.invoiceId,
        payoutId: payoutResult.payoutId,
        payoutAttemptId: payoutResult.payoutAttemptId,
        externalRef: payoutResult.payoutExternalRef,
        provider: payoutPollingProvider,
      });
    }
  }

  /** Map a payout method to the correct polling provider. */
  private resolvePayoutProvider(payoutMethod: string): PollingProvider {
    const m = (payoutMethod ?? '').toUpperCase();
    if (m === 'LIGHTNING' || m === 'BTC' || m === 'CRYPTO') return 'blink';
    return 'netwalletpay'; // MOMO, ORANGE, BANK, CARD all confirmed via Netwalletpay
  }

  private async failPayin(job: PayinPollJob, reason: string): Promise<void> {
    const current = await this.prisma.paymentAttempt.findUnique({
      where: { id: job.attemptId },
      select: { status: true },
    });
    if (current?.status !== TransactionStatus.PROCESSING) return;

    const attempt = await this.prisma.paymentAttempt.findUnique({
      where: { id: job.attemptId },
      include: {
        currency: true,
        invoice: true,
      },
    });

    await this.prisma.paymentAttempt.update({
      where: { id: job.attemptId },
      data: { status: TransactionStatus.FAILED, failureReason: reason },
    });
    await this.prisma.paymentInvoice.update({
      where: { id: job.invoiceId },
      data: { status: TransactionStatus.FAILED, failureCategory: classifyFailure(reason) },
    });
    await this.prisma.paymentRequest.updateMany({
      where: {
        metadata: { path: ['invoiceId'], equals: job.invoiceId },
      },
      data: { status: TransactionStatus.FAILED },
    });

    if (attempt) {
      this.paymentEventService.emitPaymentComplete({
        invoiceId: attempt.invoiceId,
        invoiceReference: attempt.invoice.reference,
        status: 'FAILED',
        stage: 'FAILED',
        paymentMethod: attempt.method as string,
        payoutMethod: attempt.invoice.payoutMethod,
        amount: Number(attempt.amount),
        currency: attempt.currency.code,
        paymentDetails: {
          status: 'FAILED',
          transactionId: job.externalRef,
        },
        timestamp: new Date(),
        userId: attempt.invoice.createdById ?? undefined,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RECONCILIATION — self-healing sweep for stuck PROCESSING payins
  // ─────────────────────────────────────────────────────────────────────────

  private async safeReconcile(): Promise<void> {
    if (this.reconcileRunning) return; // never overlap sweeps
    this.reconcileRunning = true;
    try {
      await this.reconcileStalePayins();
      await this.purgeAbandonedRegistrations();
    } catch (err) {
      this.logger.error('Reconcile sweep failed:', err);
    } finally {
      this.reconcileRunning = false;
    }
  }

  /**
   * Hard-delete abandoned registration shells: merchant link/event invoices that
   * were created (with a quote) but NEVER attempted — no pay-in, no payout, no
   * ledger, no money — and have been sitting PENDING for over 6 hours. Removes
   * the invoice, its now-orphan quote, and the linked payment request.
   */
  async purgeAbandonedRegistrations(): Promise<void> {
    const cutoff = new Date(Date.now() - 6 * 60 * 60_000); // 6 hours
    const abandoned = await this.prisma.paymentInvoice.findMany({
      where: {
        status: TransactionStatus.PENDING,
        createdAt: { lt: cutoff },
        paymentLinkId: { not: null }, // a merchant link/event registration shell
        attempts: { none: {} },        // never attempted to pay
        payout: null,                  // no payout
        ledgerEntries: { none: {} },   // no money ever touched it
      },
      select: { id: true, reference: true, quoteId: true },
      take: 100,
    });

    if (!abandoned.length) return;
    this.logger.log(`Purge: removing ${abandoned.length} abandoned registration shell(s)`);

    for (const inv of abandoned) {
      try {
        // The payment request links to the invoice via metadata (not a FK).
        await this.prisma.paymentRequest.deleteMany({
          where: { metadata: { path: ['invoiceId'], equals: inv.id } },
        });
        await this.prisma.paymentInvoice.delete({ where: { id: inv.id } });
        // Drop the now-orphan quote if nothing else references it.
        if (inv.quoteId) {
          const stillUsed = await this.prisma.paymentInvoice.count({ where: { quoteId: inv.quoteId } });
          const onTxn = await this.prisma.transaction.count({ where: { quoteId: inv.quoteId } });
          if (stillUsed === 0 && onTxn === 0) {
            await this.prisma.quote.delete({ where: { id: inv.quoteId } }).catch(() => undefined);
          }
        }
      } catch (e) {
        this.logger.warn(`Purge skip ${inv.reference}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  /**
   * Finds payins left PROCESSING beyond the live-poll window and resolves them
   * against the provider's status API. SUCCESS → confirm (credit + payout),
   * FAILED → fail, still-PENDING-past-expiry → fail. Fully idempotent (confirm/
   * fail re-check status before writing) so it's safe on every instance.
   */
  async reconcileStalePayins(): Promise<void> {
    const cutoff = new Date(Date.now() - 3 * 60_000); // grace for the live in-memory poll
    const stale = await this.prisma.paymentInvoice.findMany({
      where: {
        status: TransactionStatus.PROCESSING,
        updatedAt: { lt: cutoff },
        attempts: { some: { status: TransactionStatus.PROCESSING, externalRef: { not: null } } },
      },
      include: {
        currency: { select: { code: true } },
        attempts: {
          where: { status: TransactionStatus.PROCESSING, externalRef: { not: null } },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { updatedAt: 'asc' },
      take: 50,
    });

    if (!stale.length) return;
    this.logger.log(`Reconcile: checking ${stale.length} stale PROCESSING payin(s)`);

    for (const inv of stale) {
      const attempt = inv.attempts[0];
      const ref = attempt?.externalRef;
      if (!attempt || !ref) continue;

      const job: PayinPollJob = {
        invoiceId: inv.id,
        attemptId: attempt.id,
        externalRef: ref,
        provider: 'netwalletpay',
      };

      const status = await this.statusByRef(ref);
      if (status === 'SUCCESS') {
        // SAFETY: a recovered success is NEVER auto-paid. It's flagged for an
        // admin to confirm manually, so no money moves without review.
        await this.flagRecoverableSuccess(inv, ref);
      } else if (status === 'FAILED') {
        this.logger.log(`Reconcile FAILED: ${inv.reference} (${ref})`);
        await this.failPayin(job, 'Reconciled: provider reports failed');
      } else if (new Date() > inv.expiresAt) {
        this.logger.log(`Reconcile EXPIRED→FAILED: ${inv.reference} (${ref})`);
        await this.failPayin(job, 'Reconciled: expired without confirmation');
      }
    }
  }

  /**
   * A stuck payin the provider now reports as SUCCESS. We do NOT auto-confirm or
   * pay — instead we record it once in the admin audit log for manual review.
   * The invoice stays PROCESSING until an admin approves it.
   */
  private async flagRecoverableSuccess(
    inv: { id: string; reference: string; amount: unknown; expiresAt: Date; currency: { code: string } },
    ref: string,
  ): Promise<void> {
    const already = await this.prisma.adminAuditLog.findFirst({
      where: { action: 'PAYIN_RECOVERY_FLAGGED', targetId: inv.id },
      select: { id: true },
    });
    if (already) return; // flag only once

    await this.prisma.adminAuditLog.create({
      data: {
        adminId: 'SYSTEM',
        action: 'PAYIN_RECOVERY_FLAGGED',
        targetType: 'INVOICE',
        targetId: inv.id,
        metadata: {
          reference: inv.reference,
          externalRef: ref,
          amount: Number(inv.amount),
          currency: inv.currency.code,
          note: 'Provider reports SUCCESS but the invoice is stuck PROCESSING. Needs manual admin confirmation before any payout.',
        },
      },
    });
    this.logger.warn(
      `⚠️ Reconcile FLAGGED (no auto-pay): ${inv.reference} (${ref}) — provider=SUCCESS, awaiting admin review`,
    );
  }

  /** Resolve a payin's status from the right aggregator by its reference shape. */
  private async statusByRef(ref: string): Promise<'SUCCESS' | 'FAILED' | 'PENDING'> {
    try {
      // ZikoPay references are 'TXN…'; Netwalletpay uses 'DS…'. Unknown refs
      // (e.g. Lightning) fall through to Netwalletpay, which returns PENDING and
      // is then only resolved by the expiry rule above.
      if (ref.toUpperCase().startsWith('TXN')) {
        return (await this.zikopay.checkTransactionStatus(ref)).status;
      }
      return (await this.netwalletpay.checkTransactionStatus(ref)).status;
    } catch {
      return 'PENDING';
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PRIVATE — PAYOUT LOOP
  // ─────────────────────────────────────────────────────────────────────────

  private async runPayoutLoop(
    job: PayoutPollJob,
    maxAttempts: number,
    intervalMs: number,
    attempt: number,
  ): Promise<void> {
    // Stop if webhook already confirmed/failed
    const current = await this.prisma.payoutAttempt.findUnique({
      where: { id: job.payoutAttemptId },
      select: { status: true },
    });

    if (!current) return;

    if (current.status === TransactionStatus.SUCCESS) {
      this.logger.log(`Payout poll: ${job.payoutAttemptId} already SUCCESS (webhook confirmed first)`);
      return;
    }
    if (current.status === TransactionStatus.FAILED) {
      this.logger.log(`Payout poll: ${job.payoutAttemptId} already FAILED — stopping`);
      return;
    }

    const result = await this.checkProviderStatus(job.provider, job.externalRef);

    if (result === 'SUCCESS') {
      this.logger.log(`Payout poll SUCCESS: ${job.externalRef} (check ${attempt}/${maxAttempts})`);
      await this.confirmPayout(job);
      return;
    }

    if (result === 'FAILED') {
      this.logger.log(`Payout poll FAILED: ${job.externalRef} (check ${attempt}/${maxAttempts})`);
      await this.failPayout(job, 'Provider returned FAILED');
      return;
    }

    if (attempt >= maxAttempts) {
      this.logger.warn(`Payout poll timed out after ${maxAttempts} checks for ${job.externalRef}`);
      await this.failPayout(job, 'Polling timed out — payout not confirmed');
      return;
    }

    this.logger.log(`Payout poll PENDING: ${job.externalRef} (${attempt}/${maxAttempts}) — retry in ${intervalMs / 1000}s`);
    await this.sleep(intervalMs);
    await this.runPayoutLoop(job, maxAttempts, intervalMs, attempt + 1);
  }

  private async confirmPayout(job: PayoutPollJob): Promise<void> {
    // Guard: webhook may have confirmed between last check and now
    const current = await this.prisma.payoutAttempt.findUnique({
      where: { id: job.payoutAttemptId },
      select: { status: true },
    });
    if (current?.status === TransactionStatus.SUCCESS) return;

    await this.payoutExecutor.confirmPayout(job.externalRef);
    this.logger.log(`✅ Payout confirmed via polling: ${job.externalRef}`);
  }

  private async failPayout(job: PayoutPollJob, reason: string): Promise<void> {
    const current = await this.prisma.payoutAttempt.findUnique({
      where: { id: job.payoutAttemptId },
      select: { status: true },
    });
    if (current?.status !== TransactionStatus.PROCESSING) return;

    await this.payoutExecutor.failPayout(job.externalRef, reason);
    this.logger.warn(`Payout failed via polling: ${job.externalRef} — ${reason}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PRIVATE — SHARED STATUS CHECK
  // ─────────────────────────────────────────────────────────────────────────

  private async checkProviderStatus(
    provider: PollingProvider,
    externalRef: string,
    blinkPaymentRequest?: string,
  ): Promise<'SUCCESS' | 'FAILED' | 'PENDING'> {
    try {
      if (provider === 'netwalletpay') {
        const { status } = await this.netwalletpay.checkTransactionStatus(externalRef);
        return status;
      }

      if (provider === 'blink') {
        if (!blinkPaymentRequest) {
          // No BOLT11 string available — can't poll Blink, rely on webhook only
          return 'PENDING';
        }
        const result = await this.blinkApi.getInvoiceStatus(blinkPaymentRequest);
        if (result.paid) return 'SUCCESS';
        const s = (result.status ?? '').toUpperCase();
        if (s === 'EXPIRED' || s === 'NOT_RECEIVED') return 'PENDING';
        if (s === 'CANCELLED') return 'FAILED';
        return 'PENDING';
      }

      return 'PENDING';
    } catch {
      return 'PENDING'; // transient errors are not failures
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
