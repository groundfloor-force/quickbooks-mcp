import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockQuickbooksClient, mockQuickbooksClientClass, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';

// update_payment sets the reference no. (PaymentRefNum) (Steve, 2026-11-23; gd-qbo-worker DECISIONS 156). GorillaDesk's
// old sync kept an e-transfer's reference only in the memo. Customer 8273's e-transfer C1Acj2DTCP77 was $64.50:
// $64.45 on invoice #44193 and a $0.05 credit; QuickBooks payment 124472 had only the $64.45, in Undeposited Funds.
// The worker makes it whole in ONE update: total $64.50, reference C1Acj2DTCP77, the bank account; its line unchanged,
// so the $0.05 is left unapplied.
jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));

const { UpdatePaymentTool } = await import('../../../src/tools/update-payment.tool');

const run = async (params: unknown): Promise<any> => UpdatePaymentTool.handler({ params } as any, {} as any);
const text = (r: any) => r.content.map((c: any) => c.text).join('\n');
const nv = (name: string, value: string) => ({ name: '{http://schema.intuit.com/finance/v3}NameValue', declaredType: 'com.intuit.schema.finance.v3.NameValue',
  scope: 'javax.xml.bind.JAXBElement$GlobalScope', value: { Name: name, Value: value }, nil: false, globalScope: true, typeSubstituted: false });
/** Payment 124472 as QuickBooks returned it on 2026-11-23 (the customer's name replaced). */
const P124472 = {
  CustomerRef: { value: '2942', name: 'A customer #8273' },
  DepositToAccountRef: { value: '7' },
  PaymentMethodRef: { value: '17' },
  TotalAmt: 64.45,
  UnappliedAmt: 0,
  ProcessPayment: false,
  domain: 'QBO',
  sparse: false,
  Id: '124472',
  SyncToken: '0',
  MetaData: { CreateTime: '2026-11-02T06:10:05-08:00', LastUpdatedTime: '2026-11-02T06:10:05-08:00' },
  TxnDate: '2026-11-02',
  CurrencyRef: { value: 'CAD', name: 'Canadian Dollar' },
  PrivateNote: 'C1Acj2DTCP77',
  Line: [{ Amount: 64.45, LinkedTxn: [{ TxnId: '124205', TxnType: 'Invoice' }],
    LineEx: { any: [nv('txnId', '124205'), nv('txnOpenBalance', '64.45'), nv('txnReferenceNumber', '44193')] } }],
};
const reads = (payment: any) => (mockQuickBooksInstance.getPayment as jest.Mock).mockImplementation((_id: any, cb: any) => cb(null, JSON.parse(JSON.stringify(payment))));
const sends = () => (mockQuickBooksInstance.updatePayment as jest.Mock).mockImplementation((p: any, cb: any) => cb(null, { ...p, SyncToken: '1' }));
const sent = () => (mockQuickBooksInstance.updatePayment as jest.Mock).mock.calls.map((c: any) => c[0]);

describe('update_payment: payment_ref_num', () => {
  beforeEach(() => {
    resetAllMocks();
    (mockQuickbooksClientClass.getInstance as any).mockResolvedValue(mockQuickBooksInstance);
  });

  it('124472 made whole in one update: $64.50, reference C1Acj2DTCP77, the bank -- its line as it was, so $0.05 is unapplied', async () => {
    reads(P124472);
    sends();
    const r = await run({ id: '124472', sync_token: '0', total_amt: 64.5, payment_ref_num: 'C1Acj2DTCP77', deposit_to_account: '1150040002' });
    expect(text(r)).toMatch(/^Payment updated successfully:/);
    expect(sent()).toStrictEqual([{
      Id: '124472',
      SyncToken: '0',
      sparse: false,
      CustomerRef: { value: '2942' },
      TotalAmt: 64.5,
      TxnDate: '2026-11-02',
      DepositToAccountRef: { value: '1150040002' },
      PaymentMethodRef: { value: '17' },
      PaymentRefNum: 'C1Acj2DTCP77',
      PrivateNote: 'C1Acj2DTCP77',
      Line: [{ Amount: 64.45, LinkedTxn: [{ TxnId: '124205', TxnType: 'Invoice' }] }],
    }]);
  });

  it('without payment_ref_num the reference QuickBooks has is kept (Customer 11557\'s 126158, C1Ac76cuxKeq)', async () => {
    reads({ ...P124472, Id: '126158', PaymentRefNum: 'C1Ac76cuxKeq', PrivateNote: undefined });
    sends();
    await run({ id: '126158', sync_token: '0', private_note: 'checked' });
    expect(sent()[0].PaymentRefNum).toBe('C1Ac76cuxKeq');
    expect(sent()[0].PrivateNote).toBe('checked');
  });

  it('the schema refuses a reference QuickBooks would cut (over 21 characters) or an empty one; nothing is read or sent', async () => {
    const schema = UpdatePaymentTool.schema;
    expect(schema.safeParse({ id: '124472', sync_token: '0', payment_ref_num: 'C1Acj2DTCP77' }).success).toBe(true);
    expect(schema.safeParse({ id: '124472', sync_token: '0', payment_ref_num: 'x'.repeat(21) }).success).toBe(true);
    expect(schema.safeParse({ id: '124472', sync_token: '0', payment_ref_num: 'x'.repeat(22) }).success).toBe(false);
    expect(schema.safeParse({ id: '124472', sync_token: '0', payment_ref_num: '' }).success).toBe(false);
  });
});
