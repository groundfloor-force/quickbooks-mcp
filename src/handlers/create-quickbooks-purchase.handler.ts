import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import {
  attachToNewRecord,
  base64AttachmentProblem,
  type NewRecordAttachment,
} from "../helpers/attachable-upload.js";
import { findDuplicatePurchase, describeHit } from "../helpers/duplicate-guard.js";

/**
 * Create a purchase in QuickBooks Online. With `attachment`, the file is uploaded and linked to
 * the new purchase afterwards; the outcome is returned as the purchase's `_attachment`, and the
 * call succeeds even when only the upload fails, because the purchase exists.
 * Unless `allowDuplicate`, a likely duplicate (see findDuplicatePurchase) is refused before creating.
 * @param purchaseData The purchase object to create
 */
export async function createQuickbooksPurchase(
  purchaseData: any,
  attachment?: NewRecordAttachment,
  allowDuplicate = false
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

    if (!allowDuplicate) {
      let hit: any;
      try {
        hit = await findDuplicatePurchase(quickbooks, purchaseData);
      } catch (e) {
        return {
          result: null,
          isError: true,
          error: `Duplicate check failed: ${formatError(e)}. Retry, or pass allow_duplicate: true.`,
        };
      }
      if (hit) {
        return {
          result: null,
          isError: true,
          error: "Possible duplicate — " + describeHit("Purchase", hit) + " Pass allow_duplicate: true to create anyway.",
        };
      }
    }

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
