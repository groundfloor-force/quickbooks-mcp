import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";

export interface UpdatePaymentInput {
  id: string;
  sync_token: string;
  customer_ref?: string;
  total_amt?: number;
  payment_method_ref?: string;
  private_note?: string;
  /**
   * The payment's date, YYYY-MM-DD (gd-qbo-worker DECISIONS 160: an e-transfer dated the day Interac's email says it was
   * received). Refused, with nothing read or sent, when it is not a real date.
   */
  txn_date?: string;
  /** Move the payment to another deposit-to account; refused when it is already in a bank deposit. */
  deposit_to_account?: string;
  /**
   * The reference no. (PaymentRefNum), e.g. an e-transfer's reference (gd-qbo-worker DECISIONS 156: an old-sync payment
   * kept it only in its memo). QuickBooks keeps 21 characters; the schema refuses more.
   */
  payment_ref_num?: string;
  /** The payment's full Line array (a sparse update replaces it whole); guarded against applying more than the total. */
  line?: { amount: number; linked_txn: { txn_id: string; txn_type: string }[] }[];
}

const cents = (v: unknown) => Math.round(Number(v) * 100);
const dollars = (c: number) => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toFixed(2)}`;

/**
 * Why these lines may not replace the payment's (null = they may). What a payment applies is its invoice lines minus
 * its credit-memo lines (QuickBooks: UnappliedAmt = TotalAmt - that); it may not exceed the total, nor go below zero.
 */
export function lineProblem(line: NonNullable<UpdatePaymentInput['line']>, totalCents: number): string | null {
  let applied = 0;
  for (const l of line) {
    for (const t of l.linked_txn) {
      if (t.txn_type !== 'Invoice' && t.txn_type !== 'CreditMemo') {
        return `a line may link an Invoice or CreditMemo only (got ${t.txn_type} ${t.txn_id})`;
      }
    }
    const types = new Set(l.linked_txn.map((t) => t.txn_type));
    if (types.size > 1) return 'a line links an Invoice and a CreditMemo together; give each its own line';
    applied += types.has('CreditMemo') ? -cents(l.amount) : cents(l.amount);
  }
  if (!Number.isFinite(totalCents)) return 'the payment\'s total could not be read';
  if (applied > totalCents) return `the lines would apply ${dollars(applied)}, but the payment's total is ${dollars(totalCents)}`;
  if (applied < 0) return `the lines apply less than nothing (${dollars(applied)})`;
  return null;
}

/** A real calendar date written YYYY-MM-DD (2026-02-30 is not one). */
export function isRealDate(s: string): boolean {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** A reference as QuickBooks takes it back: its value only (a name it returned is not ours to send). */
const refOf = (r: any) => (r?.value !== undefined && r?.value !== null && String(r.value) !== '' ? { value: String(r.value) } : undefined);

/**
 * The full object a payment update sends (DECISIONS 149): `current` as read, with the change merged in. Its writable
 * fields only -- Id and SyncToken from the read, CustomerRef, TotalAmt, TxnDate (txn_date, DECISIONS 160), DepositToAccountRef, PaymentMethodRef,
 * PaymentRefNum, PrivateNote, Line -- never the read-only ones (MetaData, domain, the top-level LinkedTxn, each line's
 * LineEx). `sparse: false` is said out loud: node-quickbooks makes an update sparse when the object does not say.
 */
export function fullPaymentUpdate(current: any, data: UpdatePaymentInput): any {
  const line = data.line
    ? data.line.map((l) => ({ Amount: l.amount, LinkedTxn: l.linked_txn.map((t) => ({ TxnId: t.txn_id, TxnType: t.txn_type })) }))
    : (current.Line ?? []).map(({ LineEx: _readOnly, ...l }: any) => l);
  const body: any = {
    Id: String(current.Id),
    SyncToken: String(current.SyncToken),
    sparse: false,
    CustomerRef: data.customer_ref ? { value: data.customer_ref } : refOf(current.CustomerRef),
    TotalAmt: data.total_amt !== undefined ? data.total_amt : current.TotalAmt,
    TxnDate: data.txn_date !== undefined ? data.txn_date : current.TxnDate,
    DepositToAccountRef: data.deposit_to_account ? { value: data.deposit_to_account } : refOf(current.DepositToAccountRef),
    PaymentMethodRef: data.payment_method_ref ? { value: data.payment_method_ref } : refOf(current.PaymentMethodRef),
    PaymentRefNum: data.payment_ref_num !== undefined ? data.payment_ref_num : current.PaymentRefNum,
    PrivateNote: data.private_note ? data.private_note : current.PrivateNote,
    Line: line,
  };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  return body;
}

export async function updateQuickbooksPayment(data: UpdatePaymentInput): Promise<ToolResponse<any>> {
  if (data.txn_date !== undefined && !isRealDate(data.txn_date)) {
    return { result: null, isError: true, error: `payment ${data.id}: ${data.txn_date} is not a date (YYYY-MM-DD); nothing was changed` };
  }
  try {
    const quickbooks = await QuickbooksClient.getInstance();

    // Always read first (gd-qbo-worker DECISIONS 149): QuickBooks payment updates are not sparse -- a sparse update that
    // changes Line is refused ("Required param missing, need to supply the required value for the API") -- so every
    // change is merged into the full object as read. The read also feeds the guards below.
    const current: any = await new Promise((resolve, reject) => {
      (quickbooks as any).getPayment(data.id, (err: any, payment: any) => (err ? reject(err) : resolve(payment)));
    });
    if (!current) {
      return { result: null, isError: true, error: `payment ${data.id} could not be read; nothing was changed` };
    }
    // The caller's SyncToken is its optimistic lock: a payment changed since it read it is not overwritten.
    if (String(current.SyncToken) !== String(data.sync_token)) {
      return { result: null, isError: true, error: `payment ${data.id} changed since it was read (SyncToken ${current.SyncToken}, not ${data.sync_token}); nothing was changed` };
    }
    if (data.line) {
      const why = lineProblem(data.line, cents(data.total_amt ?? current.TotalAmt));
      if (why) return { result: null, isError: true, error: `payment ${data.id}: ${why}; nothing was changed` };
    }
    if (data.deposit_to_account) {
      const deposit = (current.LinkedTxn ?? []).find((t: any) => t?.TxnType === 'Deposit');
      if (deposit) {
        return {
          result: null,
          isError: true,
          error: `payment ${data.id} is already in deposit ${deposit.TxnId}; its deposit-to account cannot change while it is deposited`,
        };
      }
    }

    const paymentPayload = fullPaymentUpdate(current, data);

    return new Promise((resolve) => {
      (quickbooks as any).updatePayment(paymentPayload, (err: any, updated: any) => {
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

