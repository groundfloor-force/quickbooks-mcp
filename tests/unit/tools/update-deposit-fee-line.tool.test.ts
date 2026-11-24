import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockQuickbooksClient, mockQuickbooksClientClass, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';

// update_deposit adds a Square fee line to a deposit (Steve, 2026-11-23; gd-qbo-worker DECISIONS 155): a deposit must equal
// its bank line, so the fee goes INSIDE it as a negative line to Bank Charges. Guarded: the deposit's lines come back
// unchanged and in order, the only addition is ONE negative line to a bank-charges expense account, and the total drops by
// exactly that line. Real numbers: remainder deposit 125944 (Oct 29) holds payments 123794 ($81.65), 123796 ($71.88) and
// 123845 ($569.25) = $722.78 gross; Square's fee on them is $21.14, so it must read $701.64, the bank line.
jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));

const { UpdateDepositTool } = await import('../../../src/tools/update-deposit.tool');

const run = async (params: unknown): Promise<any> => UpdateDepositTool.handler({ params } as any, {} as any);
const text = (r: any) => r.content.map((c: any) => c.text).join('\n');
const paid = (id: string, amount: number) => ({ Amount: amount, LinkedTxn: [{ TxnId: id, TxnType: 'Payment', TxnLineId: '0' }], DepositLineDetail: { PaymentMethodRef: { value: '21' } } });
const d125944 = {
  Id: '125944', SyncToken: '0', TxnDate: '2026-10-29', TotalAmt: 722.78, DepositToAccountRef: { value: '1150040002', name: 'Scotia - Chequing' },
  GlobalTaxCalculation: 'TaxExcluded', PrivateNote: 'Square payout po_6443d14f (arrived 2026-10-29): the rest of it ... fees $21.14, net $701.64',
  MetaData: { CreateTime: '2026-11-19T08:30:32-08:00' }, Line: [paid('123794', 81.65), paid('123796', 71.88), paid('123845', 569.25)],
};
const back = [{ amount: 81.65, payment_id: '123794' }, { amount: 71.88, payment_id: '123796' }, { amount: 569.25, payment_id: '123845' }];
const fee = { amount: -21.14, account_ref: '174', description: 'Square processing fees' };
const bankCharges = { Id: '174', Name: 'Bank Charges', AccountType: 'Expense', AccountSubType: 'BankCharges', Active: true };

const reads = (deposit: any, account: any = bankCharges) => {
  (mockQuickBooksInstance.getDeposit as jest.Mock).mockImplementation((_id: any, cb: any) => cb(null, JSON.parse(JSON.stringify(deposit))));
  (mockQuickBooksInstance.getAccount as jest.Mock).mockImplementation((_id: any, cb: any) => cb(null, account));
};
const sends = (readBack?: (p: any) => any) => (mockQuickBooksInstance.updateDeposit as jest.Mock)
  .mockImplementation((p: any, cb: any) => cb(null, readBack ? readBack(p) : { ...p, SyncToken: '1' }));
const sent = () => (mockQuickBooksInstance.updateDeposit as jest.Mock).mock.calls.map((c: any) => c[0]);

