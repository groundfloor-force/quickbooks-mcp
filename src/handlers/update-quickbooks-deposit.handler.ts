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
   * The deposit's FULL Line array (gd-qbo-worker DECISIONS 155: a Square fee inside its deposit, so the deposit equals the
   * bank line). Guarded: every line the deposit has is passed back unchanged, in order, and the only addition is ONE
   * negative line to a bank-charges expense account (AccountType Expense, AccountSubType BankCharges); the total drops by
   * exactly that line.
   */
  line?: DepositLineInput[];
}

const cents = (v: unknown) => Math.round(Number(v) * 100);

/** A line's identity and amount, from what was read (QuickBooks' shape) or what was given (the tool's shape). */
function readKey(l: any): string {
  const t = (l?.LinkedTxn ?? [])[0];
  if (t) return `txn:${t.TxnType}:${t.TxnId}:${t.TxnLineId ?? '0'}:${cents(l.Amount)}`;
  return `acct:${l?.DepositLineDetail?.AccountRef?.value ?? ''}:${cents(l?.Amount)}:${l?.Description ?? ''}`;
}
function givenKey(l: DepositLineInput): string {
  if (l.payment_id) return `txn:Payment:${l.payment_id}:0:${cents(l.amount)}`;
  if (l.linked_txn) return `txn:${l.linked_txn.txn_type}:${l.linked_txn.txn_id}:${l.linked_txn.txn_line_id ?? '0'}:${cents(l.amount)}`;
  return `acct:${l.account_ref ?? ''}:${cents(l.amount)}:${l.description ?? ''}`;
}

/**
 * Why `line` may not replace the deposit's lines (null = it may): the lines read must come back unchanged and in order,
 * followed by exactly one new line -- negative, on an account, linking nothing. The account's type is checked by the
 * caller (it needs a read).
 */
export function depositLineProblem(current: any, line: DepositLineInput[]): string | null {
  const have = (current?.Line ?? []) as any[];
  if (line.length !== have.length + 1) {
    return `the lines must be the deposit's ${have.length} line(s) unchanged plus one fee line (got ${line.length})`;
  }
  for (const [i, l] of have.entries()) {
    if (givenKey(line[i]) !== readKey(l)) return `line ${i + 1} is not the deposit's own line ${i + 1}, unchanged`;
  }
  const fee = line[line.length - 1];
  if (fee.payment_id || fee.linked_txn) return 'the added line may not link a transaction';
  if (!fee.account_ref) return 'the added line needs account_ref (the bank-charges expense account)';
  if (!(cents(fee.amount) < 0)) return `the added line must be negative (got ${fee.amount})`;
  return null;
}

/** An account a fee line may go to: an expense account of the bank-charges kind. */
export const isBankChargesAccount = (a: any) => a?.AccountType === "Expense" && a?.AccountSubType === "BankCharges" && a?.Active !== false;

/** The deposit's lines as QuickBooks takes them back: the read ones as read (without read-only parts), then the fee line. */
function linesFor(current: any, line: DepositLineInput[]): any[] {
  const kept = (current.Line ?? []).map(({ LineEx: _readOnly, ...l }: any) => l);
  const fee = line[line.length - 1];
  return [...kept, {
    Amount: fee.amount,
    DetailType: "DepositLineDetail",
    ...(fee.description ? { Description: fee.description } : {}),
    DepositLineDetail: { AccountRef: { value: String(fee.account_ref) } },
  }];
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
      const why = depositLineProblem(current, data.line);
      if (why) return { result: null, isError: true, error: `deposit ${data.id}: ${why}; nothing was changed` };
      const fee = data.line[data.line.length - 1];
      const account: any = await new Promise((resolve, reject) => {
        (quickbooks as any).getAccount(String(fee.account_ref), (err: any, a: any) => (err ? reject(err) : resolve(a)));
      });
      if (!isBankChargesAccount(account)) {
        return { result: null, isError: true,
          error: `deposit ${data.id}: account ${fee.account_ref} is not an active bank-charges expense account (${account?.AccountType ?? '?'}/${account?.AccountSubType ?? '?'}); nothing was changed` };
      }
    }

    const payload: any = { ...current, SyncToken: data.sync_token };
    if (data.private_note) payload.PrivateNote = data.private_note;
    if (data.line) {
      payload.Line = linesFor(current, data.line);
      // The total is the lines' sum: lower than before by exactly the fee line.
      payload.TotalAmt = (cents(current.TotalAmt) + cents(data.line[data.line.length - 1].amount)) / 100;
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
