import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';
import {
  dateWindow,
  findDuplicateInvoice,
  findDuplicatePayment,
  findDuplicateBill,
  findDuplicatePurchase,
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

  it('matches every linked transaction as a set: order, repeats and txn_type case do not matter', async () => {
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
      line: [{
        linked_txn: [
          { txn_id: '501', txn_type: 'invoice' },
          { txn_id: '9', txn_type: 'creditmemo' },
          { txn_id: '502', txn_type: 'Invoice' },
          { txn_id: '501', txn_type: 'Invoice' },
        ],
      }],
    });

    expect(hit).toBe(existing);
  });

  it('does not match when only a non-invoice link differs: the credit memo counts too', async () => {
    const existing = {
      ...paymentFor('65', 575, ['501', '502']),
      Line: [{ Amount: 575, LinkedTxn: [{ TxnId: '501', TxnType: 'Invoice' }, { TxnId: '502', TxnType: 'Invoice' }, { TxnId: '9', TxnType: 'CreditMemo' }] }],
    };
    respondWith([existing]);

    const hit = await findDuplicatePayment(qb, {
      customer_ref: '7', total_amt: 575, txn_date: '2026-10-07',
      line: [{ linked_txn: [{ txn_id: '501', txn_type: 'Invoice' }, { txn_id: '502', txn_type: 'Invoice' }] }],
    });

    expect(hit).toBeNull();
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

  it('treats $0 payments (credit memo applications) like any other: different invoices are not duplicates', async () => {
    // A $0 payment applying credit memo 456 to invoice 123 already exists.
    const applied = paymentFor('67', 0, ['123'], {
      Line: [
        { Amount: 0, LinkedTxn: [{ TxnId: '123', TxnType: 'Invoice' }] },
        { Amount: 50, LinkedTxn: [{ TxnId: '456', TxnType: 'CreditMemo' }] },
      ],
    });
    respondWith([applied]);
    const zeroFor = (invoiceId: string, creditMemoId: string) => ({
      customer_ref: '7',
      total_amt: 0,
      txn_date: '2026-10-07',
      line: [
        { amount: 0, linked_txn: [{ txn_id: invoiceId, txn_type: 'Invoice' }] },
        { amount: 50, linked_txn: [{ txn_id: creditMemoId, txn_type: 'CreditMemo' }] },
      ],
    });

    // Positive control: the same $0 application again is refused, so the check does run on $0.
    expect(await findDuplicatePayment(qb, zeroFor('123', '456'))).toBe(applied);
    // A $0 payment applying a credit memo to a different invoice is not a duplicate.
    expect(await findDuplicatePayment(qb, zeroFor('124', '457'))).toBeNull();
  });

  it('does not refuse a $0 payment applying a different credit memo to the same invoice', async () => {
    // Credit memo 456 was applied to invoice 123; now credit memo 457 is applied to it too.
    const applied = paymentFor('68', 0, ['123'], {
      Line: [
        { Amount: 0, LinkedTxn: [{ TxnId: '123', TxnType: 'Invoice' }] },
        { Amount: 50, LinkedTxn: [{ TxnId: '456', TxnType: 'CreditMemo' }] },
      ],
    });
    respondWith([applied]);

    const hit = await findDuplicatePayment(qb, {
      customer_ref: '7',
      total_amt: 0,
      txn_date: '2026-10-07',
      line: [
        { linked_txn: [{ txn_id: '123', txn_type: 'Invoice' }] },
        { linked_txn: [{ txn_id: '457', txn_type: 'CreditMemo' }] },
      ],
    });

    expect(hit).toBeNull();
  });

  it('rejects when findPayments calls back with an error', async () => {
    qb.findPayments.mockImplementation((_c: any, cb: any) => cb(new Error('QBO down'), null));

    await expect(findDuplicatePayment(qb, { customer_ref: '7', total_amt: 1 })).rejects.toThrow('QBO down');
  });
});

