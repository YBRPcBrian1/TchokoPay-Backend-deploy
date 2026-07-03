import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  ParseIntPipe,
  DefaultValuePipe,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { AdminService } from './admin.service.js';
import { MerchantCashoutService } from '../merchant/merchant-cashout.service.js';
import { AdminGuard } from './guards/admin.guard.js';
import { JwtAuthGuard } from '../auth/guards/jwt.guard.js';

type AuthenticatedRequest = { user: { userId: string }; ip?: string };

@ApiTags('Admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin')
export class AdminController {
  constructor(
    private admin: AdminService,
    private cashouts: MerchantCashoutService,
  ) {}

  // ── Overview ──────────────────────────────────────────────────────────────

  @Get('stats')
  @ApiOperation({ summary: 'Platform overview stats' })
  getStats() {
    return this.admin.getStats();
  }

  // ── Analytics ─────────────────────────────────────────────────────────────

  @Get('analytics')
  @ApiOperation({ summary: 'Time-series analytics for the given period' })
  @ApiQuery({ name: 'period', required: false, enum: ['7d', '30d', '90d'] })
  getAnalytics(@Query('period') period: '7d' | '30d' | '90d' = '30d') {
    return this.admin.getAnalytics(period);
  }

  // ── Users ─────────────────────────────────────────────────────────────────

