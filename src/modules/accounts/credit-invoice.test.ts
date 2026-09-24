import { describe, expect, it } from 'vitest';
import {
  addMonths,
  closingDate,
  installmentSchedule,
  invoiceMonthFor,
  splitInstallments,
  summarizeCredit,
  type CreditPurchase,
} from './credit-invoice.js';

const purchase = (date: string, amountCents: number, installments = 1): CreditPurchase => ({
  amountCents,
  installments,
  occurredAt: new Date(`${date}T00:00:00.000Z`),
});

describe('invoiceMonthFor (fechamento dia 5)', () => {
  it.each([
    ['2026-09-04', '2026-09', 'antes do fechamento: fatura que fecha no mesmo mês'],
    ['2026-09-05', '2026-10', 'no dia do fechamento: próxima fatura'],
    ['2026-09-24', '2026-10', 'depois do fechamento: próxima fatura'],
    ['2026-12-20', '2027-01', 'dezembro depois do fechamento: vira o ano'],
  ])('%s → %s (%s)', (date, month) => {
    expect(invoiceMonthFor(date, 5)).toBe(month);
  });

  it('fechamento dia 31 em fevereiro usa o último dia do mês', () => {
    expect(closingDate('2027-02', 31)).toBe('2027-02-28');
    expect(invoiceMonthFor('2027-02-27', 31)).toBe('2027-02');
    expect(invoiceMonthFor('2027-02-28', 31)).toBe('2027-03');
  });
});

describe('parcelas', () => {
  it('a primeira parcela fica com o resto dos centavos', () => {
    expect(splitInstallments(10000, 3)).toEqual([3334, 3333, 3333]);
    expect(splitInstallments(30000, 3)).toEqual([10000, 10000, 10000]);
  });

  it('cada parcela cai numa fatura seguinte, atravessando o ano', () => {
    expect(installmentSchedule(purchase('2026-11-20', 30000, 3), 5)).toEqual([
      { invoiceMonth: '2026-12', amountCents: 10000 },
      { invoiceMonth: '2027-01', amountCents: 10000 },
      { invoiceMonth: '2027-02', amountCents: 10000 },
    ]);
  });

  it('addMonths', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2027-01', -1)).toBe('2026-12');
  });
});

describe('summarizeCredit', () => {
  const base = {
    closingDay: 5,
    limitCents: 300000,
    adjustmentCents: 0,
    paidMonths: [] as string[],
    today: '2026-09-24',
  };

  it('fatura aberta e disponível com compra à vista', () => {
    const summary = summarizeCredit({ ...base, purchases: [purchase('2026-09-24', 50000)] });

    expect(summary).toMatchObject({
      openInvoiceMonth: '2026-10',
      openInvoiceCents: 50000,
      openInvoiceClosesOn: '2026-10-05',
      availableCents: 250000,
      oldestUnpaidClosed: null,
    });
  });

  it('parcelado: a fatura mostra só a parcela, mas o limite reserva o total', () => {
    const summary = summarizeCredit({ ...base, purchases: [purchase('2026-09-24', 30000, 3)] });

    expect(summary.openInvoiceCents).toBe(10000);
    expect(summary.availableCents).toBe(270000);
  });

  it('fatura fechada e não paga aparece para marcar como paga', () => {
    const summary = summarizeCredit({
      ...base,
      purchases: [purchase('2026-08-20', 12000), purchase('2026-09-10', 8000)],
    });

    expect(summary.oldestUnpaidClosed).toEqual({ month: '2026-09', cents: 12000 });
    expect(summary.availableCents).toBe(280000);
  });

  it('pagar a fatura libera o limite dela, mas não o das parcelas futuras', () => {
    const summary = summarizeCredit({
      ...base,
      purchases: [purchase('2026-08-20', 30000, 3)],
      paidMonths: ['2026-09'],
    });

    // Parcela de set/2026 paga; out e nov continuam reservando o limite.
    expect(summary.availableCents).toBe(280000);
    expect(summary.oldestUnpaidClosed).toBeNull();
  });

  it('sem limite informado, não calcula disponível', () => {
    const summary = summarizeCredit({ ...base, limitCents: null, purchases: [] });

    expect(summary.availableCents).toBeNull();
  });

  it('o ajuste soma ao disponível calculado', () => {
    const summary = summarizeCredit({ ...base, adjustmentCents: -45000, purchases: [] });

    expect(summary.availableCents).toBe(255000);
  });
});
