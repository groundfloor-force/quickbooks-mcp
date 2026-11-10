import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';
import {
  dateWindow,
  findDuplicateInvoice,
  findDuplicatePayment,
  describeHit,
} from '../../../src/helpers/duplicate-guard';

const qb = mockQuickBooksInstance as any;

describe('dateWindow', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('matches the exact TxnDate when one is given', () => {
    expect(dateWindow('2026-11-05')).toEqual([{ field: 'TxnDate', value: '2026-11-05', operator: '=' }]);
  });

  it('looks back 3 days (UTC) from today when no TxnDate is given', () => {
    // 02:00 UTC on Mar 2 is still Mar 1 in Atlantic time; the window is computed in UTC,
    // and crossing the month boundary proves real date arithmetic.
    jest.useFakeTimers({ now: new Date('2026-03-02T02:00:00Z') });
    expect(dateWindow()).toEqual([{ field: 'TxnDate', value: '2026-02-27', operator: '>=' }]);
  });
});

describe('findDuplicateInvoice', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  const lines = [
    { item_ref: '1', qty: 2, unit_price: 50 },
    { item_ref: '2', qty: 1, unit_price: 50.25 },
  ]; // ours = 150.25

  describe('by doc_number', () => {
    it('returns the first invoice with the same DocNumber, queried as an object', async () => {
      const existing = { Id: '900', DocNumber: '43975' };
      qb.findInvoices.mockImplementation((_c: any, cb: any) => cb(null, { QueryResponse: { Invoice: [existing, { Id: '901' }] } }));

      const hit = await findDuplicateInvoice(qb, { customer_ref: '7', doc_number: '43975', line_items: lines });

      expect(hit).toBe(existing);
      expect(qb.findInvoices.mock.calls[0][0]).toEqual({ DocNumber: '43975' });
    });

    it('returns null when no invoice has that DocNumber (no amount fallback)', async () => {
      qb.findInvoices.mockImplementation((_c: any, cb: any) => cb(null, { QueryResponse: {} }));

      const hit = await findDuplicateInvoice(qb, { customer_ref: '7', doc_number: '43975', line_items: lines });

      expect(hit).toBeNull();
      expect(qb.findInvoices).toHaveBeenCalledTimes(1);
    });
  });

  describe('by customer, date and line total', () => {
    it('queries CustomerRef + date window + limit 50', async () => {
      qb.findInvoices.mockImplementation((_c: any, cb: any) => cb(null, { QueryResponse: {} }));

      await findDuplicateInvoice(qb, { customer_ref: '7', txn_date: '2026-11-05', line_items: lines });

      expect(qb.findInvoices.mock.calls[0][0]).toEqual([
        { field: 'CustomerRef', value: '7', operator: '=' },
        { field: 'TxnDate', value: '2026-11-05', operator: '=' },
        { field: 'limit', value: 50 },
      ]);
    });

    it('returns the invoice whose SalesItemLineDetail amounts sum to ours, ignoring the subtotal line', async () => {
      const other = { Id: '1', Line: [{ DetailType: 'SalesItemLineDetail', Amount: 99 }] };
      const match = {
        Id: '2',
        Line: [
          { DetailType: 'SalesItemLineDetail', Amount: 100 },
          { DetailType: 'SalesItemLineDetail', Amount: 50.26 }, // one cent off: inside the ±0.01 tolerance
          { DetailType: 'SubTotalLineDetail', Amount: 150.26 },
        ],
      };
      qb.findInvoices.mockImplementation((_c: any, cb: any) => cb(null, { QueryResponse: { Invoice: [other, match] } }));

      const hit = await findDuplicateInvoice(qb, { customer_ref: '7', line_items: lines });

      expect(hit).toBe(match);
    });

    it('returns null when no invoice total is within a cent of ours', async () => {
      const twoCentsOff = { Id: '3', Line: [{ DetailType: 'SalesItemLineDetail', Amount: 150.27 }] };
      qb.findInvoices.mockImplementation((_c: any, cb: any) => cb(null, { QueryResponse: { Invoice: [twoCentsOff] } }));

      const hit = await findDuplicateInvoice(qb, { customer_ref: '7', line_items: lines });

      expect(hit).toBeNull();
    });

    it('treats an invoice with no lines as $0, so it does not match', async () => {
      qb.findInvoices.mockImplementation((_c: any, cb: any) => cb(null, { QueryResponse: { Invoice: [{ Id: '4' }] } }));

      const hit = await findDuplicateInvoice(qb, { customer_ref: '7', line_items: lines });

      expect(hit).toBeNull();
    });

    it('returns null when the customer has no invoices in the window', async () => {
      qb.findInvoices.mockImplementation((_c: any, cb: any) => cb(null, { QueryResponse: {} }));

      const hit = await findDuplicateInvoice(qb, { customer_ref: '7', line_items: lines });

      expect(hit).toBeNull();
    });
  });

  it('rejects when findInvoices calls back with an error', async () => {
    qb.findInvoices.mockImplementation((_c: any, cb: any) => cb(new Error('QBO down'), null));

    await expect(findDuplicateInvoice(qb, { customer_ref: '7', line_items: lines })).rejects.toThrow('QBO down');
  });
});

