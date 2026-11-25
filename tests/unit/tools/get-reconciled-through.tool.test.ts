import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockQuickbooksClient, mockQuickbooksClientClass, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';

// get_reconciled_through (gd-qbo-worker DECISIONS 169): the latest reconciled transaction on one account, from the same
// "cleared: Reconciled" transaction list delete_deposit checks with. Read only. Example: Scotia - Chequing (1150040002),
// reconciled through Nov 21 -- a credit card's later reconciled line is someone else's account and never counts.
jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));

const { GetReconciledThroughTool } = await import('../../../src/tools/get-reconciled-through.tool');
const { latestOnAccount, columnIndex, RECONCILED_COLUMNS } = await import('../../../src/handlers/get-quickbooks-reconciled-through.handler');

const run = async (params: unknown): Promise<any> => GetReconciledThroughTool.handler({ params } as any, {} as any);
const text = (r: any) => r.content.map((c: any) => c.text).join('\n');
const SCOTIA = { Id: '1150040002', Name: 'Scotia - Chequing', FullyQualifiedName: 'Scotia - Chequing' };
const col = (title: string, key: string) => ({ ColTitle: title, ColType: 'String', MetaData: [{ Name: 'ColKey', Value: key }] });
/** A TransactionList report as QuickBooks shapes it: its columns by key, a section, rows whose account cell carries the id. */
const report = (rows: [string, string, string, string | undefined][], cols = [col('Date', 'tx_date'), col('Transaction Type', 'txn_type'), col('Account', 'account_name')]) => ({
  Header: { ReportName: 'TransactionList' }, Columns: { Column: cols },
  Rows: { Row: [{ type: 'Section', Rows: { Row: rows.map(([date, type, account, id]) => ({ type: 'Data',
    ColData: [{ value: date }, { value: type, id: '9' }, { value: account, ...(id === undefined ? {} : { id }) }] })) } }] },
});
const world = ({ account = SCOTIA as any, list = report([]) as any, reportError = null as Error | null, accountError = null as Error | null } = {}) => {
  (mockQuickBooksInstance.getAccount as jest.Mock).mockImplementation((_id: any, cb: any) => (accountError ? cb(accountError) : cb(null, account)));
  (mockQuickBooksInstance.reportTransactionList as jest.Mock).mockImplementation((_o: any, cb: any) => (reportError ? cb(reportError) : cb(null, list)));
};

