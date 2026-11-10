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

  it.each([
    ['payment_id and account_ref', { payment_id: '1234', account_ref: '79' }],
    ['payment_id and linked_txn', { payment_id: '1234', linked_txn: { txn_id: '88', txn_type: 'JournalEntry' } }],
    ['linked_txn and account_ref', { linked_txn: { txn_id: '88', txn_type: 'JournalEntry' }, account_ref: '79' }],
  ])('rejects a line with both %s', (_label, fields) => {
    const result = CreateDepositTool.schema.safeParse({
      deposit_to_account_ref: '35',
      line_items: [{ amount: 250, ...fields }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('A line is one of payment_id, linked_txn or account_ref.');
      expect(result.error.issues[0].path).toEqual(['line_items', 0]);
    }
  });

  it('accepts zero and negative line amounts (a $0 clearing deposit)', () => {
    const result = CreateDepositTool.schema.safeParse({
      deposit_to_account_ref: '35',
      line_items: [
        { amount: 74.75, payment_id: '1234' },
        { amount: -74.75, linked_txn: { txn_id: '88', txn_type: 'JournalEntry' } },
        { amount: 0, account_ref: '79' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts linked_txn with no txn_line_id, and keeps linked_txn through parsing', () => {
    const result = CreateDepositTool.schema.safeParse({
      deposit_to_account_ref: '35',
      line_items: [{ amount: -74.75, linked_txn: { txn_id: '88', txn_type: 'JournalEntry' } }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.line_items[0].linked_txn).toEqual({ txn_id: '88', txn_type: 'JournalEntry' });
    }
  });

  it('rejects linked_txn with an unknown txn_type', () => {
    const result = CreateDepositTool.schema.safeParse({
      deposit_to_account_ref: '35',
      line_items: [{ amount: 10, linked_txn: { txn_id: '88', txn_type: 'Invoice' } }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects linked_txn with an empty txn_id', () => {
    const result = CreateDepositTool.schema.safeParse({
      deposit_to_account_ref: '35',
      line_items: [{ amount: 10, linked_txn: { txn_id: '', txn_type: 'Payment' } }],
    });
    expect(result.success).toBe(false);
  });

  it('describes negative amounts and txn_line_id for the caller', () => {
    const line = (CreateDepositTool.schema.shape.line_items.element as any).innerType().shape;
    expect(line.amount.description).toBe(
      'Line amount. Negative lines are allowed, e.g. a journal entry or fee that offsets a payment; the deposit total may be 0.'
    );
    expect(line.linked_txn.unwrap().shape.txn_line_id.description).toBe(
      'Line Id inside the linked transaction. Payments use "0". For a JournalEntry, the Id of its Undeposited Funds line; omitted → resolved automatically.'
    );
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

  it('mentions linked transactions and the $0 clearing deposit in the tool description', () => {
    expect(CreateDepositTool.description).toContain(
      'Lines can link a Payment, SalesReceipt or JournalEntry sitting in Undeposited Funds; ' +
        'a $0 deposit clears a payment against an offsetting journal entry.'
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
