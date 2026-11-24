import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";

/**
 * delete_deposit, guarded (gd-qbo-worker DECISIONS 164: Remy fixed cheque deposits in the browser because the connector
 * could not). A deposit is deleted only when:
 *   - it is the one the caller read (its SyncToken);
 *   - it is dated AFTER the caller's bank_reconciled_through;
 *   - QuickBooks confirms it is not reconciled: the transaction list of its day shows it (the check can see it), and the
 *     same list filtered to reconciled transactions does not. A list that cannot be read, or that does not show it, is
 *     a refusal -- never a guess.
 * Anything else is refused and nothing is sent. Deleted, its payments are back in Undeposited Funds: each is read again
 * and returned, as QuickBooks has it now.
 */
export interface DeleteDepositInput {
  id: string;
  sync_token: string;
  bank_reconciled_through: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const call = <T>(fn: (cb: (err: any, v: T) => void) => void) => new Promise<T>((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));

/** Whether a report shows the transaction `txnType` `id`: some row's column names it (its value the type, its id the id). */
export function reportShows(report: any, txnType: string, id: string): boolean {
  const walk = (rows: any[]): boolean => rows.some((r: any) =>
    (r?.ColData ?? []).some((c: any) => c?.value === txnType && String(c?.id ?? '') === String(id)) || walk(r?.Rows?.Row ?? []));
  return walk(report?.Rows?.Row ?? []);
}

/** 'open', or why the deposit may not be deleted as unreconciled (the reports cannot say, or it is reconciled). */
async function reconciledState(quickbooks: any, deposit: any): Promise<'open' | string> {
  const day = String(deposit.TxnDate);
  const base = { start_date: day, end_date: day, transaction_type: "Deposit" };
  let all: any;
  let reconciled: any;
  try {
    all = await call((cb) => quickbooks.reportTransactionList(base, cb));
    reconciled = await call((cb) => quickbooks.reportTransactionList({ ...base, cleared: "Reconciled" }, cb));
  } catch (err) {
    return `its reconciliation could not be read (${formatError(err)})`;
  }
  // The check must be able to see it before its absence from the reconciled list means anything.
  if (!reportShows(all, "Deposit", deposit.Id)) return `QuickBooks' transaction list of ${day} does not show it, so it could not be confirmed unreconciled`;
  if (reportShows(reconciled, "Deposit", deposit.Id)) return 'it is reconciled';
  return 'open';
}

export async function deleteQuickbooksDeposit(data: DeleteDepositInput): Promise<ToolResponse<any>> {
  const refuse = (why: string): ToolResponse<any> => ({ result: null, isError: true, error: `deposit ${data?.id}: ${why}; nothing was deleted` });
  try {
    if (!data?.id || !data?.sync_token) return refuse('id and sync_token are needed');
    if (!DATE.test(String(data.bank_reconciled_through ?? ''))) return refuse(`bank_reconciled_through must be a date, YYYY-MM-DD (got ${data.bank_reconciled_through})`);
    const quickbooks: any = await QuickbooksClient.getInstance();
    const deposit: any = await call((cb) => quickbooks.getDeposit(data.id, cb)).catch(() => null);
    if (!deposit) return refuse('it could not be read');
    if (String(deposit.SyncToken) !== String(data.sync_token)) return refuse(`it changed since it was read (SyncToken ${deposit.SyncToken}, not ${data.sync_token})`);
    if (!(String(deposit.TxnDate) > data.bank_reconciled_through)) {
      return refuse(`it is dated ${deposit.TxnDate}, on or before the bank reconciliation date ${data.bank_reconciled_through}`);
    }
    const state = await reconciledState(quickbooks, deposit);
    if (state !== 'open') return refuse(state);

    await call((cb) => quickbooks.deleteDeposit({ Id: String(deposit.Id), SyncToken: String(deposit.SyncToken) }, cb));

    // Its payments, as QuickBooks has them now: back in Undeposited Funds.
    const paymentIds = (deposit.Line ?? []).flatMap((l: any) => l.LinkedTxn ?? []).filter((t: any) => t.TxnType === "Payment").map((t: any) => String(t.TxnId));
    const freed = [];
    for (const id of paymentIds) {
      const p: any = await call((cb) => quickbooks.getPayment(id, cb)).catch(() => null);
      freed.push(p
        ? { id, amount: p.TotalAmt, txn_date: p.TxnDate, deposit_to_account: p.DepositToAccountRef ?? null,
          in_deposit: (p.LinkedTxn ?? []).find((t: any) => t.TxnType === "Deposit")?.TxnId ?? null }
        : { id, read: false });
    }
    return { result: { deleted: { Id: String(deposit.Id), TxnDate: deposit.TxnDate, TotalAmt: deposit.TotalAmt }, freed_payments: freed }, isError: false, error: null };
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}
