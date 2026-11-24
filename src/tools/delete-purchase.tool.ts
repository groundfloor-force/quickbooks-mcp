import { deleteQuickbooksPurchase } from "../handlers/delete-quickbooks-purchase.handler.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";

const toolName = "delete_purchase";
const toolDescription =
  "Delete a purchase in QuickBooks Online -- only a Square fee Expense the GorillaDesk worker made (memo starting " +
  "\"GorillaDesk Square fees\"), dated AFTER bank_reconciled_through, that QuickBooks confirms is not reconciled, and only " +
  "as read (its sync_token). Anything else is refused and nothing is deleted. Read back: gone.";
const toolSchema = z.object({
  id: z.string().min(1).describe("Purchase ID"),
  sync_token: z.string().min(1).describe("The purchase's SyncToken, as read"),
  bank_reconciled_through: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("The last date the bank account is reconciled through (YYYY-MM-DD): a purchase on or before it is never deleted"),
});

const toolHandler = async ({ params }: any) => {
  const response = await deleteQuickbooksPurchase(params);
  if (response.isError) return { content: [{ type: "text" as const, text: `Error: ${response.error}` }] };
  return { content: [{ type: "text" as const, text: `Purchase deleted:` }, { type: "text" as const, text: JSON.stringify(response.result, null, 2) }] };
};

export const DeletePurchaseTool: ToolDefinition<typeof toolSchema> = { name: toolName, description: toolDescription, schema: toolSchema, handler: toolHandler };
