import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockQuickbooksClient, mockQuickbooksClientClass, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';

// update_deposit adds and removes payment lines (Steve, 2026-11-24; gd-qbo-worker DECISIONS 164): Remy had to fix cheque
// deposits in the browser because the connector could not. Cheque 004589 paid two invoices ($57.50 each) and is ONE bank
// line, but it was split over deposits 126312 (payment 125446) and 126307 (payment 125423). The fix: delete 126307 (its
// payment is back in Undeposited Funds) and add 125423 to 126312 -- one deposit of $115.00. Numbers made up but shaped so.
jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));

const { UpdateDepositTool } = await import('../../../src/tools/update-deposit.tool');
const { depositLinePlan } = await import('../../../src/handlers/update-quickbooks-deposit.handler');

const run = async (params: unknown): Promise<any> => UpdateDepositTool.handler({ params } as any, {} as any);
const text = (r: any) => r.content.map((c: any) => c.text).join('\n');
const paid = (id: string, amount: number) => ({ Amount: amount, LinkedTxn: [{ TxnId: id, TxnType: 'Payment', TxnLineId: '0' }], DepositLineDetail: { PaymentMethodRef: { value: '9' } },
  LineEx: { any: [] } });
const UF = { Id: '7', Name: 'Undeposited Funds', AccountType: 'Other Current Asset', AccountSubType: 'UndepositedFunds', Active: true };
const BANK = { Id: '1150040002', Name: 'Scotia - Chequing', AccountType: 'Bank', AccountSubType: 'Checking', Active: true };
const d126312 = { Id: '126312', SyncToken: '0', TxnDate: '2026-11-10', TotalAmt: 57.5, DepositToAccountRef: { value: '1150040002' }, PrivateNote: 'chq 004589 - inv #42444',
  MetaData: { CreateTime: '2026-11-24T13:02:33-08:00' }, Line: [paid('125446', 57.5)] };
const payment = (id: string, amount: number, o: any = {}) => ({ Id: id, TotalAmt: amount, TxnDate: '2026-11-10', DepositToAccountRef: { value: '7' }, LinkedTxn: [], PaymentRefNum: '004589', ...o });

const world = (deposit: any, payments: Record<string, any> = {}, accounts: Record<string, any> = { 7: UF, 1150040002: BANK }) => {
  (mockQuickBooksInstance.getDeposit as jest.Mock).mockImplementation((_id: any, cb: any) => cb(null, JSON.parse(JSON.stringify(deposit))));
  (mockQuickBooksInstance.getPayment as jest.Mock).mockImplementation((id: any, cb: any) => (payments[id] ? cb(null, payments[id]) : cb(new Error('Object Not Found'))));
  (mockQuickBooksInstance.getAccount as jest.Mock).mockImplementation((id: any, cb: any) => cb(null, accounts[id] ?? null));
  (mockQuickBooksInstance.updateDeposit as jest.Mock).mockImplementation((p: any, cb: any) => cb(null, { ...p, SyncToken: '1' }));
};
const sent = () => (mockQuickBooksInstance.updateDeposit as jest.Mock).mock.calls.map((c: any) => c[0]);

