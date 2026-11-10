import { jest } from '@jest/globals';

/**
 * Stand-in for https.request, for code that posts to QBO's /upload endpoint. Built the same way
 * as the inline mock in company-attachable.handlers.test.ts, plus a record of what was written so
 * a test can read back the multipart body. Each test file registers it itself:
 *
 *   jest.unstable_mockModule('https', () => ({ default: { request: mockHttpsRequest }, request: mockHttpsRequest }));
 */
export const mockHttpsRequest = jest.fn();

/** Every chunk written to the most recent mocked request: the multipart body. */
const uploadWrites: Buffer[] = [];

function fakeRequest(networkError?: Error) {
  const req = {
    write: jest.fn((chunk: Buffer) => {
      uploadWrites.push(Buffer.from(chunk));
      return true;
    }),
    end: jest.fn(),
    on: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'error' && networkError) handler(networkError);
      return req;
    }),
  };
  return req;
}

/** The next upload gets this HTTP status and body (an object is sent as JSON). */
export function mockUploadResponse(statusCode: number, body: unknown): void {
  (mockHttpsRequest as any).mockImplementation((_options: unknown, callback: (res: unknown) => void) => {
    uploadWrites.length = 0;
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    callback({
      statusCode,
      on: (event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'data') handler(Buffer.from(payload));
        else if (event === 'end') handler();
      },
    });
    return fakeRequest();
  });
}

/** The next upload fails at the network level with this error. */
export function mockUploadNetworkError(err: Error): void {
  (mockHttpsRequest as any).mockImplementation(() => {
    uploadWrites.length = 0;
    return fakeRequest(err);
  });
}

/** Resets the mock and the recorded body. Call in beforeEach. */
export function resetUploadMock(): void {
  mockHttpsRequest.mockReset();
  uploadWrites.length = 0;
}

/** The JSON metadata part (file_metadata_01) of the last upload. */
export function uploadedMetadata(): any {
  const body = Buffer.concat(uploadWrites).toString('utf-8');
  const match = body.match(/name="file_metadata_01"\r\nContent-Type: application\/json\r\n\r\n(.*?)\r\n--/);
  return match ? JSON.parse(match[1]) : undefined;
}

/** The Content-Type header of the file part (file_content_01) of the last upload. */
export function uploadedFileContentType(): string | undefined {
  const body = Buffer.concat(uploadWrites).toString('utf-8');
  return body.match(/name="file_content_01"; filename="[^"]*"\r\nContent-Type: ([^\r]*)\r\n/)?.[1];
}

/** The success body QBO returns for a single uploaded file. */
export function uploadSuccess(id = '99', fileName = 'receipt.pdf') {
  return { AttachableResponse: [{ Attachable: { Id: id, FileName: fileName } }], time: '2026-11-10T10:00:00.000-08:00' };
}
