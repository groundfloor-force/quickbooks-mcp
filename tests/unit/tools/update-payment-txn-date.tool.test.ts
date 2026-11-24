import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockQuickbooksClient, mockQuickbooksClientClass, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';

// update_payment sets the payment's date (TxnDate) (Steve, 2026-11-24; gd-qbo-worker DECISIONS 160). The worker dates an
// e-transfer the day Interac's email says it was received: GorillaDesk said Mon Nov 9, Interac says Sat Nov 7. A payment
// it posted before the email came is re-dated -- and, received on a weekend, moved to Undeposited Funds in the same update
// (its deposit is made separately, dated the next business day). The payment below is made up.
jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));

const { UpdatePaymentTool } = await import('../../../src/tools/update-payment.tool');
const { isRealDate } = await import('../../../src/handlers/update-quickbooks-payment.handler');

const run = async (params: unknown): Promise<any> => UpdatePaymentTool.handler({ params } as any, {} as any);
const text = (r: any) => r.content.map((c: any) => c.text).join('\n');
const PAYMENT = {
  CustomerRef: { value: '9001', name: 'Pat Example #7001' },
  DepositToAccountRef: { value: '1150040002' },
  PaymentMethodRef: { value: '17' },
  PaymentRefNum: 'C1AexAmple01',
  TotalAmt: 170.47,
  UnappliedAmt: 0,
  domain: 'QBO',
  sparse: false,
  Id: '126001',
  SyncToken: '2',
  MetaData: { CreateTime: '2026-11-09T06:10:05-08:00', LastUpdatedTime: '2026-11-09T06:10:05-08:00' },
  TxnDate: '2026-11-09',
  PrivateNote: 'e-Transfer C1AexAmple01 · Invoice #44001',
  Line: [{ Amount: 170.47, LinkedTxn: [{ TxnId: '125001', TxnType: 'Invoice' }] }],
};
const reads = (payment: any) => (mockQuickBooksInstance.getPayment as jest.Mock).mockImplementation((_id: any, cb: any) => cb(null, JSON.parse(JSON.stringify(payment))));
const sends = () => (mockQuickBooksInstance.updatePayment as jest.Mock).mockImplementation((p: any, cb: any) => cb(null, { ...p, SyncToken: '3' }));
const sent = () => (mockQuickBooksInstance.updatePayment as jest.Mock).mock.calls.map((c: any) => c[0]);

describe('update_payment: txn_date', () => {
  beforeEach(() => {
    resetAllMocks();
    (mockQuickbooksClientClass.getInstance as any).mockResolvedValue(mockQuickBooksInstance);
  });

  it('re-dated to the day Interac received it: the full object, the new date, everything else as it was', async () => {
    reads(PAYMENT);
    sends();
    const r = await run({ id: '126001', sync_token: '2', txn_date: '2026-11-07' });
    expect(text(r)).toMatch(/^Payment updated successfully:/);
    expect(sent()).toStrictEqual([{
      Id: '126001',
      SyncToken: '2',
      sparse: false,
      CustomerRef: { value: '9001' },
      TotalAmt: 170.47,
      TxnDate: '2026-11-07',
      DepositToAccountRef: { value: '1150040002' },
      PaymentMethodRef: { value: '17' },
      PaymentRefNum: 'C1AexAmple01',
      PrivateNote: 'e-Transfer C1AexAmple01 · Invoice #44001',
      Line: [{ Amount: 170.47, LinkedTxn: [{ TxnId: '125001', TxnType: 'Invoice' }] }],
    }]);
  });

  it('re-dated to a Saturday and moved to Undeposited Funds in one update', async () => {
    reads(PAYMENT);
    sends();
    await run({ id: '126001', sync_token: '2', txn_date: '2026-11-07', deposit_to_account: '7' });
    expect([sent()[0].TxnDate, sent()[0].DepositToAccountRef]).toStrictEqual(['2026-11-07', { value: '7' }]);
  });

  it('without txn_date the date QuickBooks has is kept', async () => {
    reads(PAYMENT);
    sends();
    await run({ id: '126001', sync_token: '2', private_note: 'checked' });
    expect(sent()[0].TxnDate).toBe('2026-11-09');
  });

  it('a date that does not exist is refused before anything is read or sent', async () => {
    reads(PAYMENT);
    sends();
    const r = await run({ id: '126001', sync_token: '2', txn_date: '2026-02-30' });
    expect(text(r)).toBe('Error updating payment: payment 126001: 2026-02-30 is not a date (YYYY-MM-DD); nothing was changed');
    expect(mockQuickBooksInstance.getPayment as jest.Mock).not.toHaveBeenCalled();
    expect(sent()).toStrictEqual([]);
  });

  it('the schema takes YYYY-MM-DD only', () => {
    const ok = (txn_date: string) => UpdatePaymentTool.schema.safeParse({ id: '126001', sync_token: '2', txn_date }).success;
    expect(['2026-11-07', '2027-12-27'].map(ok)).toStrictEqual([true, true]);
    expect(['2026-11-7', '11/07/2026', '2026-13-01', '2026-11-32', '', '2026-11-07T00:00:00Z'].map(ok)).toStrictEqual([false, false, false, false, false, false]);
  });

  it('isRealDate: real calendar days only', () => {
    expect(['2026-11-07', '2028-02-29', '2026-02-28'].map(isRealDate)).toStrictEqual([true, true, true]);
    expect(['2026-02-29', '2026-02-30', '2026-04-31', 'Nov 7'].map(isRealDate)).toStrictEqual([false, false, false, false]);
  });
});
