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

const { CreateBillTool } = await import('../../../src/tools/create-bill.tool');

const bill = { Line: [{ Amount: 500, DetailType: 'AccountBasedExpenseLineDetail' }], VendorRef: { value: '56' } };
const attachment = { file_name: 'invoice.pdf', base64_content: Buffer.from('%PDF').toString('base64') };
const created = { Id: '1', TotalAmt: 500 };

const run = async (params: unknown): Promise<any> => CreateBillTool.handler({ params } as any, {} as any);

describe('create-bill schema', () => {
  it('accepts an attachment next to the bill', () => {
    const parsed = CreateBillTool.schema.safeParse({
      bill,
      attachment: { ...attachment, content_type: 'application/pdf', note: 'scan', include_on_send: true },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an attachment with an empty file_name', () => {
    expect(CreateBillTool.schema.safeParse({ bill, attachment: { ...attachment, file_name: '' } }).success).toBe(false);
  });

  it('rejects an attachment with empty base64_content', () => {
    expect(CreateBillTool.schema.safeParse({ bill, attachment: { ...attachment, base64_content: '' } }).success).toBe(false);
  });

  it('mentions the attachment in the description', () => {
    expect(CreateBillTool.description).toBe(
      'Create a bill in QuickBooks Online. Optional attachment uploads a base64 file and links it; the response includes _attachment.'
    );
  });
});

describe('create-bill tool handler', () => {
  beforeEach(() => {
    resetAllMocks();
    resetUploadMock();
    mockQuickBooksInstance.createBill.mockImplementation((_payload: any, cb: any) => cb(null, created));
  });

  it('prints only the bill JSON when there is no attachment, as before', async () => {
    const res = await run({ bill });

    expect(res.content).toEqual([{ type: 'text', text: JSON.stringify(created) }]);
  });

  it('leads with the bill and attachment ids when the attachment uploads', async () => {
    mockUploadResponse(200, uploadSuccess('99'));

    const res = await run({ bill, attachment });

    expect(res.content).toHaveLength(2);
    expect(res.content[0].text).toBe('Bill created: Id 1, attachment 99');
    expect(JSON.parse(res.content[1].text)).toEqual({ ...created, _attachment: { attachable_id: '99' } });
  });

  it('leads with a WARNING line when the bill was created but the attachment failed', async () => {
    mockUploadResponse(413, 'too big');

    const res = await run({ bill, attachment });

    expect(res.content).toHaveLength(2);
    expect(res.content[0].text).toBe(
      'WARNING: Bill 1 was created but the attachment failed: Error: QBO upload failed (413): payload too large. ' +
        'Attach it with create_attachable (entity_ref_type Bill, entity_ref_value 1).'
    );
    expect(JSON.parse(res.content[1].text).Id).toBe('1');
  });

  it('reports a failed create as an error', async () => {
    mockQuickBooksInstance.createBill.mockImplementation((_payload: any, cb: any) => cb(new Error('Bad vendor'), null));

    const res = await run({ bill, attachment });

    expect(res.content).toEqual([{ type: 'text', text: 'Error creating bill: Error: Bad vendor' }]);
    expect(mockHttpsRequest).not.toHaveBeenCalled();
  });
});
