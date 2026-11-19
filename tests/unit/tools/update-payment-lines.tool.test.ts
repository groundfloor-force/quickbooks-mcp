import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockQuickbooksClient, mockQuickbooksClientClass, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';

// update_payment changes a payment's lines (Steve, 2026-11-19; gd-qbo-worker DECISIONS 147): which invoices it applies
// to, and how much. QuickBooks replaces an array whole in a sparse update, so `line` is the payment's FULL Line array.
// Guarded: what the lines apply (invoice lines minus credit-memo lines) never exceeds the payment's total, nor goes
// below zero; a line linking anything else is refused. Real numbers: payment 124362 ($399.63) applied $399.62 to
// invoice 124361, whose total the tax-cent repair made $399.63 -- one cent unapplied, one cent still owing.
jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));

const { UpdatePaymentTool } = await import('../../../src/tools/update-payment.tool');

const run = async (params: unknown): Promise<any> => UpdatePaymentTool.handler({ params } as any, {} as any);
const text = (r: any) => r.content.map((c: any) => c.text).join('\n');
const invoiceLine = (amount: number, txnId = '124361') => ({ amount, linked_txn: [{ txn_id: txnId, txn_type: 'Invoice' }] });
const p124362 = {
  Id: '124362', SyncToken: '3', TxnDate: '2026-11-07', TotalAmt: 399.63, UnappliedAmt: 0.01, DepositToAccountRef: { value: '1150040002' },
  Line: [{ Amount: 399.62, LinkedTxn: [{ TxnId: '124361', TxnType: 'Invoice' }] }],
};
const reads = (payment: any) => (mockQuickBooksInstance.getPayment as jest.Mock).mockImplementation((_id: any, cb: any) => cb(null, payment));
const sends = () => (mockQuickBooksInstance.updatePayment as jest.Mock).mockImplementation((p: any, cb: any) => cb(null, { ...p124362, SyncToken: '4', UnappliedAmt: 0, Line: p.Line }));
const sent = () => (mockQuickBooksInstance.updatePayment as jest.Mock).mock.calls.map((c: any) => c[0]);

