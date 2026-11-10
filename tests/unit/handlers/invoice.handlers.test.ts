import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockQuickbooksClient, mockQuickbooksClientClass, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';

// ESM-compatible module mocking
jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));

// Dynamic imports after mock setup
const { createQuickbooksInvoice } = await import('../../../src/handlers/create-quickbooks-invoice.handler');

describe('Invoice Handlers', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  describe('createQuickbooksInvoice', () => {
    // Default: the duplicate check finds nothing, so the create path runs as before.
    beforeEach(() => {
      mockQuickBooksInstance.findInvoices.mockImplementation((_c: any, cb: any) => cb(null, { QueryResponse: {} }));
    });

    it('should create an invoice successfully', async () => {
      const mockInvoice = { Id: '123', TotalAmt: 100 };
      mockQuickBooksInstance.createInvoice.mockImplementation((payload: any, cb: any) => cb(null, mockInvoice));

      const result = await createQuickbooksInvoice({
        customer_ref: 'cust-1',
        line_items: [{ item_ref: 'item-1', qty: 1, unit_price: 100 }]
      });

      expect(result.isError).toBe(false);
      expect(result.result).toEqual(mockInvoice);
      const payload = (mockQuickBooksInstance.createInvoice.mock.calls[0] as any)[0];
      expect(payload).not.toHaveProperty('GlobalTaxCalculation');
    });

    it('should pass per-line TaxCodeRef and GlobalTaxCalculation to QuickBooks', async () => {
      const mockInvoice = { Id: '123', TotalAmt: 100 };
      mockQuickBooksInstance.createInvoice.mockImplementation((payload: any, cb: any) => cb(null, mockInvoice));

      const result = await createQuickbooksInvoice({
        customer_ref: 'cust-1',
        line_items: [
          { item_ref: 'item-1', qty: 2, unit_price: 50, tax_code_ref: '14' },
          { item_ref: 'item-2', qty: 1, unit_price: 75 }
        ],
        global_tax_calculation: 'TaxExcluded'
      });

      expect(result.isError).toBe(false);
      const payload = (mockQuickBooksInstance.createInvoice.mock.calls[0] as any)[0];
      expect(payload.Line[0].SalesItemLineDetail.TaxCodeRef).toEqual({ value: '14' });
      expect(payload.Line[1].SalesItemLineDetail.TaxCodeRef).toBeUndefined();
      expect(payload.GlobalTaxCalculation).toBe('TaxExcluded');
    });

    it('should handle authentication errors', async () => {
      (mockQuickbooksClientClass.getInstance as any).mockRejectedValue(new Error('Auth failed'));

      const result = await createQuickbooksInvoice({ customer_ref: 'cust-1', line_items: [] });

      expect(result.isError).toBe(true);
      expect(result.error).toContain('Auth failed');
    });

    it('should handle API errors', async () => {
      mockQuickBooksInstance.createInvoice.mockImplementation((payload: any, cb: any) =>
        cb(new Error('Validation error'), null)
      );

      const result = await createQuickbooksInvoice({ customer_ref: 'cust-1', line_items: [] });

      expect(result.isError).toBe(true);
    });

    describe('duplicate guard', () => {
      const input = {
        customer_ref: 'cust-1',
        doc_number: '43975',
        txn_date: '2026-11-05',
        line_items: [{ item_ref: 'item-1', qty: 1, unit_price: 100 }],
      };

      it('refuses when a matching invoice exists, without creating', async () => {
        mockQuickBooksInstance.findInvoices.mockImplementation((_c: any, cb: any) =>
          cb(null, { QueryResponse: { Invoice: [{ Id: '900', DocNumber: '43975', TotalAmt: 100, TxnDate: '2026-11-05', CustomerRef: { value: 'cust-1', name: 'Acme Ltd' } }] } })
        );

        const result = await createQuickbooksInvoice(input);

        expect(result.isError).toBe(true);
        expect(result.error).toBe(
          'Possible duplicate — Invoice already exists: Id 900, #43975, $100, 2026-11-05, customer Acme Ltd. Pass allow_duplicate: true to create anyway.'
        );
        expect(mockQuickBooksInstance.createInvoice).not.toHaveBeenCalled();
      });

      it('creates with an unchanged payload when no duplicate is found', async () => {
        mockQuickBooksInstance.createInvoice.mockImplementation((_p: any, cb: any) => cb(null, { Id: '901' }));

        const result = await createQuickbooksInvoice(input);

        expect(result.isError).toBe(false);
        expect((mockQuickBooksInstance.findInvoices.mock.calls[0] as any)[0]).toEqual({ DocNumber: '43975' });
        const payload = (mockQuickBooksInstance.createInvoice.mock.calls[0] as any)[0];
        expect(payload).toEqual({
          CustomerRef: { value: 'cust-1' },
          Line: [{
            Id: '1',
            LineNum: 1,
            Amount: 100,
            DetailType: 'SalesItemLineDetail',
            SalesItemLineDetail: { ItemRef: { value: 'item-1' }, Qty: 1, UnitPrice: 100 },
          }],
          DocNumber: '43975',
          TxnDate: '2026-11-05',
        });
        expect(payload).not.toHaveProperty('allow_duplicate');
      });

      it('skips the check entirely when allow_duplicate is true', async () => {
        mockQuickBooksInstance.createInvoice.mockImplementation((_p: any, cb: any) => cb(null, { Id: '902' }));

        const result = await createQuickbooksInvoice({ ...input, allow_duplicate: true });

        expect(result.isError).toBe(false);
        expect(mockQuickBooksInstance.findInvoices).not.toHaveBeenCalled();
        expect(mockQuickBooksInstance.createInvoice).toHaveBeenCalledTimes(1);
        expect((mockQuickBooksInstance.createInvoice.mock.calls[0] as any)[0]).not.toHaveProperty('allow_duplicate');
      });

      it('refuses (fails closed) when the duplicate check errors', async () => {
        mockQuickBooksInstance.findInvoices.mockImplementation((_c: any, cb: any) => cb(new Error('QBO down'), null));

        const result = await createQuickbooksInvoice(input);

        expect(result.isError).toBe(true);
        expect(result.error).toBe('Duplicate check failed: Error: QBO down. Retry, or pass allow_duplicate: true.');
        expect(mockQuickBooksInstance.createInvoice).not.toHaveBeenCalled();
      });

      it('refuses (fails closed) when the duplicate check throws synchronously', async () => {
        mockQuickBooksInstance.findInvoices.mockImplementation(() => {
          throw new Error('bad criteria');
        });

        const result = await createQuickbooksInvoice(input);

        expect(result.isError).toBe(true);
        expect(result.error).toContain('Duplicate check failed');
        expect(mockQuickBooksInstance.createInvoice).not.toHaveBeenCalled();
      });
    });
  });
});