describe('get_reconciled_through: the latest reconciled transaction on one account', () => {
  beforeEach(() => {
    resetAllMocks();
    (mockQuickbooksClientClass.getInstance as any).mockResolvedValue(mockQuickBooksInstance);
  });

  it('takes an account id, and optionally the last day and how many days back -- nothing else', () => {
    const ok = (p: unknown) => GetReconciledThroughTool.schema.safeParse(p).success;
    expect(ok({ account_id: '1150040002' })).toBe(true);
    expect(ok({ account_id: '1150040002', as_of: '2026-11-25', days: 400 })).toBe(true);
    expect(ok({ account_id: 'Scotia' })).toBe(false);
    expect(ok({ account_id: '1150040002', as_of: 'Nov 25' })).toBe(false);
    expect(ok({ account_id: '1150040002', days: 401 })).toBe(false);
    expect(ok({ account_id: '1150040002', days: 0 })).toBe(false);
    expect(GetReconciledThroughTool.name).toBe('get_reconciled_through');
  });

  it('Scotia reconciled through Nov 21: the latest of its reconciled rows; another account\'s later row never counts; the window read', async () => {
    world({ list: report([['2026-11-03', 'Deposit', 'Scotia - Chequing', '1150040002'], ['2026-11-21', 'Payment', 'Scotia - Chequing', '1150040002'],
      ['2026-11-24', 'Credit Card Expense', 'Visa', '88'], ['2026-11-10', 'Expense', 'Scotia - Chequing', '1150040002']]) });
    const r = await run({ account_id: '1150040002', as_of: '2026-11-25' });
    expect(r.content[0].text).toBe('Reconciled through:');
    expect(JSON.parse(r.content[1].text)).toStrictEqual({ account_id: '1150040002', reconciled_through: '2026-11-21', rows: 3, from: '2026-07-28', to: '2026-11-25' });
    expect((mockQuickBooksInstance.reportTransactionList as jest.Mock).mock.calls[0][0]).toStrictEqual(
      { start_date: '2026-07-28', end_date: '2026-11-25', cleared: 'Reconciled', columns: RECONCILED_COLUMNS });
    expect((mockQuickBooksInstance.getAccount as jest.Mock).mock.calls[0][0]).toBe('1150040002');
  });

  it('an account cell with no id is matched by the account\'s own name; nothing reconciled in the window: null, never a guess', async () => {
    world({ list: report([['2026-11-18', 'Deposit', 'Scotia - Chequing', undefined], ['2026-11-19', 'Deposit', 'CIBC - 27115', undefined]]) });
    let r = await run({ account_id: '1150040002', as_of: '2026-11-25', days: 30 });
    expect(JSON.parse(r.content[1].text)).toMatchObject({ reconciled_through: '2026-11-18', rows: 1, from: '2026-10-26' });
    world({ list: report([['2026-11-19', 'Deposit', 'Visa', '88']]) });
    r = await run({ account_id: '1150040002', as_of: '2026-11-25' });
    expect(JSON.parse(r.content[1].text)).toMatchObject({ reconciled_through: null, rows: 0 });
  });

  it('a report without its date and account columns, or one QuickBooks will not give: an error, nothing read', async () => {
    world({ list: report([['2026-11-21', 'Payment', 'Scotia - Chequing', '1150040002']], [col('Date', 'tx_date'), col('Transaction Type', 'txn_type')]) });
    expect(text(await run({ account_id: '1150040002' }))).toMatch(/^Error reading the reconciled date: account 1150040002: the transaction list did not have its date and account columns/);
    world({ reportError: new Error('Report service unavailable') });
    expect(text(await run({ account_id: '1150040002' }))).toMatch(/^Error reading the reconciled date: .*Report service unavailable/);
    world({ accountError: new Error('Object Not Found') });
    expect(text(await run({ account_id: '1150040002' }))).toMatch(/Object Not Found/);
  });

  it('the handler refuses what the schema would (called directly): an account that is not an id, a date that is not one, days out of range', async () => {
    const { getQuickbooksReconciledThrough } = await import('../../../src/handlers/get-quickbooks-reconciled-through.handler');
    expect((await getQuickbooksReconciledThrough({ account_id: 'x' })).error).toMatch(/account_id must be/);
    expect((await getQuickbooksReconciledThrough({ account_id: '1', as_of: '2026-02-30' })).error).toMatch(/as_of must be a date/);
    expect((await getQuickbooksReconciledThrough({ account_id: '1', days: 0 })).error).toMatch(/days must be 1\.\.400/);
    world({ list: report([]) });
    const today = new Date().toISOString().slice(0, 10);
    expect((await getQuickbooksReconciledThrough({ account_id: '1' })).result?.to).toBe(today);
  });

  it('pure: the columns are found by their keys, and rows in nested sections are read', () => {
    const r = report([['2026-11-21', 'Payment', 'Scotia - Chequing', '1150040002']]);
    expect([columnIndex(r, 'tx_date'), columnIndex(r, 'account_name'), columnIndex(r, 'memo')]).toEqual([0, 2, -1]);
    const nested = { ...r, Rows: { Row: [{ type: 'Section', Rows: { Row: [{ type: 'Section', Rows: { Row: r.Rows.Row[0].Rows.Row } }, { Summary: {} }] } }] } };
    expect(latestOnAccount(nested, '1150040002')).toStrictEqual({ date: '2026-11-21', rows: 1 });
    expect(latestOnAccount({ ...r, Columns: undefined }, '1150040002')).toMatch(/did not have its date and account columns/);
  });

  it('pure, as QuickBooks may shape it: no rows at all; a row short of cells; an id that is null or empty (the name decides); a date that is not one; columns without metadata', () => {
    const cols = [col('Date', 'tx_date'), col('Transaction Type', 'txn_type'), col('Account', 'account_name')];
    expect(latestOnAccount({ Columns: { Column: cols } }, '1150040002')).toStrictEqual({ date: null, rows: 0 });
    const rows = [
      { ColData: [{ value: '2026-11-12' }] }, // no account cell: not this account
      { ColData: [{ value: '2026-11-13' }, { value: 'Deposit' }, { value: 'Scotia - Chequing', id: null }] },
      { ColData: [{ value: '2026-11-14' }, { value: 'Deposit' }, { value: 'Scotia - Chequing', id: '' }] },
      { ColData: [{}, { value: 'Deposit' }, { value: 'Scotia - Chequing', id: '1150040002' }] }, // no date: not counted
      { ColData: [{ value: 'Total' }, {}, { id: '1150040002' }] },
      { Rows: { Row: [{ ColData: [{ value: '2026-11-15' }, {}, {}] }] } }, // a section's rows, one with an empty account cell
    ];
    expect(latestOnAccount({ Columns: { Column: cols }, Rows: { Row: rows } }, '1150040002', ['Scotia - Chequing'])).toStrictEqual({ date: '2026-11-14', rows: 2 });
    expect(columnIndex({ Columns: { Column: [{ ColTitle: 'Date' }, { MetaData: [{ Name: 'ColType', Value: 'x' }] }] } }, 'tx_date')).toBe(-1);
    expect(columnIndex(undefined, 'tx_date')).toBe(-1);
  });

  it('no account id at all: refused before anything is read', async () => {
    const { getQuickbooksReconciledThrough } = await import('../../../src/handlers/get-quickbooks-reconciled-through.handler');
    expect((await getQuickbooksReconciledThrough({} as any)).error).toMatch(/account_id must be a QuickBooks account id \(digits\), got undefined/);
    expect(mockQuickBooksInstance.getAccount as jest.Mock).not.toHaveBeenCalled();
  });

  it('an account QuickBooks names nothing: only rows with its id count', async () => {
    world({ account: {}, list: report([['2026-11-18', 'Deposit', 'Scotia - Chequing', undefined], ['2026-11-17', 'Deposit', 'Scotia - Chequing', '1150040002']]) });
    expect(JSON.parse((await run({ account_id: '1150040002', as_of: '2026-11-25' })).content[1].text)).toMatchObject({ reconciled_through: '2026-11-17', rows: 1 });
  });
});
