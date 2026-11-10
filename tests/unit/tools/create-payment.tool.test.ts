import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockQuickbooksClient, mockQuickbooksClientClass, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';

// The tool module imports its handler, which imports the quickbooks-client.
// Mock the client so importing the tool doesn't spin up real auth/config.
jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));

const { CreatePaymentTool } = await import('../../../src/tools/create-payment.tool');

const baseParams = { customer_ref: '7', total_amt: 100 };

describe('create_payment schema', () => {
  it('accepts allow_duplicate', () => {
    const result = CreatePaymentTool.schema.safeParse({ ...baseParams, allow_duplicate: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allow_duplicate).toBe(true);
    }
  });

  it('rejects a non-boolean allow_duplicate', () => {
    expect(CreatePaymentTool.schema.safeParse({ ...baseParams, allow_duplicate: 'yes' }).success).toBe(false);
  });

  it('accepts a $0 total (QBO uses one to apply a credit memo to an invoice)', () => {
    const result = CreatePaymentTool.schema.safeParse({ ...baseParams, total_amt: 0 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.total_amt).toBe(0);
    }
  });

  it('still rejects a negative total', () => {
    expect(CreatePaymentTool.schema.safeParse({ ...baseParams, total_amt: -1 }).success).toBe(false);
  });

  it('tells the caller what a $0 total is for', () => {
    expect(CreatePaymentTool.schema.shape.total_amt.description).toBe(
      'Total payment amount. 0 is allowed — use it to apply a credit memo to an invoice by linking both in line.'
    );
  });

  it('says it refuses duplicates in the description', () => {
    expect(CreatePaymentTool.description).toBe(
      'Create a payment (receive money from customer) in QuickBooks Online. Refuses if a matching record already exists unless allow_duplicate is true.'
    );
  });
});

describe('create_payment tool handler', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  it('returns the created payment as text', async () => {
    (mockQuickBooksInstance.findPayments as jest.Mock).mockImplementation((_c: any, cb: any) => cb(null, { QueryResponse: {} }));
    (mockQuickBooksInstance.createPayment as jest.Mock).mockImplementation((_p: any, cb: any) => cb(null, { Id: '56' }));

    const res: any = await CreatePaymentTool.handler({ params: baseParams } as any, {} as any);

    expect(res.content[0].text).toBe('Payment created successfully:');
    expect(JSON.parse(res.content[1].text)).toEqual({ Id: '56' });
  });

  it('returns the duplicate refusal as an error message', async () => {
    (mockQuickBooksInstance.findPayments as jest.Mock).mockImplementation((_c: any, cb: any) =>
      cb(null, { QueryResponse: { Payment: [{ Id: '55', TotalAmt: 100, TxnDate: '2026-11-08', CustomerRef: { value: '7', name: 'Acme Ltd' } }] } })
    );

    const res: any = await CreatePaymentTool.handler({ params: baseParams } as any, {} as any);

    expect(res.content).toHaveLength(1);
    expect(res.content[0].text).toBe(
      'Error creating payment: Possible duplicate — Payment already exists: Id 55, #n/a, $100, 2026-11-08, customer Acme Ltd. Pass allow_duplicate: true to create anyway.'
    );
    expect(mockQuickBooksInstance.createPayment).not.toHaveBeenCalled();
  });
});