describe('findDuplicatePayment', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  // A QBO Payment applied to the given invoice ids, one line per invoice.
  const paymentFor = (id: string, amount: number, invoiceIds: string[], extra: Record<string, any> = {}) => ({
    Id: id,
    TotalAmt: amount,
    TxnDate: '2026-10-07',
    CustomerRef: { value: '7' },
    Line: invoiceIds.map((inv) => ({ Amount: amount / invoiceIds.length, LinkedTxn: [{ TxnId: inv, TxnType: 'Invoice' }] })),
    ...extra,
  });
  const appliedTo = (...invoiceIds: string[]) => [{ amount: 0, linked_txn: invoiceIds.map((id) => ({ txn_id: id, txn_type: 'Invoice' })) }];
  const respondWith = (payments: any[]) =>
    qb.findPayments.mockImplementation((_c: any, cb: any) => cb(null, { QueryResponse: { Payment: payments } }));

  it('queries CustomerRef + date window + limit 50 (amount is compared locally)', async () => {
    qb.findPayments.mockImplementation((_c: any, cb: any) => cb(null, { QueryResponse: {} }));

    await findDuplicatePayment(qb, { customer_ref: '7', total_amt: 287.5, txn_date: '2026-10-07' });

    expect(qb.findPayments.mock.calls[0][0]).toEqual([
      { field: 'CustomerRef', value: '7', operator: '=' },
      { field: 'TxnDate', value: '2026-10-07', operator: '=' },
      { field: 'limit', value: 50 },
    ]);
  });

  it('does not refuse the same customer paying the same amount against a different invoice on the same day', async () => {
    // Four $287.50 payments on Oct 7, one per invoice: the first three exist, this is the fourth.
    respondWith([paymentFor('61', 287.5, ['501']), paymentFor('62', 287.5, ['502']), paymentFor('63', 287.5, ['503'])]);

    const hit = await findDuplicatePayment(qb, {
      customer_ref: '7', total_amt: 287.5, txn_date: '2026-10-07', line: appliedTo('504'),
    });

    expect(hit).toBeNull();
  });

  it('refuses a payment with the same amount applied to the same invoice', async () => {
    const same = paymentFor('62', 287.5, ['502']);
    respondWith([paymentFor('61', 287.5, ['501']), same]);

    const hit = await findDuplicatePayment(qb, {
      customer_ref: '7', total_amt: 287.5, txn_date: '2026-10-07', line: appliedTo('502'),
    });

    expect(hit).toBe(same);
  });

  it('matches linked invoices as a set: order, repeats and txn_type case do not matter, non-invoice links are ignored', async () => {
    const existing = {
      ...paymentFor('64', 575, ['501', '502']),
      Line: [
        { Amount: 287.5, LinkedTxn: [{ TxnId: '502', TxnType: 'Invoice' }] },
        { Amount: 287.5, LinkedTxn: [{ TxnId: '501', TxnType: 'Invoice' }, { TxnId: '9', TxnType: 'CreditMemo' }] },
        { Amount: 0 }, // a line with no LinkedTxn
      ],
    };
    respondWith([existing]);

    const hit = await findDuplicatePayment(qb, {
      customer_ref: '7', total_amt: 575, txn_date: '2026-10-07',
      line: [{ linked_txn: [{ txn_id: '501', txn_type: 'invoice' }, { txn_id: '502', txn_type: 'Invoice' }, { txn_id: '501', txn_type: 'Invoice' }] }],
    });

    expect(hit).toBe(existing);
  });

  it('does not refuse the same invoices at a different amount', async () => {
    respondWith([paymentFor('62', 287.5, ['502'])]);

    const hit = await findDuplicatePayment(qb, {
      customer_ref: '7', total_amt: 100, txn_date: '2026-10-07', line: appliedTo('502'),
    });

    expect(hit).toBeNull();
  });

  it('refuses a matching PaymentRefNum even when the amount and invoices differ', async () => {
    const sameRef = paymentFor('65', 287.5, ['501'], { PaymentRefNum: 'EFT-9' });
    respondWith([paymentFor('61', 287.5, ['503']), sameRef]);

    const hit = await findDuplicatePayment(qb, {
      customer_ref: '7', total_amt: 100, txn_date: '2026-10-07', payment_ref_num: 'EFT-9', line: appliedTo('504'),
    });

    expect(hit).toBe(sameRef);
  });

  it('does not treat two payments with no PaymentRefNum as a reference match', async () => {
    respondWith([paymentFor('61', 287.5, ['501'])]); // no PaymentRefNum on either side

    const hit = await findDuplicatePayment(qb, {
      customer_ref: '7', total_amt: 287.5, txn_date: '2026-10-07', line: appliedTo('504'),
    });

    expect(hit).toBeNull();
  });

  it('refuses an unapplied payment when an unapplied payment of the same amount exists', async () => {
    const unapplied = { Id: '66', TotalAmt: 50, TxnDate: '2026-10-07', CustomerRef: { value: '7' } }; // no Line
    respondWith([unapplied]);

    const hit = await findDuplicatePayment(qb, { customer_ref: '7', total_amt: 50, txn_date: '2026-10-07' });

    expect(hit).toBe(unapplied);
  });

  it('returns null when the customer has no payments in the window', async () => {
    qb.findPayments.mockImplementation((_c: any, cb: any) => cb(null, { QueryResponse: {} }));

    const hit = await findDuplicatePayment(qb, { customer_ref: '7', total_amt: 150.25 });

    expect(hit).toBeNull();
  });

  it('rejects when findPayments calls back with an error', async () => {
    qb.findPayments.mockImplementation((_c: any, cb: any) => cb(new Error('QBO down'), null));

    await expect(findDuplicatePayment(qb, { customer_ref: '7', total_amt: 1 })).rejects.toThrow('QBO down');
  });
});

describe('describeHit', () => {
  it('uses DocNumber and the customer name when present', () => {
    const hit = { Id: '900', DocNumber: '43975', TotalAmt: 150.25, TxnDate: '2026-11-05', CustomerRef: { value: '7', name: 'Acme Ltd' } };
    expect(describeHit('Invoice', hit)).toBe(
      'Invoice already exists: Id 900, #43975, $150.25, 2026-11-05, customer Acme Ltd.'
    );
  });

  it('falls back to PaymentRefNum and the customer id', () => {
    const hit = { Id: '55', PaymentRefNum: 'EFT-1', TotalAmt: 20, TxnDate: '2026-11-06', CustomerRef: { value: '7' } };
    expect(describeHit('Payment', hit)).toBe(
      'Payment already exists: Id 55, #EFT-1, $20, 2026-11-06, customer 7.'
    );
  });

  it('shows n/a when there is no DocNumber or PaymentRefNum', () => {
    const hit = { Id: '56', TotalAmt: 20, TxnDate: '2026-11-06', CustomerRef: { value: '7' } };
    expect(describeHit('Payment', hit)).toBe(
      'Payment already exists: Id 56, #n/a, $20, 2026-11-06, customer 7.'
    );
  });
});
