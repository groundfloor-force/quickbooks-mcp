import { jest, describe, it, expect, beforeEach, beforeAll } from '@jest/globals';
import { mockQuickbooksClient, mockQuickbooksClientClass, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';

// ESM-compatible module mocking
jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));

// Dynamic imports after mock setup
const { createQuickbooksPayment } = await import('../../../src/handlers/create-quickbooks-payment.handler');
const { getQuickbooksPayment } = await import('../../../src/handlers/get-quickbooks-payment.handler');
const { updateQuickbooksPayment } = await import('../../../src/handlers/update-quickbooks-payment.handler');
const { deleteQuickbooksPayment } = await import('../../../src/handlers/delete-quickbooks-payment.handler');
const { searchQuickbooksPayments } = await import('../../../src/handlers/search-quickbooks-payments.handler');

describe('Payment Handlers', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  describe('createQuickbooksPayment', () => {
    // Default: the duplicate check finds nothing, so the create path runs as before.
    beforeEach(() => {
      (mockQuickBooksInstance.findPayments as jest.Mock).mockImplementation(
        (_c: any, cb: any) => cb(null, { QueryResponse: {} })
      );
    });

    it('should create a payment successfully', async () => {
      const mockPayment = { Id: '123', TotalAmt: 100 };
      (mockQuickBooksInstance.createPayment as jest.Mock).mockImplementation(
        (_payload: any, cb: any) => cb(null, mockPayment)
      );

      const result = await createQuickbooksPayment({ customer_ref: 'cust-1', total_amt: 100 });

      expect(result.isError).toBe(false);
      expect(result.result).toEqual(mockPayment);
    });

    it('should handle API errors', async () => {
      (mockQuickBooksInstance.createPayment as jest.Mock).mockImplementation(
        (_payload: any, cb: any) => cb(new Error('API Error'), null)
      );

      const result = await createQuickbooksPayment({ customer_ref: 'cust-1', total_amt: 100 });

      expect(result.isError).toBe(true);
    });

    it('should handle authentication errors', async () => {
      (mockQuickbooksClientClass.getInstance as any).mockRejectedValue(new Error('Auth failed'));

      const result = await createQuickbooksPayment({ customer_ref: 'cust-1', total_amt: 100 });

      expect(result.isError).toBe(true);
      expect(result.error).toContain('Auth failed');
    });

    it('should create a payment with all optional fields', async () => {
      const mockPayment = { Id: '123', TotalAmt: 100 };
      (mockQuickBooksInstance.createPayment as jest.Mock).mockImplementation(
        (_payload: any, cb: any) => cb(null, mockPayment)
      );

      const result = await createQuickbooksPayment({
        customer_ref: 'cust-1',
        total_amt: 100,
        payment_method_ref: 'pm-1',
        deposit_to_account_ref: 'acc-1',
        txn_date: '2024-01-01',
        private_note: 'Test note',
        line: [{ amount: 100, linked_txn: [{ txn_id: 'inv-1', txn_type: 'Invoice' }] }]
      });

      expect(result.isError).toBe(false);
      expect(result.result).toEqual(mockPayment);
    });

    it('should map reference number and multicurrency fields onto the QBO payload', async () => {
      // Capture the payload the handler builds so we can assert the new
      // PaymentRefNum / CurrencyRef / ExchangeRate fields are wired through —
      // these previously had no schema entry and were silently dropped.
      let capturedPayload: any = null;
      (mockQuickBooksInstance.createPayment as jest.Mock).mockImplementation(
        (payload: any, cb: any) => {
          capturedPayload = payload;
          cb(null, { Id: '123' });
        }
      );

      const result = await createQuickbooksPayment({
        customer_ref: 'cust-1',
        total_amt: 100,
        payment_ref_num: '755182592',
        currency_ref: 'GBP',
        exchange_rate: 1.17,
      });

      expect(result.isError).toBe(false);
      // PaymentRefNum is a plain string ("Reference no." in the QBO UI).
      expect(capturedPayload.PaymentRefNum).toBe('755182592');
      // CurrencyRef must be wrapped in { value } like the other *Ref fields.
      expect(capturedPayload.CurrencyRef).toEqual({ value: 'GBP' });
      expect(capturedPayload.ExchangeRate).toBe(1.17);
    });

    it('should omit reference number and multicurrency fields when not provided', async () => {
      // Backward compatibility: existing single-currency callers must not get
      // any of the new keys injected into their payload.
      let capturedPayload: any = null;
      (mockQuickBooksInstance.createPayment as jest.Mock).mockImplementation(
        (payload: any, cb: any) => {
          capturedPayload = payload;
          cb(null, { Id: '123' });
        }
      );

      await createQuickbooksPayment({ customer_ref: 'cust-1', total_amt: 100 });

      expect(capturedPayload).not.toHaveProperty('PaymentRefNum');
      expect(capturedPayload).not.toHaveProperty('CurrencyRef');
      expect(capturedPayload).not.toHaveProperty('ExchangeRate');
    });

    describe('duplicate guard', () => {
      const input = { customer_ref: 'cust-1', total_amt: 100, txn_date: '2026-11-05', payment_ref_num: 'EFT-1' };

      it('refuses when a matching payment exists, without creating', async () => {
        (mockQuickBooksInstance.findPayments as jest.Mock).mockImplementation((_c: any, cb: any) =>
          cb(null, { QueryResponse: { Payment: [{ Id: '55', PaymentRefNum: 'EFT-1', TotalAmt: 100, TxnDate: '2026-11-05', CustomerRef: { value: 'cust-1' } }] } })
        );

        const result = await createQuickbooksPayment(input);

        expect(result.isError).toBe(true);
        expect(result.error).toBe(
          'Possible duplicate — Payment already exists: Id 55, #EFT-1, $100, 2026-11-05, customer cust-1. Pass allow_duplicate: true to create anyway.'
        );
        expect(mockQuickBooksInstance.createPayment).not.toHaveBeenCalled();
      });

      it('creates with an unchanged payload when no duplicate is found', async () => {
        (mockQuickBooksInstance.createPayment as jest.Mock).mockImplementation((_p: any, cb: any) => cb(null, { Id: '56' }));

        const result = await createQuickbooksPayment(input);

        expect(result.isError).toBe(false);
        expect((mockQuickBooksInstance.findPayments as jest.Mock).mock.calls[0][0]).toEqual([
          { field: 'CustomerRef', value: 'cust-1', operator: '=' },
          { field: 'TxnDate', value: '2026-11-05', operator: '=' },
          { field: 'limit', value: 50 },
        ]);
        expect((mockQuickBooksInstance.createPayment as jest.Mock).mock.calls[0][0]).toStrictEqual({
          CustomerRef: { value: 'cust-1' },
          TotalAmt: 100,
          TxnDate: '2026-11-05',
          PaymentRefNum: 'EFT-1',
        });
      });

      it('creates the 4th of four same-day, same-amount payments when each pays a different invoice', async () => {
        // Four $287.50 payments on Oct 7 for four invoices; three are already in QBO.
        const existing = ['501', '502', '503'].map((inv, i) => ({
          Id: `6${i + 1}`, TotalAmt: 287.5, TxnDate: '2026-10-07', CustomerRef: { value: 'cust-1' },
          Line: [{ Amount: 287.5, LinkedTxn: [{ TxnId: inv, TxnType: 'Invoice' }] }],
        }));
        (mockQuickBooksInstance.findPayments as jest.Mock).mockImplementation((_c: any, cb: any) =>
          cb(null, { QueryResponse: { Payment: existing } })
        );
        (mockQuickBooksInstance.createPayment as jest.Mock).mockImplementation((_p: any, cb: any) => cb(null, { Id: '64' }));

        const result = await createQuickbooksPayment({
          customer_ref: 'cust-1',
          total_amt: 287.5,
          txn_date: '2026-10-07',
          line: [{ amount: 287.5, linked_txn: [{ txn_id: '504', txn_type: 'Invoice' }] }],
        });

        expect(result.isError).toBe(false);
        expect(mockQuickBooksInstance.createPayment).toHaveBeenCalledTimes(1);
      });

      it('skips the check entirely when allow_duplicate is true', async () => {
        (mockQuickBooksInstance.createPayment as jest.Mock).mockImplementation((_p: any, cb: any) => cb(null, { Id: '57' }));

        const result = await createQuickbooksPayment({ ...input, allow_duplicate: true });

        expect(result.isError).toBe(false);
        expect(mockQuickBooksInstance.findPayments).not.toHaveBeenCalled();
        expect((mockQuickBooksInstance.createPayment as jest.Mock).mock.calls[0][0]).not.toHaveProperty('allow_duplicate');
      });

      it('refuses (fails closed) when the duplicate check errors', async () => {
        (mockQuickBooksInstance.findPayments as jest.Mock).mockImplementation((_c: any, cb: any) => cb(new Error('QBO down'), null));

        const result = await createQuickbooksPayment(input);

        expect(result.isError).toBe(true);
        expect(result.error).toBe('Duplicate check failed: Error: QBO down. Retry, or pass allow_duplicate: true.');
        expect(mockQuickBooksInstance.createPayment).not.toHaveBeenCalled();
      });
    });
  });

  describe('getQuickbooksPayment', () => {
    it('should get a payment by ID', async () => {
      const mockPayment = { Id: '123', TotalAmt: 100 };
      (mockQuickBooksInstance.getPayment as jest.Mock).mockImplementation(
        (_id: any, cb: any) => cb(null, mockPayment)
      );

      const result = await getQuickbooksPayment('123');

      expect(result.isError).toBe(false);
      expect(result.result).toEqual(mockPayment);
    });

    it('should handle not found errors', async () => {
      (mockQuickBooksInstance.getPayment as jest.Mock).mockImplementation(
        (_id: any, cb: any) => cb(new Error('Not found'), null)
      );

      const result = await getQuickbooksPayment('999');

      expect(result.isError).toBe(true);
    });

    it('should handle authentication errors', async () => {
      (mockQuickbooksClientClass.getInstance as any).mockRejectedValue(new Error('Auth failed'));

      const result = await getQuickbooksPayment('123');

      expect(result.isError).toBe(true);
      expect(result.error).toContain('Auth failed');
    });
  });

  describe('updateQuickbooksPayment', () => {
    it('should update a payment', async () => {
      const mockUpdated = { Id: '123', TotalAmt: 150 };
      (mockQuickBooksInstance.updatePayment as jest.Mock).mockImplementation(
        (_payload: any, cb: any) => cb(null, mockUpdated)
      );

      const result = await updateQuickbooksPayment({ id: '123', sync_token: '0', total_amt: 150 });

      expect(result.isError).toBe(false);
      expect(result.result).toEqual(mockUpdated);
    });

    it('should update with all optional fields', async () => {
      const mockUpdated = { Id: '123' };
      (mockQuickBooksInstance.updatePayment as jest.Mock).mockImplementation(
        (_payload: any, cb: any) => cb(null, mockUpdated)
      );

      const result = await updateQuickbooksPayment({
        id: '123',
        sync_token: '0',
        customer_ref: 'cust-1',
        total_amt: 200,
        payment_method_ref: 'pm-1',
        private_note: 'Updated payment note'
      });

      expect(result.isError).toBe(false);
    });

    it('should update without total_amt', async () => {
      const mockUpdated = { Id: '123' };
      (mockQuickBooksInstance.updatePayment as jest.Mock).mockImplementation(
        (_payload: any, cb: any) => cb(null, mockUpdated)
      );

      const result = await updateQuickbooksPayment({
        id: '123',
        sync_token: '0',
        customer_ref: 'cust-2'
      });

      expect(result.isError).toBe(false);
    });

    it('should handle API errors', async () => {
      (mockQuickBooksInstance.updatePayment as jest.Mock).mockImplementation(
        (_payload: any, cb: any) => cb(new Error('Update failed'), null)
      );

      const result = await updateQuickbooksPayment({ id: '123', sync_token: '0', total_amt: 150 });

      expect(result.isError).toBe(true);
    });

    it('should handle authentication errors', async () => {
      (mockQuickbooksClientClass.getInstance as any).mockRejectedValue(new Error('Auth failed'));

      const result = await updateQuickbooksPayment({ id: '123', sync_token: '0', total_amt: 150 });

      expect(result.isError).toBe(true);
      expect(result.error).toContain('Auth failed');
    });
  });

  describe('deleteQuickbooksPayment', () => {
    it('should void a payment', async () => {
      const mockVoided = { Id: '123', status: 'Voided' };
      (mockQuickBooksInstance.deletePayment as jest.Mock).mockImplementation(
        (_payload: any, cb: any) => cb(null, mockVoided)
      );

      const result = await deleteQuickbooksPayment({ id: '123', sync_token: '0' });

      expect(result.isError).toBe(false);
    });

    it('should handle API errors', async () => {
      (mockQuickBooksInstance.deletePayment as jest.Mock).mockImplementation(
        (_payload: any, cb: any) => cb(new Error('Delete failed'), null)
      );

      const result = await deleteQuickbooksPayment({ id: '123', sync_token: '0' });

      expect(result.isError).toBe(true);
    });

    it('should handle authentication errors', async () => {
      (mockQuickbooksClientClass.getInstance as any).mockRejectedValue(new Error('Auth failed'));

      const result = await deleteQuickbooksPayment({ id: '123', sync_token: '0' });

      expect(result.isError).toBe(true);
      expect(result.error).toContain('Auth failed');
    });
  });

  describe('searchQuickbooksPayments', () => {
    it('should search payments with criteria', async () => {
      const mockPayments = [{ Id: '1' }, { Id: '2' }];
      (mockQuickBooksInstance.findPayments as jest.Mock).mockImplementation(
        (_criteria: any, cb: any) => cb(null, { QueryResponse: { Payment: mockPayments } })
      );

      const result = await searchQuickbooksPayments({ limit: 10 });

      expect(result.isError).toBe(false);
      expect(result.result).toEqual(mockPayments);
    });

    it('should return empty array when no results', async () => {
      (mockQuickBooksInstance.findPayments as jest.Mock).mockImplementation(
        (_criteria: any, cb: any) => cb(null, { QueryResponse: {} })
      );

      const result = await searchQuickbooksPayments({});

      expect(result.isError).toBe(false);
      expect(result.result).toEqual([]);
    });

    it('should handle API errors', async () => {
      (mockQuickBooksInstance.findPayments as jest.Mock).mockImplementation(
        (_criteria: any, cb: any) => cb(new Error('Search failed'), null)
      );

      const result = await searchQuickbooksPayments({});

      expect(result.isError).toBe(true);
    });

    it('should handle authentication errors', async () => {
      (mockQuickbooksClientClass.getInstance as any).mockRejectedValue(new Error('Auth failed'));

      const result = await searchQuickbooksPayments({ limit: 10 });

      expect(result.isError).toBe(true);
      expect(result.error).toContain('Auth failed');
    });

    it('should search with all filter options', async () => {
      (mockQuickBooksInstance.findPayments as jest.Mock).mockImplementation(
        (_criteria: any, cb: any) => cb(null, { QueryResponse: { Payment: [] } })
      );

      const result = await searchQuickbooksPayments({
        customer_ref: 'cust-1',
        txn_date_from: '2024-01-01',
        txn_date_to: '2024-12-31',
        limit: 50
      });

      expect(result.isError).toBe(false);
    });
  });
});


