import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockQuickbooksClient, mockQuickbooksClientClass, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';

// update_purchase as a full object (Steve, 2026-11-24; gd-qbo-worker DECISIONS 166). deposit-fee-repair --armed stopped at
// deposit 125982: QuickBooks refused the sparse update of its fee Expense 125983 ("Required param missing"), as it did
// payments (DECISIONS 148). Now: read first, the change merged in, sparse:false, the caller's SyncToken its lock, read back.
// 125983 below is the purchase exactly as QuickBooks returned it on Nov 24.
jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));

const { UpdatePurchaseTool } = await import('../../../src/tools/update-purchase.tool');
const { fullPurchaseUpdate, readBackProblem } = await import('../../../src/handlers/update-quickbooks-purchase.handler');

const run = async (purchase: unknown): Promise<any> => UpdatePurchaseTool.handler({ params: { purchase } } as any, {} as any);
const text = (r: any) => r.content.map((c: any) => c.text).join('\n');
const LINE = { Id: '1', Description: 'Square processing fees', Amount: 73.79, DetailType: 'AccountBasedExpenseLineDetail',
  AccountBasedExpenseLineDetail: { AccountRef: { value: '174', name: 'Bank Charges' }, BillableStatus: 'NotBillable', TaxCodeRef: { value: '3' } }, CustomExtensions: [] };
const p125983 = () => ({
  AccountRef: { value: '1150040002', name: 'Scotia - Chequing' }, PaymentType: 'Cash', TotalAmt: 73.79, GlobalTaxCalculation: 'NotApplicable',
  PurchaseEx: { any: [{ name: '{http://schema.intuit.com/finance/v3}NameValue', value: { Name: 'TxnType', Value: '54' } }] },
  domain: 'QBO', sparse: false, Id: '125983', SyncToken: '0', MetaData: { CreateTime: '2026-11-19T20:01:53-08:00', LastUpdatedTime: '2026-11-19T20:01:53-08:00' },
  CustomField: [], TxnDate: '2026-11-20', CurrencyRef: { value: 'CAD', name: 'Canadian Dollar' },
  PrivateNote: 'GorillaDesk Square fees, square-payout:po_ee4c39ee-93ac-4bbf-af29-f962096e2536', Line: [LINE],
  TxnTaxDetail: { TotalTax: 0, TaxLine: [{ Amount: 0, DetailType: 'TaxLineDetail', TaxLineDetail: { TaxRateRef: { value: '3' }, PercentBased: true, TaxPercent: 0, NetAmountTaxable: 73.79 } }] },
});
const ZERO = { Id: '125983', SyncToken: '0', Line: [{ ...LINE, Amount: 0 }], PrivateNote: 'Voided — fee moved into deposit 125982' };

/** QuickBooks in memory: getPurchase returns `purchase`; updatePurchase takes what it is sent (or `reply`, or an error). */
const world = ({ purchase = p125983() as any, reply = null as any, updateError = null as Error | null } = {}) => {
  (mockQuickBooksInstance.getPurchase as jest.Mock).mockImplementation((_id: any, cb: any) => (purchase ? cb(null, JSON.parse(JSON.stringify(purchase))) : cb(new Error('Object Not Found'))));
  (mockQuickBooksInstance.updatePurchase as jest.Mock).mockImplementation((body: any, cb: any) => (updateError ? cb(updateError)
    : cb(null, reply ?? { ...body, SyncToken: '1', TotalAmt: body.Line.reduce((s: number, l: any) => s + l.Amount, 0) })));
};
const sent = () => (mockQuickBooksInstance.updatePurchase as jest.Mock).mock.calls.map((c: any) => c[0]);