describe('update_payment: line (which invoices a payment applies to, and how much)', () => {
  beforeEach(() => {
    resetAllMocks();
    (mockQuickbooksClientClass.getInstance as any).mockResolvedValue(mockQuickBooksInstance);
  });

  it('takes the full Line array in create_payment\'s shape, and nothing looser', () => {
    const ok = (line: unknown) => UpdatePaymentTool.schema.safeParse({ id: '1', sync_token: '0', line }).success;
    expect(ok([invoiceLine(399.63)])).toBe(true);
    expect(ok([invoiceLine(100, '1'), invoiceLine(50, '2')])).toBe(true);
    expect(ok([])).toBe(false);
    expect(ok([invoiceLine(0)])).toBe(false);
    expect(ok([invoiceLine(-1)])).toBe(false);
    expect(ok([{ amount: 1, linked_txn: [] }])).toBe(false);
    expect(ok([{ amount: 1 }])).toBe(false);
  });

  it('124362: the unapplied cent is applied -- the payment read first, then the full object with the new Line', async () => {
    reads(p124362);
    sends();
    const r = await run({ id: '124362', sync_token: '3', line: [invoiceLine(399.63)] });
    expect(text(r)).toMatch(/^Payment updated successfully:/);
    expect((mockQuickBooksInstance.getPayment as jest.Mock).mock.calls[0][0]).toBe('124362');
    expect(sent()).toStrictEqual([{
      Id: '124362', SyncToken: '3', sparse: false, TotalAmt: 399.63, TxnDate: '2026-11-07', DepositToAccountRef: { value: '1150040002' },
      Line: [{ Amount: 399.63, LinkedTxn: [{ TxnId: '124361', TxnType: 'Invoice' }] }],
    }]);
  });

  it('never applies more than the payment\'s total: one cent over is refused, and nothing is sent', async () => {
    reads(p124362);
    const r = await run({ id: '124362', sync_token: '3', line: [invoiceLine(399.64)] });
    expect(text(r)).toMatch(/^Error updating payment: .*would apply \$399\.64.*total is \$399\.63/);
    expect(mockQuickBooksInstance.updatePayment).not.toHaveBeenCalled();
  });

  it('counts in cents: two lines whose float sum is 399.63000000000005 apply exactly the total', async () => {
    reads(p124362);
    sends();
    const r = await run({ id: '124362', sync_token: '3', line: [invoiceLine(199.81, '1'), invoiceLine(199.82, '2')] });
    expect(text(r)).toMatch(/^Payment updated successfully:/);
    expect(sent()[0].Line.map((l: any) => l.Amount)).toStrictEqual([199.81, 199.82]);
  });

  it('with total_amt in the same call, the new total is the limit', async () => {
    reads(p124362);
    sends();
    expect(text(await run({ id: '124362', sync_token: '3', total_amt: 400, line: [invoiceLine(400)] }))).toMatch(/^Payment updated successfully:/);
    expect(sent()[0]).toStrictEqual({ Id: '124362', SyncToken: '3', sparse: false, TotalAmt: 400, TxnDate: '2026-11-07', DepositToAccountRef: { value: '1150040002' },
      Line: [{ Amount: 400, LinkedTxn: [{ TxnId: '124361', TxnType: 'Invoice' }] }] });
    resetAllMocks();
    (mockQuickbooksClientClass.getInstance as any).mockResolvedValue(mockQuickBooksInstance);
    reads(p124362);
    expect(text(await run({ id: '124362', sync_token: '3', total_amt: 399, line: [invoiceLine(399.63)] }))).toMatch(/would apply \$399\.63.*total is \$399\.00/);
    expect(mockQuickBooksInstance.updatePayment).not.toHaveBeenCalled();
  });

  it('a credit memo line counts against the invoice lines (a $0 payment applying a credit): applied = invoices - credits', async () => {
    reads({ ...p124362, TotalAmt: 0, UnappliedAmt: 0, Line: [] });
    sends();
    const credit = { amount: 50, linked_txn: [{ txn_id: '777', txn_type: 'CreditMemo' }] };
    expect(text(await run({ id: '124362', sync_token: '3', line: [invoiceLine(50), credit] }))).toMatch(/^Payment updated successfully:/);
    resetAllMocks();
    (mockQuickbooksClientClass.getInstance as any).mockResolvedValue(mockQuickBooksInstance);
    reads({ ...p124362, TotalAmt: 0, UnappliedAmt: 0, Line: [] });
    expect(text(await run({ id: '124362', sync_token: '3', line: [invoiceLine(40), credit] }))).toMatch(/the lines apply less than nothing \(-\$10\.00\); nothing was changed/);
    expect(mockQuickBooksInstance.updatePayment).not.toHaveBeenCalled();
  });

  it('a line linking anything but an invoice or a credit memo is refused (its effect on the total is not known)', async () => {
    reads(p124362);
    const r = await run({ id: '124362', sync_token: '3', line: [{ amount: 1, linked_txn: [{ txn_id: '9', txn_type: 'JournalEntry' }] }] });
    expect(text(r)).toMatch(/^Error updating payment: .*Invoice or CreditMemo/);
    expect(mockQuickBooksInstance.updatePayment).not.toHaveBeenCalled();
  });

  it('a payment that cannot be read first is refused: its lines never change blind', async () => {
    (mockQuickBooksInstance.getPayment as jest.Mock).mockImplementation((_id: any, cb: any) => cb({ Fault: { Error: [{ Message: 'Object Not Found' }] } }, null));
    const r = await run({ id: '124362', sync_token: '3', line: [invoiceLine(399.63)] });
    expect(text(r)).toMatch(/^Error updating payment:/);
    expect(mockQuickBooksInstance.updatePayment).not.toHaveBeenCalled();
  });

  it('an invoice and a credit memo on ONE line are refused (which way would it count?)', async () => {
    reads(p124362);
    const both = { amount: 1, linked_txn: [{ txn_id: '124361', txn_type: 'Invoice' }, { txn_id: '777', txn_type: 'CreditMemo' }] };
    expect(text(await run({ id: '124362', sync_token: '3', line: [both] }))).toMatch(/give each its own line; nothing was changed/);
    expect(mockQuickBooksInstance.updatePayment).not.toHaveBeenCalled();
  });

  it('a payment QuickBooks returns as nothing (no error) is refused, for new lines and for a move alike', async () => {
    reads(null);
    expect(text(await run({ id: '124362', sync_token: '3', line: [invoiceLine(1)] }))).toMatch(/^Error updating payment: payment 124362 could not be read; nothing was changed$/);
    expect(text(await run({ id: '124362', sync_token: '3', deposit_to_account: '7' }))).toMatch(/could not be read; nothing was changed/);
    expect(mockQuickBooksInstance.updatePayment).not.toHaveBeenCalled();
  });

  it('a move of a payment QuickBooks reads with no LinkedTxn at all goes ahead (in no deposit)', async () => {
    const { LinkedTxn: _none, ...bare } = { ...p124362, LinkedTxn: [] };
    reads(bare);
    sends();
    expect(text(await run({ id: '124362', sync_token: '3', deposit_to_account: '7' }))).toMatch(/^Payment updated successfully:/);
    expect(sent()[0]).toStrictEqual({ Id: '124362', SyncToken: '3', sparse: false, TotalAmt: 399.63, TxnDate: '2026-11-07', DepositToAccountRef: { value: '7' },
      Line: [{ Amount: 399.62, LinkedTxn: [{ TxnId: '124361', TxnType: 'Invoice' }] }] });
  });

  it('a payment read without a total (and no total_amt given) is refused: the limit is not known', async () => {
    reads({ ...p124362, TotalAmt: undefined });
    expect(text(await run({ id: '124362', sync_token: '3', line: [invoiceLine(1)] }))).toMatch(/total could not be read; nothing was changed/);
    expect(mockQuickBooksInstance.updatePayment).not.toHaveBeenCalled();
  });
});
