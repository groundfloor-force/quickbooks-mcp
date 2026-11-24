import { deleteQuickbooksDeposit } from "../handlers/delete-quickbooks-deposit.handler.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";

const toolName = "delete_deposit";
const toolDescription =
  "Delete a deposit in QuickBooks Online -- only one dated AFTER bank_reconciled_through that QuickBooks confirms is not " +
  "reconciled, and only as read (its sync_token). Anything else is refused and nothing is deleted. Returns the payments it " +
  "held, read again: back in Undeposited Funds.";
const toolSchema = z.object({
  id: z.string().min(1).describe("Deposit ID"),
  sync_token: z.string().min(1).describe("The deposit's SyncToken, as read"),
  bank_reconciled_through: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("The last date the bank account is reconciled through (YYYY-MM-DD): a deposit on or before it is never deleted"),
});

const toolHandler = async ({ params }: any) => {
  const response = await deleteQuickbooksDeposit(params);
  if (response.isError) return { content: [{ type: "text" as const, text: `Error: ${response.error}` }] };
  return { content: [{ type: "text" as const, text: `Deposit deleted:` }, { type: "text" as const, text: JSON.stringify(response.result, null, 2) }] };
};

export const DeleteDepositTool: ToolDefinition<typeof toolSchema> = { name: toolName, description: toolDescription, schema: toolSchema, handler: toolHandler };
