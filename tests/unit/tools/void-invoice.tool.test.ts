import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockQuickbooksClient, mockQuickbooksClientClass, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';

// The tool module imports its handler, which imports the quickbooks-client.
// Mock the client so importing the tool doesn't spin up real auth/config.
jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));

const { VoidInvoiceTool } = await import('../../../src/tools/void-invoice.tool');

describe('void_invoice schema', () => {
  it('is named void_invoice', () => {
    expect(VoidInvoiceTool.name).toBe('void_invoice');
  });

  it('accepts invoice_id on its own', () => {
    const result = VoidInvoiceTool.schema.safeParse({ invoice_id: '124423' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ invoice_id: '124423' });
    }
  });

  it('accepts allow_paid alongside invoice_id', () => {
    const result = VoidInvoiceTool.schema.safeParse({ invoice_id: '124423', allow_paid: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allow_paid).toBe(true);
    }
  });

  it('rejects an empty invoice_id', () => {
    const result = VoidInvoiceTool.schema.safeParse({ invoice_id: '' });
    expect(result.success).toBe(false);
  });

  it('steers callers away from delete in the description', () => {
    expect(VoidInvoiceTool.description).toBe(
      'Void an invoice in QuickBooks Online. Keeps the record at $0 with an audit trail — use this instead of delete. Refuses invoices with payments applied unless allow_paid is true.'
    );
  });
});

describe('void_invoice tool handler', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  const openInvoice = { Id: '124423', SyncToken: '3', Balance: 150, TotalAmt: 150 };

  it('returns the voided invoice as text', async () => {
    mockQuickBooksInstance.getInvoice.mockImplementation((_id: any, cb: any) => cb(null, openInvoice));
    mockQuickBooksInstance.voidInvoice.mockImplementation((_payload: any, cb: any) =>
      cb(null, { Id: '124423', SyncToken: '4', TotalAmt: 0 })
    );

    const res: any = await VoidInvoiceTool.handler({ params: { invoice_id: '124423' } } as any, {} as any);

    expect(res.content[0].text).toBe('Invoice voided:');
    expect(JSON.parse(res.content[1].text)).toEqual({ Id: '124423', SyncToken: '4', TotalAmt: 0 });
  });

  it('passes allow_paid through to the handler', async () => {
    mockQuickBooksInstance.getInvoice.mockImplementation((_id: any, cb: any) =>
      cb(null, { ...openInvoice, Balance: 0 })
    );
    mockQuickBooksInstance.voidInvoice.mockImplementation((_payload: any, cb: any) => cb(null, { Id: '124423' }));

    const res: any = await VoidInvoiceTool.handler(
      { params: { invoice_id: '124423', allow_paid: true } } as any,
      {} as any
    );

    expect(res.content[0].text).toBe('Invoice voided:');
    expect(mockQuickBooksInstance.voidInvoice).toHaveBeenCalledTimes(1);
  });

  it('returns an error message when the void is refused', async () => {
    mockQuickBooksInstance.getInvoice.mockImplementation((_id: any, cb: any) =>
      cb(null, { ...openInvoice, Balance: 0 })
    );

    const res: any = await VoidInvoiceTool.handler({ params: { invoice_id: '124423' } } as any, {} as any);

    expect(res.content).toHaveLength(1);
    expect(res.content[0].text).toBe(
      'Error voiding invoice: Invoice 124423 has payments applied (Balance 0 of 150). Unapply them first, or pass allow_paid: true.'
    );
  });

  it('returns an error message when the void fails', async () => {
    mockQuickBooksInstance.getInvoice.mockImplementation((_id: any, cb: any) => cb(null, openInvoice));
    mockQuickBooksInstance.voidInvoice.mockImplementation((_payload: any, cb: any) => cb(new Error('Boom'), null));

    const res: any = await VoidInvoiceTool.handler({ params: { invoice_id: '124423' } } as any, {} as any);

    expect(res.content[0].text).toBe('Error voiding invoice: Error: Boom');
  });
});
