import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockQuickbooksClient, mockQuickbooksClientClass, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';

// The tool module imports its handler, which imports the quickbooks-client.
// Mock the client so importing the tool doesn't spin up real auth/config.
jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));

const { CreateDepositTool } = await import('../../../src/tools/create-deposit.tool');

describe('create_deposit schema', () => {
  it('accepts a line with payment_id only', () => {
    const result = CreateDepositTool.schema.safeParse({
      deposit_to_account_ref: '35',
      line_items: [{ amount: 250, payment_id: '1234' }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // payment_id must survive parsing, or the handler never sees it.
      expect(result.data.line_items[0].payment_id).toBe('1234');
    }
  });

  it('rejects a line with both payment_id and account_ref', () => {
    const result = CreateDepositTool.schema.safeParse({
      deposit_to_account_ref: '35',
      line_items: [{ amount: 250, payment_id: '1234', account_ref: '79' }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        'A line is either a payment_id or an account_ref, not both'
      );
      expect(result.error.issues[0].path).toEqual(['line_items', 0]);
    }
  });

  it('still accepts a plain account_ref line', () => {
    const result = CreateDepositTool.schema.safeParse({
      deposit_to_account_ref: '35',
      line_items: [{ amount: 40, account_ref: '79' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty payment_id', () => {
    const result = CreateDepositTool.schema.safeParse({
      deposit_to_account_ref: '35',
      line_items: [{ amount: 250, payment_id: '' }],
    });
    expect(result.success).toBe(false);
  });

  it('mentions payment_id in the tool description', () => {
    expect(CreateDepositTool.description).toContain(
      'To deposit payments from Undeposited Funds, pass payment_id on each line.'
    );
  });
});

describe('create_deposit tool handler', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  it('returns the created deposit as text', async () => {
    mockQuickBooksInstance.createDeposit.mockImplementation((payload: any, cb: any) => cb(null, { Id: '9' }));

    const res: any = await CreateDepositTool.handler(
      { params: { deposit_to_account_ref: '35', line_items: [{ amount: 250, payment_id: '1234' }] } } as any,
      {} as any
    );

    expect(res.content[0].text).toBe('Deposit created:');
    expect(JSON.parse(res.content[1].text)).toEqual({ Id: '9' });
  });

  it('returns an error message when the create fails', async () => {
    mockQuickBooksInstance.createDeposit.mockImplementation((payload: any, cb: any) => cb(new Error('Boom'), null));

    const res: any = await CreateDepositTool.handler(
      { params: { deposit_to_account_ref: '35', line_items: [{ amount: 250, payment_id: '1234' }] } } as any,
      {} as any
    );

    expect(res.content[0].text).toContain('Error:');
  });
});
