import type { PrismaClient } from '../../generated/prisma/client.js';

/** Faturas de cartão de crédito marcadas como pagas. */
export interface InvoicePaymentRepository {
  /** Meses ("YYYY-MM") das faturas pagas deste cartão. */
  listPaidMonths(accountId: number): Promise<string[]>;
  /** Idempotente: marcar duas vezes a mesma fatura não duplica. */
  markPaid(accountId: number, invoiceMonth: string): Promise<void>;
}

export class PrismaInvoicePaymentRepository implements InvoicePaymentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listPaidMonths(accountId: number): Promise<string[]> {
    const rows = await this.prisma.invoicePayment.findMany({
      where: { accountId },
      select: { invoiceMonth: true },
    });
    return rows.map((row) => row.invoiceMonth);
  }

  async markPaid(accountId: number, invoiceMonth: string): Promise<void> {
    await this.prisma.invoicePayment.upsert({
      where: { accountId_invoiceMonth: { accountId, invoiceMonth } },
      create: { accountId, invoiceMonth },
      update: {},
    });
  }
}