  @Get('users')
  @ApiOperation({ summary: 'List all users with filters' })
  @ApiQuery({ name: 'page',      required: false, example: 1 })
  @ApiQuery({ name: 'limit',     required: false, example: 20 })
  @ApiQuery({ name: 'search',    required: false })
  @ApiQuery({ name: 'role',      required: false, enum: ['USER', 'ADMIN'] })
  @ApiQuery({ name: 'isActive',  required: false })
  @ApiQuery({ name: 'kycStatus', required: false, enum: ['PENDING', 'VERIFIED', 'REJECTED'] })
  listUsers(
    @Query('page',     new DefaultValuePipe(1),  ParseIntPipe) page: number,
    @Query('limit',    new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('search')    search?: string,
    @Query('role')      role?: string,
    @Query('isActive')  isActive?: string,
    @Query('kycStatus') kycStatus?: string,
  ) {
    return this.admin.listUsers({
      page,
      limit: Math.min(limit, 100),
      search,
      role,
      isActive: isActive === undefined ? undefined : isActive === 'true',
      kycStatus,
    });
  }

  @Get('users/:id')
  @ApiOperation({ summary: 'Get full user detail' })
  getUserDetail(@Param('id') id: string) {
    return this.admin.getUserDetail(id);
  }

  @Patch('users/:id/role')
  @ApiOperation({ summary: 'Promote or demote a user' })
  setRole(
    @Req() req: AuthenticatedRequest,
    @Param('id') userId: string,
    @Body('role') role: 'USER' | 'ADMIN',
  ) {
    return this.admin.setUserRole(req.user.userId, userId, role, req.ip);
  }

  @Patch('users/:id/status')
  @ApiOperation({ summary: 'Activate or ban a user' })
  setStatus(
    @Req() req: AuthenticatedRequest,
    @Param('id') userId: string,
    @Body('isActive') isActive: boolean,
  ) {
    return this.admin.setUserStatus(req.user.userId, userId, isActive, req.ip);
  }

  // ── Invoices / Transactions ───────────────────────────────────────────────

  @Get('payment-issues')
  @ApiOperation({ summary: 'Failed + stalled payments with full diagnostic detail (failure reason + raw provider response)' })
  @ApiQuery({ name: 'page',  required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'type',  required: false, description: 'ALL | FAILED | STALLED | SYSTEM | DECLINED | ABANDONED' })
  @ApiQuery({ name: 'search', required: false })
  getPaymentIssues(
    @Query('page',  new DefaultValuePipe(1),  ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit: number,
    @Query('type')   type?: string,
    @Query('search') search?: string,
  ) {
    return this.admin.getPaymentIssues({ page, limit: Math.min(limit, 100), type, search });
  }

  @Get('invoices')
  @ApiOperation({ summary: 'List all payment invoices' })
  @ApiQuery({ name: 'page',    required: false })
  @ApiQuery({ name: 'limit',   required: false })
  @ApiQuery({ name: 'status',  required: false })
  @ApiQuery({ name: 'flow',    required: false })
  @ApiQuery({ name: 'country', required: false })
  @ApiQuery({ name: 'category', required: false, description: 'SYSTEM | DECLINED | ABANDONED (failed only)' })
  @ApiQuery({ name: 'search',  required: false })
  listInvoices(
    @Query('page',    new DefaultValuePipe(1),  ParseIntPipe) page: number,
    @Query('limit',   new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('status')  status?: string,
    @Query('flow')    flow?: string,
    @Query('country') country?: string,
    @Query('category') category?: string,
    @Query('search')  search?: string,
  ) {
    return this.admin.listInvoices({ page, limit: Math.min(limit, 100), status, flow, country, category, search });
  }

  @Get('invoices/:id')
  @ApiOperation({ summary: 'Get invoice detail with full audit trail' })
  getInvoice(@Param('id') id: string) {
    return this.admin.getInvoiceDetail(id);
  }

  // -- Refunds & admin withdrawals -----------------------------------------

  @Get('payout-rails')
  @ApiOperation({ summary: 'Active payout countries/providers grouped by aggregator' })
  listPayoutRails() {
    return this.admin.listPayoutRails();
  }

  @Get('refundable-transactions')
  @ApiOperation({ summary: 'Search successful transactions that can be refunded' })
  listRefundableTransactions(
    @Query('search') search?: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit?: number,
  ) {
    return this.admin.listRefundableTransactions({ search, limit });
  }

  @Get('refunds')
  @ApiOperation({ summary: 'List refund logs' })
  listRefunds(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit: number,
  ) {
    return this.admin.listRefunds({ page, limit: Math.min(limit, 100) });
  }

  @Post('refunds')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Execute a manual admin refund through a selected payout rail' })
  createRefund(@Req() req: AuthenticatedRequest, @Body() dto: Record<string, unknown>) {
    const amount = Number(dto.amount);
    if (!dto.transactionId || !dto.phone || !dto.country || !dto.providerCode || !Number.isFinite(amount)) {
      throw new BadRequestException('transactionId, amount, phone, country and providerCode are required');
    }
    return this.admin.createRefund(req.user.userId, {
      transactionId: String(dto.transactionId),
      amount,
      phone: String(dto.phone),
      country: String(dto.country),
      providerCode: String(dto.providerCode),
      aggregator: dto.aggregator == null ? undefined : String(dto.aggregator),
      reason: dto.reason == null ? undefined : String(dto.reason),
    }, req.ip);
  }

  @Post('refunds/declare')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a refundable payment as already refunded without triggering a provider payout' })
  declareRefunded(@Req() req: AuthenticatedRequest, @Body() dto: Record<string, unknown>) {
    const amount = dto.amount == null || dto.amount === '' ? undefined : Number(dto.amount);
    if (!dto.reference) {
      throw new BadRequestException('reference is required');
    }
    if (amount !== undefined && !Number.isFinite(amount)) {
      throw new BadRequestException('amount must be a valid number');
    }
    return this.admin.declareRefunded(req.user.userId, {
      reference: String(dto.reference),
      amount,
      note: dto.note == null ? undefined : String(dto.note),
    }, req.ip);
  }

  @Get('withdrawals')
  @ApiOperation({ summary: 'List admin withdrawal audit records' })
  listWithdrawals(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit: number,
  ) {
    return this.admin.listAdminWithdrawals({ page, limit: Math.min(limit, 100) });
  }

  @Post('withdrawals')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Execute a manual admin withdrawal through a selected payout rail' })
  createWithdrawal(@Req() req: AuthenticatedRequest, @Body() dto: Record<string, unknown>) {
    const amount = Number(dto.amount);
    if (!dto.amount || !dto.phone || !dto.country || !dto.providerCode || !Number.isFinite(amount)) {
      throw new BadRequestException('amount, phone, country and providerCode are required');
    }
    return this.admin.createAdminWithdrawal(req.user.userId, {
      amount,
      phone: String(dto.phone),
      country: String(dto.country),
      providerCode: String(dto.providerCode),
      aggregator: dto.aggregator == null ? undefined : String(dto.aggregator),
      note: dto.note == null ? undefined : String(dto.note),
    }, req.ip);
  }

  // ── KYC ──────────────────────────────────────────────────────────────────

  @Get('kyc')
  @ApiOperation({ summary: 'List KYC submissions' })
  @ApiQuery({ name: 'status', required: false, enum: ['PENDING', 'VERIFIED', 'REJECTED'] })
  listKyc(
    @Query('page',   new DefaultValuePipe(1),  ParseIntPipe) page: number,
    @Query('limit',  new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('status') status?: string,
  ) {
    return this.admin.listKyc({ page, limit, status });
  }

  @Patch('kyc/:id/review')
  @ApiOperation({ summary: 'Approve or reject a KYC submission' })
  reviewKyc(
    @Req() req: AuthenticatedRequest,
    @Param('id') kycId: string,
    @Body('decision') decision: 'VERIFIED' | 'REJECTED',
    @Body('reason') reason?: string,
  ) {
    return this.admin.reviewKyc(req.user.userId, kycId, decision, reason, req.ip);
  }

  // ── Merchants ──────────────────────────────────────────────────────────────

  @Get('merchants')
  @ApiOperation({ summary: 'List merchant applications' })
  @ApiQuery({ name: 'status', required: false, enum: ['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'] })
  listMerchants(
    @Query('page',   new DefaultValuePipe(1),  ParseIntPipe) page: number,
    @Query('limit',  new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('status') status?: string,
  ) {
    return this.admin.listMerchants({ page, limit, status });
  }

  @Patch('merchants/:id/review')
  @ApiOperation({ summary: 'Approve or reject a merchant application' })
  reviewMerchant(
    @Req() req: AuthenticatedRequest,
    @Param('id') merchantId: string,
    @Body('decision') decision: 'APPROVED' | 'REJECTED',
    @Body('reason') reason?: string,
  ) {
    return this.admin.reviewMerchant(req.user.userId, merchantId, decision, reason, req.ip);
  }

  @Get('merchants/:id')
  @ApiOperation({ summary: 'Full detail + activity stats for one merchant' })
  getMerchantDetail(@Param('id') id: string) {
    return this.admin.getMerchantDetail(id);
  }

  @Patch('merchants/:id/suspend')
  @ApiOperation({ summary: 'Suspend (ban) an approved merchant' })
  suspendMerchant(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body('reason') reason?: string) {
    return this.admin.setMerchantStatus(req.user.userId, id, 'SUSPEND', reason, req.ip);
  }

  @Patch('merchants/:id/reactivate')
  @ApiOperation({ summary: 'Reactivate a suspended merchant' })
  reactivateMerchant(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.admin.setMerchantStatus(req.user.userId, id, 'REACTIVATE', undefined, req.ip);
  }

  // ── Merchant payout routing + cash-outs ──────────────────────────────────

  @Get('merchant-settings')
  @ApiOperation({ summary: 'Platform merchant settings (auto-route payout toggle)' })
  getMerchantSettings() {
    return this.admin.getMerchantSettings();
  }

  @Patch('merchant-settings')
  @ApiOperation({ summary: 'Toggle whether merchant payments auto-route (vs hold to wallet)' })
  setMerchantSettings(@Body('merchantAutoRoutePayout') enabled: boolean) {
    return this.admin.setMerchantAutoRoute(!!enabled);
  }

  @Patch('merchant-settings/min-withdrawal')
  @ApiOperation({ summary: 'Set the minimum withdrawal amount merchants can request' })
  setMinWithdrawal(@Body('minWithdrawalAmount') amount: number) {
    return this.admin.setMinWithdrawal(Number(amount));
  }

  @Get('cashouts')
  @ApiOperation({ summary: 'List merchant cash-out requests' })
  @ApiQuery({ name: 'status', required: false, enum: ['PENDING', 'PAID', 'REJECTED', 'FAILED'] })
  listCashouts(@Query('status') status?: string) {
    return this.cashouts.adminList(status);
  }

  @Get('cashouts/:id')
  @ApiOperation({ summary: 'Cash-out review detail (balance, destination, history)' })
  getCashoutDetail(@Param('id') id: string) {
    return this.cashouts.adminGetCashoutDetail(id);
  }

  @Patch('cashouts/:id/approve')
  @ApiOperation({ summary: 'Approve a cash-out — executes the payout' })
  approveCashout(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.cashouts.approve(req.user.userId, id);
  }

  @Patch('cashouts/:id/reject')
  @ApiOperation({ summary: 'Reject a cash-out — refunds the wallet' })
  rejectCashout(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body('reason') reason?: string) {
    return this.cashouts.reject(req.user.userId, id, reason);
  }

  // ── Country & Provider Management ────────────────────────────────────────

  @Get('countries')
  @ApiOperation({ summary: 'All countries with their Netwalletpay providers (active + inactive)' })
  listCountries() {
    return this.admin.listCountriesWithProviders();
  }

  @Patch('countries/:iso2/toggle')
  @ApiOperation({ summary: 'Enable or disable a country (removes it from payment wizard)' })
  toggleCountry(@Req() req: AuthenticatedRequest, @Param('iso2') iso2: string) {
    return this.admin.toggleCountry(req.user.userId, iso2.toUpperCase(), req.ip);
  }

  @Patch('providers/:code/toggle')
  @ApiOperation({ summary: 'Enable or disable a single payment provider' })
  toggleProvider(@Req() req: AuthenticatedRequest, @Param('code') code: string) {
    return this.admin.toggleProvider(req.user.userId, code, req.ip);
  }

  @Post('providers/import')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Add (or re-activate) a provider into our DB — e.g. pull a missing Netwalletpay provider from the live lookup' })
  importProvider(
    @Req() req: AuthenticatedRequest,
    @Body('country')      country: string,
    @Body('method')       method: string,
    @Body('providerCode') providerCode: string,
    @Body('name')         name: string,
    @Body('aggregator')   aggregator?: string,
  ) {
    if (!country || !method || !providerCode || !name) {
      throw new BadRequestException('country, method, providerCode and name are required');
    }
    return this.admin.importProvider(
      req.user.userId,
      { country, method: method.toUpperCase(), providerCode: providerCode.trim(), name: name.trim(), aggregator },
      req.ip,
    );
  }

  @Delete('providers/:code')
  @ApiOperation({ summary: 'Delete a provider (deactivates instead if still referenced)' })
  deleteProvider(@Req() req: AuthenticatedRequest, @Param('code') code: string) {
    return this.admin.deleteProvider(req.user.userId, code, req.ip);
  }

  @Post('providers/test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Query Netwalletpay API for providers — shows what they have vs our DB' })
  testProvider(
    @Body('country')     country: string,
    @Body('method')      method: string,
    @Body('paymentType') paymentType: string,
  ) {
    if (!country || !method || !paymentType) {
      throw new BadRequestException('country, method and paymentType are required');
    }
    return this.admin.testProvider(country.toUpperCase(), method.toUpperCase(), paymentType.toUpperCase() as 'COLLECTION' | 'PAYOUT');
  }

  @Post('providers/test-transaction')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Fire a real COLLECTION or PAYOUT request at Netwalletpay to verify a provider is live' })
  testTransaction(
    @Req() req: AuthenticatedRequest,
    @Body('country')     country: string,
    @Body('providerCode') providerCode: string,
    @Body('paymentType') paymentType: string,
    @Body('phone')       phone: string,
    @Body('amount')      amount: number,
  ) {
    if (!country || !providerCode || !paymentType || !phone || !amount) {
      throw new BadRequestException('country, providerCode, paymentType, phone and amount are required');
    }
    return this.admin.testTransaction({
      country: country.toUpperCase(),
      providerCode,
      paymentType: paymentType.toUpperCase() as 'COLLECTION' | 'PAYOUT',
      phone,
      amount: Number(amount),
      adminId: req.user.userId,
    }, req.ip);
  }

  // ── Aggregator Management ─────────────────────────────────────────────────

  @Get('aggregators')
  @ApiOperation({ summary: 'List all aggregators with priority, status and active provider counts' })
  listAggregators() {
    return this.admin.listAggregators();
  }

  @Patch('aggregators/:code/toggle')
  @ApiOperation({ summary: 'Enable or disable an aggregator' })
  toggleAggregator(@Req() req: AuthenticatedRequest, @Param('code') code: string) {
    return this.admin.toggleAggregator(req.user.userId, code, req.ip);
  }

  @Patch('aggregators/:code/priority')
  @ApiOperation({ summary: 'Set routing priority for an aggregator (lower = tried first)' })
  setAggregatorPriority(
    @Req() req: AuthenticatedRequest,
    @Param('code') code: string,
    @Body('priority') priority: number,
  ) {
    if (priority == null) throw new BadRequestException('priority is required');
    return this.admin.setAggregatorPriority(req.user.userId, code, Number(priority), req.ip);
  }

  // ── Transaction Limits ────────────────────────────────────────────────────

  @Get('limits')
  @ApiOperation({ summary: 'List all transaction limits' })
  listLimits() {
    return this.admin.listLimits();
  }

  @Post('limits')
  @ApiOperation({ summary: 'Create or update a transaction limit for a currency' })
  upsertLimit(
    @Req() req: AuthenticatedRequest,
    @Body('currencyCode') currencyCode: string,
    @Body('minAmount')    minAmount: number,
    @Body('maxAmount')    maxAmount: number,
  ) {
    if (!currencyCode || minAmount == null || maxAmount == null) {
      throw new BadRequestException('currencyCode, minAmount and maxAmount are required');
    }
    return this.admin.upsertLimit(req.user.userId, currencyCode, Number(minAmount), Number(maxAmount), req.ip);
  }

  @Patch('limits/:code/toggle')
  @ApiOperation({ summary: 'Enable or disable a transaction limit' })
  toggleLimit(@Req() req: AuthenticatedRequest, @Param('code') code: string) {
    return this.admin.toggleLimit(req.user.userId, code, req.ip);
  }

  // ── Pricing (admin-audited) ───────────────────────────────────────────────

  @Get('pricing')
  @ApiOperation({ summary: 'List all fee configurations' })
  listPricing() {
    return this.admin.listAdminPricing();
  }

  @Post('pricing')
  @ApiOperation({ summary: 'Create a fee configuration rule' })
  createPricing(@Req() req: AuthenticatedRequest, @Body() dto: Record<string, unknown>) {
    return this.admin.createPricing(req.user.userId, dto, req.ip);
  }

  @Patch('pricing/:id')
  @ApiOperation({ summary: 'Update a fee configuration rule' })
  updatePricing(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: Record<string, unknown>,
  ) {
    return this.admin.updatePricing(req.user.userId, id, dto, req.ip);
  }

  @Delete('pricing/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a fee configuration rule' })
  deletePricing(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.admin.deletePricing(req.user.userId, id, req.ip);
  }

  @Patch('pricing/:id/toggle')
  @ApiOperation({ summary: 'Toggle a fee configuration active state' })
  togglePricing(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.admin.togglePricing(req.user.userId, id, req.ip);
  }

  // ── Audit log ─────────────────────────────────────────────────────────────

  @Get('audit-log')
  @ApiOperation({ summary: 'View admin audit trail' })
  getAuditLog(
    @Query('page',    new DefaultValuePipe(1),  ParseIntPipe) page: number,
    @Query('limit',   new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('adminId') adminId?: string,
    @Query('action')  action?: string,
  ) {
    return this.admin.getAuditLog({ page, limit: Math.min(limit, 200), adminId, action });
  }
}
