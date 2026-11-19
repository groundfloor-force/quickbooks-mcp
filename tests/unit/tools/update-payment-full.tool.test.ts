import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockQuickbooksClient, mockQuickbooksClientClass, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';

// update_payment sends a FULL update (Steve, 2026-11-19; gd-qbo-worker DECISIONS 149). QuickBooks refused a sparse
// update that changed payment 124362's Line: "Required param missing, need to supply the required value for the API".
// Payment updates are not sparse: for ANY change the payment is read, the change merged into the full object, and the
// whole object sent -- Id and SyncToken from the read, CustomerRef, TotalAmt, TxnDate, DepositToAccountRef,
// PaymentMethodRef, PaymentRefNum, PrivateNote, Line -- without the read-only fields (MetaData, domain, the top-level
// LinkedTxn, each line's LineEx) and with `sparse: false` said out loud: node-quickbooks makes an update sparse whenever
// the object does not say otherwise.
jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));

const { UpdatePaymentTool } = await import('../../../src/tools/update-payment.tool');

const run = async (params: unknown): Promise<any> => UpdatePaymentTool.handler({ params } as any, {} as any);
const text = (r: any) => r.content.map((c: any) => c.text).join('\n');
const nv = (name: string, value: string) => ({ name: '{http://schema.intuit.com/finance/v3}NameValue', declaredType: 'com.intuit.schema.finance.v3.NameValue',
  scope: 'javax.xml.bind.JAXBElement$GlobalScope', value: { Name: name, Value: value }, nil: false, globalScope: true, typeSubstituted: false });
/** Payment 124362 exactly as QuickBooks returned it on 2026-11-19 (only the customer's name replaced). */
const P124362 = {
  CustomerRef: { value: '6859', name: 'A customer #12507' },
  DepositToAccountRef: { value: '7' },
  PaymentMethodRef: { value: '21' },
  TotalAmt: 399.63,
  UnappliedAmt: 0.01,
  ProcessPayment: false,
  domain: 'QBO',
  sparse: false,
  Id: '124362',
  SyncToken: '0',
  MetaData: { CreateTime: '2026-11-02T03:11:25-08:00', LastUpdatedTime: '2026-11-02T03:11:25-08:00' },
  TxnDate: '2026-11-01',
  CurrencyRef: { value: 'CAD', name: 'Canadian Dollar' },
  LinkedTxn: [{ TxnId: '124363', TxnType: 'Deposit' }],
  Line: [{ Amount: 399.62, LinkedTxn: [{ TxnId: '124361', TxnType: 'Invoice' }],
    LineEx: { any: [nv('txnId', '124361'), nv('txnOpenBalance', '399.63'), nv('txnReferenceNumber', '44083')] } }],
};
// A JSON copy, as QuickBooks' reply is parsed (structuredClone would build objects of another realm than jest's).
const reads = (payment: any) => (mockQuickBooksInstance.getPayment as jest.Mock).mockImplementation((_id: any, cb: any) => cb(null, JSON.parse(JSON.stringify(payment))));
const sends = () => (mockQuickBooksInstance.updatePayment as jest.Mock).mockImplementation((p: any, cb: any) => cb(null, { ...p, SyncToken: '1' }));
const sent = () => (mockQuickBooksInstance.updatePayment as jest.Mock).mock.calls.map((c: any) => c[0]);

describe('update_payment: a full update, every time', () => {
  beforeEach(() => {
    resetAllMocks();
    (mockQuickbooksClientClass.getInstance as any).mockResolvedValue(mockQuickBooksInstance);
  });

  it('124362: its $0.01 applied -- the exact full object sent (read-only fields gone, sparse: false)', async () => {
    reads(P124362);
    sends();
    const r = await run({ id: '124362', sync_token: '0', line: [{ amount: 399.63, linked_txn: [{ txn_id: '124361', txn_type: 'Invoice' }] }] });
    expect(text(r)).toMatch(/^Payment updated successfully:/);
    expect(sent()).toStrictEqual([{
      Id: '124362',
      SyncToken: '0',
      sparse: false,
      CustomerRef: { value: '6859' },
      TotalAmt: 399.63,
      TxnDate: '2026-11-01',
      DepositToAccountRef: { value: '7' },
      PaymentMethodRef: { value: '21' },
      Line: [{ Amount: 399.63, LinkedTxn: [{ TxnId: '124361', TxnType: 'Invoice' }] }],
    }]);
  });

  it('a deposit_to_account move still works: the full object, the new account, its lines kept (without LineEx)', async () => {
    const inUndeposited = { ...P124362, LinkedTxn: [] };
    reads(inUndeposited);
    sends();
    expect(text(await run({ id: '124362', sync_token: '0', deposit_to_account: '1150040002' }))).toMatch(/^Payment updated successfully:/);
    expect(sent()).toStrictEqual([{
      Id: '124362', SyncToken: '0', sparse: false, CustomerRef: { value: '6859' }, TotalAmt: 399.63, TxnDate: '2026-11-01',
      DepositToAccountRef: { value: '1150040002' }, PaymentMethodRef: { value: '21' },
      Line: [{ Amount: 399.62, LinkedTxn: [{ TxnId: '124361', TxnType: 'Invoice' }] }],
    }]);
  });

  it('...and an account move of a payment in a bank deposit is still refused, naming the deposit; a line change on it is not', async () => {
    reads(P124362);
    expect(text(await run({ id: '124362', sync_token: '0', deposit_to_account: '1150040002' }))).toMatch(/already in deposit 124363/);
    expect(mockQuickBooksInstance.updatePayment).not.toHaveBeenCalled();
  });

  it('a memo or reference already on the payment is kept; a new memo replaces it; the rest as read', async () => {
    reads({ ...P124362, PaymentRefNum: 'c96mePmux8I64lE44i8my', PrivateNote: 'Square •••• 9202 · Invoice #44083' });
    sends();
    await run({ id: '124362', sync_token: '0', private_note: 'Square •••• 9202 · Invoice #44083 (checked)' });
    expect(sent()[0]).toStrictEqual({
      Id: '124362', SyncToken: '0', sparse: false, CustomerRef: { value: '6859' }, TotalAmt: 399.63, TxnDate: '2026-11-01',
      DepositToAccountRef: { value: '7' }, PaymentMethodRef: { value: '21' }, PaymentRefNum: 'c96mePmux8I64lE44i8my',
      PrivateNote: 'Square •••• 9202 · Invoice #44083 (checked)',
      Line: [{ Amount: 399.62, LinkedTxn: [{ TxnId: '124361', TxnType: 'Invoice' }] }],
    });
  });

  it('a payment that cannot be read is refused, whatever the change: never a full update built blind', async () => {
    (mockQuickBooksInstance.getPayment as jest.Mock).mockImplementation((_id: any, cb: any) => cb({ Fault: { Error: [{ Message: 'Object Not Found' }] } }, null));
    expect(text(await run({ id: '124362', sync_token: '0', private_note: 'n' }))).toMatch(/^Error updating payment:/);
    expect(mockQuickBooksInstance.updatePayment).not.toHaveBeenCalled();
  });

  it('a sync_token other than the payment\'s is refused: it changed since the caller read it (nothing is overwritten)', async () => {
    reads({ ...P124362, SyncToken: '4' });
    expect(text(await run({ id: '124362', sync_token: '0', private_note: 'n' }))).toMatch(/payment 124362 changed since it was read \(SyncToken 4, not 0\); nothing was changed/);
    expect(mockQuickBooksInstance.updatePayment).not.toHaveBeenCalled();
  });
});
