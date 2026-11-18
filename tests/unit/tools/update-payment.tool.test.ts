import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockQuickbooksClient, mockQuickbooksClientClass, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';

// update_payment moves a payment to another deposit-to account (deposit_to_account -> DepositToAccountRef):
// e.g. an e-transfer the worker put in Undeposited Funds goes straight to the chequing account it arrived in.
// A payment already in a bank deposit is refused: moving it would take it out of that deposit.
jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));

const { UpdatePaymentTool } = await import('../../../src/tools/update-payment.tool');

const run = async (params: unknown): Promise<any> => UpdatePaymentTool.handler({ params } as any, {} as any);
const text = (r: any) => r.content.map((c: any) => c.text).join('\n');
const inUndeposited = { Id: '125858', SyncToken: '0', TxnDate: '2026-11-12', DepositToAccountRef: { value: '7' }, LinkedTxn: [] };
const inADeposit = { ...inUndeposited, LinkedTxn: [{ TxnId: '125695', TxnType: 'Deposit' }] };

describe('update_payment: deposit_to_account', () => {
  beforeEach(() => {
    resetAllMocks();
    (mockQuickbooksClientClass.getInstance as any).mockResolvedValue(mockQuickBooksInstance);
  });

  it('accepts deposit_to_account as an account id (string), and only as one', () => {
    expect(UpdatePaymentTool.schema.safeParse({ id: '1', sync_token: '0', deposit_to_account: '1150040002' }).success).toBe(true);
    expect(UpdatePaymentTool.schema.safeParse({ id: '1', sync_token: '0', deposit_to_account: 1150040002 }).success).toBe(false);
    expect(UpdatePaymentTool.schema.safeParse({ id: '1', sync_token: '0', deposit_to_account: '' }).success).toBe(false);
  });

  it('a payment in Undeposited Funds moves: a sparse update with DepositToAccountRef only, its date untouched', async () => {
    (mockQuickBooksInstance.getPayment as jest.Mock).mockImplementation((_id: any, cb: any) => cb(null, inUndeposited));
    (mockQuickBooksInstance.updatePayment as jest.Mock).mockImplementation((_p: any, cb: any) => cb(null, { ...inUndeposited, SyncToken: '1', DepositToAccountRef: { value: '1150040002' } }));
    const r = await run({ id: '125858', sync_token: '0', deposit_to_account: '1150040002' });
    expect(text(r)).toMatch(/^Payment updated successfully:/);
    expect((mockQuickBooksInstance.getPayment as jest.Mock).mock.calls[0][0]).toBe('125858');
    expect((mockQuickBooksInstance.updatePayment as jest.Mock).mock.calls[0][0]).toStrictEqual({
      Id: '125858', SyncToken: '0', sparse: true, DepositToAccountRef: { value: '1150040002' },
    });
  });

  it('a payment already in a bank deposit is refused, naming the deposit; nothing is sent', async () => {
    (mockQuickBooksInstance.getPayment as jest.Mock).mockImplementation((_id: any, cb: any) => cb(null, inADeposit));
    const r = await run({ id: '125858', sync_token: '0', deposit_to_account: '1150040002' });
    expect(text(r)).toMatch(/^Error updating payment: .*already in deposit 125695/);
    expect(mockQuickBooksInstance.updatePayment).not.toHaveBeenCalled();
  });

  it('a payment that cannot be read first is refused (never moved blind)', async () => {
    (mockQuickBooksInstance.getPayment as jest.Mock).mockImplementation((_id: any, cb: any) => cb({ Fault: { Error: [{ Message: 'Object Not Found' }] } }, null));
    const r = await run({ id: '125858', sync_token: '0', deposit_to_account: '1150040002' });
    expect(text(r)).toMatch(/^Error updating payment:/);
    expect(mockQuickBooksInstance.updatePayment).not.toHaveBeenCalled();
  });

  it('without deposit_to_account nothing changes: no read first, the same payload as before', async () => {
    (mockQuickBooksInstance.updatePayment as jest.Mock).mockImplementation((_p: any, cb: any) => cb(null, { Id: '1' }));
    await run({ id: '1', sync_token: '0', private_note: 'n' });
    expect(mockQuickBooksInstance.getPayment).not.toHaveBeenCalled();
    expect((mockQuickBooksInstance.updatePayment as jest.Mock).mock.calls[0][0]).toStrictEqual({ Id: '1', SyncToken: '0', sparse: true, PrivateNote: 'n' });
  });
});
