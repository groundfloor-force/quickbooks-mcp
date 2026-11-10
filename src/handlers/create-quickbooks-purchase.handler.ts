import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import {
  attachToNewRecord,
  base64AttachmentProblem,
  type NewRecordAttachment,
} from "../helpers/attachable-upload.js";

/**
 * Create a purchase in QuickBooks Online. With `attachment`, the file is uploaded and linked to
 * the new purchase afterwards; the outcome is returned as the purchase's `_attachment`, and the
 * call succeeds even when only the upload fails, because the purchase exists.
 * @param purchaseData The purchase object to create
 */
export async function createQuickbooksPurchase(
  purchaseData: any,
  attachment?: NewRecordAttachment
): Promise<ToolResponse<any>> {
  try {
    // An attachment that can never upload (unsupported type, over 100 MB) is refused before
    // the purchase is created, so the caller can fix it and retry without a duplicate.
    const problem = attachment && base64AttachmentProblem(attachment);
    if (problem) {
      return {
        result: null,
        isError: true,
        error: `Attachment rejected, so no purchase was created: ${problem}`,
      };
    }

    const quickbooks = await QuickbooksClient.getInstance();

    const purchase = await new Promise<any>((resolve, reject) => {
      quickbooks.createPurchase(purchaseData, (err: any, created: any) => (err ? reject(err) : resolve(created)));
    });

    if (!attachment) {
      return { result: purchase, isError: false, error: null };
    }
    // attachToNewRecord never throws, so nothing after the create can report it as failed.
    const _attachment = await attachToNewRecord("Purchase", purchase.Id, attachment);
    return { result: { ...purchase, _attachment }, isError: false, error: null };
  } catch (error) {
    return {
      result: null,
      isError: true,
      error: formatError(error),
    };
  }
}
