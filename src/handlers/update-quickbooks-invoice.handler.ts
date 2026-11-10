import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { patchLinesTotalCents, belowZeroError } from "../helpers/invoice-total.js";

export interface UpdateInvoiceInput {
  invoice_id: string;
  patch: Record<string, any>; // Sparse update fields per Quickbooks spec
}

export async function updateQuickbooksInvoice({ invoice_id, patch }: UpdateInvoiceInput): Promise<ToolResponse<any>> {
  // A patch that replaces the lines may hold negative or zero lines, but the resulting invoice total may
  // not be below zero. Checked before any QBO call. A patch without Line leaves the lines as they are.
  if (Array.isArray(patch?.Line)) {
    const belowZero = belowZeroError(patchLinesTotalCents(patch.Line));
    if (belowZero) return { result: null, isError: true, error: belowZero };
  }

  try {
    const quickbooks = await QuickbooksClient.getInstance();

    // Need SyncToken; fetch existing invoice first
    const existing: any = await new Promise((res, rej) => {
      (quickbooks as any).getInvoice(invoice_id, (e: any, inv: any) => (e ? rej(e) : res(inv)));
    });

    const updatePayload = { ...existing, ...patch, Id: invoice_id, sparse: true };

    return new Promise((resolve) => {
      (quickbooks as any).updateInvoice(updatePayload, (err: any, updated: any) => {
        if (err) {
          resolve({ result: null, isError: true, error: formatError(err) });
        } else {
          resolve({ result: updated, isError: false, error: null });
        }
      });
    });
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
} 
