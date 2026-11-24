import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockQuickbooksClient, mockQuickbooksClientClass, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';

// delete_deposit, guarded (Steve, 2026-11-24; gd-qbo-worker DECISIONS 164). Only a deposit dated AFTER the caller's
// bank_reconciled_through that QuickBooks confirms is unreconciled: the transaction list of its day must show it (the check
// can see it) and the same list filtered to reconciled transactions must not. Anything else is refused, nothing deleted.
// Deleted, its payments are back in Undeposited Funds, read again and returned. Example: 126307, the second deposit of
// cheque 004589 (one bank line split over two deposits by hand).
jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));

const { DeleteDepositTool } = await import('../../../src/tools/delete-deposit.tool');
const { reportShows } = await import('../../../src/handlers/delete-quickbooks-deposit.handler');

const run = async (params: unknown): Promise<any> => DeleteDepositTool.handler({ params } as any, {} as any);
const text = (r: any) => r.content.map((c: any) => c.text).join('\n');
const d126307 = { Id: '126307', SyncToken: '2', TxnDate: '2026-11-10', TotalAmt: 57.5, DepositToAccountRef: { value: '1150040002' },
  Line: [{ Amount: 57.5, LinkedTxn: [{ TxnId: '125423', TxnType: 'Payment', TxnLineId: '0' }] }] };
/** A TransactionList report as QuickBooks shapes it: a section, its rows, each txn_type cell carrying the id. */
const list = (...ids: string[]) => ({ Header: { ReportName: 'TransactionList' }, Rows: { Row: [{ type: 'Section', Rows: { Row: ids.map((id) => ({
  type: 'Data', ColData: [{ value: '2026-11-10' }, { value: 'Deposit', id }, { value: '' }, { value: 'Example Plaza #8155', id: '2892' }, { value: '57.50' }] })) } }] } });
const ARGS = { id: '126307', sync_token: '2', bank_reconciled_through: '2026-10-27' };

const world = ({ deposit = d126307, all = list('126305', '126307'), reconciled = list(), reportError = null as Error | null } = {}) => {
  (mockQuickBooksInstance.getDeposit as jest.Mock).mockImplementation((_id: any, cb: any) => (deposit ? cb(null, JSON.parse(JSON.stringify(deposit))) : cb(new Error('Object Not Found'))));
  (mockQuickBooksInstance.reportTransactionList as jest.Mock).mockImplementation((o: any, cb: any) => (reportError ? cb(reportError) : cb(null, o.cleared ? reconciled : all)));
  (mockQuickBooksInstance.deleteDeposit as jest.Mock).mockImplementation((_e: any, cb: any) => cb(null, { Deposit: { Id: '126307', status: 'Deleted' } }));
  (mockQuickBooksInstance.getPayment as jest.Mock).mockImplementation((id: any, cb: any) => cb(null, { Id: id, TotalAmt: 57.5, TxnDate: '2026-11-10', DepositToAccountRef: { value: '7', name: 'Undeposited Funds' }, LinkedTxn: [] }));
};

