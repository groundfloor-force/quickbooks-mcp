import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockQuickbooksClient, mockQuickbooksClientClass, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';
import { mockHttpsRequest, mockUploadResponse, resetUploadMock, uploadedMetadata, uploadSuccess } from '../../mocks/https-upload.mock';

jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));
// The optional attachment is uploaded through a raw https request to QBO's /upload.
jest.unstable_mockModule('https', () => ({
  default: { request: mockHttpsRequest },
  request: mockHttpsRequest,
}));

const { createQuickbooksPurchase } = await import('../../../src/handlers/create-quickbooks-purchase.handler');

const purchase = {
  PaymentType: 'CreditCard',
  AccountRef: { value: '42' },
  Line: [
    { Amount: 86.25, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: '7' } } },
  ],
};
const created = { Id: '7', SyncToken: '0', TotalAmt: 86.25, PaymentType: 'CreditCard' };
const attachment = {
  file_name: 'receipt.jpg',
  base64_content: Buffer.from('jpeg bytes').toString('base64'),
  note: 'Fuel receipt',
};

beforeEach(() => {
  resetAllMocks();
  resetUploadMock();
  // Default: the duplicate check finds nothing, so the create path runs as before.
  mockQuickBooksInstance.findPurchases.mockImplementation((_c: any, cb: any) => cb(null, { QueryResponse: {} }));
});

describe('createQuickbooksPurchase', () => {
  it('passes the purchase to QBO unchanged and returns the created object', async () => {
    mockQuickBooksInstance.createPurchase.mockImplementation((_payload: any, cb: any) => cb(null, created));

    const result = await createQuickbooksPurchase(purchase);

    expect(mockQuickBooksInstance.createPurchase.mock.calls[0][0]).toBe(purchase);
    expect(result).toEqual({ result: created, isError: false, error: null });
    expect(result.result).toBe(created);
    expect(mockHttpsRequest).not.toHaveBeenCalled();
  });

  it('returns the formatted QBO error when the create fails', async () => {
    mockQuickBooksInstance.createPurchase.mockImplementation((_payload: any, cb: any) =>
      cb({ Fault: { Error: [{ Message: 'Invalid account', code: '2500', element: 'AccountRef' }] } }, null)
    );

    const result = await createQuickbooksPurchase(purchase);

    expect(result).toEqual({
      result: null,
      isError: true,
      error: 'Error: Invalid account (QBO code 2500, element AccountRef)',
    });
  });

  it('returns the error when authentication fails', async () => {
    (mockQuickbooksClientClass.getInstance as any).mockRejectedValue(new Error('Auth failed'));

    const result = await createQuickbooksPurchase(purchase);

    expect(result.isError).toBe(true);
    expect(result.error).toBe('Error: Auth failed');
  });
});