describe('update_deposit: one Square fee line inside the deposit', () => {
  beforeEach(() => {
    resetAllMocks();
    (mockQuickbooksClientClass.getInstance as any).mockResolvedValue(mockQuickBooksInstance);
  });

  it('takes the full Line array, each line exactly one of payment_id / linked_txn / account_ref', () => {
    const ok = (line: unknown) => UpdateDepositTool.schema.safeParse({ id: '1', sync_token: '0', line }).success;
    expect(ok([...back, fee])).toBe(true);
    expect(ok([])).toBe(false); // at least one line (the handler checks the rest against the deposit)
    expect(ok([...back, { amount: -1 }])).toBe(false);
    expect(ok([...back, { amount: -1, account_ref: '174', payment_id: '9' }])).toBe(false);
  });

  it('125944: its three payment lines as read, then the $21.14 fee to Bank Charges -- total $701.64, the full object, nothing else changed', async () => {
    reads(d125944);
    sends();
    const r = await run({ id: '125944', sync_token: '0', line: [...back, fee] });
    expect(text(r)).toMatch(/^Deposit updated:/);
    expect((mockQuickBooksInstance.getAccount as jest.Mock).mock.calls[0][0]).toBe('174');
    const { MetaData: _m, ...rest } = d125944;
    expect(sent()).toStrictEqual([{
      ...rest, SyncToken: '0', sparse: false, TotalAmt: 701.64,
      Line: [...d125944.Line, { Amount: -21.14, DetailType: 'DepositLineDetail', Description: 'Square processing fees', DepositLineDetail: { AccountRef: { value: '174' } } }],
    }]);
  });

  // Adding, removing and reordering payment lines is allowed now (DECISIONS 164): update-deposit-payment-lines.tool.test.ts.
  it('refuses, sending nothing: a kept payment\'s amount changed; a payment twice; two fees; a positive fee; no change at all', async () => {
    const cases: [string, unknown[], RegExp][] = [
      ['a payment line changed', [{ amount: 81.66, payment_id: '123794' }, back[1], back[2], fee], /payment 123794 is 81\.65 in the deposit; a kept payment keeps its amount \(got 81\.66\)/],
      ['two fee lines', [...back, fee, fee], /at most one new line besides payments: one fee line \(got 2\)/],
      ['the fee positive', [...back, { ...fee, amount: 21.14 }], /must be negative/],
      ['the fee linking a payment already there', [...back, { amount: -21.14, payment_id: '123794' }], /payment 123794 is on two lines/],
      ['the lines as they are', back, /nothing to change/],
    ];
    for (const [name, line, why] of cases) {
      resetAllMocks();
      (mockQuickbooksClientClass.getInstance as any).mockResolvedValue(mockQuickBooksInstance);
      reads(d125944);
      const r = await run({ id: '125944', sync_token: '0', line });
      expect(text(r)).toMatch(why);
      expect(text(r)).toMatch(/nothing was changed$/);
      expect(mockQuickBooksInstance.updateDeposit).not.toHaveBeenCalled();
    }
  });

  it('refuses a fee to anything but an active bank-charges expense account (income, another expense, inactive), sending nothing', async () => {
    for (const account of [
      { Id: '133', AccountType: 'Income', AccountSubType: 'SalesOfProductIncome', Active: true },
      { Id: '176', AccountType: 'Expense', AccountSubType: 'OfficeGeneralAdministrativeExpenses', Active: true },
      { ...bankCharges, Active: false },
    ]) {
      resetAllMocks();
      (mockQuickbooksClientClass.getInstance as any).mockResolvedValue(mockQuickBooksInstance);
      reads(d125944, account);
      const r = await run({ id: '125944', sync_token: '0', line: [...back, { ...fee, account_ref: account.Id }] });
      expect(text(r)).toMatch(/is not an active bank-charges expense account .*nothing was changed$/);
      expect(mockQuickBooksInstance.updateDeposit).not.toHaveBeenCalled();
    }
  });

  it('refuses a deposit changed since it was read (its SyncToken), sending nothing', async () => {
    reads({ ...d125944, SyncToken: '1' });
    const r = await run({ id: '125944', sync_token: '0', line: [...back, fee] });
    expect(text(r)).toMatch(/changed since it was read \(SyncToken 1, not 0\); nothing was changed/);
    expect(mockQuickBooksInstance.updateDeposit).not.toHaveBeenCalled();
  });

  it('a deposit QuickBooks reads back at another total is an error, not a success', async () => {
    reads(d125944);
    sends((p) => ({ ...p, TotalAmt: 722.78 }));
    const r = await run({ id: '125944', sync_token: '0', line: [...back, fee] });
    expect(text(r)).toMatch(/^Error: deposit 125944 read back totalling 722\.78, not 701\.64/);
  });

  it('without line, only the memo changes, as before: no account read, the lines untouched', async () => {
    reads(d125944);
    sends();
    const r = await run({ id: '125944', sync_token: '0', private_note: 'checked' });
    expect(text(r)).toMatch(/^Deposit updated:/);
    expect(mockQuickBooksInstance.getAccount).not.toHaveBeenCalled();
    expect(sent()[0].Line).toStrictEqual(d125944.Line);
    expect(sent()[0].PrivateNote).toBe('checked');
  });
});
