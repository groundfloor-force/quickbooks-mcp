import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockQuickbooksClient, mockQuickbooksClientClass, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';

jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));

const { createQuickbooksDeposit } = await import('../../../src/handlers/create-quickbooks-deposit.handler');

// Captures the payload the real handler hands to node-quickbooks.
function capturePayload(): { get: () => any } {
  let captured: any;
  mockQuickBooksInstance.createDeposit.mockImplementation((payload: any, cb: any) => {
    captured = payload;
    cb(null, { Id: '1' });
  });
  return { get: () => captured };
}

describe('Create Deposit Handler - LinkedTxn (Undeposited Funds)', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  it('maps a payment_id line to a LinkedTxn line with no DepositLineDetail', async () => {
    const cap = capturePayload();

    const result = await createQuickbooksDeposit({
      deposit_to_account_ref: '35',
      line_items: [{ amount: 250, payment_id: '1234', description: 'Cheque 501' }],
    });

    expect(result.isError).toBe(false);
    const line = cap.get().Line[0];
    expect(line).toEqual({
      Id: '1',
      Amount: 250,
      Description: 'Cheque 501',
      LinkedTxn: [{ TxnId: '1234', TxnType: 'Payment', TxnLineId: '0' }],
    });
    expect(line).not.toHaveProperty('DetailType');
    expect(line).not.toHaveProperty('DepositLineDetail');
  });

  it('maps a mixed deposit: one linked line and one account line', async () => {
    const cap = capturePayload();

    const result = await createQuickbooksDeposit({
      deposit_to_account_ref: '35',
      line_items: [
        { amount: 250, payment_id: '1234' },
        { amount: 40, account_ref: '79', description: 'Bank interest' },
      ],
      txn_date: '2026-11-05',
    });

    expect(result.isError).toBe(false);
    const payload = cap.get();
    expect(payload.DepositToAccountRef).toEqual({ value: '35' });
    expect(payload.TxnDate).toBe('2026-11-05');
    expect(payload.Line).toHaveLength(2);

    expect(payload.Line[0]).toEqual({
      Id: '1',
      Amount: 250,
      Description: undefined,
      LinkedTxn: [{ TxnId: '1234', TxnType: 'Payment', TxnLineId: '0' }],
    });
    expect(payload.Line[0]).not.toHaveProperty('DepositLineDetail');

    expect(payload.Line[1]).toEqual({
      Id: '2',
      Amount: 40,
      Description: 'Bank interest',
      DetailType: 'DepositLineDetail',
      DepositLineDetail: { AccountRef: { value: '79' }, Entity: undefined },
    });
    expect(payload.Line[1]).not.toHaveProperty('LinkedTxn');
  });
});

