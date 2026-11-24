import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";

/** One deposit line in create_deposit's shape: a linked transaction (payment_id or linked_txn), or an account line. */
export interface DepositLineInput {
  amount: number;
  payment_id?: string;
  linked_txn?: { txn_id: string; txn_type: string; txn_line_id?: string };
  account_ref?: string;
  description?: string;
}

export interface UpdateDepositInput {
  id: string;
  sync_token: string;
  private_note?: string;
  /**
   * The deposit's FULL Line array, as it is to be (sent as a full object, sparse:false). Guarded:
   *   - payment lines may be added and removed (gd-qbo-worker DECISIONS 164: a cheque deposit fixed in place). A kept
   *     payment keeps its amount; an added one is deposited whole, and must be in Undeposited Funds and in no deposit.
   *     A removed one goes back to Undeposited Funds.
   *   - every other line the deposit has (an account line, a linked sales receipt, journal entry...) comes back unchanged.
   *   - at most ONE new account line: negative, to a bank-charges expense account (a Square fee, DECISIONS 155).
   * The total is the lines' sum; it is read back.
   */
  line?: DepositLineInput[];
}

const cents = (v: unknown) => Math.round(Number(v) * 100);
const isPaymentLine = (l: DepositLineInput) => Boolean(l.payment_id) || l.linked_txn?.txn_type === "Payment";
const paymentIdOf = (l: DepositLineInput) => String(l.payment_id ?? l.linked_txn?.txn_id);
/** A read line's linked payment id, or null. */
const readPaymentId = (l: any): string | null => {
  const t = (l?.LinkedTxn ?? [])[0];
  return t && t.TxnType === "Payment" ? String(t.TxnId) : null;
};

/** A line's identity and amount, from what was read (QuickBooks' shape) or what was given (the tool's shape). */
function readKey(l: any): string {
  const t = (l?.LinkedTxn ?? [])[0];
  if (t) return `txn:${t.TxnType}:${t.TxnId}:${t.TxnLineId ?? '0'}:${cents(l.Amount)}`;
  return `acct:${l?.DepositLineDetail?.AccountRef?.value ?? ''}:${cents(l?.Amount)}:${l?.Description ?? ''}`;
}
/** A line other than a payment's (those are matched by their payment id). */
function givenKey(l: DepositLineInput): string {
  if (l.linked_txn) return `txn:${l.linked_txn.txn_type}:${l.linked_txn.txn_id}:${l.linked_txn.txn_line_id ?? '0'}:${cents(l.amount)}`;
  return `acct:${l.account_ref}:${cents(l.amount)}:${l.description ?? ''}`;
}

/** What `line` does to the deposit: the payments it keeps, adds and removes, and its new account line (the fee), if any. */
export interface DepositLinePlan {
  kept: string[];
  added: { id: string; cents: number }[];
  removed: string[];
  fee: DepositLineInput | null;
}

/**
 * Why `line` may not become the deposit's lines (a string), or what it does (a plan). Pure: what needs a read -- an added
 * payment, the fee's account -- is checked by the caller.
 */
export function depositLinePlan(current: any, line: DepositLineInput[]): string | DepositLinePlan {
  const have = (current?.Line ?? []) as any[];
  if (!line.length) return 'a deposit keeps at least one line (to empty it, delete it: delete_deposit)';
  const havePayments = new Map(have.filter(readPaymentId).map((l) => [readPaymentId(l) as string, l]));
  const seen = new Set<string>();
  const added: { id: string; cents: number }[] = [];
  const kept: string[] = [];
  for (const l of line.filter(isPaymentLine)) {
    const id = paymentIdOf(l);
    if (seen.has(id)) return `payment ${id} is on two lines`;
    seen.add(id);
    if (l.linked_txn && (l.linked_txn.txn_line_id ?? '0') !== '0') return `payment ${id}'s line must link it whole (TxnLineId 0)`;
    const now = havePayments.get(id);
    if (now) {
      if (cents(l.amount) !== cents(now.Amount)) return `payment ${id} is ${now.Amount} in the deposit; a kept payment keeps its amount (got ${l.amount})`;
      kept.push(id);
    } else {
      if (!(cents(l.amount) > 0)) return `payment ${id}'s line must be its amount (got ${l.amount})`;
      added.push({ id, cents: cents(l.amount) });
    }
  }
  const removed = [...havePayments.keys()].filter((id) => !seen.has(id));
  // Everything else the deposit has comes back unchanged; at most one new line, an account line (the fee).
  const others = have.filter((l) => !readPaymentId(l)).map(readKey);
  const given = line.filter((l) => !isPaymentLine(l));
  const left = [...others];
  const extra: DepositLineInput[] = [];
  for (const l of given) {
    const i = left.indexOf(givenKey(l));
    if (i >= 0) left.splice(i, 1); else extra.push(l);
  }
  if (left.length) return `the deposit's other line${left.length === 1 ? '' : 's'} (${left.join(', ')}) must come back unchanged`;
  if (extra.length > 1) return `at most one new line besides payments: one fee line (got ${extra.length})`;
  const fee = extra[0] ?? null;
  if (fee) {
    if (fee.linked_txn) return `the new ${fee.linked_txn.txn_type} line may not be added: only payments, and one fee line`;
    if (!fee.account_ref) return 'the added line needs account_ref (the bank-charges expense account)';
    if (!(cents(fee.amount) < 0)) return `the added line must be negative (got ${fee.amount})`;
  }
  if (!added.length && !removed.length && !fee) return 'the lines are the deposit\'s own: nothing to change (leave out `line`)';
  return { kept, added, removed, fee };
}