describe('createQuickbooksPurchase with an attachment', () => {
  it('creates the purchase, then uploads the file linked to it and returns the attachable id', async () => {
    mockQuickBooksInstance.createPurchase.mockImplementation((_payload: any, cb: any) => cb(null, created));
    mockUploadResponse(200, uploadSuccess('99', 'receipt.jpg'));

    const result = await createQuickbooksPurchase(purchase, attachment);

    expect(mockQuickBooksInstance.createPurchase).toHaveBeenCalledTimes(1);
    expect(mockQuickBooksInstance.createPurchase.mock.invocationCallOrder[0]).toBeLessThan(
      mockHttpsRequest.mock.invocationCallOrder[0]
    );
    expect(uploadedMetadata()).toEqual({
      FileName: 'receipt.jpg',
      ContentType: 'image/jpg', // inferContentType maps .jpg to QBO's literal image/jpg
      Note: 'Fuel receipt',
      AttachableRef: [{ EntityRef: { type: 'Purchase', value: '7' } }],
    });
    expect(result.isError).toBe(false);
    expect(result.result).toEqual({ ...created, _attachment: { attachable_id: '99' } });
  });

  it('still succeeds, with the purchase and an _attachment.error, when the upload fails', async () => {
    mockQuickBooksInstance.createPurchase.mockImplementation((_payload: any, cb: any) => cb(null, created));
    mockUploadResponse(401, 'unauthorized');

    const result = await createQuickbooksPurchase(purchase, attachment);

    expect(result.isError).toBe(false);
    expect(result.result.Id).toBe('7');
    expect(result.result._attachment).toEqual({
      error:
        'Purchase 7 was created but the attachment failed: Error: QBO upload failed (401): authentication or ' +
        'authorization error. Attach it with create_attachable (entity_ref_type Purchase, entity_ref_value 7).',
    });
  });

  it('does not attempt the upload when the create fails', async () => {
    mockQuickBooksInstance.createPurchase.mockImplementation((_payload: any, cb: any) =>
      cb(new Error('Business Validation Error'), null)
    );

    const result = await createQuickbooksPurchase(purchase, attachment);

    expect(result).toEqual({ result: null, isError: true, error: 'Error: Business Validation Error' });
    expect(mockHttpsRequest).not.toHaveBeenCalled();
  });

  it('refuses an attachment that could never upload before creating anything', async () => {
    const oversized = 'A'.repeat(Math.ceil(((100 * 1024 * 1024) + 1) * 4 / 3));

    const result = await createQuickbooksPurchase(purchase, { file_name: 'huge.pdf', base64_content: oversized });

    expect(result.isError).toBe(true);
    expect(result.error).toMatch(
      /^Attachment rejected, so no purchase was created: File too large: approximately \d+ bytes exceeds/
    );
    expect(mockQuickBooksInstance.createPurchase).not.toHaveBeenCalled();
    expect(mockHttpsRequest).not.toHaveBeenCalled();
    expect(mockQuickBooksInstance.findPurchases).not.toHaveBeenCalled();
  });
});

describe('createQuickbooksPurchase duplicate guard', () => {
  const existing = {
    Id: '300',
    PaymentType: 'CreditCard',
    AccountRef: { value: '42', name: 'Visa' },
    TxnDate: '2026-11-05',
    TotalAmt: 99.19,
    Line: [{ Amount: 86.25, DetailType: 'AccountBasedExpenseLineDetail' }],
  };

  it('refuses when a matching purchase exists, without creating', async () => {
    mockQuickBooksInstance.findPurchases.mockImplementation((_c: any, cb: any) =>
      cb(null, { QueryResponse: { Purchase: [existing] } })
    );

    const result = await createQuickbooksPurchase(purchase);

    expect(result).toEqual({
      result: null,
      isError: true,
      error:
        'Possible duplicate — Purchase already exists: Id 300, #n/a, $99.19, 2026-11-05, account Visa. ' +
        'Pass allow_duplicate: true to create anyway.',
    });
    expect(mockQuickBooksInstance.createPurchase).not.toHaveBeenCalled();
  });

  it('refuses before uploading anything when an attachment was given', async () => {
    mockQuickBooksInstance.findPurchases.mockImplementation((_c: any, cb: any) =>
      cb(null, { QueryResponse: { Purchase: [existing] } })
    );

    const result = await createQuickbooksPurchase(purchase, attachment);

    expect(result.isError).toBe(true);
    expect(mockQuickBooksInstance.createPurchase).not.toHaveBeenCalled();
    expect(mockHttpsRequest).not.toHaveBeenCalled();
  });

  it('skips the check entirely when allow_duplicate is true, and still sends the purchase unchanged', async () => {
    mockQuickBooksInstance.createPurchase.mockImplementation((_payload: any, cb: any) => cb(null, created));

    const result = await createQuickbooksPurchase(purchase, undefined, true);

    expect(result).toEqual({ result: created, isError: false, error: null });
    expect(mockQuickBooksInstance.findPurchases).not.toHaveBeenCalled();
    expect(mockQuickBooksInstance.createPurchase.mock.calls[0][0]).toBe(purchase);
  });

  it('refuses (fails closed) when the duplicate check errors', async () => {
    mockQuickBooksInstance.findPurchases.mockImplementation((_c: any, cb: any) => cb(new Error('QBO down'), null));

    const result = await createQuickbooksPurchase(purchase);

    expect(result).toEqual({
      result: null,
      isError: true,
      error: 'Duplicate check failed: Error: QBO down. Retry, or pass allow_duplicate: true.',
    });
    expect(mockQuickBooksInstance.createPurchase).not.toHaveBeenCalled();
  });
});