describe('Create Deposit Handler - linked_txn (Payment, SalesReceipt, JournalEntry, ...)', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  // A journal entry moving 74.75 between Undeposited Funds and A/R, as QBO returns it.
  const jeLine = (id: string, name: string | undefined, amount: number, value = `acct-${id}`) => ({
    Id: id,
    Amount: amount,
    DetailType: 'JournalEntryLineDetail',
    JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: name === undefined ? { value } : { value, name } },
  });
  const respondWithJournalEntry = (lines: any[] | undefined) =>
    mockQuickBooksInstance.getJournalEntry.mockImplementation((_id: any, cb: any) =>
      cb(null, lines === undefined ? { Id: '88' } : { Id: '88', Line: lines })
    );

  it('uses an explicit txn_line_id as given, without reading the journal entry', async () => {
    const cap = capturePayload();

    const result = await createQuickbooksDeposit({
      deposit_to_account_ref: '35',
      line_items: [{ amount: -74.75, linked_txn: { txn_id: '88', txn_type: 'JournalEntry', txn_line_id: '1' } }],
    });

    expect(result.isError).toBe(false);
    expect(cap.get().Line).toStrictEqual([
      { Id: '1', Amount: -74.75, Description: undefined, LinkedTxn: [{ TxnId: '88', TxnType: 'JournalEntry', TxnLineId: '1' }] },
    ]);
    expect(mockQuickBooksInstance.getJournalEntry).not.toHaveBeenCalled();
  });

  it('resolves a journal entry line with no txn_line_id to its one Undeposited Funds line', async () => {
    respondWithJournalEntry([jeLine('0', 'Accounts Receivable (A/R)', 74.75), jeLine('1', 'Undeposited Funds', 74.75)]);
    const cap = capturePayload();

    const result = await createQuickbooksDeposit({
      deposit_to_account_ref: '35',
      line_items: [{ amount: -74.75, linked_txn: { txn_id: '88', txn_type: 'JournalEntry' } }],
    });

    expect(result.isError).toBe(false);
    expect((mockQuickBooksInstance.getJournalEntry.mock.calls[0] as any)[0]).toBe('88');
    expect(cap.get().Line[0].LinkedTxn).toStrictEqual([{ TxnId: '88', TxnType: 'JournalEntry', TxnLineId: '1' }]);
  });

  it.each([
    [
      'no Undeposited Funds line',
      [jeLine('0', 'Accounts Receivable (A/R)', 74.75), jeLine('1', undefined, 74.75, '4')],
      'Journal entry 88 has 0 Undeposited Funds lines; pass txn_line_id. Lines: 0: Accounts Receivable (A/R) 74.75, 1: 4 74.75.',
    ],
    [
      'no lines at all',
      undefined,
      'Journal entry 88 has 0 Undeposited Funds lines; pass txn_line_id. Lines: none.',
    ],
    [
      'two Undeposited Funds lines (matched case-insensitively)',
      [jeLine('0', 'Undeposited Funds', 50), jeLine('1', 'UNDEPOSITED FUNDS (old)', 24.75), jeLine('2', 'Sales', 74.75)],
      'Journal entry 88 has 2 Undeposited Funds lines; pass txn_line_id. ' +
        'Lines: 0: Undeposited Funds 50, 1: UNDEPOSITED FUNDS (old) 24.75, 2: Sales 74.75.',
    ],
  ])('refuses, creating nothing, when the journal entry has %s', async (_label, lines, message) => {
    respondWithJournalEntry(lines);

    const result = await createQuickbooksDeposit({
      deposit_to_account_ref: '35',
      line_items: [{ amount: -74.75, linked_txn: { txn_id: '88', txn_type: 'JournalEntry' } }],
    });

    expect(result).toEqual({ result: null, isError: true, error: message });
    expect(mockQuickBooksInstance.createDeposit).not.toHaveBeenCalled();
  });

  it('returns the formatted error, creating nothing, when the journal entry cannot be read', async () => {
    mockQuickBooksInstance.getJournalEntry.mockImplementation((_id: any, cb: any) =>
      cb({ Fault: { Error: [{ Message: 'Object Not Found', code: '610' }] } }, null)
    );

    const result = await createQuickbooksDeposit({
      deposit_to_account_ref: '35',
      line_items: [{ amount: -74.75, linked_txn: { txn_id: '88', txn_type: 'JournalEntry' } }],
    });

    expect(result).toEqual({ result: null, isError: true, error: 'Error: Object Not Found (QBO code 610)' });
    expect(mockQuickBooksInstance.createDeposit).not.toHaveBeenCalled();
  });

  it('builds a $0 clearing deposit: +74.75 Payment line and -74.75 JournalEntry line', async () => {
    respondWithJournalEntry([jeLine('0', 'Undeposited Funds', 74.75), jeLine('1', 'Accounts Receivable (A/R)', 74.75)]);
    const cap = capturePayload();

    const result = await createQuickbooksDeposit({
      deposit_to_account_ref: '35',
      line_items: [
        { amount: 74.75, linked_txn: { txn_id: '1234', txn_type: 'Payment' } },
        { amount: -74.75, linked_txn: { txn_id: '88', txn_type: 'JournalEntry' }, description: 'Clears payment 1234' },
      ],
    });

    expect(result.isError).toBe(false);
    expect(mockQuickBooksInstance.createDeposit).toHaveBeenCalledTimes(1);
    expect(cap.get().Line).toStrictEqual([
      { Id: '1', Amount: 74.75, Description: undefined, LinkedTxn: [{ TxnId: '1234', TxnType: 'Payment', TxnLineId: '0' }] },
      {
        Id: '2',
        Amount: -74.75,
        Description: 'Clears payment 1234',
        LinkedTxn: [{ TxnId: '88', TxnType: 'JournalEntry', TxnLineId: '0' }],
      },
    ]);
  });

  it('keeps a txn_line_id given for another type, and defaults it to "0" otherwise', async () => {
    const cap = capturePayload();

    await createQuickbooksDeposit({
      deposit_to_account_ref: '35',
      line_items: [
        { amount: 20, linked_txn: { txn_id: '501', txn_type: 'SalesReceipt', txn_line_id: '3' } },
        { amount: 30, linked_txn: { txn_id: '502', txn_type: 'SalesReceipt' } },
      ],
    });

    expect(cap.get().Line.map((l: any) => l.LinkedTxn)).toStrictEqual([
      [{ TxnId: '501', TxnType: 'SalesReceipt', TxnLineId: '3' }],
      [{ TxnId: '502', TxnType: 'SalesReceipt', TxnLineId: '0' }],
    ]);
    expect(mockQuickBooksInstance.getJournalEntry).not.toHaveBeenCalled();
  });
});
