import { updateQuickbooksDeposit } from "../handlers/update-quickbooks-deposit.handler.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";

const toolName = "update_deposit";
const toolDescription =
  "Update a deposit in QuickBooks Online. With `line`, the deposit's FULL Line array as it is to be (a full update, " +
  "sparse:false): payment lines may be added (a payment deposited whole, from Undeposited Funds, in no other deposit) or " +
  "removed (it goes back to Undeposited Funds); a kept payment keeps its amount; every other line comes back unchanged; " +
  "at most one new line, a negative fee to a bank-charges expense account (AccountType Expense, AccountSubType " +
  "BankCharges). The total is the lines' sum. With `txn_date`, the deposit's date. Pass the deposit's sync_token: a deposit " +
  "changed since is not overwritten.";

const lineSchema = z
  .object({
    amount: z.number().describe("Line amount: a payment's whole amount, a kept line's own amount, or the negative fee"),
    payment_id: z.string().min(1).optional().describe("A linked Payment (TxnLineId 0): kept, or added from Undeposited Funds"),
    linked_txn: z
      .object({
        txn_id: z.string().min(1),
        txn_type: z.enum(["Payment", "SalesReceipt", "JournalEntry", "RefundReceipt", "Transfer"]),
        txn_line_id: z.string().optional(),
      })
      .optional(),
    account_ref: z.string().min(1).optional().describe("The account of an account line (the fee: a bank-charges expense account)"),
    description: z.string().optional(),
  })
  .refine((l) => [l.payment_id, l.linked_txn, l.account_ref].filter((v) => v !== undefined).length === 1, {
    message: "A line is exactly one of payment_id, linked_txn or account_ref.",
  });

const toolSchema = z.object({
  id: z.string().min(1).describe("Deposit ID"),
  sync_token: z.string().min(1).describe("Sync token"),
  private_note: z.string().optional().describe("Private note"),
  txn_date: z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/).optional().describe(
    "The deposit's date (TxnDate), YYYY-MM-DD: e.g. a deposit holding one payment re-dated in GorillaDesk. A date that does not exist (2026-02-30) is refused."
  ),
  line: z
    .array(lineSchema)
    .min(1)
    .optional()
    .describe(
      "The deposit's FULL Line array as it is to be: payments kept, added or removed; its other lines unchanged; at most one new negative fee line. Anything else is refused and nothing is sent."
    ),
});

const toolHandler = async ({ params }: any) => {
  const response = await updateQuickbooksDeposit(params);
  if (response.isError) return { content: [{ type: "text" as const, text: `Error: ${response.error}` }] };
  return { content: [{ type: "text" as const, text: `Deposit updated:` }, { type: "text" as const, text: JSON.stringify(response.result, null, 2) }] };
};

export const UpdateDepositTool: ToolDefinition<typeof toolSchema> = { name: toolName, description: toolDescription, schema: toolSchema, handler: toolHandler };
