import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockQuickbooksClient, mockQuickbooksClientClass, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';

// delete_purchase, guarded (Steve, 2026-11-24; gd-qbo-worker DECISIONS 166). Only a Square fee Expense the worker made (memo
// starting "GorillaDesk Square fees"), dated AFTER the caller's bank_reconciled_through, that QuickBooks confirms is
// unreconciled (the transaction list of its day must show it, and the same list filtered to reconciled transactions must
// not), as read. Anything else is refused, nothing deleted. Read back: gone. 125983 is deposit 125982's fee Expense.
jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));

const { DeletePurchaseTool } = await import('../../../src/tools/delete-purchase.tool');
const { reportShowsPurchase, SQUARE_FEE_MEMO } = await import('../../../src/handlers/delete-quickbooks-purchase.handler');

const run = async (params: unknown): Promise<any> => DeletePurchaseTool.handler({ params } as any, {} as any);
const text = (r: any) => r.content.map((c: any) => c.text).join('\n');
const p125983 = { Id: '125983', SyncToken: '0', TxnDate: '2026-11-20', TotalAmt: 73.79, PaymentType: 'Cash', AccountRef: { value: '1150040002' },
  PrivateNote: 'GorillaDesk Square fees, square-payout:po_ee4c39ee-93ac-4bbf-af29-f962096e2536',
  Line: [{ Id: '1', Amount: 73.79, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: '174' } } }] };
/** A TransactionList report as QuickBooks shapes it: a section, its rows, each txn_type cell carrying the id. */
const list = (...rows: [string, string][]) => ({ Header: { ReportName: 'TransactionList' }, Rows: { Row: [{ type: 'Section', Rows: { Row: rows.map(([type, id]) => ({
  type: 'Data', ColData: [{ value: '2026-11-20' }, { value: type, id }, { value: '' }, { value: 'Square', id: '77' }, { value: '73.79' }] })) } }] } });
const ARGS = { id: '125983', sync_token: '0', bank_reconciled_through: '2026-11-19' };

/** QuickBooks in memory: the purchase (until deleted, unless `survives`), the day's lists, the delete. */
const world = ({ purchase = p125983 as any, all = list(['Deposit', '125982'], ['Expense', '125983']), reconciled = list(), reportError = null as Error | null,
  survives = false } = {}) => {
  let gone = false;
  (mockQuickBooksInstance.getPurchase as jest.Mock).mockImplementation((_id: any, cb: any) => (purchase && !gone ? cb(null, JSON.parse(JSON.stringify(purchase))) : cb(new Error('Object Not Found'))));
  (mockQuickBooksInstance.reportTransactionList as jest.Mock).mockImplementation((o: any, cb: any) => (reportError ? cb(reportError) : cb(null, o.cleared ? reconciled : all)));
  (mockQuickBooksInstance.deletePurchase as jest.Mock).mockImplementation((_e: any, cb: any) => { gone = !survives; cb(null, { Purchase: { Id: '125983', status: 'Deleted' } }); });
};

