import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockQuickbooksClient, mockQuickbooksClientClass, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';

// The tool module imports its handler, which imports the quickbooks-client.
// Mock the client so importing the tool doesn't spin up real auth/config.
jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));

const { CreateInvoiceTool } = await import('../../../src/tools/create-invoice.tool');

const baseParams = { customer_ref: '7', line_items: [{ item_ref: '1', qty: 1, unit_price: 100 }] };

describe('create_invoice schema', () => {
  it('accepts allow_duplicate', () => {
    const result = CreateInvoiceTool.schema.safeParse({ ...baseParams, allow_duplicate: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allow_duplicate).toBe(true);
    }
  });

  it('rejects a non-boolean allow_duplicate', () => {
    expect(CreateInvoiceTool.schema.safeParse({ ...baseParams, allow_duplicate: 'yes' }).success).toBe(false);
  });

  it('says it refuses duplicates in the description', () => {
    expect(CreateInvoiceTool.description).toBe(
      'Create an invoice in QuickBooks Online. Refuses if a matching record already exists unless allow_duplicate is true.'
    );
  });
});

describe('create_invoice tool handler', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  it('returns the created invoice as text', async () => {
    mockQuickBooksInstance.findInvoices.mockImplementation((_c: any, cb: any) => cb(null, { QueryResponse: {} }));
    mockQuickBooksInstance.createInvoice.mockImplementation((_p: any, cb: any) => cb(null, { Id: '901' }));

    const res: any = await CreateInvoiceTool.handler({ params: baseParams } as any, {} as any);

    expect(res.content[0].text).toBe('Invoice created successfully:');
    expect(JSON.parse(res.content[1].text)).toEqual({ Id: '901' });
  });

  it('returns the duplicate refusal as an error message', async () => {
    mockQuickBooksInstance.findInvoices.mockImplementation((_c: any, cb: any) =>
      cb(null, { QueryResponse: { Invoice: [{ Id: '900', TotalAmt: 100, TxnDate: '2026-11-08', CustomerRef: { value: '7' }, Line: [{ DetailType: 'SalesItemLineDetail', Amount: 100 }] }] } })
    );

    const res: any = await CreateInvoiceTool.handler({ params: baseParams } as any, {} as any);

    expect(res.content).toHaveLength(1);
    expect(res.content[0].text).toBe(
      'Error creating invoice: Possible duplicate — Invoice already exists: Id 900, #n/a, $100, 2026-11-08, customer 7. Pass allow_duplicate: true to create anyway.'
    );
    expect(mockQuickBooksInstance.createInvoice).not.toHaveBeenCalled();
  });
});
