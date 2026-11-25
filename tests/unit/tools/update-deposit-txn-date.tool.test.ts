import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockQuickbooksClient, mockQuickbooksClientClass, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';

// update_deposit takes txn_date (Steve, 2026-11-24; gd-qbo-worker DECISIONS 165). A payment re-dated in GorillaDesk is
// re-dated in QuickBooks, and a deposit holding only that payment with it: Invite Properties' Nov 17 direct deposits were
// posted dated Nov 19. Numbers made up but shaped so.
jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));

const { UpdateDepositTool } = await import('../../../src/tools/update-deposit.tool');

const run = async (params: unknown): Promise<any> => UpdateDepositTool.handler({ params } as any, {} as any);
const text = (r: any) => r.content.map((c: any) => c.text).join('\n');
const d126320 = { Id: '126320', SyncToken: '0', TxnDate: '2026-11-19', TotalAmt: 109.25, DepositToAccountRef: { value: '1150040002' },
  MetaData: { CreateTime: '2026-11-24T14:00:00-08:00' }, Line: [{ Amount: 109.25, LinkedTxn: [{ TxnId: '125930', TxnType: 'Payment', TxnLineId: '0' }] }] };
const reads = (deposit: any) => (mockQuickBooksInstance.getDeposit as jest.Mock).mockImplementation((_id: any, cb: any) => cb(null, JSON.parse(JSON.stringify(deposit))));
const sends = (readBack?: (p: any) => any) => (mockQuickBooksInstance.updateDeposit as jest.Mock)
  .mockImplementation((p: any, cb: any) => cb(null, readBack ? readBack(p) : { ...p, SyncToken: '1' }));
const sent = () => (mockQuickBooksInstance.updateDeposit as jest.Mock).mock.calls.map((c: any) => c[0]);

describe('update_deposit: txn_date', () => {
  beforeEach(() => {
    resetAllMocks();
    (mockQuickbooksClientClass.getInstance as any).mockResolvedValue(mockQuickBooksInstance);
  });

  it('takes a date only: YYYY-MM-DD, a real one', () => {
    const ok = (txn_date: unknown) => UpdateDepositTool.schema.safeParse({ id: '1', sync_token: '0', txn_date }).success;
    expect([ok('2026-11-17'), ok('Nov 17'), ok('2026-13-01')]).toStrictEqual([true, false, false]);
  });

  it('re-dates the deposit: the full object, its lines and total as read, dated the new day -- read back', async () => {
    reads(d126320);
    sends();
    const r = await run({ id: '126320', sync_token: '0', txn_date: '2026-11-17' });
    expect(text(r)).toMatch(/^Deposit updated:/);
    const { MetaData: _m, ...rest } = d126320;
    expect(sent()).toStrictEqual([{ ...rest, SyncToken: '0', TxnDate: '2026-11-17', sparse: false }]);
  });

  it('refuses, sending nothing: a day that does not exist, a deposit changed since it was read, one that cannot be read', async () => {
    reads(d126320);
    expect(text(await run({ id: '126320', sync_token: '0', txn_date: '2026-02-30' }))).toMatch(/2026-02-30 is not a date \(YYYY-MM-DD\); nothing was changed$/);
    expect(text(await run({ id: '126320', sync_token: '7', txn_date: '2026-11-17' }))).toMatch(/changed since it was read \(SyncToken 0, not 7\); nothing was changed$/);
    (mockQuickBooksInstance.getDeposit as jest.Mock).mockImplementation((_id: any, cb: any) => cb(null, null));
    expect(text(await run({ id: '126320', sync_token: '0', txn_date: '2026-11-17' }))).toMatch(/could not be read; nothing was changed$/);
    expect(mockQuickBooksInstance.updateDeposit).not.toHaveBeenCalled();
  });

  it('a deposit QuickBooks reads back at another date, or another total, is an error', async () => {
    reads(d126320);
    sends((p) => ({ ...p, TxnDate: '2026-11-19' }));
    expect(text(await run({ id: '126320', sync_token: '0', txn_date: '2026-11-17' }))).toMatch(/^Error: deposit 126320 read back dated 2026-11-19 totalling 109\.25, not 2026-11-17 and 109\.25/);
    sends((p) => ({ ...p, TotalAmt: 100 }));
    expect(text(await run({ id: '126320', sync_token: '0', txn_date: '2026-11-17' }))).toMatch(/read back dated 2026-11-17 totalling 100/);
  });
});