/** An account a fee line may go to: an expense account of the bank-charges kind. */
export const isBankChargesAccount = (a: any) => a?.AccountType === "Expense" && a?.AccountSubType === "BankCharges" && a?.Active !== false;
/** QuickBooks' Undeposited Funds account. */
export const isUndepositedFunds = (a: any) => a?.AccountSubType === "UndepositedFunds";

/** The deposit's lines as QuickBooks takes them back, in the given order: a read line as read (without read-only parts). */
function linesFor(current: any, line: DepositLineInput[]): any[] {
  const read = (current.Line ?? []).map(({ LineEx: _readOnly, ...l }: any) => l);
  const used = new Set<number>();
  return line.map((l) => {
    const i = read.findIndex((r: any, j: number) => !used.has(j) && (isPaymentLine(l) ? readPaymentId(r) === paymentIdOf(l) : readKey(r) === givenKey(l)));
    if (i >= 0) { used.add(i); return read[i]; }
    if (isPaymentLine(l)) return { Amount: l.amount, LinkedTxn: [{ TxnId: paymentIdOf(l), TxnType: "Payment", TxnLineId: "0" }] };
    return { Amount: l.amount, DetailType: "DepositLineDetail", ...(l.description ? { Description: l.description } : {}),
      DepositLineDetail: { AccountRef: { value: String(l.account_ref) } } };
  });
}

const call = <T>(fn: (cb: (err: any, v: T) => void) => void) => new Promise<T>((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));

/** Why an added payment may not go into this deposit, or null: it is deposited whole, from Undeposited Funds, in no deposit. */
async function addedPaymentProblem(quickbooks: any, a: { id: string; cents: number }, accounts: Map<string, any>): Promise<string | null> {
  const p: any = await call((cb) => quickbooks.getPayment(a.id, cb)).catch(() => null);
  if (!p) return `payment ${a.id} could not be read`;
  if (cents(p.TotalAmt) !== a.cents) return `payment ${a.id} is ${p.TotalAmt}; it is deposited whole (got ${a.cents / 100})`;
  const dep = (p.LinkedTxn ?? []).find((t: any) => t.TxnType === "Deposit");
  if (dep) return `payment ${a.id} is already in deposit ${dep.TxnId}`;
  const acctId = String(p.DepositToAccountRef?.value ?? '');
  if (!accounts.has(acctId)) accounts.set(acctId, await call((cb) => quickbooks.getAccount(acctId, cb)).catch(() => null));
  if (!isUndepositedFunds(accounts.get(acctId))) return `payment ${a.id} is not in Undeposited Funds (account ${acctId || '?'})`;
  return null;
}

export async function updateQuickbooksDeposit(data: UpdateDepositInput): Promise<ToolResponse<any>> {
  try {
    const quickbooks = await QuickbooksClient.getInstance();

    // QBO rejects a sparse Deposit update that omits DepositToAccountRef (and
    // other required fields) — unlike Purchase, sparse=true isn't honored here.
    // Fetch the current record and send a full object back instead.
    const current: any = await new Promise((resolve, reject) => {
      (quickbooks as any).getDeposit(data.id, (err: any, deposit: any) => {
        if (err) reject(err); else resolve(deposit);
      });
    });

    if (data.line) {
      if (!current) return { result: null, isError: true, error: `deposit ${data.id} could not be read; nothing was changed` };
      // The caller's SyncToken is its optimistic lock: a deposit changed since it read it is not overwritten.
      if (String(current.SyncToken) !== String(data.sync_token)) {
        return { result: null, isError: true, error: `deposit ${data.id} changed since it was read (SyncToken ${current.SyncToken}, not ${data.sync_token}); nothing was changed` };
      }
      const plan = depositLinePlan(current, data.line);
      if (typeof plan === "string") return { result: null, isError: true, error: `deposit ${data.id}: ${plan}; nothing was changed` };
      const accounts = new Map<string, any>();
      for (const a of plan.added) {
        const why = await addedPaymentProblem(quickbooks, a, accounts);
        if (why) return { result: null, isError: true, error: `deposit ${data.id}: ${why}; nothing was changed` };
      }
      if (plan.fee) {
        const account: any = await call((cb) => (quickbooks as any).getAccount(String(plan.fee!.account_ref), cb));
        if (!isBankChargesAccount(account)) {
          return { result: null, isError: true,
            error: `deposit ${data.id}: account ${plan.fee.account_ref} is not an active bank-charges expense account (${account?.AccountType ?? '?'}/${account?.AccountSubType ?? '?'}); nothing was changed` };
        }
      }
    }

    const payload: any = { ...current, SyncToken: data.sync_token };
    if (data.private_note) payload.PrivateNote = data.private_note;
    if (data.line) {
      payload.Line = linesFor(current, data.line);
      // The total is the lines' sum.
      payload.TotalAmt = data.line.reduce((t, l) => t + cents(l.amount), 0) / 100;
      payload.sparse = false;
      delete payload.MetaData;
    }

    return new Promise((resolve) => {
      (quickbooks as any).updateDeposit(payload, (err: any, updated: any) => {
        if (err) resolve({ result: null, isError: true, error: formatError(err) });
        else if (data.line && cents(updated?.TotalAmt) !== cents(payload.TotalAmt)) {
          resolve({ result: updated, isError: true,
            error: `deposit ${data.id} read back totalling ${updated?.TotalAmt}, not ${payload.TotalAmt}; check it in QuickBooks` });
        } else resolve({ result: updated, isError: false, error: null });
      });
    });
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}