describe('update_deposit: payment lines added and removed (a full line edit, sparse:false)', () => {
  beforeEach(() => {
    resetAllMocks();
    (mockQuickbooksClientClass.getInstance as any).mockResolvedValue(mockQuickBooksInstance);
  });

  it('cheque 004589 made one deposit: 125423, back in Undeposited Funds, added to 126312 -- $115.00, the full object, its own line kept as read', async () => {
    world(d126312, { 125423: payment('125423', 57.5) });
    const r = await run({ id: '126312', sync_token: '0', line: [{ amount: 57.5, payment_id: '125446' }, { amount: 57.5, payment_id: '125423' }] });
    expect(text(r)).toMatch(/^Deposit updated:/);
    const { MetaData: _m, ...rest } = d126312;
    const { LineEx: _x, ...kept } = d126312.Line[0];
    expect(sent()).toStrictEqual([{ ...rest, SyncToken: '0', sparse: false, TotalAmt: 115,
      Line: [kept, { Amount: 57.5, LinkedTxn: [{ TxnId: '125423', TxnType: 'Payment', TxnLineId: '0' }] }] }]);
  });

  it('a payment removed: the rest kept as read, in the order given, the total their sum (the removed one goes back to Undeposited Funds)', async () => {
    const d = { ...d126312, TotalAmt: 172.5, Line: [paid('125446', 57.5), paid('125423', 57.5), paid('125417', 57.5)] };
    world(d);
    const r = await run({ id: '126312', sync_token: '0', line: [{ amount: 57.5, payment_id: '125417' }, { amount: 57.5, payment_id: '125446' }] });
    expect(text(r)).toMatch(/^Deposit updated:/);
    expect(sent()[0].Line.map((l: any) => l.LinkedTxn[0].TxnId)).toStrictEqual(['125417', '125446']);
    expect([sent()[0].TotalAmt, sent()[0].sparse]).toStrictEqual([115, false]);
    expect(mockQuickBooksInstance.getPayment).not.toHaveBeenCalled(); // nothing added: nothing to read
  });

  it('a payment swapped for another, with a fee line kept unchanged: allowed (linked_txn Payment counts as a payment line)', async () => {
    const d = { ...d126312, TotalAmt: 55.5, Line: [paid('125446', 57.5), { Amount: -2, DetailType: 'DepositLineDetail', DepositLineDetail: { AccountRef: { value: '174' } } }] };
    world(d, { 125423: payment('125423', 57.5) });
    const r = await run({ id: '126312', sync_token: '0', line: [{ amount: 57.5, linked_txn: { txn_id: '125423', txn_type: 'Payment' } }, { amount: -2, account_ref: '174' }] });
    expect(text(r)).toMatch(/^Deposit updated:/);
    expect(sent()[0].TotalAmt).toBe(55.5);
  });

  it('refuses an added payment that is not deposited whole, not in Undeposited Funds, already in a deposit, or unreadable -- sending nothing', async () => {
    const cases: [string, any, RegExp][] = [
      ['part of it', { 125423: payment('125423', 115) }, /payment 125423 is 115; it is deposited whole \(got 57\.5\)/],
      ['in the bank', { 125423: payment('125423', 57.5, { DepositToAccountRef: { value: '1150040002' } }) }, /payment 125423 is not in Undeposited Funds \(account 1150040002\)/],
      ['in another deposit', { 125423: payment('125423', 57.5, { LinkedTxn: [{ TxnId: '126307', TxnType: 'Deposit' }] }) }, /payment 125423 is already in deposit 126307/],
      ['not there', {}, /payment 125423 could not be read/],
    ];
    for (const [name, payments, why] of cases) {
      resetAllMocks();
      (mockQuickbooksClientClass.getInstance as any).mockResolvedValue(mockQuickBooksInstance);
      world(d126312, payments);
      const r = await run({ id: '126312', sync_token: '0', line: [{ amount: 57.5, payment_id: '125446' }, { amount: 57.5, payment_id: '125423' }] });
      expect([name, text(r)]).toStrictEqual([name, expect.stringMatching(why)]);
      expect(text(r)).toMatch(/nothing was changed$/);
      expect(mockQuickBooksInstance.updateDeposit).not.toHaveBeenCalled();
    }
  });

  it('two payments added from one Undeposited Funds account (read once), and a new fee with no description: one update, the total their sum', async () => {
    const d = { ...d126312, Line: undefined, TotalAmt: 0 }; // as QuickBooks may give a deposit with no lines read
    world(d, { 125423: payment('125423', 57.5), 125418: payment('125418', 57.5) }, { 7: UF, 174: { Id: '174', AccountType: 'Expense', AccountSubType: 'BankCharges' } });
    const r = await run({ id: '126312', sync_token: '0', line: [{ amount: 57.5, payment_id: '125423' }, { amount: 57.5, payment_id: '125418' }, { amount: -1, account_ref: '174' }] });
    expect(text(r)).toMatch(/^Deposit updated:/);
    expect((mockQuickBooksInstance.getAccount as jest.Mock).mock.calls.map((c: any) => c[0])).toStrictEqual(['7', '174']);
    expect(sent()[0].Line[2]).toStrictEqual({ Amount: -1, DetailType: 'DepositLineDetail', DepositLineDetail: { AccountRef: { value: '174' } } });
    expect(sent()[0].TotalAmt).toBe(114);
  });

  it('refuses: a payment with no account and no links read (not in Undeposited Funds), an account that cannot be read, a fee account that cannot be read, a deposit that cannot be read', async () => {
    world(d126312, { 125423: { Id: '125423', TotalAmt: 57.5 } });
    expect(text(await run({ id: '126312', sync_token: '0', line: [{ amount: 57.5, payment_id: '125446' }, { amount: 57.5, payment_id: '125423' }] })))
      .toMatch(/payment 125423 is not in Undeposited Funds \(account \?\); nothing was changed$/);
    resetAllMocks();
    (mockQuickbooksClientClass.getInstance as any).mockResolvedValue(mockQuickBooksInstance);
    world(d126312, { 125423: payment('125423', 57.5) });
    (mockQuickBooksInstance.getAccount as jest.Mock).mockImplementation((_id: any, cb: any) => cb(new Error('down')));
    expect(text(await run({ id: '126312', sync_token: '0', line: [{ amount: 57.5, payment_id: '125446' }, { amount: 57.5, payment_id: '125423' }] })))
      .toMatch(/payment 125423 is not in Undeposited Funds \(account 7\)/);
    resetAllMocks();
    (mockQuickbooksClientClass.getInstance as any).mockResolvedValue(mockQuickBooksInstance);
    world(d126312, {}, {});
    expect(text(await run({ id: '126312', sync_token: '0', line: [{ amount: 57.5, payment_id: '125446' }, { amount: -1, account_ref: '999' }] })))
      .toMatch(/account 999 is not an active bank-charges expense account \(\?\/\?\); nothing was changed$/);
    resetAllMocks();
    (mockQuickbooksClientClass.getInstance as any).mockResolvedValue(mockQuickBooksInstance);
    (mockQuickBooksInstance.getDeposit as jest.Mock).mockImplementation((_id: any, cb: any) => cb(null, null));
    expect(text(await run({ id: '126312', sync_token: '0', line: [{ amount: 57.5, payment_id: '125446' }] }))).toMatch(/deposit 126312 could not be read; nothing was changed$/);
    expect(mockQuickBooksInstance.updateDeposit).not.toHaveBeenCalled();
  });

  it('the plan, pure: what is kept, added and removed; other linked lines and account lines must come back; a new non-payment link is refused', () => {
    const d = { Line: [paid('1', 10), { Amount: 5, LinkedTxn: [{ TxnId: '77', TxnType: 'JournalEntry', TxnLineId: '3' }] }, { Amount: -1, DepositLineDetail: { AccountRef: { value: '174' } } }] };
    const je = { amount: 5, linked_txn: { txn_id: '77', txn_type: 'JournalEntry', txn_line_id: '3' } };
    const fee = { amount: -1, account_ref: '174' };
    expect(depositLinePlan(d, [je, fee, { amount: 20, payment_id: '2' }])).toStrictEqual({ kept: [], added: [{ id: '2', cents: 2000 }], removed: ['1'], fee: null });
    expect(depositLinePlan(d, [{ amount: 10, payment_id: '1' }, fee])).toMatch(/other line \(txn:JournalEntry:77:3:500\) must come back unchanged/);
    expect(depositLinePlan(d, [{ amount: 10, payment_id: '1' }, je])).toMatch(/other line \(acct:174:-100:\) must come back unchanged/);
    expect(depositLinePlan(d, [{ amount: 10, payment_id: '1' }, je, fee, { amount: 4, linked_txn: { txn_id: '88', txn_type: 'SalesReceipt' } }])).toMatch(/the new SalesReceipt line may not be added/);
    expect(depositLinePlan(d, [{ amount: 10, linked_txn: { txn_id: '1', txn_type: 'Payment', txn_line_id: '2' } }, je, fee])).toMatch(/must link it whole \(TxnLineId 0\)/);
    expect(depositLinePlan(d, [{ amount: -3, payment_id: '9' }, je, fee])).toMatch(/payment 9's line must be its amount \(got -3\)/);
    expect(depositLinePlan(d, [])).toMatch(/at least one line .*delete_deposit/);
    expect(depositLinePlan(d, [{ amount: 10, payment_id: '1' }, je, fee, { amount: -2, account_ref: '' }])).toMatch(/needs account_ref/);
    expect(depositLinePlan(d, [{ amount: 10, payment_id: '1' }])).toMatch(/other lines \(txn:JournalEntry:77:3:500, acct:174:-100:\) must come back unchanged/);
    // Lines as QuickBooks may read them: a link with no TxnLineId, an account line with a description, none with no account.
    const loose = { Line: [{ Amount: 5, LinkedTxn: [{ TxnId: '78', TxnType: 'Transfer' }] }, { Amount: -1, Description: 'fee', DepositLineDetail: { AccountRef: { value: '174' } } },
      { Amount: 2 }] };
    expect(depositLinePlan(loose, [{ amount: 5, linked_txn: { txn_id: '78', txn_type: 'Transfer' } }, { amount: -1, account_ref: '174', description: 'fee' },
      { amount: 2, account_ref: '' }, { amount: 3, payment_id: '4' }])).toStrictEqual({ kept: [], added: [{ id: '4', cents: 300 }], removed: [], fee: null });
    expect(depositLinePlan({}, [{ amount: 3, payment_id: '4' }])).toStrictEqual({ kept: [], added: [{ id: '4', cents: 300 }], removed: [], fee: null });
  });
});
