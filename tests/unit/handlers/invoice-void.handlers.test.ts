import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockQuickbooksClient, mockQuickbooksClientClass, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';

// ESM-compatible module mocking
jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));

// Dynamic imports after mock setup
const { voidQuickbooksInvoice } = await import('../../../src/handlers/void-quickbooks-invoice.handler');

describe('voidQuickbooksInvoice', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  const openInvoice = { Id: '124423', SyncToken: '3', Balance: 150, TotalAmt: 150, CustomerRef: { value: '7' } };
  const paidInvoice = { ...openInvoice, Balance: 0 };

  it('voids an open invoice, sending only Id and SyncToken', async () => {
    mockQuickBooksInstance.getInvoice.mockImplementation((_id: any, cb: any) => cb(null, openInvoice));
    const voided = { ...openInvoice, SyncToken: '4', Balance: 0, TotalAmt: 0 };
    mockQuickBooksInstance.voidInvoice.mockImplementation((_payload: any, cb: any) => cb(null, voided));

    const result = await voidQuickbooksInvoice({ invoice_id: '124423' });

    expect(result.isError).toBe(false);
    expect(result.result).toEqual(voided);
    expect((mockQuickBooksInstance.getInvoice.mock.calls[0] as any)[0]).toBe('124423');
    // Exactly Id + SyncToken: no sparse flag, no PrivateNote, nothing from the fetched invoice.
    expect((mockQuickBooksInstance.voidInvoice.mock.calls[0] as any)[0]).toStrictEqual({ Id: '124423', SyncToken: '3' });
  });

  it('refuses an invoice with payments applied when allow_paid is not set', async () => {
    mockQuickBooksInstance.getInvoice.mockImplementation((_id: any, cb: any) => cb(null, paidInvoice));

    const result = await voidQuickbooksInvoice({ invoice_id: '124423' });

    expect(result.isError).toBe(true);
    expect(result.error).toBe(
      'Invoice 124423 has payments applied (Balance 0 of 150). Unapply them first, or pass allow_paid: true.'
    );
    expect(mockQuickBooksInstance.voidInvoice).not.toHaveBeenCalled();
  });

  it('refuses an invoice that is already $0, even with allow_paid', async () => {
    mockQuickBooksInstance.getInvoice.mockImplementation((_id: any, cb: any) =>
      cb(null, { ...openInvoice, Balance: 0, TotalAmt: 0 })
    );

    const result = await voidQuickbooksInvoice({ invoice_id: '124423', allow_paid: true });

    expect(result.isError).toBe(true);
    expect(result.error).toBe('Invoice 124423 is already $0 (voided or empty). Nothing to void.');
    expect(mockQuickBooksInstance.voidInvoice).not.toHaveBeenCalled();
  });

  it('voids an invoice with payments applied when allow_paid is true', async () => {
    mockQuickBooksInstance.getInvoice.mockImplementation((_id: any, cb: any) => cb(null, paidInvoice));
    mockQuickBooksInstance.voidInvoice.mockImplementation((_payload: any, cb: any) => cb(null, { Id: '124423' }));

    const result = await voidQuickbooksInvoice({ invoice_id: '124423', allow_paid: true });

    expect(result.isError).toBe(false);
    expect((mockQuickBooksInstance.voidInvoice.mock.calls[0] as any)[0]).toStrictEqual({ Id: '124423', SyncToken: '3' });
  });

  it('surfaces an error if the initial read fails', async () => {
    mockQuickBooksInstance.getInvoice.mockImplementation((_id: any, cb: any) =>
      cb(new Error('Invoice 124423 not found'), null)
    );

    const result = await voidQuickbooksInvoice({ invoice_id: '124423' });

    expect(result.isError).toBe(true);
    expect(result.error).toContain('not found');
    expect(mockQuickBooksInstance.voidInvoice).not.toHaveBeenCalled();
  });

  it('surfaces an error when voidInvoice calls back with one', async () => {
    mockQuickBooksInstance.getInvoice.mockImplementation((_id: any, cb: any) => cb(null, openInvoice));
    mockQuickBooksInstance.voidInvoice.mockImplementation((_payload: any, cb: any) =>
      cb(new Error('Stale SyncToken'), null)
    );

    const result = await voidQuickbooksInvoice({ invoice_id: '124423' });

    expect(result.isError).toBe(true);
    expect(result.error).toContain('Stale SyncToken');
  });

  it('returns an error (does not reject) when voidInvoice throws synchronously', async () => {
    mockQuickBooksInstance.getInvoice.mockImplementation((_id: any, cb: any) => cb(null, openInvoice));
    mockQuickBooksInstance.voidInvoice.mockImplementation(() => {
      throw new Error('invoice must contain Id and SyncToken fields');
    });

    const result = await voidQuickbooksInvoice({ invoice_id: '124423' });

    expect(result.isError).toBe(true);
    expect(result.error).toContain('must contain Id and SyncToken');
  });

  it('handles authentication errors', async () => {
    (mockQuickbooksClientClass.getInstance as any).mockRejectedValue(new Error('Auth failed'));

    const result = await voidQuickbooksInvoice({ invoice_id: '124423' });

    expect(result.isError).toBe(true);
    expect(result.error).toContain('Auth failed');
  });
});
