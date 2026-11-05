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
