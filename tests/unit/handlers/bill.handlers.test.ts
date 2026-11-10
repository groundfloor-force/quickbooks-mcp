import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockQuickbooksClient, mockQuickbooksClientClass, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';
import { mockHttpsRequest, mockUploadResponse, resetUploadMock, uploadedMetadata, uploadSuccess } from '../../mocks/https-upload.mock';

// ESM-compatible module mocking
jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));
// The optional attachment is uploaded through a raw https request to QBO's /upload.
jest.unstable_mockModule('https', () => ({
  default: { request: mockHttpsRequest },
  request: mockHttpsRequest,
}));

// Dynamic imports after mock setup
const { createQuickbooksBill } = await import('../../../src/handlers/create-quickbooks-bill.handler');
const { getQuickbooksBill } = await import('../../../src/handlers/get-quickbooks-bill.handler');
const { updateQuickbooksBill } = await import('../../../src/handlers/update-quickbooks-bill.handler');
const { deleteQuickbooksBill } = await import('../../../src/handlers/delete-quickbooks-bill.handler');
const { searchQuickbooksBills } = await import('../../../src/handlers/search-quickbooks-bills.handler');

describe('Bill Handlers', () => {
  beforeEach(() => {
    resetAllMocks();
    resetUploadMock();
    // Default: the duplicate check finds nothing, so the create path runs as before.
    // (The searchQuickbooksBills tests below set their own findBills.)
    mockQuickBooksInstance.findBills.mockImplementation((_c: any, cb: any) => cb(null, { QueryResponse: {} }));
  });

  describe('createQuickbooksBill', () => {
    it('should create a bill successfully', async () => {
      const mockBill = { Id: '1', TotalAmt: 500, Balance: 500 };
      mockQuickBooksInstance.createBill.mockImplementation((_payload: any, cb: any) => cb(null, mockBill));

      const result = await createQuickbooksBill({
        Line: [{ Amount: 500, DetailType: 'AccountBasedExpenseLineDetail', Description: 'Office supplies', AccountRef: { value: '1' } }],
        VendorRef: { value: '56' },
        DueDate: '2026-05-01',
        Balance: 500,
        TotalAmt: 500,
      });

      expect(result.isError).toBe(false);
      expect(result.result).toEqual(mockBill);
    });

    it('should preserve already-structured line items and pass through bare lines', async () => {
      const mockBill = { Id: '2', TotalAmt: 200 };
      mockQuickBooksInstance.createBill.mockImplementation((_payload: any, cb: any) => cb(null, mockBill));

      const result = await createQuickbooksBill({
        Line: [
          // already has AccountBasedExpenseLineDetail — must be returned as-is (line 18)
          { Amount: 100, AccountBasedExpenseLineDetail: { AccountRef: { value: '1' } } },
          // already has ItemBasedExpenseLineDetail — must be returned as-is (line 18)
          { Amount: 50, ItemBasedExpenseLineDetail: { ItemRef: { value: '2' } } },
          // no AccountRef and no detail key — bare pass-through (line 27)
          { Amount: 0, DetailType: 'SubTotalLineDetail' },
        ],
        VendorRef: { value: '56' },
      });

      expect(result.isError).toBe(false);
      expect(result.result).toEqual(mockBill);
    });

    it('should handle API errors', async () => {
      mockQuickBooksInstance.createBill.mockImplementation((_payload: any, cb: any) =>
        cb(new Error('SAXParseException: Premature end of file'), null)
      );

      const result = await createQuickbooksBill({});

      expect(result.isError).toBe(true);
    });

    it('should handle authentication errors', async () => {
      (mockQuickbooksClientClass.getInstance as any).mockRejectedValue(new Error('Auth failed'));

      const result = await createQuickbooksBill({});

      expect(result.isError).toBe(true);
      expect(result.error).toContain('Error: Auth failed');
    });
  });

  describe('createQuickbooksBill with an attachment', () => {
    const bill = { Line: [{ Amount: 500, DetailType: 'AccountBasedExpenseLineDetail', AccountRef: { value: '1' } }], VendorRef: { value: '56' } };
    const attachment = {
      file_name: 'invoice-1042.pdf',
      base64_content: Buffer.from('%PDF-1.4 fake').toString('base64'),
      include_on_send: false,
    };
    const created = { Id: '1', SyncToken: '0', TotalAmt: 500 };

    it('returns the created bill object itself and uploads nothing when no attachment is given', async () => {
      mockQuickBooksInstance.createBill.mockImplementation((_payload: any, cb: any) => cb(null, created));

      const result = await createQuickbooksBill(bill);

      expect(result).toEqual({ result: created, isError: false, error: null });
      expect(result.result).toBe(created);
      expect(mockHttpsRequest).not.toHaveBeenCalled();
    });

    it('creates the bill, then uploads the file linked to it and returns the attachable id', async () => {
      mockQuickBooksInstance.createBill.mockImplementation((_payload: any, cb: any) => cb(null, created));
      mockUploadResponse(200, uploadSuccess('99', 'invoice-1042.pdf'));

      const result = await createQuickbooksBill(bill, attachment);

      expect(mockQuickBooksInstance.createBill).toHaveBeenCalledTimes(1);
      expect(mockHttpsRequest).toHaveBeenCalledTimes(1);
      expect(mockQuickBooksInstance.createBill.mock.invocationCallOrder[0]).toBeLessThan(
        mockHttpsRequest.mock.invocationCallOrder[0]
      );
      expect(uploadedMetadata().AttachableRef).toEqual([
        { EntityRef: { type: 'Bill', value: '1' }, IncludeOnSend: false },
      ]);
      expect(result.isError).toBe(false);
      expect(result.result).toEqual({ ...created, _attachment: { attachable_id: '99' } });
    });

    it('still succeeds, with the bill and an _attachment.error, when the upload fails', async () => {
      mockQuickBooksInstance.createBill.mockImplementation((_payload: any, cb: any) => cb(null, created));
      mockUploadResponse(500, 'upstream down');

      const result = await createQuickbooksBill(bill, attachment);

      expect(result.isError).toBe(false);
      expect(result.result.Id).toBe('1');
      expect(result.result._attachment.attachable_id).toBeUndefined();
      expect(result.result._attachment.error).toBe(
        'Bill 1 was created but the attachment failed: Error: QBO upload failed (500): QBO server error. ' +
          'Attach it with create_attachable (entity_ref_type Bill, entity_ref_value 1).'
      );
    });

    it('does not attempt the upload when the create fails', async () => {
      mockQuickBooksInstance.createBill.mockImplementation((_payload: any, cb: any) =>
        cb(new Error('Business Validation Error'), null)
      );

      const result = await createQuickbooksBill(bill, attachment);

      expect(result).toEqual({ result: null, isError: true, error: 'Error: Business Validation Error' });
      expect(mockHttpsRequest).not.toHaveBeenCalled();
    });

    it('refuses an attachment that could never upload before creating anything', async () => {
      const result = await createQuickbooksBill(bill, { file_name: 'sketch.psd', base64_content: 'eA==' });

      expect(result.isError).toBe(true);
      expect(result.error).toBe(
        'Attachment rejected, so no bill was created: Unsupported content_type "application/octet-stream". ' +
          'Allowed: application/msword, application/pdf, application/postscript, application/vnd.ms-excel, ' +
          'application/vnd.oasis.opendocument.spreadsheet, ' +
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, ' +
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document, image/gif, image/jpeg, ' +
          'image/jpg, image/png, image/tif, text/csv, text/plain, text/rtf, text/xml'
      );
      expect(mockQuickBooksInstance.createBill).not.toHaveBeenCalled();
      expect(mockHttpsRequest).not.toHaveBeenCalled();
    });
  });

  describe('createQuickbooksBill duplicate guard', () => {
    // A legacy flat line with no DetailType: only the reshaped line counts toward the total.
    const bill = { VendorRef: { value: '56' }, TxnDate: '2026-11-05', Line: [{ Amount: 500, AccountRef: { value: '1' } }] };
    const existing = {
      Id: '900',
      DocNumber: 'INV-1042',
      TotalAmt: 575,
      TxnDate: '2026-11-05',
      VendorRef: { value: '56', name: 'Harbour Lumber' },
      Line: [{ Amount: 500, DetailType: 'AccountBasedExpenseLineDetail' }],
    };
    const refusal =
      'Possible duplicate — Bill already exists: Id 900, #INV-1042, $575, 2026-11-05, vendor Harbour Lumber. ' +
      'Pass allow_duplicate: true to create anyway.';

    it('refuses when a matching bill exists, checking the reshaped lines, without creating', async () => {
      mockQuickBooksInstance.findBills.mockImplementation((_c: any, cb: any) => cb(null, { QueryResponse: { Bill: [existing] } }));

      const result = await createQuickbooksBill(bill);

      expect(result).toEqual({ result: null, isError: true, error: refusal });
      expect((mockQuickBooksInstance.findBills.mock.calls[0] as any)[0]).toEqual([
        { field: 'VendorRef', value: '56', operator: '=' },
        { field: 'TxnDate', value: '2026-11-05', operator: '=' },
        { field: 'limit', value: 50 },
      ]);
      expect(mockQuickBooksInstance.createBill).not.toHaveBeenCalled();
    });

    it('refuses before uploading anything when an attachment was given', async () => {
      mockQuickBooksInstance.findBills.mockImplementation((_c: any, cb: any) => cb(null, { QueryResponse: { Bill: [existing] } }));

      const result = await createQuickbooksBill(bill, { file_name: 'invoice.pdf', base64_content: 'JVBERg==' });

      expect(result.error).toBe(refusal);
      expect(mockQuickBooksInstance.createBill).not.toHaveBeenCalled();
      expect(mockHttpsRequest).not.toHaveBeenCalled();
    });

    it('creates as before when no duplicate is found', async () => {
      mockQuickBooksInstance.createBill.mockImplementation((_p: any, cb: any) => cb(null, { Id: '901' }));

      const result = await createQuickbooksBill(bill);

      expect(result).toEqual({ result: { Id: '901' }, isError: false, error: null });
      expect(mockQuickBooksInstance.findBills).toHaveBeenCalledTimes(1);
      expect((mockQuickBooksInstance.createBill.mock.calls[0] as any)[0]).toEqual({
        VendorRef: { value: '56' },
        TxnDate: '2026-11-05',
        Line: [{ Amount: 500, AccountBasedExpenseLineDetail: { AccountRef: { value: '1' } } }],
      });
    });

    it('skips the check entirely when allow_duplicate is true', async () => {
      mockQuickBooksInstance.createBill.mockImplementation((_p: any, cb: any) => cb(null, { Id: '902' }));

      const result = await createQuickbooksBill(bill, undefined, true);

      expect(result.isError).toBe(false);
      expect(mockQuickBooksInstance.findBills).not.toHaveBeenCalled();
      expect(mockQuickBooksInstance.createBill).toHaveBeenCalledTimes(1);
    });

    it('refuses (fails closed) when the duplicate check errors', async () => {
      mockQuickBooksInstance.findBills.mockImplementation((_c: any, cb: any) => cb(new Error('QBO down'), null));

      const result = await createQuickbooksBill(bill);

      expect(result).toEqual({
        result: null,
        isError: true,
        error: 'Duplicate check failed: Error: QBO down. Retry, or pass allow_duplicate: true.',
      });
      expect(mockQuickBooksInstance.createBill).not.toHaveBeenCalled();
    });

    it('refuses (fails closed) when the duplicate check throws synchronously', async () => {
      mockQuickBooksInstance.findBills.mockImplementation(() => {
        throw new Error('bad criteria');
      });

      const result = await createQuickbooksBill(bill);

      expect(result.isError).toBe(true);
      expect(result.error).toBe('Duplicate check failed: Error: bad criteria. Retry, or pass allow_duplicate: true.');
      expect(mockQuickBooksInstance.createBill).not.toHaveBeenCalled();
    });
  });

  describe('getQuickbooksBill', () => {
    it('should get a bill by ID', async () => {
      const mockBill = { Id: '1', TotalAmt: 500, Balance: 500 };
      mockQuickBooksInstance.getBill.mockImplementation((_id: any, cb: any) => cb(null, mockBill));

      const result = await getQuickbooksBill('1');

      expect(result.isError).toBe(false);
      expect(result.result).toEqual(mockBill);
    });

    it('should handle API errors', async () => {
      mockQuickBooksInstance.getBill.mockImplementation((_id: any, cb: any) =>
        cb(new Error('Not found'), null)
      );

      const result = await getQuickbooksBill('999');

      expect(result.isError).toBe(true);
    });

    it('should handle authentication errors', async () => {
      (mockQuickbooksClientClass.getInstance as any).mockRejectedValue(new Error('Auth failed'));

      const result = await getQuickbooksBill('1');

      expect(result.isError).toBe(true);
      expect(result.error).toContain('Error: Auth failed');
    });
  });

  describe('updateQuickbooksBill', () => {
    // Default: company is NOT on Automated Sales Tax (PartnerTaxEnabled absent),
    // so a dropped line-level TaxCodeRef is treated as real data loss. AST-specific
    // tests override this per-case.
    beforeEach(() => {
      mockQuickBooksInstance.getPreferences.mockImplementation((cb: any) =>
        cb(null, { TaxPrefs: {} })
      );
    });

    // A bill whose principal line carries the class + tax tracking that prior
    // schemas silently stripped on update.
    const currentBill = {
      Id: '1',
      SyncToken: '5',
      VendorRef: { value: '56' },
      Line: [
        {
          Id: '1',
          Amount: 500,
          DetailType: 'AccountBasedExpenseLineDetail',
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: '1' },
            ClassRef: { value: '100', name: '5614' },
            TaxCodeRef: { value: 'NON' },
          },
        },
      ],
    };

    it('should update a bill via read-merge-write', async () => {
      mockQuickBooksInstance.getBill.mockImplementation((_id: any, cb: any) => cb(null, currentBill));
      const updated = { ...currentBill, SyncToken: '6' };
      mockQuickBooksInstance.updateBill.mockImplementation((_payload: any, cb: any) => cb(null, updated));

      const result = await updateQuickbooksBill({ Id: '1', DueDate: '2026-05-10' });

      expect(result.isError).toBe(false);
      expect(result.result).toEqual(updated);
    });

    it('should preserve ClassRef/TaxCodeRef when the caller omits them', async () => {
      mockQuickBooksInstance.getBill.mockImplementation((_id: any, cb: any) => cb(null, currentBill));
      let sentPayload: any;
      mockQuickBooksInstance.updateBill.mockImplementation((payload: any, cb: any) => {
        sentPayload = payload;
        cb(null, payload); // QBO echoes back the saved object
      });

      // The bug repro: caller supplies a line WITHOUT ClassRef/TaxCodeRef.
      const result = await updateQuickbooksBill({
        Id: '1',
        Line: [
          {
            Id: '1',
            Amount: 600,
            DetailType: 'AccountBasedExpenseLineDetail',
            AccountBasedExpenseLineDetail: { AccountRef: { value: '1' } },
          },
        ],
      });

      expect(result.isError).toBe(false);
      // Class + tax survived the merge into the outbound payload...
      expect(sentPayload.Line[0].AccountBasedExpenseLineDetail.ClassRef).toEqual({ value: '100', name: '5614' });
      expect(sentPayload.Line[0].AccountBasedExpenseLineDetail.TaxCodeRef).toEqual({ value: 'NON' });
      // ...while the caller's amount change applied...
      expect(sentPayload.Line[0].Amount).toBe(600);
      // ...and the freshest SyncToken was used, not the caller's.
      expect(sentPayload.SyncToken).toBe('5');
    });

    it('should let the caller explicitly override an existing ClassRef', async () => {
      mockQuickBooksInstance.getBill.mockImplementation((_id: any, cb: any) => cb(null, currentBill));
      let sentPayload: any;
      mockQuickBooksInstance.updateBill.mockImplementation((payload: any, cb: any) => {
        sentPayload = payload;
        cb(null, payload);
      });

      await updateQuickbooksBill({
        Id: '1',
        Line: [
          {
            Id: '1',
            AccountBasedExpenseLineDetail: { ClassRef: { value: '200', name: '179' } },
          },
        ],
      });

      expect(sentPayload.Line[0].AccountBasedExpenseLineDetail.ClassRef).toEqual({ value: '200', name: '179' });
      // AccountRef from current is still preserved through the override.
      expect(sentPayload.Line[0].AccountBasedExpenseLineDetail.AccountRef).toEqual({ value: '1' });
    });

    it('should error if QuickBooks drops a ClassRef on the round-trip', async () => {
      mockQuickBooksInstance.getBill.mockImplementation((_id: any, cb: any) => cb(null, currentBill));
      const strippedBack = {
        ...currentBill,
        SyncToken: '6',
        Line: [
          {
            Id: '1',
            Amount: 500,
            DetailType: 'AccountBasedExpenseLineDetail',
            AccountBasedExpenseLineDetail: { AccountRef: { value: '1' }, TaxCodeRef: { value: 'NON' } },
          },
        ],
      };
      mockQuickBooksInstance.updateBill.mockImplementation((_payload: any, cb: any) => cb(null, strippedBack));

      const result = await updateQuickbooksBill({ Id: '1', DueDate: '2026-05-10' });

      expect(result.isError).toBe(true);
      expect(result.error).toContain('ClassRef');
    });

    it('should add a new line (no Id) without disturbing existing classed lines', async () => {
      mockQuickBooksInstance.getBill.mockImplementation((_id: any, cb: any) => cb(null, currentBill));
      let sentPayload: any;
      mockQuickBooksInstance.updateBill.mockImplementation((payload: any, cb: any) => {
        sentPayload = payload;
        cb(null, payload);
      });

      await updateQuickbooksBill({
        Id: '1',
        Line: [
          // existing classed line, re-supplied by Id
          { Id: '1', AccountBasedExpenseLineDetail: { AccountRef: { value: '1' } } },
          // brand-new interest line (no Id) — passes through as authored
          {
            Amount: 112.04,
            DetailType: 'AccountBasedExpenseLineDetail',
            Description: 'interest',
            AccountBasedExpenseLineDetail: { AccountRef: { value: '184' }, ClassRef: { value: '100', name: '5614' } },
          },
        ],
      });

      // existing line kept its class via merge
      expect(sentPayload.Line[0].AccountBasedExpenseLineDetail.ClassRef).toEqual({ value: '100', name: '5614' });
      // new line preserved exactly as authored
      expect(sentPayload.Line[1].Amount).toBe(112.04);
      expect(sentPayload.Line[1].AccountBasedExpenseLineDetail.ClassRef).toEqual({ value: '100', name: '5614' });
    });

    it('should perform a header-only update without touching the line array', async () => {
      mockQuickBooksInstance.getBill.mockImplementation((_id: any, cb: any) => cb(null, currentBill));
      let sentPayload: any;
      mockQuickBooksInstance.updateBill.mockImplementation((payload: any, cb: any) => {
        sentPayload = payload;
        cb(null, payload);
      });

      const result = await updateQuickbooksBill({ Id: '1', PrivateNote: 'paid 2026-06-24' });

      expect(result.isError).toBe(false);
      expect(sentPayload.PrivateNote).toBe('paid 2026-06-24');
      // lines carried over verbatim, class intact
      expect(sentPayload.Line).toEqual(currentBill.Line);
    });

    it('should not flag a line the caller intentionally removed', async () => {
      const twoLine = {
        ...currentBill,
        Line: [
          currentBill.Line[0],
          { Id: '2', Amount: 50, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: '9' }, ClassRef: { value: '100' } } },
        ],
      };
      mockQuickBooksInstance.getBill.mockImplementation((_id: any, cb: any) => cb(null, twoLine));
      // caller resubmits only line 1; QBO returns a bill with line 2 gone
      mockQuickBooksInstance.updateBill.mockImplementation((payload: any, cb: any) => cb(null, payload));

      const result = await updateQuickbooksBill({
        Id: '1',
        Line: [{ Id: '1', AccountBasedExpenseLineDetail: { AccountRef: { value: '1' } } }],
      });

      expect(result.isError).toBe(false); // dropping line 2 was intentional, not a regression
    });

    it('should error if the whole line detail is dropped on the round-trip', async () => {
      mockQuickBooksInstance.getBill.mockImplementation((_id: any, cb: any) => cb(null, currentBill));
      // updated line lost its entire AccountBasedExpenseLineDetail
      const wiped = { ...currentBill, Line: [{ Id: '1', Amount: 500, DetailType: 'AccountBasedExpenseLineDetail' }] };
      mockQuickBooksInstance.updateBill.mockImplementation((_payload: any, cb: any) => cb(null, wiped));

      const result = await updateQuickbooksBill({ Id: '1', PrivateNote: 'x' });

      expect(result.isError).toBe(true);
      expect(result.error).toContain('ClassRef');
      expect(result.error).toContain('TaxCodeRef');
    });

    it('should require bill.Id', async () => {
      const missingId = await updateQuickbooksBill({ DueDate: '2026-05-10' });
      expect(missingId.isError).toBe(true);
      expect(missingId.error).toContain('Id');

      const noBill = await updateQuickbooksBill(undefined as any);
      expect(noBill.isError).toBe(true);
      expect(noBill.error).toContain('Id');
    });

    it('should surface an error if the initial read fails', async () => {
      mockQuickBooksInstance.getBill.mockImplementation((_id: any, cb: any) =>
        cb(new Error('Bill 1 not found'), null)
      );

      const result = await updateQuickbooksBill({ Id: '1', PrivateNote: 'x' });

      expect(result.isError).toBe(true);
      expect(result.error).toContain('not found');
    });

    it('should handle API errors', async () => {
      mockQuickBooksInstance.getBill.mockImplementation((_id: any, cb: any) => cb(null, currentBill));
      mockQuickBooksInstance.updateBill.mockImplementation((_payload: any, cb: any) =>
        cb(new Error('Update failed'), null)
      );

      const result = await updateQuickbooksBill({ Id: '1' });

      expect(result.isError).toBe(true);
    });

    it('should handle authentication errors', async () => {
      (mockQuickbooksClientClass.getInstance as any).mockRejectedValue(new Error('Auth failed'));

      const result = await updateQuickbooksBill({ Id: '1' });

      expect(result.isError).toBe(true);
      expect(result.error).toContain('Error: Auth failed');
    });

    // ── Automated Sales Tax (AST) handling ────────────────────────────────────
    // Under AST, QBO manages tax centrally and legitimately removes line-level
    // TaxCodeRef. A dropped TaxCodeRef must be a non-blocking warning, not an error.
    // A line whose TaxCodeRef QBO strips on the round-trip (no ClassRef involved).
    const taxOnlyBill = {
      Id: '1',
      SyncToken: '5',
      VendorRef: { value: '56' },
      Line: [
        {
          Id: '1',
          Amount: 500,
          DetailType: 'AccountBasedExpenseLineDetail',
          AccountBasedExpenseLineDetail: { AccountRef: { value: '1' }, TaxCodeRef: { value: 'NON' } },
        },
      ],
    };
    const taxStrippedBack = {
      ...taxOnlyBill,
      SyncToken: '6',
      Line: [
        {
          Id: '1',
          Amount: 500,
          DetailType: 'AccountBasedExpenseLineDetail',
          AccountBasedExpenseLineDetail: { AccountRef: { value: '1' } }, // TaxCodeRef gone
        },
      ],
    };

    it('warns (does not error) when AST is on and QBO drops a TaxCodeRef', async () => {
      mockQuickBooksInstance.getPreferences.mockImplementation((cb: any) =>
        cb(null, { TaxPrefs: { PartnerTaxEnabled: true } })
      );
      mockQuickBooksInstance.getBill.mockImplementation((_id: any, cb: any) => cb(null, taxOnlyBill));
      mockQuickBooksInstance.updateBill.mockImplementation((_payload: any, cb: any) => cb(null, taxStrippedBack));

      const result = await updateQuickbooksBill({ Id: '1', PrivateNote: 'x' });

      expect(result.isError).toBe(false);
      expect((result.result as any)._warning).toContain('Automated Sales Tax');
      expect((result.result as any)._warning).toContain('Line 1');
    });

    it('treats PartnerTaxEnabled:false as AST-enabled (attribute present)', async () => {
      mockQuickBooksInstance.getPreferences.mockImplementation((cb: any) =>
        cb(null, { TaxPrefs: { PartnerTaxEnabled: false } })
      );
      mockQuickBooksInstance.getBill.mockImplementation((_id: any, cb: any) => cb(null, taxOnlyBill));
      mockQuickBooksInstance.updateBill.mockImplementation((_payload: any, cb: any) => cb(null, taxStrippedBack));

      const result = await updateQuickbooksBill({ Id: '1', PrivateNote: 'x' });

      expect(result.isError).toBe(false);
      expect((result.result as any)._warning).toContain('Automated Sales Tax');
    });

    it('still errors on a dropped ClassRef even when AST is on', async () => {
      mockQuickBooksInstance.getPreferences.mockImplementation((cb: any) =>
        cb(null, { TaxPrefs: { PartnerTaxEnabled: true } })
      );
      mockQuickBooksInstance.getBill.mockImplementation((_id: any, cb: any) => cb(null, currentBill));
      // ClassRef dropped, TaxCodeRef also dropped — only ClassRef should error under AST.
      const wiped = { ...currentBill, Line: [{ Id: '1', Amount: 500, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: '1' } } }] };
      mockQuickBooksInstance.updateBill.mockImplementation((_payload: any, cb: any) => cb(null, wiped));

      const result = await updateQuickbooksBill({ Id: '1', PrivateNote: 'x' });

      expect(result.isError).toBe(true);
      expect(result.error).toContain('ClassRef');
      expect(result.error).not.toContain('TaxCodeRef'); // suppressed under AST
    });

    it('surfaces an error if reading Preferences fails', async () => {
      // Preferences is only read when a TaxCodeRef was actually dropped, so drive that path.
      mockQuickBooksInstance.getBill.mockImplementation((_id: any, cb: any) => cb(null, taxOnlyBill));
      mockQuickBooksInstance.updateBill.mockImplementation((_payload: any, cb: any) => cb(null, taxStrippedBack));
      mockQuickBooksInstance.getPreferences.mockImplementation((cb: any) =>
        cb(new Error('Preferences read failed'), null)
      );

      const result = await updateQuickbooksBill({ Id: '1', PrivateNote: 'x' });

      expect(result.isError).toBe(true);
      expect(result.error).toContain('Preferences read failed');
    });
  });

  describe('deleteQuickbooksBill', () => {
    it('should delete a bill', async () => {
      const mockDeleted = { Id: '1', status: 'Deleted' };
      mockQuickBooksInstance.deleteBill.mockImplementation((_payload: any, cb: any) => cb(null, mockDeleted));

      const result = await deleteQuickbooksBill({ Id: '1', SyncToken: '0' });

      expect(result.isError).toBe(false);
      expect(result.result).toEqual(mockDeleted);
    });

    it('should handle API errors', async () => {
      mockQuickBooksInstance.deleteBill.mockImplementation((_payload: any, cb: any) =>
        cb(new Error('Delete failed'), null)
      );

      const result = await deleteQuickbooksBill({ Id: '1', SyncToken: '0' });

      expect(result.isError).toBe(true);
    });

    it('should handle authentication errors', async () => {
      (mockQuickbooksClientClass.getInstance as any).mockRejectedValue(new Error('Auth failed'));

      const result = await deleteQuickbooksBill({ Id: '1', SyncToken: '0' });

      expect(result.isError).toBe(true);
      expect(result.error).toContain('Error: Auth failed');
    });
  });

  describe('searchQuickbooksBills', () => {
    it('should search bills', async () => {
      const mockBills = [{ Id: '1', TotalAmt: 500 }, { Id: '2', TotalAmt: 300 }];
      mockQuickBooksInstance.findBills.mockImplementation((_criteria: any, cb: any) =>
        cb(null, { QueryResponse: { Bill: mockBills } })
      );

      const result = await searchQuickbooksBills({});

      expect(result.isError).toBe(false);
      expect(result.result).toEqual(mockBills);
    });

    it('should search bills with array criteria', async () => {
      mockQuickBooksInstance.findBills.mockImplementation((_criteria: any, cb: any) =>
        cb(null, { QueryResponse: { Bill: [{ Id: '1', TotalAmt: 500 }] } })
      );

      const result = await searchQuickbooksBills([
        { field: 'TotalAmt', value: '500', operator: '>' },
      ]);

      expect(result.isError).toBe(false);
      expect(result.result).toHaveLength(1);
    });

    it('should use default empty criteria when none provided', async () => {
      mockQuickBooksInstance.findBills.mockImplementation((_criteria: any, cb: any) =>
        cb(null, { QueryResponse: { Bill: [] } })
      );

      const result = await searchQuickbooksBills();

      expect(result.isError).toBe(false);
      expect(result.result).toEqual([]);
    });

    it('should return totalCount for count queries', async () => {
      mockQuickBooksInstance.findBills.mockImplementation((_criteria: any, cb: any) =>
        cb(null, { QueryResponse: { totalCount: 42 } })
      );

      const result = await searchQuickbooksBills({});

      expect(result.isError).toBe(false);
      expect(result.result).toBe(42);
    });

    it('should handle empty QueryResponse', async () => {
      mockQuickBooksInstance.findBills.mockImplementation((_criteria: any, cb: any) =>
        cb(null, { QueryResponse: {} })
      );

      const result = await searchQuickbooksBills({});

      expect(result.isError).toBe(false);
      expect(result.result).toEqual([]);
    });

    it('should handle API errors', async () => {
      mockQuickBooksInstance.findBills.mockImplementation((_criteria: any, cb: any) =>
        cb(new Error('Search failed'), null)
      );

      const result = await searchQuickbooksBills({});

      expect(result.isError).toBe(true);
    });

    it('should handle authentication errors', async () => {
      (mockQuickbooksClientClass.getInstance as any).mockRejectedValue(new Error('Auth failed'));

      const result = await searchQuickbooksBills({});

      expect(result.isError).toBe(true);
      expect(result.error).toContain('Error: Auth failed');
    });
  });
});


