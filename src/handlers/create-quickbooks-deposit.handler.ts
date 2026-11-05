import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";

export interface CreateDepositInput {
  deposit_to_account_ref: string;
  line_items: Array<{
    amount: number;
    account_ref?: string;
    entity_ref?: { type: string; value: string };
    description?: string;
    payment_id?: string;
  }>;
  txn_date?: string;
  private_note?: string;
}

export async function createQuickbooksDeposit(data: CreateDepositInput): Promise<ToolResponse<any>> {
  try {
    const quickbooks = await QuickbooksClient.getInstance();

    const payload: any = {
      DepositToAccountRef: { value: data.deposit_to_account_ref },
      Line: data.line_items.map((l, idx) =>
        l.payment_id
          ? {
              // Linked line: pulls an Undeposited Funds payment into this
              // deposit. Carries LinkedTxn only — no DetailType/DepositLineDetail.
              Id: `${idx + 1}`,
              Amount: l.amount,
              Description: l.description,
              LinkedTxn: [{ TxnId: l.payment_id, TxnType: "Payment", TxnLineId: "0" }],
            }
          : {
              Id: `${idx + 1}`,
              Amount: l.amount,
              Description: l.description,
              DetailType: "DepositLineDetail",
              DepositLineDetail: {
                AccountRef: l.account_ref ? { value: l.account_ref } : undefined,
                Entity: l.entity_ref ? { Type: l.entity_ref.type, EntityRef: { value: l.entity_ref.value } } : undefined,
              },
            }
      ),
    };

    if (data.txn_date) payload.TxnDate = data.txn_date;
    if (data.private_note) payload.PrivateNote = data.private_note;

    return new Promise((resolve) => {
      (quickbooks as any).createDeposit(payload, (err: any, created: any) => {
        if (err) resolve({ result: null, isError: true, error: formatError(err) });
        else resolve({ result: created, isError: false, error: null });
      });
    });
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}

