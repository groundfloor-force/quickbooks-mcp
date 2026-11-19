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
  /** Move the payment to another deposit-to account; refused when it is already in a bank deposit. */
  deposit_to_account?: string;
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

export async function updateQuickbooksPayment(data: UpdatePaymentInput): Promise<ToolResponse<any>> {
  try {
    const quickbooks = await QuickbooksClient.getInstance();

    // Read first when the update depends on what the payment is: a payment in a bank deposit cannot move to another
    // account without leaving that deposit; new lines are checked against its total.
    const current: any = data.deposit_to_account || data.line
      ? await new Promise((resolve, reject) => {
        (quickbooks as any).getPayment(data.id, (err: any, payment: any) => (err ? reject(err) : resolve(payment)));
      })
      : null;
    if ((data.deposit_to_account || data.line) && !current) {
      return { result: null, isError: true, error: `payment ${data.id} could not be read; nothing was changed` };
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

    const paymentPayload: any = {
      Id: data.id,
      SyncToken: data.sync_token,
      sparse: true,
    };

    if (data.customer_ref) {
      paymentPayload.CustomerRef = { value: data.customer_ref };
    }
    if (data.total_amt !== undefined) {
      paymentPayload.TotalAmt = data.total_amt;
    }
    if (data.payment_method_ref) {
      paymentPayload.PaymentMethodRef = { value: data.payment_method_ref };
    }
    if (data.private_note) {
      paymentPayload.PrivateNote = data.private_note;
    }
    if (data.deposit_to_account) {
      paymentPayload.DepositToAccountRef = { value: data.deposit_to_account };
    }
    if (data.line) {
      paymentPayload.Line = data.line.map((l) => ({
        Amount: l.amount,
        LinkedTxn: l.linked_txn.map((t) => ({ TxnId: t.txn_id, TxnType: t.txn_type })),
      }));
    }

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

