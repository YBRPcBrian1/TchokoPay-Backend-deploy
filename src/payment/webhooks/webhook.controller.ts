import {
  Controller,
  Post,
  Body,
  BadRequestException,
  Headers,
  Logger,
} from '@nestjs/common';
import { createHmac, createHash } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TransactionStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { PaymentEventService } from '../services/payment-event.service.js';
import { PayoutExecutorService } from '../services/payout-executor.service.js';
import { PaymentPollingService, PollingProvider } from '../services/payment-polling.service.js';
import { classifyFailure } from '../../common/failure-category.js';

@ApiTags('Webhooks')
@Controller('webhooks')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
    private paymentEventService: PaymentEventService,
    private payoutExecutor: PayoutExecutorService,
    private pollingService: PaymentPollingService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // BLINK LIGHTNING WEBHOOK
  // Header: x-blink-signature  = HMAC-SHA256(rawBody, BLINK_WEBHOOK_SECRET)
  // Payload: { type: "invoice.completed", data: { invoiceId, status, amount, currency, description } }
  // ─────────────────────────────────────────────────────────────────────────

  @Post('blink')
  @ApiOperation({ summary: 'Blink Lightning payment webhook' })
  @ApiBody({
    schema: {
      example: {
        type: 'invoice.completed',
        data: {
          invoiceId: 'abc123',
          status: 'PAID',
          amount: 101500,
          currency: 'SAT',
          description: 'INV-1774421373834',
        },
      },
    },
  })
  async handleBlinkWebhook(
    @Body() payload: any,
    @Headers('x-blink-signature') signature: string,
  ) {
    this.logger.log(`Blink webhook received: ${payload.type}`);

    // ── 1. Signature verification ──
    const blinkSecret = this.configService.get<string>('BLINK_WEBHOOK_SECRET');
    if (blinkSecret && signature) {
      const expected = createHmac('sha256', blinkSecret)
        .update(JSON.stringify(payload))
        .digest('hex');
      if (signature !== expected) {
        this.logger.warn('Blink webhook: invalid signature');
        throw new BadRequestException('Invalid webhook signature');
      }
    }

    // ── 2. Extract event ID for idempotency ──
    const eventId = payload.data?.invoiceId || payload.id;
    if (!eventId) {
      throw new BadRequestException('Missing invoiceId in Blink webhook');
    }

    const existing = await this.prisma.webhookEvent.findUnique({ where: { eventId } });
    if (existing?.processed) {
      this.logger.log(`Blink webhook already processed: ${eventId}`);
      return { acknowledged: true };
    }

    // ── 3. Store event ──
    const webhookEvent = await this.prisma.webhookEvent.upsert({
      where: { eventId },
      create: { provider: 'blink', eventId, type: payload.type, payload, processed: false },
      update: { payload },
    });

    // ── 4. Dispatch by event type ──
    try {
      switch (payload.type) {
        case 'invoice.completed':
        case 'invoice.paid':
          await this.handleBlinkPayinConfirmed(payload);
          break;

        case 'invoice.expired':
        case 'invoice.failed':
          await this.handleBlinkPayinFailed(payload);
          break;

        default:
          this.logger.warn(`Unknown Blink webhook type: ${payload.type}`);
      }

      await this.prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: { processed: true },
      });

      return { success: true };
    } catch (error) {
      this.logger.error(`Error processing Blink webhook ${eventId}:`, error);
      throw error;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // NETWALLETPAY WEBHOOK
  // Header: x-callbacktoken = SHA256("{orderId}_{secondaryKey}")
  // Payload: { Status: "SUCCESS", TransactionId: "MMM..." }
  // Both collection (payin) and payout share the same callback URL.
  // We distinguish them by matching TransactionId against PaymentAttempt.externalRef
  // (payin) or PayoutAttempt.externalRef (payout).
  // ─────────────────────────────────────────────────────────────────────────

  @Post('netwalletpay')
  @ApiOperation({ summary: 'Netwalletpay collection/payout status webhook' })
  async handleNetwalletpayWebhook(
    @Body() payload: any,
    @Headers('x-callbacktoken') callbackToken?: string,
  ) {
    const transactionId: string =
      payload.TransactionId || payload.transactionId || payload.reference || payload.id;
    const status: string = (payload.Status || payload.status || '').toUpperCase();

    this.logger.log(`Netwalletpay webhook: ${transactionId} → ${status}`);

    if (!transactionId) {
      throw new BadRequestException('Missing TransactionId in Netwalletpay webhook');
    }

    // ── 1. Token verification ──
    const secondaryKey = this.configService.get<string>('NETWALLETPAY_SECONDARY_KEY');
    if (secondaryKey) {
      // If the secret is configured, the token MUST be present and valid.
      // Missing token = potential spoofed request — reject immediately.
      if (!callbackToken) {
        throw new BadRequestException('Missing X-CallbackToken header');
      }
      this.verifyNetwalletpayToken(callbackToken, transactionId, secondaryKey);
    }

    // ── 2. Idempotency ──
    const existing = await this.prisma.webhookEvent.findUnique({ where: { eventId: transactionId } });
    if (existing?.processed) {
      this.logger.log(`Netwalletpay webhook already processed: ${transactionId}`);
      return { status: 'DUPLICATE' };
    }

    const webhookEvent = await this.prisma.webhookEvent.create({
      data: {
        eventId: transactionId,
        provider: 'netwalletpay',
        type: status || 'netwalletpay.callback',
        payload,
        processed: false,
      },
    });

    // ── 3. Determine whether this is a payin or payout confirmation ──
    try {
      const payinAttempt = await this.prisma.paymentAttempt.findFirst({
        where: { externalRef: transactionId },
        include: { invoice: true, currency: true },
      });

      const payoutAttempt = await this.prisma.payoutAttempt.findFirst({
        where: { externalRef: transactionId },
        include: { payout: { include: { invoice: true } } },
      });

      if (status === 'SUCCESS' || status === 'COMPLETED') {
        if (payinAttempt) {
          await this.confirmPayin(
            payinAttempt,
            transactionId,
            payload as Record<string, unknown>,
          );
        }
        if (payoutAttempt) {
          await this.payoutExecutor.confirmPayout(transactionId);
          this.logger.log(`Payout confirmed: ${transactionId}`);
        }
      } else if (status === 'FAILED' || status === 'CANCELLED' || status === 'TIMEOUT') {
        if (payinAttempt) {
          await this.failPayin(payinAttempt, status);
        }
        if (payoutAttempt) {
          await this.payoutExecutor.failPayout(transactionId, status);
        }
      } else {
        this.logger.log(`Netwalletpay webhook status PENDING/UNKNOWN for ${transactionId} — no action`);
      }

      await this.prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: { processed: true },
      });

      return { status: 'OK' };
    } catch (error) {
      this.logger.error(`Error processing Netwalletpay webhook ${transactionId}:`, error);
      throw error;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PRIVATE HELPERS
  // ─────────────────────────────────────────────────────────────────────────

  /** Blink: invoice confirmed paid → mark attempt SUCCESS → trigger payout */
  private async handleBlinkPayinConfirmed(payload: any) {
    const { invoiceId, amount, currency, description } = payload.data ?? {};

    const attempt = await this.prisma.paymentAttempt.findFirst({
      where: { externalRef: invoiceId },
      include: { invoice: true, currency: true },
    });

    if (!attempt) {
      this.logger.warn(`No PaymentAttempt found for Blink invoiceId: ${invoiceId}`);
      return;
    }

    await this.prisma.paymentAttempt.update({
      where: { id: attempt.id },
      data: {
        status: TransactionStatus.SUCCESS,
        providerResponse: { ...payload.data, confirmedAt: new Date() },
      },
    });

    this.logger.log(`Blink payin confirmed: ${attempt.invoice.reference}`);

    // Trigger payout and start payout polling for async confirmation
    await this.paymentEventService.emitPaymentComplete({
      invoiceId: attempt.invoiceId,
      invoiceReference: attempt.invoice.reference,
      status: 'PROCESSING',
      stage: 'PAYER_CONFIRMED',
      paymentMethod: attempt.method as string,
      payoutMethod: attempt.invoice.payoutMethod,
      amount: Number(attempt.amount),
      currency: attempt.currency.code,
      paymentDetails: { status: 'PAID', transactionId: invoiceId },
      timestamp: new Date(),
      userId: attempt.invoice.createdById ?? undefined,
    });

    const payoutResult = await this.payoutExecutor.execute(attempt.invoiceId);
    if (payoutResult?.payoutAttemptId && payoutResult.payoutExternalRef) {
      this.pollingService.startPayoutPoll({
        invoiceId: attempt.invoiceId,
        payoutId: payoutResult.payoutId,
        payoutAttemptId: payoutResult.payoutAttemptId,
        externalRef: payoutResult.payoutExternalRef,
        provider: this.resolvePayoutPollingProvider(String(attempt.invoice.payoutMethod)),
      });
    }

    await this.paymentEventService.emitWebhookPayment({
      provider: 'blink',
      eventType: 'payment.confirmed',
      stage: 'PAYER_CONFIRMED',
      invoiceId: attempt.invoiceId,
      invoiceReference: attempt.invoice.reference,
      externalRef: invoiceId,
      status: 'SUCCESS',
      amount: Number(amount),
      currency,
      payload: payload.data,
      timestamp: new Date(),
    });
  }

  /** Blink: invoice expired/failed → mark FAILED, no payout */
  private async handleBlinkPayinFailed(payload: any) {
    const { invoiceId, status, reason } = payload.data ?? {};

    const attempt = await this.prisma.paymentAttempt.findFirst({
      where: { externalRef: invoiceId },
      include: { invoice: true, currency: true },
    });

    if (!attempt) return;

    await this.prisma.paymentAttempt.update({
      where: { id: attempt.id },
      data: { status: TransactionStatus.FAILED, failureReason: reason || status, providerResponse: payload.data },
    });

    await this.prisma.paymentInvoice.update({
      where: { id: attempt.invoiceId },
      data: { status: TransactionStatus.FAILED, failureCategory: classifyFailure(reason || status, status) },
    });
    await this.prisma.paymentRequest.updateMany({
      where: {
        metadata: { path: ['invoiceId'], equals: attempt.invoiceId },
      },
      data: { status: TransactionStatus.FAILED },
    });

    this.logger.log(`Blink payin FAILED: ${attempt.invoice.reference}`);

    await this.paymentEventService.emitWebhookPayment({
      provider: 'blink',
      eventType: 'payment.failed',
      stage: 'FAILED',
      invoiceId: attempt.invoiceId,
      invoiceReference: attempt.invoice.reference,
      externalRef: invoiceId,
      status: 'FAILED',
      failureReason: reason || status,
      payload: payload.data,
      timestamp: new Date(),
    });

    await this.paymentEventService.emitPaymentComplete({
      invoiceId: attempt.invoiceId,
      invoiceReference: attempt.invoice.reference,
      status: 'FAILED',
      stage: 'FAILED',
      paymentMethod: attempt.method as string,
      payoutMethod: attempt.invoice.payoutMethod,
      amount: Number(attempt.amount),
      currency: attempt.currency.code,
      paymentDetails: { status: 'FAILED', transactionId: invoiceId },
      timestamp: new Date(),
      userId: attempt.invoice.createdById ?? undefined,
    });
  }

  /**
   * Netwalletpay: payin confirmed → update attempt SUCCESS → trigger payout
   */
  private async confirmPayin(
    attempt: { id: string; invoiceId: string; method: string; amount: unknown; currencyId: string; currency?: { code: string }; invoice: { reference: string; createdById: string | null; payoutMethod: string } },
    transactionId: string,
    payload: Record<string, unknown>,
  ) {
    await this.prisma.paymentAttempt.update({
      where: { id: attempt.id },
      data: {
        status: TransactionStatus.SUCCESS,
        providerResponse: { ...payload, confirmedAt: new Date() },
      },
    });

    this.logger.log(`Netwalletpay payin confirmed: ${attempt.invoice.reference}`);

    // Trigger payout and start payout polling for async confirmation
    await this.paymentEventService.emitPaymentComplete({
      invoiceId: attempt.invoiceId,
      invoiceReference: attempt.invoice.reference,
      status: 'PROCESSING',
      stage: 'PAYER_CONFIRMED',
      paymentMethod: attempt.method as string,
      payoutMethod: attempt.invoice.payoutMethod,
      amount: Number(attempt.amount),
      currency: attempt.currency?.code ?? attempt.currencyId,
      paymentDetails: { status: 'PAID', transactionId },
      timestamp: new Date(),
      userId: attempt.invoice.createdById ?? undefined,
    });

    const payoutResult = await this.payoutExecutor.execute(attempt.invoiceId);
    if (payoutResult?.payoutAttemptId && payoutResult.payoutExternalRef) {
      this.pollingService.startPayoutPoll({
        invoiceId: attempt.invoiceId,
        payoutId: payoutResult.payoutId,
        payoutAttemptId: payoutResult.payoutAttemptId,
        externalRef: payoutResult.payoutExternalRef,
        provider: this.resolvePayoutPollingProvider(String(attempt.invoice.payoutMethod)),
      });
    }

    await this.paymentEventService.emitWebhookPayment({
      provider: 'netwalletpay',
      eventType: 'payment.confirmed',
      stage: 'PAYER_CONFIRMED',
      invoiceId: attempt.invoiceId,
      invoiceReference: attempt.invoice.reference,
      externalRef: transactionId,
      status: 'SUCCESS',
      amount: Number(attempt.amount),
      currency: attempt.currency?.code ?? attempt.currencyId,
      payload,
      timestamp: new Date(),
    });

  }

  /** Netwalletpay: payin failed → mark FAILED, no payout */
  private async failPayin(attempt: any, reason: string) {
    const currencyCode = attempt.currency?.code ?? attempt.currencyId;

    await this.prisma.paymentAttempt.update({
      where: { id: attempt.id },
      data: { status: TransactionStatus.FAILED, failureReason: reason },
    });

    await this.prisma.paymentInvoice.update({
      where: { id: attempt.invoiceId },
      data: { status: TransactionStatus.FAILED, failureCategory: classifyFailure(reason, reason) },
    });
    await this.prisma.paymentRequest.updateMany({
      where: {
        metadata: { path: ['invoiceId'], equals: attempt.invoiceId },
      },
      data: { status: TransactionStatus.FAILED },
    });

    this.logger.log(`Netwalletpay payin FAILED: ${attempt.invoice.reference} (${reason})`);

    await this.paymentEventService.emitWebhookPayment({
      provider: 'netwalletpay',
      eventType: 'payment.failed',
      stage: 'FAILED',
      invoiceId: attempt.invoiceId,
      invoiceReference: attempt.invoice.reference,
      externalRef: attempt.externalRef ?? undefined,
      status: 'FAILED',
      amount: Number(attempt.amount),
      currency: currencyCode,
      failureReason: reason,
      payload: { reason },
      timestamp: new Date(),
    });

    await this.paymentEventService.emitPaymentComplete({
      invoiceId: attempt.invoiceId,
      invoiceReference: attempt.invoice.reference,
      status: 'FAILED',
      stage: 'FAILED',
      paymentMethod: attempt.method as string,
      payoutMethod: attempt.invoice.payoutMethod,
      amount: Number(attempt.amount),
      currency: currencyCode,
      paymentDetails: {
        status: 'FAILED',
        transactionId: attempt.externalRef ?? undefined,
      },
      timestamp: new Date(),
      userId: attempt.invoice.createdById ?? undefined,
    });
  }

  /** Map invoice payoutMethod to the correct polling provider. */
  private resolvePayoutPollingProvider(payoutMethod: string): PollingProvider {
    const m = (payoutMethod ?? '').toUpperCase();
    if (m === 'LIGHTNING' || m === 'BTC') return 'blink';
    return 'netwalletpay';
  }

  /**
   * Verify Netwalletpay X-CallbackToken.
   * Token = SHA256("{transactionId}_{secondaryKey}").
   * Throws BadRequestException on mismatch — fake webhooks are rejected before any DB write.
   */
  private verifyNetwalletpayToken(token: string, transactionId: string, secondaryKey: string) {
    const expected = createHash('sha256')
      .update(`${transactionId}_${secondaryKey}`)
      .digest('hex');

    if (token !== expected) {
      this.logger.warn(
        `Netwalletpay callback token mismatch for ${transactionId}`,
      );
      throw new BadRequestException('Invalid webhook token');
    }
  }
}
