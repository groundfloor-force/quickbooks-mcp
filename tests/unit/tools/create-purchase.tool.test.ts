import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockQuickbooksClient, mockQuickbooksClientClass, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';
import { mockHttpsRequest, mockUploadResponse, resetUploadMock, uploadSuccess } from '../../mocks/https-upload.mock';

// The tool module imports its handler, which imports the quickbooks-client and https.
jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));
jest.unstable_mockModule('https', () => ({
  default: { request: mockHttpsRequest },
  request: mockHttpsRequest,
}));

const { CreatePurchaseTool } = await import('../../../src/tools/create-purchase.tool');

const purchase = { PaymentType: 'Cash', AccountRef: { value: '35' }, Line: [] };
const attachment = { file_name: 'receipt.png', base64_content: Buffer.from('png').toString('base64') };
const created = { Id: '7', TotalAmt: 12.5 };

const run = async (params: unknown): Promise<any> => CreatePurchaseTool.handler({ params } as any, {} as any);

describe('create_purchase schema', () => {
  it('accepts an attachment next to the purchase', () => {
    const parsed = CreatePurchaseTool.schema.safeParse({ purchase, attachment: { ...attachment, include_on_send: false } });
    expect(parsed.success).toBe(true);
  });

  it('rejects an attachment with an empty file_name', () => {
    expect(CreatePurchaseTool.schema.safeParse({ purchase, attachment: { ...attachment, file_name: '' } }).success).toBe(false);
  });

  it('accepts allow_duplicate next to the purchase, and only as a boolean', () => {
    expect(CreatePurchaseTool.schema.safeParse({ purchase, allow_duplicate: false }).success).toBe(true);
    expect(CreatePurchaseTool.schema.safeParse({ purchase, allow_duplicate: 1 }).success).toBe(false);
  });

  it('mentions the duplicate check and the attachment in the description', () => {
    expect(CreatePurchaseTool.description).toBe(
      'Create a purchase in QuickBooks Online. Refuses if a matching record already exists unless allow_duplicate is true. ' +
        'Optional attachment uploads a base64 file and links it; the response includes _attachment.'
    );
  });
});

describe('create_purchase tool handler', () => {
  beforeEach(() => {
    resetAllMocks();
    resetUploadMock();
    mockQuickBooksInstance.createPurchase.mockImplementation((_payload: any, cb: any) => cb(null, created));
    // Default: the duplicate check finds nothing.
    mockQuickBooksInstance.findPurchases.mockImplementation((_c: any, cb: any) => cb(null, { QueryResponse: {} }));
  });

  it('prints the same two lines as before when there is no attachment', async () => {
    const res = await run({ purchase });

    expect(res.content).toEqual([
      { type: 'text', text: 'Purchase created:' },
      { type: 'text', text: JSON.stringify(created) },
    ]);
  });

  it('leads with the purchase and attachment ids when the attachment uploads', async () => {
    mockUploadResponse(200, uploadSuccess('99', 'receipt.png'));

    const res = await run({ purchase, attachment });

    expect(res.content).toHaveLength(2);
    expect(res.content[0].text).toBe('Purchase created: Id 7, attachment 99');
    expect(JSON.parse(res.content[1].text)).toEqual({ ...created, _attachment: { attachable_id: '99' } });
  });

  it('leads with a WARNING line when the purchase was created but the attachment failed', async () => {
    mockUploadResponse(500, 'down');

    const res = await run({ purchase, attachment });

    expect(res.content).toHaveLength(3);
    expect(res.content[0].text).toBe(
      'WARNING: Purchase 7 was created but the attachment failed: Error: QBO upload failed (500): QBO server error. ' +
        'Attach it with create_attachable (entity_ref_type Purchase, entity_ref_value 7).'
    );
    expect(res.content[1].text).toBe('Purchase created:');
    expect(JSON.parse(res.content[2].text).Id).toBe('7');
  });

  it('reports a failed create as an error', async () => {
    mockQuickBooksInstance.createPurchase.mockImplementation((_payload: any, cb: any) => cb(new Error('Bad account'), null));

    const res = await run({ purchase, attachment });

    expect(res.content).toEqual([{ type: 'text', text: 'Error creating purchase: Error: Bad account' }]);
    expect(mockHttpsRequest).not.toHaveBeenCalled();
  });

  it('reports a likely duplicate as an error, and creates nothing', async () => {
    const existing = { Id: '8', PaymentType: 'Cash', AccountRef: { value: '35' }, TotalAmt: 0, TxnDate: '2026-11-05', Line: [] };
    mockQuickBooksInstance.findPurchases.mockImplementation((_c: any, cb: any) =>
      cb(null, { QueryResponse: { Purchase: [existing] } })
    );

    const res = await run({ purchase });

    expect(res.content).toEqual([
      {
        type: 'text',
        text:
          'Error creating purchase: Possible duplicate — Purchase already exists: Id 8, #n/a, $0, 2026-11-05, account 35. ' +
          'Pass allow_duplicate: true to create anyway.',
      },
    ]);
    expect(mockQuickBooksInstance.createPurchase).not.toHaveBeenCalled();
  });

  it('passes allow_duplicate through, so the check is skipped and the purchase created', async () => {
    const res = await run({ purchase, allow_duplicate: true });

    expect(mockQuickBooksInstance.findPurchases).not.toHaveBeenCalled();
    expect(res.content[0]).toEqual({ type: 'text', text: 'Purchase created:' });
  });
});