describe('findDuplicateBill', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  // ours = 150.25: one account line, one item line, and a subtotal line that does not count.
  const bill = {
    VendorRef: { value: '56' },
    TxnDate: '2026-11-05',
    Line: [
      { Amount: 100, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: '1' } } },
      { Amount: 50.25, DetailType: 'ItemBasedExpenseLineDetail', ItemBasedExpenseLineDetail: { ItemRef: { value: '2' } } },
      { Amount: 150.25, DetailType: 'SubTotalLineDetail' },
    ],
  };
  const respondWith = (bills: any[]) =>
    qb.findBills.mockImplementation((_c: any, cb: any) => cb(null, { QueryResponse: { Bill: bills } }));

  describe('by DocNumber', () => {
    const numbered = { ...bill, DocNumber: 'INV-1042' };

    it('queries VendorRef + DocNumber, with no date window, and returns the first hit', async () => {
      const existing = { Id: '900', DocNumber: 'INV-1042' };
      respondWith([existing, { Id: '901' }]);

      const hit = await findDuplicateBill(qb, numbered);

      expect(hit).toBe(existing);
      expect(qb.findBills.mock.calls[0][0]).toEqual([
        { field: 'VendorRef', value: '56', operator: '=' },
        { field: 'DocNumber', value: 'INV-1042', operator: '=' },
      ]);
    });

    it('returns null when that vendor has no bill with the DocNumber (no amount fallback)', async () => {
      qb.findBills.mockImplementation((_c: any, cb: any) => cb(null, { QueryResponse: {} }));

      const hit = await findDuplicateBill(qb, numbered);

      expect(hit).toBeNull();
      expect(qb.findBills).toHaveBeenCalledTimes(1);
    });
  });

  describe('by vendor, date and line total', () => {
    it('queries VendorRef + date window + limit 50', async () => {
      respondWith([]);

      await findDuplicateBill(qb, bill);

      expect(qb.findBills.mock.calls[0][0]).toEqual([
        { field: 'VendorRef', value: '56', operator: '=' },
        { field: 'TxnDate', value: '2026-11-05', operator: '=' },
        { field: 'limit', value: 50 },
      ]);
    });

    it('returns the bill whose expense lines sum to ours within a cent, ignoring other line types', async () => {
      const other = { Id: '1', Line: [{ DetailType: 'AccountBasedExpenseLineDetail', Amount: 99 }] };
      const match = {
        Id: '2',
        Line: [
          { DetailType: 'AccountBasedExpenseLineDetail', Amount: 150.26 }, // one cent off: inside the tolerance
          { DetailType: 'SubTotalLineDetail', Amount: 150.26 },
        ],
      };
      respondWith([other, match]);

      expect(await findDuplicateBill(qb, bill)).toBe(match);
    });

    it('counts a line by its detail object when it has no DetailType', async () => {
      const match = { Id: '3', Line: [{ DetailType: 'AccountBasedExpenseLineDetail', Amount: 70 }] };
      respondWith([match]);

      const hit = await findDuplicateBill(qb, {
        VendorRef: { value: '56' },
        Line: [
          { Amount: 50, AccountBasedExpenseLineDetail: { AccountRef: { value: '1' } } },
          { Amount: 20, ItemBasedExpenseLineDetail: { ItemRef: { value: '2' } } },
        ],
      });

      expect(hit).toBe(match);
    });

    it('returns null when no bill total is within a cent of ours', async () => {
      respondWith([{ Id: '4', Line: [{ DetailType: 'AccountBasedExpenseLineDetail', Amount: 150.27 }] }]);

      expect(await findDuplicateBill(qb, bill)).toBeNull();
    });

    it('treats a bill with no lines as $0, so it does not match', async () => {
      respondWith([{ Id: '5' }]);

      expect(await findDuplicateBill(qb, bill)).toBeNull();
    });

    it('returns null when the vendor has no bills in the window', async () => {
      qb.findBills.mockImplementation((_c: any, cb: any) => cb(null, { QueryResponse: {} }));

      expect(await findDuplicateBill(qb, bill)).toBeNull();
    });
  });

  it('returns null without querying when the bill has no VendorRef (QBO rejects it anyway)', async () => {
    expect(await findDuplicateBill(qb, { Line: bill.Line })).toBeNull();
    expect(qb.findBills).not.toHaveBeenCalled();
  });

  it('rejects when findBills calls back with an error', async () => {
    qb.findBills.mockImplementation((_c: any, cb: any) => cb(new Error('QBO down'), null));

    await expect(findDuplicateBill(qb, bill)).rejects.toThrow('QBO down');
  });
});