describe('update_purchase: the full purchase, never sparse', () => {
  beforeEach(() => {
    resetAllMocks();
    (mockQuickbooksClientClass.getInstance as any).mockResolvedValue(mockQuickBooksInstance);
  });

  it('takes the purchase\'s Id and SyncToken (as read) and the fields to change', () => {
    const ok = (p: unknown) => UpdatePurchaseTool.schema.safeParse({ purchase: p }).success;
    expect(ok(ZERO)).toBe(true);
    expect(ok({ Id: '125983', SyncToken: '0' })).toBe(true);
    expect(ok({ Id: '125983', Line: [] })).toBe(false);
    expect(ok({ SyncToken: '0' })).toBe(false);
    expect(UpdatePurchaseTool.schema.safeParse({ purchase: ZERO }).data?.purchase).toStrictEqual(ZERO); // the rest passes through
  });

  it('125983 zeroed: sent whole, sparse:false -- its account, type, date, currency as read; the new line and memo; nothing QuickBooks owns', async () => {
    world();
    const r = await run(ZERO);
    expect(text(r)).toMatch(/^Purchase updated:/);
    expect(sent()).toStrictEqual([{
      AccountRef: { value: '1150040002', name: 'Scotia - Chequing' }, PaymentType: 'Cash', GlobalTaxCalculation: 'NotApplicable', CustomField: [],
      TxnDate: '2026-11-20', CurrencyRef: { value: 'CAD', name: 'Canadian Dollar' }, PrivateNote: 'Voided — fee moved into deposit 125982',
      Line: [{ ...LINE, Amount: 0 }], Id: '125983', SyncToken: '0', sparse: false }]);
    expect(JSON.parse(r.content[1].text)).toMatchObject({ Id: '125983', SyncToken: '1', TotalAmt: 0 });
  });

  it('a memo-only change keeps every line and the tax detail as read', () => {
    const body = fullPurchaseUpdate(p125983(), { Id: '125983', SyncToken: '0', PrivateNote: 'x' });
    expect([body.Line, body.TxnTaxDetail, body.PrivateNote, body.sparse]).toStrictEqual([[LINE], p125983().TxnTaxDetail, 'x', false]);
    // A caller's own tax detail with new lines is sent as given; a read line's LineEx never is.
    const tax = { TotalTax: 1 };
    expect(fullPurchaseUpdate(p125983(), { ...ZERO, TxnTaxDetail: tax }).TxnTaxDetail).toStrictEqual(tax);
    expect(fullPurchaseUpdate({ ...p125983(), Line: [{ ...LINE, LineEx: { any: [] } }] }, { Id: '125983', SyncToken: '0' }).Line).toStrictEqual([LINE]);
    expect(fullPurchaseUpdate({ ...p125983(), Line: undefined }, { Id: '125983', SyncToken: '0' }).Line).toStrictEqual([]);
    // The caller's sparse is never honoured.
    expect(fullPurchaseUpdate(p125983(), { ...ZERO, sparse: true }).sparse).toBe(false);
  });

  it('refuses -- sending nothing -- a purchase changed since it was read, one that cannot be read, a change with no Id or SyncToken', async () => {
    const cases: [string, any, unknown, RegExp][] = [
      ['changed since read', { purchase: { ...p125983(), SyncToken: '2' } }, ZERO, /purchase 125983: it changed since it was read \(SyncToken 2, not 0\); nothing was changed$/],
      ['unreadable', { purchase: null }, ZERO, /purchase 125983: it could not be read; nothing was changed$/],
      ['no SyncToken', {}, { Id: '125983', Line: [] }, /purchase 125983: Id and SyncToken are needed/],
      ['empty SyncToken', {}, { Id: '125983', SyncToken: '' }, /Id and SyncToken are needed/],
      ['null SyncToken', {}, { Id: '125983', SyncToken: null }, /Id and SyncToken are needed/],
      ['no Id', {}, { SyncToken: '0' }, /purchase \?: Id and SyncToken are needed/],
    ];
    for (const [name, w, args, why] of cases) {
      resetAllMocks();
      (mockQuickbooksClientClass.getInstance as any).mockResolvedValue(mockQuickBooksInstance);
      world(w);
      expect([name, text(await run(args))]).toStrictEqual([name, expect.stringMatching(why)]);
      expect(mockQuickBooksInstance.updatePurchase).not.toHaveBeenCalled();
    }
  });

  it('read back: a memo, date or line QuickBooks did not take is an error with what it returned; a QuickBooks refusal or no connection is an error', async () => {
    world({ reply: p125983() });
    expect(text(await run(ZERO))).toMatch(/^Error updating purchase: purchase 125983 its memo reads back "GorillaDesk Square fees, square-payout:po_ee4c39ee-93ac-4bbf-af29-f962096e2536", not "Voided — fee moved into deposit 125982"; check it in QuickBooks$/);
    world({ reply: { ...p125983(), PrivateNote: ZERO.PrivateNote } });
    expect(text(await run(ZERO))).toMatch(/its lines read back 73\.79, not 0\.00; check it in QuickBooks$/);
    world({ updateError: new Error('Business Validation Error: amount must be greater than zero') });
    expect(text(await run(ZERO))).toMatch(/^Error updating purchase: .*amount must be greater than zero/);
    resetAllMocks();
    (mockQuickbooksClientClass.getInstance as any).mockRejectedValue(new Error('Auth failed'));
    expect(text(await run(ZERO))).toMatch(/^Error updating purchase: .*Auth failed/);
  });

  it('readBackProblem: each field sent holds what was sent; fields not sent are not checked', () => {
    expect(readBackProblem({ TxnDate: '2026-11-21' }, { TxnDate: '2026-11-20' })).toBe('it reads back dated 2026-11-20, not 2026-11-21');
    expect(readBackProblem({ TxnDate: '2026-11-21' }, { TxnDate: '2026-11-21' })).toBeNull();
    expect(readBackProblem({ PrivateNote: '' }, {})).toBeNull();
    expect(readBackProblem({ PrivateNote: null }, { PrivateNote: '' })).toBeNull();
    expect(readBackProblem({ PrivateNote: 'a' }, {})).toBe('its memo reads back "", not "a"');
    expect(readBackProblem({ Line: [{ Amount: 1 }] }, {})).toBe('its lines read back (none), not 1.00');
    expect(readBackProblem({ Line: [{ Amount: 1 }, { Amount: 2 }] }, { Line: [{ Amount: 2 }, { Amount: 1 }] })).toBe('its lines read back 2.00, 1.00, not 1.00, 2.00');
    expect(readBackProblem({ PrivateNote: 'a' }, null)).toBe('QuickBooks returned no purchase');
    expect(readBackProblem({ Id: '1' }, { Line: [] })).toBeNull();
  });
});
