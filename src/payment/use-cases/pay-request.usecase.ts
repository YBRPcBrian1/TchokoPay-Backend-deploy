import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { PaymentProviderFactory } from '../providers/payment-provider.factory.js';
import { TransactionStatus, Prisma } from '@prisma/client';
import { FlowType } from '../enums/payment.enums.js';
import { QuoteService } from '../../quote/quote.service.js';
import { PaymentEventService } from '../services/payment-event.service.js';
import { PaymentPollingService, PollingProvider } from '../services/payment-polling.service.js';
import { classifyFailure } from '../../common/failure-category.js';

type QuoteWithCurrencies = Prisma.QuoteGetPayload<{
  include: { baseCurrency: true; targetCurrency: true };
}>;

@Injectable()
export class PayRequestUseCase {
  constructor(
    private prisma: PrismaService,
    private providerFactory: PaymentProviderFactory,
    private quoteService: QuoteService,
    private paymentEventService: PaymentEventService,
    private pollingService: PaymentPollingService,
  ) {}

  async execute(userId: string, dto: any) {
    if (!dto.invoiceReference) {
      throw new BadRequestException('invoiceReference is required for request payment');
    }

    const invoice = await this.prisma.paymentInvoice.findUnique({
      where: { reference: dto.invoiceReference },
      include: {
        quote: true,
        recipient: true,
        currency: true,
        merchantPaymentLink: { include: { baseCurrency: true } },
        merchantProfile: { select: { businessName: true } },
      },
    });

    if (!invoice) {
      throw new NotFoundException('Invoice not found');
    }

    if (invoice.flow !== FlowType.REQUEST) {
      throw new BadRequestException('Invalid payment request');
    }

    if (invoice.status === TransactionStatus.SUCCESS) {
      throw new BadRequestException('Payment request has already been paid');
    }

    if (
      (invoice.status === TransactionStatus.PENDING ||
        invoice.status === TransactionStatus.PROCESSING) &&
      new Date() > invoice.expiresAt
    ) {
      await this.expireRequestInvoice(invoice.id);
      throw new BadRequestException('Payment request has expired');
    }

    if (invoice.status === TransactionStatus.PROCESSING) {
      throw new BadRequestException('Payment request is already being processed');
    }

    if (invoice.status !== TransactionStatus.PENDING) {
      throw new BadRequestException('Payment request is no longer available');
    }

    const isGuest = !userId?.trim();
    const paymentMethod = (dto.paymentMethod || 'MOMO')?.toUpperCase();
    const requiresPayerPhone = ['MOMO', 'ORANGE'].includes(paymentMethod);

    let payerPhone: string | undefined;
    if (requiresPayerPhone) {
      const submittedPayerPhone =
        typeof dto.payerPhone === 'string' ? dto.payerPhone.trim() : '';

      if (!submittedPayerPhone) {
        throw new BadRequestException(
          `${paymentMethod} payments require the mobile money number entered in the payment form.`,
        );
      }

      payerPhone = submittedPayerPhone;
    }

    const paymentRequest = await this.prisma.paymentRequest.findFirst({
      where: {
        metadata: { path: ['invoiceId'], equals: invoice.id },
      },
    });

    const requestMetadata = paymentRequest?.metadata as any;
    const amountType = requestMetadata?.amountType || 'RECEIVE';

    if (!dto.baseCurrency) {
      throw new BadRequestException('baseCurrency is required to pay a request');
    }

    const link = invoice.merchantPaymentLink;

    let quote: QuoteWithCurrencies;
    let lockedSettlement: number | null = null;
    let settlementCurrencyId: string | null = null;

    if (link) {
      // Merchant event/link: the MERCHANT is settled in the PAYER's currency,
      // net of fees — no conversion to a fixed wallet currency. Two quotes are
      // locked at this instant: the payer leg (their currency → event base, with
      // our spread/fee) and the clean settlement (event base → payer currency).
      const baseCcy = link.baseCurrency.code;
      const isUsd = baseCcy === 'USD';

      const settlementQuote = (await this.quoteService.create({
        baseCurrency: baseCcy,            // event base, e.g. USD / XAF
        targetCurrency: dto.baseCurrency, // the payer's currency
        amount: Number(link.baseAmount),
        amountType: 'PAY' as any,
        cleanRate: true,
        paymentMethod,
        payoutMethod: invoice.payoutMethod,
        flow: 'REQUEST' as any,
      })) as QuoteWithCurrencies;
      lockedSettlement = Number(settlementQuote.targetAmount);
      settlementCurrencyId = settlementQuote.targetCurrencyId;

      quote = (await this.quoteService.create({
        baseCurrency: dto.baseCurrency,   // payer currency
        targetCurrency: baseCcy,          // event base
        amount: Number(link.baseAmount),
        amountType: 'RECEIVE' as any,
        pricingBaseCurrency: isUsd ? 'USD' : undefined,
        paymentMethod,
        payoutMethod: invoice.payoutMethod,
        flow: 'REQUEST' as any,
      })) as QuoteWithCurrencies;
    } else {
      quote = (await this.quoteService.create({
        amount: Number(invoice.amount),
        amountType,
        baseCurrency: dto.baseCurrency,
        targetCurrency: invoice.currency.code,
        paymentMethod,
        payoutMethod: invoice.payoutMethod,
        flow: 'REQUEST' as any,
      })) as QuoteWithCurrencies;
    }

    await this.prisma.paymentInvoice.update({
      where: { id: invoice.id },
      data: {
        quote: { connect: { id: quote.id } },
        paymentMethod,
        status: TransactionStatus.PROCESSING,
        // Merchant payments settle in the payer's currency: re-point the invoice
        // amount AND currency to the locked settlement computed now.
        ...(lockedSettlement != null ? { amount: new Prisma.Decimal(lockedSettlement) } : {}),
        ...(settlementCurrencyId ? { currency: { connect: { id: settlementCurrencyId } } } : {}),
        createdBy: isGuest
          ? { disconnect: true }
          : { connect: { id: userId } },
      },
    });

    if (paymentRequest) {
      await this.prisma.paymentRequest.update({
        where: { id: paymentRequest.id },
        data: { status: TransactionStatus.PROCESSING },
      });
    }

    const attempt = await this.prisma.paymentAttempt.create({
      data: {
        invoice: { connect: { id: invoice.id } },
        method: paymentMethod,
        provider: paymentMethod,
        flow: FlowType.REQUEST,
        amount: quote.baseAmount,
        currency: { connect: { id: quote.baseCurrencyId } },
        status: TransactionStatus.PENDING,
      },
    });

    const payerCountry =
      (dto.payerCountry as string | undefined)?.trim().toUpperCase() ||
      invoice.country;

    const payinProvider = this.providerFactory.getProvider(paymentMethod, payerCountry);
    const paymentProviderCode =
      typeof dto.paymentProviderCode === 'string' && dto.paymentProviderCode.trim()
        ? dto.paymentProviderCode.trim()
        : undefined;
    const payinResponse = await payinProvider.payin({
      amount: Number(quote.baseAmount),
      currency: quote.baseCurrency.code,
      phone: payerPhone,
      reference: invoice.reference,
      description: invoice.description || undefined,
      metadata: {
        country: payerCountry,
        method: paymentMethod,
        type: 'COLLECTION',
        providerCode: paymentProviderCode,
      },
    });

    if (payinResponse?.status === 'FAILED') {
      await this.prisma.paymentAttempt.update({
        where: { id: attempt.id },
        data: {
          status: TransactionStatus.FAILED,
          failureReason: payinResponse?.error || 'Provider returned FAILED',
          providerResponse: payinResponse,
          metadata: {
            payerPhone: payerPhone ?? null,
            payerCountry,
            providerCode: paymentProviderCode ?? null,
            method: paymentMethod,
            type: 'COLLECTION',
          },
        },
      });
      await this.prisma.paymentInvoice.update({
        where: { id: invoice.id },
        // Provider rejected the request outright (no prompt reached the payer) —
        // classify (usually SYSTEM, e.g. a provider errorCode).
        data: { status: TransactionStatus.FAILED, failureCategory: classifyFailure(payinResponse?.error, payinResponse?.status) },
      });
      if (paymentRequest) {
        await this.prisma.paymentRequest.update({
          where: { id: paymentRequest.id },
          data: { status: TransactionStatus.FAILED },
        });
      }

      this.paymentEventService.emitPaymentComplete({
        invoiceId: invoice.id,
        invoiceReference: invoice.reference,
        status: 'FAILED',
        stage: 'FAILED',
        paymentMethod,
        payoutMethod: invoice.payoutMethod,
        amount: Number(quote.baseAmount),
        currency: quote.baseCurrency.code,
        paymentDetails: {
          status: 'FAILED',
          failureReason: payinResponse?.error || 'Provider returned FAILED',
        },
        timestamp: new Date(),
        userId: isGuest ? undefined : userId,
      });

      return {
        message: 'Payment failed',
        invoice: { ...invoice, status: TransactionStatus.FAILED },
        quote,
        payment: { status: 'FAILED', error: payinResponse?.error },
      };
    }

    const externalRef =
      payinResponse?.transactionId ||
      payinResponse?.id ||
      payinResponse?.invoiceId ||
      null;

    await this.prisma.paymentAttempt.update({
      where: { id: attempt.id },
      data: {
        status: TransactionStatus.PROCESSING,
        externalRef,
        providerResponse: payinResponse,
        metadata: {
          payerPhone: payerPhone ?? null,
          payerCountry,
          providerCode: paymentProviderCode ?? null,
          method: paymentMethod,
          type: 'COLLECTION',
        },
      },
    });

    const result: any = {
      message: 'Payment initiated - awaiting confirmation',
      invoice: { ...invoice, status: TransactionStatus.PROCESSING, quote },
      quote,
      payment: {
        status: payinResponse?.status ?? 'PROCESSING',
        externalRef,
        paymentRequest: payinResponse?.paymentRequest ?? null,
        amount: payinResponse?.amount ?? null,
        currency: payinResponse?.currency ?? null,
        expiresAt: payinResponse?.expiresAt ?? null,
        address: payinResponse?.address ?? null,
        reference: payinResponse?.reference ?? null,
      },
    };

    await this.paymentEventService.emitPaymentComplete({
      invoiceId: invoice.id,
      invoiceReference: invoice.reference,
      status: 'PENDING',
      stage: 'AWAITING_PAYER',
      paymentMethod,
      payoutMethod: invoice.payoutMethod,
      amount: Number(quote.baseAmount),
      currency: quote.baseCurrency.code,
      paymentDetails: result.payment,
      timestamp: new Date(),
      userId: isGuest ? undefined : userId,
    });

    if (externalRef) {
      const pollingProvider = this.resolvePollingProvider(paymentMethod);
      this.pollingService.start({
        invoiceId: invoice.id,
        attemptId: attempt.id,
        externalRef,
        provider: pollingProvider,
        blinkPaymentRequest:
          pollingProvider === 'blink'
            ? (payinResponse?.paymentRequest ?? undefined)
            : undefined,
      });
    }

    return result;
  }

  private resolvePollingProvider(method: string): PollingProvider {
    return method.toUpperCase() === 'LIGHTNING' || method.toUpperCase() === 'BTC'
      ? 'blink'
      : 'netwalletpay';
  }

  private async expireRequestInvoice(invoiceId: string) {
    await this.prisma.$transaction([
      this.prisma.paymentInvoice.update({
        where: { id: invoiceId },
        data: { status: TransactionStatus.CANCELLED },
      }),
      this.prisma.paymentRequest.updateMany({
        where: {
          metadata: { path: ['invoiceId'], equals: invoiceId },
        },
        data: { status: TransactionStatus.CANCELLED },
      }),
      this.prisma.paymentLink.updateMany({
        where: { invoiceId },
        data: { isActive: false },
      }),
    ]);
  }
}