describe('delete_purchase: only the worker\'s unreconciled Square fee Expense after the bank reconciliation date', () => {
  beforeEach(() => {
    resetAllMocks();
    (mockQuickbooksClientClass.getInstance as any).mockResolvedValue(mockQuickBooksInstance);
  });

  it('takes id, sync_token and bank_reconciled_through (a date) -- never an entity', () => {
    const ok = (p: unknown) => DeletePurchaseTool.schema.safeParse(p).success;
    expect(ok(ARGS)).toBe(true);
    expect(ok({ id: '125983', sync_token: '0' })).toBe(false);
    expect(ok({ ...ARGS, bank_reconciled_through: 'Nov 19' })).toBe(false);
    expect(ok({ idOrEntity: { Id: '1' } })).toBe(false);
    expect(SQUARE_FEE_MEMO).toBe('GorillaDesk Square fees');
  });

  it('125983 (Nov 20, after Nov 19, not reconciled): deleted as read, and read back gone', async () => {
    world();
    const r = await run(ARGS);
    expect(text(r)).toMatch(/^Purchase deleted:/);
    expect((mockQuickBooksInstance.deletePurchase as jest.Mock).mock.calls[0][0]).toStrictEqual({ Id: '125983', SyncToken: '0' });
    expect((mockQuickBooksInstance.reportTransactionList as jest.Mock).mock.calls.map((c: any) => c[0])).toStrictEqual([
      { start_date: '2026-11-20', end_date: '2026-11-20' },
      { start_date: '2026-11-20', end_date: '2026-11-20', cleared: 'Reconciled' },
    ]);
    expect(JSON.parse(r.content[1].text)).toStrictEqual({ deleted: { Id: '125983', TxnDate: '2026-11-20', TotalAmt: 73.79, PrivateNote: p125983.PrivateNote } });
    expect((mockQuickBooksInstance.getPurchase as jest.Mock).mock.calls.length).toBe(2); // read, then read back
  });

  it('refuses -- deleting nothing -- any other purchase, on or before the bank date, changed since read, reconciled, unseen by the list, an unreadable list or purchase', async () => {
    const cases: [string, any, any, RegExp][] = [
      ['another memo', { purchase: { ...p125983, PrivateNote: 'EMT reimbursement - office supplies' } }, ARGS, /its memo does not start "GorillaDesk Square fees"/],
      ['the memo inside, not at the start', { purchase: { ...p125983, PrivateNote: 'Re: GorillaDesk Square fees' } }, ARGS, /its memo does not start/],
      ['no memo', { purchase: { ...p125983, PrivateNote: undefined } }, ARGS, /its memo does not start/],
      ['on the bank date', {}, { ...ARGS, bank_reconciled_through: '2026-11-20' }, /dated 2026-11-20, on or before the bank reconciliation date 2026-11-20/],
      ['before it', { purchase: { ...p125983, TxnDate: '2026-11-19' } }, ARGS, /dated 2026-11-19, on or before the bank reconciliation date 2026-11-19/],
      ['changed since read', { purchase: { ...p125983, SyncToken: '1' } }, ARGS, /changed since it was read \(SyncToken 1, not 0\)/],
      ['reconciled', { reconciled: list(['Expense', '125983']) }, ARGS, /it is reconciled/],
      ['the filter ignored (everything listed as reconciled)', { reconciled: list(['Deposit', '125982'], ['Expense', '125983']) }, ARGS, /it is reconciled/],
      ['not in the list (the check cannot see it)', { all: list(['Deposit', '125982']) }, ARGS, /does not show it, so it could not be confirmed unreconciled/],
      ['in the list as another type with its id', { all: list(['Deposit', '125983']) }, ARGS, /does not show it/],
      ['the list unreadable', { reportError: new Error('Report failed') }, ARGS, /its reconciliation could not be read \(.*Report failed.*\)/],
      ['the purchase unreadable', { purchase: null }, ARGS, /it could not be read/],
      ['no date', {}, { id: '125983', sync_token: '0' }, /bank_reconciled_through must be a date, YYYY-MM-DD/],
      ['no id', {}, { sync_token: '0', bank_reconciled_through: '2026-11-19' }, /id and sync_token are needed/],
    ];
    for (const [name, w, args, why] of cases) {
      resetAllMocks();
      (mockQuickbooksClientClass.getInstance as any).mockResolvedValue(mockQuickBooksInstance);
      world(w);
      const r = await run(args);
      expect([name, text(r)]).toStrictEqual([name, expect.stringMatching(why)]);
      expect(text(r)).toMatch(/nothing was deleted$/);
      expect(mockQuickBooksInstance.deletePurchase).not.toHaveBeenCalled();
    }
  });

  it('a purchase still there after the delete is an error; a QuickBooks refusal or no connection is an error', async () => {
    world({ survives: true });
    expect(text(await run(ARGS))).toMatch(/^Error: purchase 125983 still reads back after the delete; check it in QuickBooks$/);
    world();
    (mockQuickBooksInstance.deletePurchase as jest.Mock).mockImplementation((_e: any, cb: any) => cb(new Error('Business Validation Error')));
    expect(text(await run(ARGS))).toMatch(/^Error: .*Business Validation Error/);
    resetAllMocks();
    (mockQuickbooksClientClass.getInstance as any).mockRejectedValue(new Error('Auth failed'));
    expect(text(await run(ARGS))).toMatch(/^Error: .*Auth failed/);
  });

  it('reportShowsPurchase: a purchase type naming the id, at any depth; nothing else', () => {
    for (const type of ['Expense', 'Cash Expense', 'Check', 'Cheque', 'Check Expense', 'Cheque Expense', 'Credit Card Expense', 'Credit Card Credit']) {
      expect([type, reportShowsPurchase(list([type, '125983']), '125983')]).toStrictEqual([type, true]);
    }
    expect(reportShowsPurchase(list(['Expense', '125983']), '12598')).toBe(false);
    expect(reportShowsPurchase(list(['Bill', '125983']), '125983')).toBe(false);
    expect(reportShowsPurchase({}, '1')).toBe(false);
    expect(reportShowsPurchase({ Rows: { Row: [{ ColData: [{ value: 'Expense', id: 1 }] }] } }, '1')).toBe(true);
    expect(reportShowsPurchase({ Rows: { Row: [{ ColData: [{ value: 'Expense' }] }, { Rows: {} }] } }, '1')).toBe(false);
  });
});
