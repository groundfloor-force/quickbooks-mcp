import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockQuickbooksClient, mockQuickbooksClientClass, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';

jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));

const { CreateInvoiceTool } = await import('../../../src/tools/create-invoice.tool');

const params = (unit_price: number, qty = 1) => ({ customer_ref: 'c1', line_items: [{ item_ref: '26', qty: 1, unit_price: 100 }, { item_ref: '27', qty, unit_price }] });

describe('create_invoice schema: line amounts', () => {
  beforeEach(() => {
    resetAllMocks();
    // The duplicate guard runs on every create: no matching invoice exists.
    mockQuickBooksInstance.findInvoices.mockImplementation((_c: any, cb: any) => cb(null, { QueryResponse: {} }));
  });

  it('accepts a negative unit_price and a zero one', () => {
    expect(CreateInvoiceTool.schema.safeParse(params(-77.5)).success).toBe(true);
    expect(CreateInvoiceTool.schema.safeParse(params(0)).success).toBe(true);
  });

  it('still requires a positive qty and a finite unit_price', () => {
    expect(CreateInvoiceTool.schema.safeParse(params(10, 0)).success).toBe(false);
    expect(CreateInvoiceTool.schema.safeParse(params(10, -1)).success).toBe(false);
    expect(CreateInvoiceTool.schema.safeParse(params(Number.POSITIVE_INFINITY)).success).toBe(false);
    expect(CreateInvoiceTool.schema.safeParse(params(Number.NaN)).success).toBe(false);
  });

  it('reports a below-zero total as a tool error, and nothing is created', async () => {
    const out: any = await CreateInvoiceTool.handler({ params: params(-150) } as any, {} as any);
    expect(out.content[0].text).toBe(
      'Error creating invoice: Invoice total would be below zero (-50.00). A line may be negative, but an invoice cannot total less than zero; use a credit memo for money owed to the customer.'
    );
    expect(mockQuickBooksInstance.createInvoice).not.toHaveBeenCalled();
  });

  it('creates an invoice holding a negative line and returns it', async () => {
    mockQuickBooksInstance.createInvoice.mockImplementation((payload: any, cb: any) => cb(null, { Id: '77', TotalAmt: 22.5 }));
    const out: any = await CreateInvoiceTool.handler({ params: params(-77.5) } as any, {} as any);
    expect(out.content[0].text).toBe('Invoice created successfully:');
    expect(JSON.parse(out.content[1].text)).toEqual({ Id: '77', TotalAmt: 22.5 });
    expect(mockQuickBooksInstance.createInvoice).toHaveBeenCalledTimes(1);
  });
});
