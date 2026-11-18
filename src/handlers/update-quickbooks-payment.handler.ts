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
}

export async function updateQuickbooksPayment(data: UpdatePaymentInput): Promise<ToolResponse<any>> {
  try {
    const quickbooks = await QuickbooksClient.getInstance();

    // A payment in a bank deposit cannot move to another account without leaving that deposit: read it first.
    if (data.deposit_to_account) {
      const current: any = await new Promise((resolve, reject) => {
        (quickbooks as any).getPayment(data.id, (err: any, payment: any) => (err ? reject(err) : resolve(payment)));
      });
      const deposit = (current?.LinkedTxn ?? []).find((t: any) => t?.TxnType === 'Deposit');
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

