import { Injectable, NotFoundException } from '@nestjs/common';
import { PaymentFlow, TransactionStatus } from '@prisma/client';
import { FlowHelper } from './flows/flow.helper.js';
import { CreatePaymentDto } from './dto/create-payment.dto.js';
import { NetwalletpayProvider } from './providers/netwalletpay.provider.js';
import { PrismaService } from '../../prisma/prisma.service.js';

@Injectable()
export class PaymentService {
  constructor(
    private flowHelper: FlowHelper,
    private netwalletpayProvider: NetwalletpayProvider,
    private prisma: PrismaService,
  ) {}

  async processPayment(userId: string, dto: CreatePaymentDto) {
    const result = await this.flowHelper.execute(userId, dto);
    await this.attachConfirmInstruction(result, dto);
    return result;
  }

  /**
   * Attaches the operator's "how to finish the payment" hint (from the
   * PaymentProvider row) to the initiation response, so the checkout "check
   * your phone" screen can guide the payer and cut abandoned payments.
   * Best-effort and mobile-money only — never blocks a payment.
   */
  private async attachConfirmInstruction(result: any, dto: CreatePaymentDto) {
    try {
      const method = (dto.paymentMethod || '').toUpperCase();
      if (!result?.payment || !['MOMO', 'ORANGE'].includes(method)) return;

      const code = (dto as any).paymentProviderCode?.trim();
      const iso2 = ((dto as any).payerCountry || (dto as any).country)?.trim()?.toUpperCase();

      const providerRow = code
        ? await this.prisma.paymentProvider.findUnique({
            where: { providerCode: code },
            select: { confirmInstruction: true },
          })
        : iso2
          ? await this.prisma.paymentProvider.findFirst({
              where: { isActive: true, country: { iso2 }, method: { code: 'MOBILE_MONEY' } },
              select: { confirmInstruction: true },
              orderBy: { aggregator: { priority: 'asc' } },
            })
          : null;

      result.payment.confirmInstruction = providerRow?.confirmInstruction ?? null;
    } catch {
      // Hint is purely cosmetic — swallow any lookup error.
    }
  }

  async verifyProviders(paymentType: string, method: string, country: string) {
    return this.netwalletpayProvider.verifyProviderConfig(
      paymentType as 'COLLECTION' | 'PAYOUT',
      method,
      country,
    );
  }

  /** Returns all active transaction limits — used by the frontend to validate amounts before submission. */
  async getTransactionLimits() {
    return this.prisma.transactionLimit.findMany({
      where: { isActive: true },
      select: { currencyCode: true, minAmount: true, maxAmount: true },
      orderBy: { currencyCode: 'asc' },
    });
  }

  /**
   * Returns active countries with their providers for the payment wizard.
   *
   * Per-country routing logic:
   *   For each country only the HIGHEST-PRIORITY active aggregator that has
   *   providers is shown (lower priority number = tried first).
   *   Example: CM has Netwalletpay (priority 1) → shows mtn_cm, orange_cm.
   *            GH has only ZikoPay (priority 2) → shows ziko_mtn_gh, etc.
   *   Countries with no active providers at all are excluded.
   */
  async getActiveCountries() {
    const countries = await this.prisma.country.findMany({
      where: { isActive: true },
      include: {
        currency: { select: { code: true, symbol: true } },
        providers: {
          where: { isActive: true, aggregator: { isActive: true } },
          include: {
            method:     { select: { code: true } },
            aggregator: { select: { code: true, priority: true } },
          },
          orderBy: [
            { aggregator: { priority: 'asc' } }, // primary first
            { providerCode: 'asc' },
          ],
        },
      },
      orderBy: { name: 'asc' },
    });

    return countries
      .map(c => {
        if (!c.providers.length) return null;
        // Pick only the highest-priority aggregator's providers for this country
        const topPriority = (c.providers[0] as any).aggregator?.priority as number;
        const primary = c.providers.filter(
          (p: any) => p.aggregator?.priority === topPriority,
        );
        return {
          iso2:      c.iso2,
          name:      c.name,
          dialCode:  c.dialCode,
          currency:  c.currency.code,
          aggregator: (c.providers[0] as any).aggregator?.code as string,
          providers: primary.map((p: any) => ({
            code:         p.providerCode as string,
            name:         p.name         as string,
            method:       p.method.code  as string,
            requiresType: p.requiresType as boolean,
          })),
        };
      })
      .filter(Boolean);
  }

  async getInvoiceByReference(reference: string) {
    const normalizedReference = reference.trim().toUpperCase();
    const invoice = await this.prisma.paymentInvoice.findUnique({
      where: { reference: normalizedReference },
      include: {
        currency: true,
        recipient: {
          select: { id: true, firstName: true, lastName: true, paymentIdentity: true },
        },
        paymentLink: true,
        merchantPaymentLink: {
          select: {
            kind: true,
            reason: true,
            slug: true,
            title: true,
            eventType: true,
            logoUrl: true,
            baseAmount: true,
            baseCurrency: { select: { code: true, symbol: true } },
          },
        },
        merchantProfile: { select: { businessName: true } },
        quote: {
          include: { baseCurrency: true, targetCurrency: true },
        },
      },
    });

    if (!invoice) {
      throw new NotFoundException('Invoice not found');
    }

    const currentInvoice = await this.expireRequestInvoiceIfNeeded(invoice);
    const requestState = this.getRequestState(currentInvoice);

    return {
      ...currentInvoice,
      requestState,
      isExpired: requestState === 'EXPIRED',
      isPayable: requestState === 'PAYABLE',
    };
  }

  private async expireRequestInvoiceIfNeeded(invoice: any) {
    const isExpirableStatus =
      invoice.status === TransactionStatus.PENDING ||
      invoice.status === TransactionStatus.PROCESSING;
    const isExpiredRequest =
      invoice.flow === PaymentFlow.REQUEST &&
      isExpirableStatus &&
      new Date() > invoice.expiresAt;

    if (!isExpiredRequest) {
      return invoice;
    }

    const [updatedInvoice] = await this.prisma.$transaction([
      this.prisma.paymentInvoice.update({
        where: { id: invoice.id },
        data: { status: TransactionStatus.CANCELLED },
        include: {
          currency: true,
          recipient: {
            select: { id: true, firstName: true, lastName: true, paymentIdentity: true },
          },
          paymentLink: true,
          quote: {
            include: { baseCurrency: true, targetCurrency: true },
          },
        },
      }),
      this.prisma.paymentRequest.updateMany({
        where: {
          metadata: { path: ['invoiceId'], equals: invoice.id },
        },
        data: { status: TransactionStatus.CANCELLED },
      }),
      this.prisma.paymentLink.updateMany({
        where: { invoiceId: invoice.id },
        data: { isActive: false },
      }),
    ]);

    return updatedInvoice;
  }

  private getRequestState(invoice: any) {
    if (invoice.status === TransactionStatus.SUCCESS) {
      return 'PAID';
    }

    if (invoice.flow === PaymentFlow.REQUEST && new Date() > invoice.expiresAt) {
      return 'EXPIRED';
    }

    if (invoice.status === TransactionStatus.PROCESSING) {
      return 'PROCESSING';
    }

    if (invoice.status === TransactionStatus.PENDING) {
      return 'PAYABLE';
    }

    return 'CLOSED';
  }
}