describe('findDuplicatePurchase', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  const purchase = {
    PaymentType: 'CreditCard',
    AccountRef: { value: '42' },
    EntityRef: { value: '9', type: 'Vendor' },
    TxnDate: '2026-11-05',
    Line: [{ Amount: 86.25, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: '7' } } }],
  };
  // An existing QBO Purchase that matches `purchase` in every compared field.
  const existing = (extra: Record<string, any> = {}) => ({
    Id: '300',
    PaymentType: 'CreditCard',
    AccountRef: { value: '42', name: 'Visa' },
    EntityRef: { value: '9', name: 'Coastal Fuel', type: 'Vendor' },
    TxnDate: '2026-11-05',
    TotalAmt: 99.19,
    Line: [{ Amount: 86.25, DetailType: 'AccountBasedExpenseLineDetail' }],
    ...extra,
  });
  const respondWith = (purchases: any[]) =>
    qb.findPurchases.mockImplementation((_c: any, cb: any) => cb(null, { QueryResponse: { Purchase: purchases } }));

  describe('by DocNumber', () => {
    const numbered = { ...purchase, DocNumber: '1007' };

    it('queries DocNumber only, with no date window (QBO cannot filter on account or payee)', async () => {
      respondWith([]);

      await findDuplicatePurchase(qb, numbered);

      expect(qb.findPurchases.mock.calls[0][0]).toEqual([{ field: 'DocNumber', value: '1007', operator: '=' }]);
    });

    it('returns the hit from the same account and payee, at any amount', async () => {
      const otherAccount = existing({ Id: '301', DocNumber: '1007', AccountRef: { value: '43' } });
      const otherPayee = existing({ Id: '302', DocNumber: '1007', EntityRef: { value: '10', type: 'Vendor' } });
      const match = existing({ Id: '303', DocNumber: '1007', Line: [] });
      respondWith([otherAccount, otherPayee, match]);

      expect(await findDuplicatePurchase(qb, numbered)).toBe(match);
    });

    it('returns null when the DocNumber exists only on other accounts (no amount fallback)', async () => {
      respondWith([existing({ DocNumber: '1007', AccountRef: { value: '43' } })]);

      expect(await findDuplicatePurchase(qb, numbered)).toBeNull();
      expect(qb.findPurchases).toHaveBeenCalledTimes(1);
    });

    it('returns null when no purchase has the DocNumber', async () => {
      qb.findPurchases.mockImplementation((_c: any, cb: any) => cb(null, { QueryResponse: {} }));

      expect(await findDuplicatePurchase(qb, numbered)).toBeNull();
    });
  });

  describe('by account, payee, date and line total', () => {
    it('queries the date window only, with limit 1000 (QBO page maximum)', async () => {
      respondWith([]);

      await findDuplicatePurchase(qb, purchase);

      expect(qb.findPurchases.mock.calls[0][0]).toEqual([
        { field: 'TxnDate', value: '2026-11-05', operator: '=' },
        { field: 'limit', value: 1000 },
      ]);
    });

    it('returns the purchase matching account, payment type, payee and line total (within a cent), not TotalAmt', async () => {
      const match = existing({ Line: [{ Amount: 86.24, DetailType: 'AccountBasedExpenseLineDetail' }] });
      respondWith([match]);

      expect(await findDuplicatePurchase(qb, purchase)).toBe(match);
    });

    it.each([
      ['another account', { AccountRef: { value: '43' } }],
      ['another payment type', { PaymentType: 'Cash' }],
      ['a credit-card credit rather than a charge', { Credit: true }],
      ['another payee', { EntityRef: { value: '10', type: 'Vendor' } }],
      ['a payee of another type with the same id', { EntityRef: { value: '9', type: 'Customer' } }],
      ['no payee', { EntityRef: undefined }],
      ['a line total two cents off', { Line: [{ Amount: 86.27, DetailType: 'AccountBasedExpenseLineDetail' }] }],
    ])('does not match %s', async (_label, difference) => {
      respondWith([existing(difference)]);

      expect(await findDuplicatePurchase(qb, purchase)).toBeNull();
    });

    it('compares payee ids as strings and payee types case-insensitively', async () => {
      const match = existing({ EntityRef: { value: 9, type: 'vendor' } });
      respondWith([match]);

      expect(await findDuplicatePurchase(qb, purchase)).toBe(match);
    });

    it('matches on the payee id alone when either side has no payee type', async () => {
      const match = existing({ EntityRef: { value: '9' } });
      respondWith([match]);

      expect(await findDuplicatePurchase(qb, { ...purchase, EntityRef: { value: '9' } })).toBe(match);
      expect(await findDuplicatePurchase(qb, purchase)).toBe(match);
    });

    it('matches two purchases that both have no payee', async () => {
      const match = existing({ EntityRef: undefined });
      respondWith([match]);

      expect(await findDuplicatePurchase(qb, { ...purchase, EntityRef: undefined })).toBe(match);
    });

    it('returns null when nothing was purchased in the window', async () => {
      qb.findPurchases.mockImplementation((_c: any, cb: any) => cb(null, { QueryResponse: {} }));

      expect(await findDuplicatePurchase(qb, purchase)).toBeNull();
    });
  });

  it.each([
    ['no purchase at all', undefined],
    ['a purchase with no AccountRef', { PaymentType: 'Cash', Line: purchase.Line }],
  ])('returns null without querying for %s (QBO rejects it anyway)', async (_label, input) => {
    expect(await findDuplicatePurchase(qb, input)).toBeNull();
    expect(qb.findPurchases).not.toHaveBeenCalled();
  });

  it('rejects when findPurchases calls back with an error', async () => {
    qb.findPurchases.mockImplementation((_c: any, cb: any) => cb(new Error('QBO down'), null));

    await expect(findDuplicatePurchase(qb, purchase)).rejects.toThrow('QBO down');
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

  it('names the vendor of a bill', () => {
    const hit = { Id: '900', DocNumber: 'INV-1042', TotalAmt: 172.79, TxnDate: '2026-11-05', VendorRef: { value: '56', name: 'Harbour Lumber' } };
    expect(describeHit('Bill', hit)).toBe(
      'Bill already exists: Id 900, #INV-1042, $172.79, 2026-11-05, vendor Harbour Lumber.'
    );
  });

  it('names the payee and the account of a purchase', () => {
    const hit = { Id: '300', TotalAmt: 99.19, TxnDate: '2026-11-05', EntityRef: { value: '9', name: 'Coastal Fuel' }, AccountRef: { value: '42', name: 'Visa' } };
    expect(describeHit('Purchase', hit)).toBe(
      'Purchase already exists: Id 300, #n/a, $99.19, 2026-11-05, payee Coastal Fuel, account Visa.'
    );
  });

  it('leaves out a party it does not have, instead of printing undefined', () => {
    const hit = { Id: '301', TotalAmt: 4.12, TxnDate: '2026-11-05', AccountRef: { value: '1150040002' } };
    expect(describeHit('Purchase', hit)).toBe('Purchase already exists: Id 301, #n/a, $4.12, 2026-11-05, account 1150040002.');
  });
});
