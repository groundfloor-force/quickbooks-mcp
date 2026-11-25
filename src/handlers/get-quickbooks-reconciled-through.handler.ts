import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";

/**
 * get_reconciled_through (gd-qbo-worker DECISIONS 169): the latest date QuickBooks shows a RECONCILED transaction on one
 * account -- the same "cleared: Reconciled" transaction list delete_deposit checks with -- so the worker can read its
 * bank reconciliation date from QuickBooks instead of having it typed. Read only.
 *
 * QuickBooks' API has no reconciliation statement date: this is the latest reconciled transaction, which can be earlier
 * than the statement's end (a statement through Nov 23 whose last transaction is Nov 21 says Nov 21). The worker only
 * ever moves its date FORWARD to it.
 *
 * The report is asked for its date, type and account columns by name; rows are matched to the account by the account
 * cell's id, or -- a cell with no id -- by the account's own name as QuickBooks reads it. A report whose columns cannot
 * be found is an error: never a guessed date.
 */
export interface ReconciledThroughInput {
  account_id: string;
  /** The last day looked at, YYYY-MM-DD (default: today, UTC). */
  as_of?: string;
  /** How many days back from as_of (default 120, 1..400). */
  days?: number;
}

export interface ReconciledThrough {
  account_id: string;
  /** The latest reconciled transaction's date on the account, or null: none in the window. */
  reconciled_through: string | null;
  /** How many reconciled transactions on the account the window holds. */
  rows: number;
  from: string;
  to: string;
}

export const RECONCILED_DEFAULT_DAYS = 120;
export const RECONCILED_MAX_DAYS = 400;
export const RECONCILED_COLUMNS = "tx_date,txn_type,account_name";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const call = <T>(fn: (cb: (err: any, v: T) => void) => void) => new Promise<T>((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));
const shift = (day: string, n: number) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** The index of the report column whose ColKey is `key`, or -1. */
export function columnIndex(report: any, key: string): number {
  const cols: any[] = report?.Columns?.Column ?? [];
  return cols.findIndex((c) => (c?.MetaData ?? []).some((m: any) => m?.Name === "ColKey" && m?.Value === key));
}

/** Every data row of a report, its sections walked. */
function dataRows(report: any): any[] {
  const out: any[] = [];
  const walk = (rows: any[]) => {
    for (const r of rows) {
      if (Array.isArray(r?.ColData)) out.push(r);
      if (r?.Rows?.Row) walk(r.Rows.Row);
    }
  };
  walk(report?.Rows?.Row ?? []);
  return out;
}

/**
 * The latest date of a row on the account (its account cell's id, or -- no id -- its name), and how many there are; or why
 * the report cannot say (a string). Pure.
 */
export function latestOnAccount(report: any, accountId: string, accountNames: string[] = []): { date: string | null; rows: number } | string {
  const di = columnIndex(report, "tx_date");
  const ai = columnIndex(report, "account_name");
  if (di < 0 || ai < 0) return "the transaction list did not have its date and account columns";
  const names = new Set(accountNames.filter(Boolean));
  let date: string | null = null;
  let rows = 0;
  for (const r of dataRows(report)) {
    const cell = r.ColData[ai] ?? {};
    const mine = cell.id !== undefined && cell.id !== null && String(cell.id) !== "" ? String(cell.id) === accountId : names.has(String(cell.value ?? ""));
    const d = String(r.ColData[di]?.value ?? "");
    if (!mine || !DATE.test(d)) continue;
    rows += 1;
    if (!date || d > date) date = d;
  }
  return { date, rows };
}

export async function getQuickbooksReconciledThrough(data: ReconciledThroughInput): Promise<ToolResponse<ReconciledThrough>> {
  const accountId = String(data.account_id ?? "");
  if (!/^\d+$/.test(accountId)) return { result: null, isError: true, error: `account_id must be a QuickBooks account id (digits), got ${data.account_id}` };
  const to = data.as_of ?? new Date().toISOString().slice(0, 10);
  if (!DATE.test(to) || shift(to, 0) !== to) return { result: null, isError: true, error: `as_of must be a date YYYY-MM-DD, got ${data.as_of}` };
  const days = data.days ?? RECONCILED_DEFAULT_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > RECONCILED_MAX_DAYS) return { result: null, isError: true, error: `days must be 1..${RECONCILED_MAX_DAYS}, got ${data.days}` };
  const from = shift(to, -days);
  try {
    const quickbooks: any = await QuickbooksClient.getInstance();
    const account: any = await call((cb) => quickbooks.getAccount(accountId, cb));
    const names = [account?.FullyQualifiedName, account?.Name].filter(Boolean).map(String);
    const report = await call((cb) => quickbooks.reportTransactionList({ start_date: from, end_date: to, cleared: "Reconciled", columns: RECONCILED_COLUMNS }, cb));
    const found = latestOnAccount(report, accountId, names);
    if (typeof found === "string") return { result: null, isError: true, error: `account ${accountId}: ${found}; nothing could be read` };
    return { result: { account_id: accountId, reconciled_through: found.date, rows: found.rows, from, to }, isError: false, error: null };
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}
