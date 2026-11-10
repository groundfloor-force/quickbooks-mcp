import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";

export interface VoidInvoiceInput {
  invoice_id: string;
  allow_paid?: boolean;
}

/**
 * Void an invoice in QuickBooks Online (POST /invoice?operation=void).
 * Unlike delete, the record stays in the books at $0 with an audit trail.
 * Refuses an invoice that is already $0 (TotalAmt 0), and one with payments applied
 * (Balance differs from TotalAmt) unless allow_paid is true.
 */
export async function voidQuickbooksInvoice({ invoice_id, allow_paid }: VoidInvoiceInput): Promise<ToolResponse<any>> {
  try {
    const quickbooks = await QuickbooksClient.getInstance();

    // Need SyncToken and the current Balance; fetch the invoice first
    const existing: any = await new Promise((res, rej) => {
      (quickbooks as any).getInvoice(invoice_id, (e: any, inv: any) => (e ? rej(e) : res(inv)));
    });

    if (Number(existing.TotalAmt) === 0) {
      return {
        result: null,
        isError: true,
        error: `Invoice ${invoice_id} is already $0 (voided or empty). Nothing to void.`,
      };
    }

    if (Number(existing.Balance) !== Number(existing.TotalAmt) && !allow_paid) {
      return {
        result: null,
        isError: true,
        error: `Invoice ${invoice_id} has payments applied (Balance ${existing.Balance} of ${existing.TotalAmt}). Unapply them first, or pass allow_paid: true.`,
      };
    }

    // Awaited so a synchronous throw from node-quickbooks lands in the catch below
    const voided = await new Promise((res, rej) => {
      (quickbooks as any).voidInvoice(
        { Id: existing.Id, SyncToken: existing.SyncToken },
        (err: any, resp: any) => (err ? rej(err) : res(resp))
      );
    });

    return { result: voided, isError: false, error: null };
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}