describe('delete_deposit: only an unreconciled deposit after the bank reconciliation date', () => {
  beforeEach(() => {
    resetAllMocks();
    (mockQuickbooksClientClass.getInstance as any).mockResolvedValue(mockQuickBooksInstance);
  });

  it('takes id, sync_token and bank_reconciled_through (a date) -- never an entity', () => {
    const ok = (p: unknown) => DeleteDepositTool.schema.safeParse(p).success;
    expect(ok(ARGS)).toBe(true);
    expect(ok({ id: '126307', sync_token: '2' })).toBe(false);
    expect(ok({ ...ARGS, bank_reconciled_through: 'Oct 27' })).toBe(false);
    expect(ok({ idOrEntity: { Id: '1' } })).toBe(false);
  });

  it('126307 (Nov 10, after Oct 27, not reconciled): deleted as read, and its payment returned, back in Undeposited Funds', async () => {
    world();
    const r = await run(ARGS);
    expect(text(r)).toMatch(/^Deposit deleted:/);
    expect((mockQuickBooksInstance.deleteDeposit as jest.Mock).mock.calls[0][0]).toStrictEqual({ Id: '126307', SyncToken: '2' });
    expect((mockQuickBooksInstance.reportTransactionList as jest.Mock).mock.calls.map((c: any) => c[0])).toStrictEqual([
      { start_date: '2026-11-10', end_date: '2026-11-10', transaction_type: 'Deposit' },
      { start_date: '2026-11-10', end_date: '2026-11-10', transaction_type: 'Deposit', cleared: 'Reconciled' },
    ]);
    expect(JSON.parse(r.content[1].text)).toStrictEqual({
      deleted: { Id: '126307', TxnDate: '2026-11-10', TotalAmt: 57.5 },
      freed_payments: [{ id: '125423', amount: 57.5, txn_date: '2026-11-10', deposit_to_account: { value: '7', name: 'Undeposited Funds' }, in_deposit: null }],
    });
  });

  it('refuses -- deleting nothing -- on or before the bank date, a deposit changed since it was read, one reconciled, one the list cannot show, a list that cannot be read, one that cannot be read', async () => {
    const cases: [string, any, any, RegExp][] = [
      ['on the bank date', {}, { ...ARGS, bank_reconciled_through: '2026-11-10' }, /dated 2026-11-10, on or before the bank reconciliation date 2026-11-10/],
      ['before it', { deposit: { ...d126307, TxnDate: '2026-10-20' } }, ARGS, /dated 2026-10-20, on or before the bank reconciliation date 2026-10-27/],
      ['changed since read', { deposit: { ...d126307, SyncToken: '3' } }, ARGS, /changed since it was read \(SyncToken 3, not 2\)/],
      ['reconciled', { reconciled: list('126307') }, ARGS, /it is reconciled/],
      ['the filter ignored (every deposit listed as reconciled)', { reconciled: list('126305', '126307') }, ARGS, /it is reconciled/],
      ['not in the list (the check cannot see it)', { all: list('126305') }, ARGS, /does not show it, so it could not be confirmed unreconciled/],
      ['the list unreadable', { reportError: new Error('Report failed') }, ARGS, /its reconciliation could not be read \(.*Report failed.*\)/],
      ['the deposit unreadable', { deposit: null }, ARGS, /it could not be read/],
      ['no date', {}, { id: '126307', sync_token: '2' }, /bank_reconciled_through must be a date, YYYY-MM-DD/],
      ['no id', {}, { sync_token: '2', bank_reconciled_through: '2026-10-27' }, /id and sync_token are needed/],
    ];
    for (const [name, w, args, why] of cases) {
      resetAllMocks();
      (mockQuickbooksClientClass.getInstance as any).mockResolvedValue(mockQuickBooksInstance);
      world(w);
      const r = await run(args);
      expect([name, text(r)]).toStrictEqual([name, expect.stringMatching(why)]);
      expect(text(r)).toMatch(/nothing was deleted$/);
      expect(mockQuickBooksInstance.deleteDeposit).not.toHaveBeenCalled();
    }
  });

  it('a QuickBooks refusal of the delete, or no connection, is an error; a freed payment that cannot be read again is said', async () => {
    world();
    (mockQuickBooksInstance.deleteDeposit as jest.Mock).mockImplementation((_e: any, cb: any) => cb(new Error('Business Validation Error')));
    expect(text(await run(ARGS))).toMatch(/^Error: .*Business Validation Error/);
    resetAllMocks();
    (mockQuickbooksClientClass.getInstance as any).mockRejectedValue(new Error('Auth failed'));
    expect(text(await run(ARGS))).toMatch(/^Error: .*Auth failed/);
    resetAllMocks();
    (mockQuickbooksClientClass.getInstance as any).mockResolvedValue(mockQuickBooksInstance);
    world();
    (mockQuickBooksInstance.getPayment as jest.Mock).mockImplementation((_id: any, cb: any) => cb(new Error('gone')));
    expect(JSON.parse((await run(ARGS)).content[1].text).freed_payments).toStrictEqual([{ id: '125423', read: false }]);
  });

  it('what it returns of each payment is what QuickBooks says now -- still in a deposit, or with no account read -- and a fee line frees nothing', async () => {
    world({ deposit: { ...d126307, TotalAmt: 55.5, Line: [...d126307.Line, { Amount: -2, DetailType: 'DepositLineDetail', DepositLineDetail: { AccountRef: { value: '174' } } }] } as any });
    (mockQuickBooksInstance.getPayment as jest.Mock).mockImplementation((id: any, cb: any) => cb(null, { Id: id, TotalAmt: 57.5, TxnDate: '2026-11-10',
      LinkedTxn: [{ TxnId: '125429', TxnType: 'Invoice' }, { TxnId: '126999', TxnType: 'Deposit' }] }));
    expect(JSON.parse((await run(ARGS)).content[1].text).freed_payments).toStrictEqual([
      { id: '125423', amount: 57.5, txn_date: '2026-11-10', deposit_to_account: null, in_deposit: '126999' }]);
    resetAllMocks();
    (mockQuickbooksClientClass.getInstance as any).mockResolvedValue(mockQuickBooksInstance);
    world();
    (mockQuickBooksInstance.getPayment as jest.Mock).mockImplementation((id: any, cb: any) => cb(null, { Id: id, TotalAmt: 57.5 }));
    expect(JSON.parse((await run(ARGS)).content[1].text).freed_payments).toStrictEqual([{ id: '125423', amount: 57.5, deposit_to_account: null, in_deposit: null }]);
    resetAllMocks();
    (mockQuickbooksClientClass.getInstance as any).mockResolvedValue(mockQuickBooksInstance);
    world({ deposit: { ...d126307, Line: undefined } as any });
    expect(JSON.parse((await run(ARGS)).content[1].text)).toStrictEqual({ deleted: { Id: '126307', TxnDate: '2026-11-10', TotalAmt: 57.5 }, freed_payments: [] });
  });

  it('reportShows: a txn_type cell naming the type and id, at any depth; nothing else', () => {
    expect(reportShows(list('126307'), 'Deposit', '126307')).toBe(true);
    expect(reportShows(list('126307'), 'Deposit', '12630')).toBe(false);
    expect(reportShows(list('126307'), 'Payment', '126307')).toBe(false);
    expect(reportShows({}, 'Deposit', '1')).toBe(false);
    expect(reportShows({ Rows: { Row: [{ ColData: [{ value: 'Deposit', id: 1 }] }] } }, 'Deposit', '1')).toBe(true);
    expect(reportShows({ Rows: { Row: [{ ColData: [{ value: 'Deposit' }] }, { Rows: {} }] } }, 'Deposit', '1')).toBe(false); // a cell with no id; a section with no rows
  });
});
