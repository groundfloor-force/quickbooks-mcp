import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import {
  attachToNewRecord,
  base64AttachmentProblem,
  type NewRecordAttachment,
} from "../helpers/attachable-upload.js";

/**
 * Create a bill in QuickBooks Online. With `attachment`, the file is uploaded and linked to the
 * new bill afterwards; the outcome is returned as the bill's `_attachment`, and the call
 * succeeds even when only the upload fails, because the bill exists.
 */
export async function createQuickbooksBill(
  bill: any,
  attachment?: NewRecordAttachment
): Promise<ToolResponse<any>> {
  try {
    // An attachment that can never upload (unsupported type, over 100 MB) is refused before
    // the bill is created, so the caller can fix it and retry without a duplicate bill.
    const problem = attachment && base64AttachmentProblem(attachment);
    if (problem) {
      return { result: null, isError: true, error: `Attachment rejected, so no bill was created: ${problem}` };
    }

    const quickbooks = await QuickbooksClient.getInstance();

    // Auto-nest flat line items into QBO's expected nested structure.
    // If caller sends AccountRef at line level (legacy shape), move it under AccountBasedExpenseLineDetail.
    const reshapedBill = {
      ...bill,
      Line: (bill.Line || []).map((line: any) => {
        if (line.AccountBasedExpenseLineDetail || line.ItemBasedExpenseLineDetail) {
          return line; // already properly structured
        }
        if (line.AccountRef) {
          const { AccountRef, ...rest } = line;
          return {
            ...rest,
            AccountBasedExpenseLineDetail: { AccountRef },
          };
        }
        return line;
      }),
    };

    const createdBill = await new Promise<any>((resolve, reject) => {
      quickbooks.createBill(reshapedBill, (err: any, created: any) => (err ? reject(err) : resolve(created)));
    });

    if (!attachment) {
      return { result: createdBill, isError: false, error: null };
    }
    // attachToNewRecord never throws, so nothing after the create can report it as failed.
    const _attachment = await attachToNewRecord("Bill", createdBill.Id, attachment);
    return { result: { ...createdBill, _attachment }, isError: false, error: null };
  } catch (error) {
    return {
      result: null,
      isError: true,
      error: formatError(error),
    };
  }
}
