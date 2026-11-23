import { updateQuickbooksDeposit } from "../handlers/update-quickbooks-deposit.handler.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";

const toolName = "update_deposit";
const toolDescription =
  "Update a deposit in QuickBooks Online. With `line`, add ONE fee line: pass the deposit's lines back unchanged, in order, " +
  "then one negative line to a bank-charges expense account (AccountType Expense, AccountSubType BankCharges); the total " +
  "drops by exactly that line. Nothing else about the lines can change.";

const lineSchema = z
  .object({
    amount: z.number().describe("Line amount: a deposit line's own amount, or the negative fee"),
    payment_id: z.string().min(1).optional().describe("A linked Payment (TxnLineId 0), as the deposit has it"),
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
  line: z
    .array(lineSchema)
    .min(2)
    .optional()
    .describe(
      "The deposit's FULL Line array: its lines as they are, unchanged and in order, then one negative fee line to a bank-charges expense account. Anything else is refused and nothing is sent."
    ),
});

const toolHandler = async ({ params }: any) => {
  const response = await updateQuickbooksDeposit(params);
  if (response.isError) return { content: [{ type: "text" as const, text: `Error: ${response.error}` }] };
  return { content: [{ type: "text" as const, text: `Deposit updated:` }, { type: "text" as const, text: JSON.stringify(response.result, null, 2) }] };
};

export const UpdateDepositTool: ToolDefinition<typeof toolSchema> = { name: toolName, description: toolDescription, schema: toolSchema, handler: toolHandler };
