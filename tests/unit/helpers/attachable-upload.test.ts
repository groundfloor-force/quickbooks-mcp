import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mockQuickbooksClient, mockQuickbooksClientClass, resetAllMocks } from '../../mocks/quickbooks.mock';
import {
  mockHttpsRequest,
  mockUploadNetworkError,
  mockUploadResponse,
  resetUploadMock,
  uploadedFileContentType,
  uploadedMetadata,
  uploadSuccess,
} from '../../mocks/https-upload.mock';

jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));
jest.unstable_mockModule('https', () => ({
  default: { request: mockHttpsRequest },
  request: mockHttpsRequest,
}));

const { uploadBase64Attachment } = await import('../../../src/helpers/attachable-upload');

const pdf = { file_name: 'receipt.pdf', base64_content: Buffer.from('%PDF-1.4 fake').toString('base64') };

beforeEach(() => {
  resetAllMocks();
  resetUploadMock();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('uploadBase64Attachment', () => {
  it('uploads the file linked to the entity and returns the new Attachable id', async () => {
    const response = uploadSuccess('99');
    mockUploadResponse(200, response);

    const uploaded = await uploadBase64Attachment({
      ...pdf,
      note: 'Vendor invoice',
      category: 'Other',
      entity: { type: 'Bill', value: '1', include_on_send: true },
    });

    expect(uploaded).toEqual({ attachable_id: '99', raw: response });
    const [[options]] = mockHttpsRequest.mock.calls as any[][];
    expect(options.method).toBe('POST');
    expect(options.path).toBe('/v3/company/mock-realm-id/upload');
    expect(options.hostname).toBe('sandbox-quickbooks.api.intuit.com');
    expect(options.headers.Authorization).toBe('Bearer mock-access-token');
    expect(uploadedMetadata()).toEqual({
      FileName: 'receipt.pdf',
      ContentType: 'application/pdf',
      Note: 'Vendor invoice',
      Category: 'Other',
      AttachableRef: [{ EntityRef: { type: 'Bill', value: '1' }, IncludeOnSend: true }],
    });
  });

  it('infers the content type from file_name when none is given', async () => {
    mockUploadResponse(200, uploadSuccess('5', 'photo.png'));

    await uploadBase64Attachment({ file_name: 'photo.png', base64_content: Buffer.from('png').toString('base64') });

    expect(uploadedMetadata().ContentType).toBe('image/png');
    expect(uploadedFileContentType()).toBe('image/png');
  });

  it('prefers an explicit content_type over the file name', async () => {
    mockUploadResponse(200, uploadSuccess());

    await uploadBase64Attachment({ ...pdf, file_name: 'scan', content_type: 'image/jpeg' });

    expect(uploadedMetadata().ContentType).toBe('image/jpeg');
  });

  it('sends no AttachableRef, Note or Category when they are not given', async () => {
    mockUploadResponse(200, uploadSuccess());

    await uploadBase64Attachment(pdf);

    expect(uploadedMetadata()).toEqual({ FileName: 'receipt.pdf', ContentType: 'application/pdf' });
  });

  it('omits IncludeOnSend when the entity does not set it', async () => {
    mockUploadResponse(200, uploadSuccess());

    await uploadBase64Attachment({ ...pdf, entity: { type: 'Purchase', value: '7' } });

    expect(uploadedMetadata().AttachableRef).toEqual([{ EntityRef: { type: 'Purchase', value: '7' } }]);
  });

  it('treats a per-file Fault in a 200 response as a failure, with the formatted fault text', async () => {
    mockUploadResponse(200, {
      AttachableResponse: [
        {
          Fault: {
            Error: [
              {
                Message: 'Invalid Reference Id',
                Detail: 'Invalid Reference Id : Bill assigned to Entity Ref not found',
                code: '2500',
                element: 'AttachableRef',
              },
            ],
            type: 'ValidationFault',
          },
        },
      ],
    });

    await expect(uploadBase64Attachment({ ...pdf, entity: { type: 'Bill', value: '404' } })).rejects.toThrow(
      /^Invalid Reference Id — Invalid Reference Id : Bill assigned to Entity Ref not found \(QBO code 2500, element AttachableRef\)$/
    );
  });

  it('fails when a 200 response carries no Attachable id', async () => {
    mockUploadResponse(200, { AttachableResponse: [] });

    await expect(uploadBase64Attachment(pdf)).rejects.toThrow('QBO upload returned no Attachable id');
  });

  it.each([
    [401, 'QBO upload failed (401): authentication or authorization error'],
    [403, 'QBO upload failed (403): authentication or authorization error'],
    [413, 'QBO upload failed (413): payload too large'],
    [400, 'QBO upload failed (400): client error'],
    [500, 'QBO upload failed (500): QBO server error'],
  ])('throws the fixed redacted message on HTTP %i', async (status, message) => {
    mockUploadResponse(status, { Fault: { Error: [{ Detail: 'realm 9341454900 trace=abc123' }] } });

    const failure = uploadBase64Attachment(pdf);

    await expect(failure).rejects.toThrow(new Error(message));
    await expect(failure).rejects.not.toThrow(/9341454900|abc123/);
  });

  it('throws the fixed message on a network error, without the address', async () => {
    mockUploadNetworkError(new Error('ECONNREFUSED 10.0.0.1:443'));

    await expect(uploadBase64Attachment(pdf)).rejects.toThrow(new Error('QBO upload failed: network error'));
  });

  it('throws the fixed message on a 200 whose body is not JSON', async () => {
    mockUploadResponse(200, '<html>not json</html>');

    await expect(uploadBase64Attachment(pdf)).rejects.toThrow(/^QBO upload failed \(200\)/);
  });

  it('refuses a disallowed content type before any request', async () => {
    await expect(
      uploadBase64Attachment({ file_name: 'sketch.psd', base64_content: 'eA==' })
    ).rejects.toThrow(/^Unsupported content_type "application\/octet-stream"/);

    expect(mockHttpsRequest).not.toHaveBeenCalled();
    expect(mockQuickbooksClientClass.getAuthCredentials).not.toHaveBeenCalled();
  });

  it('refuses more than 100 MB before decoding the base64', async () => {
    const fromSpy = jest.spyOn(Buffer, 'from');
    const oversized = 'A'.repeat(Math.ceil(((100 * 1024 * 1024) + 1) * 4 / 3));

    await expect(uploadBase64Attachment({ file_name: 'huge.pdf', base64_content: oversized })).rejects.toThrow(
      /^File too large: approximately \d+ bytes exceeds QBO's 104857600 byte \(100 MB\) upload limit\.$/
    );

    expect(fromSpy.mock.calls.some(([value]) => value === oversized)).toBe(false); // never decoded
    expect(mockHttpsRequest).not.toHaveBeenCalled();
  });
});
