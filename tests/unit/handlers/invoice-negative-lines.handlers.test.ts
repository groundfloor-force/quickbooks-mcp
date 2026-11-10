import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockQuickbooksClient, mockQuickbooksClientClass, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';

// Negative invoice lines (staff adjustments, e.g. GorillaDesk #44083: lines 0, 75, 3 x 60, 3 x 40, 50 and
// an "Adjustment" of -77.50). A line may be negative or zero; only an invoice whose TOTAL would be below
// zero is refused -- before anything reaches QuickBooks.
jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));

const { createQuickbooksInvoice } = await import('../../../src/handlers/create-quickbooks-invoice.handler');
const { updateQuickbooksInvoice } = await import('../../../src/handlers/update-quickbooks-invoice.handler');

const sales = (amount: number) => ({ DetailType: 'SalesItemLineDetail', Amount: amount, SalesItemLineDetail: { ItemRef: { value: '26' } } });
const discount = (amount: number) => ({ DetailType: 'DiscountLineDetail', Amount: amount, DiscountLineDetail: { PercentBased: false } });

describe('create_invoice with negative lines', () => {
  beforeEach(() => {
    resetAllMocks();
    // The duplicate guard runs on every create: no matching invoice exists.
    mockQuickBooksInstance.findInvoices.mockImplementation((_c: any, cb: any) => cb(null, { QueryResponse: {} }));
  });

  it('accepts a negative line (and a $0 line) when the invoice total stays at or above zero', async () => {
    mockQuickBooksInstance.createInvoice.mockImplementation((payload: any, cb: any) => cb(null, { Id: '1', TotalAmt: 399.63 }));
    const result = await createQuickbooksInvoice({
      customer_ref: 'cust-1',
      line_items: [
        { item_ref: '26', qty: 1, unit_price: 0 },
        { item_ref: '26', qty: 1, unit_price: 75 },
        { item_ref: '26', qty: 3, unit_price: 60 },
        { item_ref: '26', qty: 3, unit_price: 40 },
        { item_ref: '26', qty: 1, unit_price: 50 },
        { item_ref: '27', qty: 1, unit_price: -77.5, description: 'Adjustment' },
      ],
    });
    expect(result.isError).toBe(false);
    expect(mockQuickBooksInstance.findInvoices).toHaveBeenCalledTimes(1); // the duplicate guard still ran
    const payload = (mockQuickBooksInstance.createInvoice.mock.calls[0] as any)[0];
    expect(payload.Line[0].Amount).toBe(0);
    expect(payload.Line[5].Amount).toBe(-77.5);
    expect(payload.Line[5].SalesItemLineDetail.UnitPrice).toBe(-77.5);
  });

  it('accepts an invoice whose lines net to exactly zero', async () => {
    mockQuickBooksInstance.createInvoice.mockImplementation((payload: any, cb: any) => cb(null, { Id: '2', TotalAmt: 0 }));
    const result = await createQuickbooksInvoice({
      customer_ref: 'cust-1',
      line_items: [{ item_ref: '26', qty: 1, unit_price: 50 }, { item_ref: '27', qty: 1, unit_price: -50 }],
    });
    expect(result.isError).toBe(false);
    expect(mockQuickBooksInstance.createInvoice).toHaveBeenCalledTimes(1);
  });

  it('refuses an invoice whose total would be below zero, with a clear error, before calling QuickBooks', async () => {
    const result = await createQuickbooksInvoice({
      customer_ref: 'cust-1',
      line_items: [{ item_ref: '26', qty: 1, unit_price: 50 }, { item_ref: '27', qty: 2, unit_price: -30.01 }],
    });
    expect(result.isError).toBe(true);
    expect(result.error).toBe(
      'Invoice total would be below zero (-10.02). A line may be negative, but an invoice cannot total less than zero; use a credit memo for money owed to the customer.'
    );
    expect(mockQuickbooksClientClass.getInstance).not.toHaveBeenCalled();
    expect(mockQuickBooksInstance.findInvoices).not.toHaveBeenCalled();
    expect(mockQuickBooksInstance.createInvoice).not.toHaveBeenCalled();
  });

  it('still refuses a likely duplicate holding a negative line (the duplicate guard is not bypassed)', async () => {
    mockQuickBooksInstance.findInvoices.mockImplementation((_c: any, cb: any) =>
      cb(null, { QueryResponse: { Invoice: [{ Id: '55', DocNumber: '44083', TotalAmt: 22.5 }] } }));
    const result = await createQuickbooksInvoice({
      customer_ref: 'cust-1',
      doc_number: '44083',
      line_items: [{ item_ref: '26', qty: 1, unit_price: 100 }, { item_ref: '27', qty: 1, unit_price: -77.5 }],
    });
    expect(result.isError).toBe(true);
    expect(result.error).toMatch(/^Possible duplicate/);
    expect(mockQuickBooksInstance.createInvoice).not.toHaveBeenCalled();
  });

  it('sums in cents, so float noise never turns a zero total negative', async () => {
    mockQuickBooksInstance.createInvoice.mockImplementation((payload: any, cb: any) => cb(null, { Id: '3' }));
    const result = await createQuickbooksInvoice({
      customer_ref: 'cust-1',
      // 0.1 + 1.15 - 1.25 is exactly zero, but summed as floats x 100 it comes to -1.4e-14.
      line_items: [{ item_ref: '26', qty: 1, unit_price: 0.1 }, { item_ref: '26', qty: 1, unit_price: 1.15 }, { item_ref: '27', qty: 1, unit_price: -1.25 }],
    });
    expect(result.isError).toBe(false);
  });
});

