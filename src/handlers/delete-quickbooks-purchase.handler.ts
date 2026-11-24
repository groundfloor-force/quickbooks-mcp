import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";

/**
 * delete_purchase, guarded (gd-qbo-worker DECISIONS 166: the Square fee Expenses the worker made before fees went inside
 * their deposits, removed when QuickBooks will not take one at $0.00). A purchase is deleted only when:
 *   - it is the one the caller read (its SyncToken);
 *   - its memo starts "GorillaDesk Square fees" (the worker's fee Expense; nothing else);
 *   - it is dated AFTER the caller's bank_reconciled_through;
 *   - QuickBooks confirms it is not reconciled: the transaction list of its day shows it (the check can see it), and the
 *     same list filtered to reconciled transactions does not. A list that cannot be read, or that does not show it, is a
 *     refusal -- never a guess.
 * Anything else is refused and nothing is sent. Read back: it is gone.
 */
export interface DeletePurchaseInput {
  id: string;
  sync_token: string;
  bank_reconciled_through: string;
}

/** The memo every fee Expense the worker made starts with ("GorillaDesk Square fees, square-payout:po_..."). */
export const SQUARE_FEE_MEMO = "GorillaDesk Square fees";
/** What a transaction list calls a purchase, by its payment type. */
const PURCHASE_TYPES = new Set(["Expense", "Cash Expense", "Check", "Cheque", "Check Expense", "Cheque Expense", "Credit Card Expense", "Credit Card Credit"]);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const call = <T>(fn: (cb: (err: any, v: T) => void) => void) => new Promise<T>((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));

/** Whether a report shows the purchase `id`: some row's txn_type cell names it (a purchase type, and its id), at any depth. */
export function reportShowsPurchase(report: any, id: string): boolean {
  const walk = (rows: any[]): boolean => rows.some((r: any) =>
    (r?.ColData ?? []).some((c: any) => PURCHASE_TYPES.has(c?.value) && String(c?.id ?? "") === String(id)) || walk(r?.Rows?.Row ?? []));
  return walk(report?.Rows?.Row ?? []);
}

/** 'open', or why the purchase may not be deleted as unreconciled (the reports cannot say, or it is reconciled). */
async function reconciledState(quickbooks: any, purchase: any): Promise<"open" | string> {
  const day = String(purchase.TxnDate);
  const base = { start_date: day, end_date: day };
  let all: any;
  let reconciled: any;
  try {
    all = await call((cb) => quickbooks.reportTransactionList(base, cb));
    reconciled = await call((cb) => quickbooks.reportTransactionList({ ...base, cleared: "Reconciled" }, cb));
  } catch (err) {
    return `its reconciliation could not be read (${formatError(err)})`;
  }
  // The check must be able to see it before its absence from the reconciled list means anything.
  if (!reportShowsPurchase(all, purchase.Id)) return `QuickBooks' transaction list of ${day} does not show it, so it could not be confirmed unreconciled`;
  if (reportShowsPurchase(reconciled, purchase.Id)) return "it is reconciled";
  return "open";
}

export async function deleteQuickbooksPurchase(data: DeletePurchaseInput): Promise<ToolResponse<any>> {
  const refuse = (why: string): ToolResponse<any> => ({ result: null, isError: true, error: `purchase ${data?.id}: ${why}; nothing was deleted` });
  try {
    if (!data?.id || !data?.sync_token) return refuse("id and sync_token are needed");
    if (!DATE.test(String(data.bank_reconciled_through ?? ""))) return refuse(`bank_reconciled_through must be a date, YYYY-MM-DD (got ${data.bank_reconciled_through})`);
    const quickbooks: any = await QuickbooksClient.getInstance();
    const purchase: any = await call((cb) => quickbooks.getPurchase(String(data.id), cb)).catch(() => null);
    if (!purchase) return refuse("it could not be read");
    if (String(purchase.SyncToken) !== String(data.sync_token)) return refuse(`it changed since it was read (SyncToken ${purchase.SyncToken}, not ${data.sync_token})`);
    if (!String(purchase.PrivateNote ?? "").startsWith(SQUARE_FEE_MEMO)) {
      return refuse(`its memo does not start "${SQUARE_FEE_MEMO}" (only the worker's Square fee Expenses are deleted here)`);
    }
    if (!(String(purchase.TxnDate) > data.bank_reconciled_through)) {
      return refuse(`it is dated ${purchase.TxnDate}, on or before the bank reconciliation date ${data.bank_reconciled_through}`);
    }
    const state = await reconciledState(quickbooks, purchase);
    if (state !== "open") return refuse(state);

    await call((cb) => quickbooks.deletePurchase({ Id: String(purchase.Id), SyncToken: String(purchase.SyncToken) }, cb));

    // Read back: gone. A purchase QuickBooks still returns was not deleted, whatever the reply said.
    const after: any = await call((cb) => quickbooks.getPurchase(String(purchase.Id), cb)).catch(() => null);
    if (after) return { result: after, isError: true, error: `purchase ${purchase.Id} still reads back after the delete; check it in QuickBooks` };
    return { result: { deleted: { Id: String(purchase.Id), TxnDate: purchase.TxnDate, TotalAmt: purchase.TotalAmt, PrivateNote: purchase.PrivateNote } },
      isError: false, error: null };
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}
