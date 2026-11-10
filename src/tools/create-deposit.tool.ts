import { createQuickbooksDeposit } from "../handlers/create-quickbooks-deposit.handler.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";

const toolName = "create_deposit";
const toolDescription =
  "Create a bank deposit in QuickBooks Online. To deposit payments from Undeposited Funds, pass payment_id on each line. " +
  "Lines can link a Payment, SalesReceipt or JournalEntry sitting in Undeposited Funds; " +
  "a $0 deposit clears a payment against an offsetting journal entry.";

const lineItemSchema = z
  .object({
    amount: z
      .number()
      .describe(
        "Line amount. Negative lines are allowed, e.g. a journal entry or fee that offsets a payment; the deposit total may be 0."
      ),
    account_ref: z.string().optional(),
    description: z.string().optional(),
    payment_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        "ID of a Payment sitting in Undeposited Funds. Line becomes a linked-transaction line. amount must equal the payment amount."
      ),
    linked_txn: z
      .object({
        txn_id: z.string().min(1),
        txn_type: z.enum(["Payment", "SalesReceipt", "JournalEntry", "RefundReceipt", "Transfer"]),
        txn_line_id: z
          .string()
          .optional()
          .describe(
            'Line Id inside the linked transaction. Payments use "0". For a JournalEntry, the Id of its Undeposited Funds line; omitted → resolved automatically.'
          ),
      })
      .optional(),
  })
  .refine((l) => [l.payment_id, l.linked_txn, l.account_ref].filter((v) => v !== undefined).length <= 1, {
    message: "A line is one of payment_id, linked_txn or account_ref.",
  });

const toolSchema = z.object({
  deposit_to_account_ref: z.string().min(1).describe("Bank account ID to deposit to"),
  line_items: z.array(lineItemSchema).min(1).describe("Deposit line items"),
  txn_date: z.string().optional().describe("Transaction date (YYYY-MM-DD)"),
  private_note: z.string().optional().describe("Private note"),
});

const toolHandler = async ({ params }: any) => {
  const response = await createQuickbooksDeposit(params);
  if (response.isError) return { content: [{ type: "text" as const, text: `Error: ${response.error}` }] };
  return { content: [{ type: "text" as const, text: `Deposit created:` }, { type: "text" as const, text: JSON.stringify(response.result, null, 2) }] };
};

export const CreateDepositTool: ToolDefinition<typeof toolSchema> = { name: toolName, description: toolDescription, schema: toolSchema, handler: toolHandler };