describe('update_invoice with negative lines', () => {
  beforeEach(() => resetAllMocks());

  it('accepts a patch whose lines include a negative one when the total stays at or above zero', async () => {
    mockQuickBooksInstance.getInvoice.mockImplementation((id: any, cb: any) => cb(null, { Id: '9', SyncToken: '0', Line: [sales(100)] }));
    mockQuickBooksInstance.updateInvoice.mockImplementation((payload: any, cb: any) => cb(null, { Id: '9', SyncToken: '1' }));
    const result = await updateQuickbooksInvoice({ invoice_id: '9', patch: { SyncToken: '0', Line: [sales(100), sales(-77.5)] } });
    expect(result.isError).toBe(false);
    const payload = (mockQuickBooksInstance.updateInvoice.mock.calls[0] as any)[0];
    expect(payload.Line[1].Amount).toBe(-77.5);
  });

  it('refuses a patch whose lines would bring the total below zero (discount lines count), before any QuickBooks call', async () => {
    const result = await updateQuickbooksInvoice({ invoice_id: '9', patch: { Line: [sales(50), sales(-20), discount(40)] } });
    expect(result.isError).toBe(true);
    expect(result.error).toBe(
      'Invoice total would be below zero (-10.00). A line may be negative, but an invoice cannot total less than zero; use a credit memo for money owed to the customer.'
    );
    expect(mockQuickbooksClientClass.getInstance).not.toHaveBeenCalled();
    expect(mockQuickBooksInstance.getInvoice).not.toHaveBeenCalled();
    expect(mockQuickBooksInstance.updateInvoice).not.toHaveBeenCalled();
  });

  it('takes Qty x UnitPrice when a sales line carries no Amount', async () => {
    const result = await updateQuickbooksInvoice({
      invoice_id: '9',
      patch: { Line: [{ DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { Qty: 2, UnitPrice: -5 } }] },
    });
    expect(result.isError).toBe(true);
    expect(result.error).toContain('(-10.00)');
  });

  it('counts only sales and discount lines; a line it cannot price counts as zero (QuickBooks validates it)', async () => {
    mockQuickBooksInstance.getInvoice.mockImplementation((id: any, cb: any) => cb(null, { Id: '9', SyncToken: '0' }));
    mockQuickBooksInstance.updateInvoice.mockImplementation((payload: any, cb: any) => cb(null, { Id: '9', SyncToken: '1' }));
    const result = await updateQuickbooksInvoice({
      invoice_id: '9',
      patch: {
        Line: [
          sales(10),
          { DetailType: 'SubTotalLineDetail', Amount: -500 },
          { DetailType: 'SalesItemLineDetail' },
          { DetailType: 'DiscountLineDetail' },
          null,
        ],
      },
    });
    expect(result.isError).toBe(false);
    expect(mockQuickBooksInstance.updateInvoice).toHaveBeenCalledTimes(1);
  });

  it('reports a failed read of the invoice as an error, and updates nothing', async () => {
    mockQuickBooksInstance.getInvoice.mockImplementation((id: any, cb: any) => cb(new Error('Object Not Found')));
    const result = await updateQuickbooksInvoice({ invoice_id: '9', patch: { Line: [sales(10), sales(-5)] } });
    expect(result).toEqual({ result: null, isError: true, error: 'Error: Object Not Found' });
    expect(mockQuickBooksInstance.updateInvoice).not.toHaveBeenCalled();
  });

  it("reports QuickBooks' refusal of the update as an error", async () => {
    mockQuickBooksInstance.getInvoice.mockImplementation((id: any, cb: any) => cb(null, { Id: '9', SyncToken: '0' }));
    mockQuickBooksInstance.updateInvoice.mockImplementation((payload: any, cb: any) => cb(new Error('Stale Object Error')));
    const result = await updateQuickbooksInvoice({ invoice_id: '9', patch: { Line: [sales(10), sales(-5)] } });
    expect(result).toEqual({ result: null, isError: true, error: 'Error: Stale Object Error' });
  });

  it('leaves a patch without Line alone: the invoice lines are unchanged', async () => {
    mockQuickBooksInstance.getInvoice.mockImplementation((id: any, cb: any) => cb(null, { Id: '9', SyncToken: '0', Line: [sales(100)] }));
    mockQuickBooksInstance.updateInvoice.mockImplementation((payload: any, cb: any) => cb(null, { Id: '9', SyncToken: '1' }));
    const result = await updateQuickbooksInvoice({ invoice_id: '9', patch: { PrivateNote: 'note' } });
    expect(result.isError).toBe(false);
    expect(mockQuickBooksInstance.updateInvoice).toHaveBeenCalledTimes(1);
  });
});
