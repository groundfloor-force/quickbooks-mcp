import { formatError, scrub } from '../../../src/helpers/format-error';

describe('formatError', () => {
  it('should format Error instances', () => {
    const error = new Error('Something went wrong');
    expect(formatError(error)).toBe('Error: Something went wrong');
  });

  it('should format string errors', () => {
    expect(formatError('A string error')).toBe('Error: A string error');
  });

  it('should format unknown error types', () => {
    const unknownError = { code: 500, message: 'Server error' };
    expect(formatError(unknownError)).toBe(
      'Unknown error: {"code":500,"message":"Server error"}'
    );
  });

  it('should handle null errors', () => {
    expect(formatError(null)).toBe('Unknown error: null');
  });

  it('should handle undefined errors', () => {
    expect(formatError(undefined)).toBe('Unknown error: undefined');
  });

  it('should handle number errors', () => {
    expect(formatError(404)).toBe('Unknown error: 404');
  });
});

/**
 * node-quickbooks hands a QBO fault to the callback in one of three shapes:
 * an HTTP 4xx/5xx arrives as the axios error (fault body at response.data), an HTTP 200
 * that carries a Fault arrives as the parsed body itself, and the upload path passes the
 * first element of the response array.
 */
describe('formatError with a QBO fault', () => {
  const validationFault = {
    Fault: {
      Error: [
        {
          Message: 'Required param missing, need to supply the required value for the API',
          Detail: 'Required parameter Line.Amount is missing in the request',
          code: '2020',
          element: 'Line.Amount',
        },
      ],
      type: 'ValidationFault',
    },
    time: '2026-11-10T09:15:02.123-08:00',
  };

  it('reads the fault from an axios error (HTTP 4xx: response.data.Fault)', () => {
    const axiosError = Object.assign(new Error('Request failed with status code 400'), {
      response: { status: 400, data: validationFault },
    });

    expect(formatError(axiosError)).toBe(
      'Error: Required param missing, need to supply the required value for the API' +
        ' — Required parameter Line.Amount is missing in the request' +
        ' (QBO code 2020, element Line.Amount)'
    );
  });

  it('reads the fault from a parsed body (HTTP 200 with Fault: error.Fault)', () => {
    const body = {
      Fault: {
        Error: [
          {
            Message: 'Stale Object Error',
            Detail: 'Stale Object Error : You and another user were working on this at the same time.',
            code: '5010',
          },
        ],
        type: 'ValidationFault',
      },
    };

    expect(formatError(body)).toBe(
      'Error: Stale Object Error — Stale Object Error : You and another user were working on this' +
        ' at the same time. (QBO code 5010)'
    );
  });

  it('reads the fault from an array response (error[0].Fault)', () => {
    const response = [
      {
        Fault: {
          Error: [
            {
              Message: 'Duplicate Document Number Error',
              Detail: 'You must specify a different number. This number has already been used.',
              code: '6140',
              element: 'DocNumber',
            },
          ],
        },
      },
    ];

    expect(formatError(response)).toBe(
      'Error: Duplicate Document Number Error — You must specify a different number. This number' +
        ' has already been used. (QBO code 6140, element DocNumber)'
    );
  });

  it('omits the detail when the fault has none', () => {
    const axiosError = Object.assign(new Error('Request failed with status code 401'), {
      response: {
        status: 401,
        data: {
          Fault: {
            Error: [{ Message: 'message=AuthenticationFailed; errorCode=003200; statusCode=401', code: '3200' }],
            type: 'AuthenticationFault',
          },
        },
      },
    });

    expect(formatError(axiosError)).toBe(
      'Error: message=AuthenticationFailed; errorCode=003200; statusCode=401 (QBO code 3200)'
    );
  });

  it('omits the element when the fault has none', () => {
    const body = { Fault: { Error: [{ Message: 'Object Not Found', Detail: 'Something you are trying to use has been made inactive.', code: '610' }] } };

    expect(formatError(body)).toBe(
      'Error: Object Not Found — Something you are trying to use has been made inactive. (QBO code 610)'
    );
  });

  it('omits the code part when the fault has neither code nor element', () => {
    expect(formatError({ Fault: { Error: [{ Message: 'Business Validation Error' }] } })).toBe(
      'Error: Business Validation Error'
    );
  });

  it('scrubs the detail before it reaches the message', () => {
    const body = {
      Fault: {
        Error: [
          {
            Message: 'Permission Denied Error',
            Detail: 'realm 9341454900 trace=abc123 user=foo@bar.com cannot access this resource',
            code: '5020',
          },
        ],
      },
    };

    const message = formatError(body);

    expect(message).toContain('Permission Denied Error');
    expect(message).toContain('cannot access this resource');
    expect(message).toContain('(QBO code 5020)');
    expect(message).not.toContain('9341454900');
    expect(message).not.toContain('abc123');
    expect(message).not.toContain('foo@bar.com');
  });

  it('drops the detail separator when nothing is left after scrubbing', () => {
    const body = { Fault: { Error: [{ Message: 'Invalid user', Detail: 'foo@bar.com', code: '100' }] } };

    expect(formatError(body)).toBe('Error: Invalid user (QBO code 100)');
  });

  it('falls through to the existing behaviour when the fault entry has nothing usable', () => {
    expect(formatError({ Fault: { Error: [{}] } })).toBe('Unknown error: {"Fault":{"Error":[{}]}}');
  });

  it('falls through to the existing behaviour when Fault.Error is empty', () => {
    expect(formatError({ Fault: { Error: [] } })).toBe('Unknown error: {"Fault":{"Error":[]}}');
  });

  it('keeps an axios error with no fault body as the plain message', () => {
    const axiosError = Object.assign(new Error('Request failed with status code 502'), {
      response: { status: 502, data: '<html>Bad Gateway</html>' },
    });

    expect(formatError(axiosError)).toBe('Error: Request failed with status code 502');
  });
});

describe('scrub', () => {
  it('removes everything the attachable redaction test treats as sensitive', () => {
    // The same string company-attachable.handlers.test.ts:373 must keep out of an error.
    const scrubbed = scrub('realm 9341454900 trace=abc123 user=foo@bar.com');

    expect(scrubbed).not.toContain('9341454900');
    expect(scrubbed).not.toContain('abc123');
    expect(scrubbed).not.toContain('foo@bar.com');
  });

  it('removes an email address, a realmId= fragment and a tid= fragment', () => {
    const scrubbed = scrub(
      'Access denied for jane.doe+qbo@example.co.uk on realmId=123456789 (tid=1-66b2a7f3-4d1c2e8b) today'
    );

    expect(scrubbed).not.toContain('jane.doe+qbo@example.co.uk');
    expect(scrubbed).not.toContain('123456789');
    expect(scrubbed).not.toContain('1-66b2a7f3-4d1c2e8b');
    expect(scrubbed).toContain('Access denied for');
    expect(scrubbed).toContain('today');
  });

  it('removes intuit_tid= and realm= variants regardless of case', () => {
    const scrubbed = scrub('INTUIT_TID=abc-def-123 Realm=42 failed');

    expect(scrubbed).not.toContain('abc-def-123');
    expect(scrubbed).not.toContain('42');
    expect(scrubbed).toContain('failed');
  });

  it('removes any number of 10 or more digits', () => {
    expect(scrub('company 12345678901234 not found')).toBe('company not found');
  });

  it('leaves ordinary text, amounts and short numbers alone', () => {
    const text = 'Line 3 Amount 1250.00 exceeds the balance of 999999999 on invoice 1042';
    expect(scrub(text)).toBe(text);
  });
});
