import type { PrismaClient } from '../../generated/prisma/client.js';

/** Faturas de cartão de crédito marcadas como pagas. */
export interface InvoicePaymentRepository {
  /** Meses ("YYYY-MM") das faturas pagas deste cartão. */
  listPaidMonths(accountId: number): Promise<string[]>;
  /** Idempotente: marcar duas vezes a mesma fatura não duplica. */
  markPaid(payment: NewInvoicePayment): Promise<void>;
  /** Total de faturas pagas com dinheiro desta conta bancária (entra no saldo dela). */
  sumPaidFrom(bankAccountId: number): Promise<number>;
}

export interface NewInvoicePayment {
  /** O cartão de crédito. */
  accountId: number;
  invoiceMonth: string;
  amountCents: number;
  paidFromAccountId: number | null;
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

  async markPaid(payment: NewInvoicePayment): Promise<void> {
    const { accountId, invoiceMonth } = payment;
    await this.prisma.invoicePayment.upsert({
      where: { accountId_invoiceMonth: { accountId, invoiceMonth } },
      create: payment,
      update: {},
    });
  }

  async sumPaidFrom(bankAccountId: number): Promise<number> {
    const { _sum } = await this.prisma.invoicePayment.aggregate({
      where: { paidFromAccountId: bankAccountId },
      _sum: { amountCents: true },
    });
    return _sum.amountCents ?? 0;
  }
}
