import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";

/**
 * update_purchase, as a full object (gd-qbo-worker DECISIONS 166). QuickBooks refuses a sparse Purchase update ("Required
 * param missing, need to supply the required value for the API": deposit-fee-repair --armed, purchase 125983), as it did
 * payments (DECISIONS 148). So the purchase is read first and the change merged into it: each field the caller gives
 * replaces that field whole (its Line replaces every line), everything else goes back as read, with `sparse: false` said
 * out loud (node-quickbooks makes an update sparse when the object does not say). The caller's SyncToken is its
 * optimistic lock: a purchase changed since it read it is not overwritten. Read back: each field it changed holds what
 * it sent, else an error with the purchase as QuickBooks returned it.
 */

/** What QuickBooks computes or owns: never sent back. */
const READ_ONLY = ["MetaData", "domain", "PurchaseEx", "TotalAmt", "sparse"];

const cents = (v: unknown) => Math.round(Number(v) * 100);

/** The full object an update sends: `current` as read, with `change` merged in (its Id and SyncToken excepted). */
export function fullPurchaseUpdate(current: any, change: any): any {
  const { Id: _id, SyncToken: _token, sparse: _sparse, ...given } = change;
  const body: any = { ...current, ...given };
  for (const k of READ_ONLY) delete body[k];
  // New lines make the tax detail as read stale: QuickBooks works it out again from them, unless the caller sends one.
  if (given.Line !== undefined && given.TxnTaxDetail === undefined) delete body.TxnTaxDetail;
  body.Line = (body.Line ?? []).map(({ LineEx: _readOnly, ...l }: any) => l);
  return { ...body, Id: String(current.Id), SyncToken: String(change.SyncToken), sparse: false };
}

/** Why the purchase QuickBooks returned does not hold what was sent (null = it does): its memo, its date, its lines' amounts. */
export function readBackProblem(change: any, updated: any): string | null {
  if (!updated) return "QuickBooks returned no purchase";
  if (change.PrivateNote !== undefined && String(updated.PrivateNote ?? "") !== String(change.PrivateNote ?? "")) {
    return `its memo reads back "${updated.PrivateNote ?? ""}", not "${change.PrivateNote}"`;
  }
  if (change.TxnDate !== undefined && updated.TxnDate !== change.TxnDate) return `it reads back dated ${updated.TxnDate}, not ${change.TxnDate}`;
  if (Array.isArray(change.Line)) {
    const want = change.Line.map((l: any) => cents(l.Amount));
    const got = (updated.Line ?? []).map((l: any) => cents(l.Amount));
    if (want.join(",") !== got.join(",")) {
      return `its lines read back ${got.map((x: number) => (x / 100).toFixed(2)).join(", ") || "(none)"}, not ${want.map((x: number) => (x / 100).toFixed(2)).join(", ")}`;
    }
  }
  return null;
}

const call = <T>(fn: (cb: (err: any, v: T) => void) => void) => new Promise<T>((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));

/**
 * Update a purchase in QuickBooks Online.
 * @param change the purchase's Id and SyncToken (as read), and the fields to change
 */
export async function updateQuickbooksPurchase(change: any): Promise<ToolResponse<any>> {
  const refuse = (why: string): ToolResponse<any> => ({ result: null, isError: true, error: `purchase ${change?.Id ?? "?"}: ${why}; nothing was changed` });
  try {
    if (!change?.Id || change?.SyncToken === undefined || change?.SyncToken === null || change?.SyncToken === "") return refuse("Id and SyncToken are needed");
    const quickbooks: any = await QuickbooksClient.getInstance();
    const current: any = await call((cb) => quickbooks.getPurchase(String(change.Id), cb)).catch(() => null);
    if (!current) return refuse("it could not be read");
    if (String(current.SyncToken) !== String(change.SyncToken)) {
      return refuse(`it changed since it was read (SyncToken ${current.SyncToken}, not ${change.SyncToken})`);
    }
    const updated: any = await call((cb) => quickbooks.updatePurchase(fullPurchaseUpdate(current, change), cb));
    const why = readBackProblem(change, updated);
    if (why) return { result: updated, isError: true, error: `purchase ${change.Id} ${why}; check it in QuickBooks` };
    return { result: updated, isError: false, error: null };
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}
