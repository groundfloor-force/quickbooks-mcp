import { createQuickbooksDeposit } from "../handlers/create-quickbooks-deposit.handler.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";

const toolName = "create_deposit";
const toolDescription =
  "Create a bank deposit in QuickBooks Online. To deposit payments from Undeposited Funds, pass payment_id on each line.";

const lineItemSchema = z
  .object({
    amount: z.number().positive(),
    account_ref: z.string().optional(),
    description: z.string().optional(),
    payment_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        "ID of a Payment sitting in Undeposited Funds. Line becomes a linked-transaction line. amount must equal the payment amount."
      ),
  })
  .refine((l) => !(l.payment_id !== undefined && l.account_ref !== undefined), {
    message: "A line is either a payment_id or an account_ref, not both",
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
