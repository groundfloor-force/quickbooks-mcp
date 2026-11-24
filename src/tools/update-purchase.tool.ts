import { updateQuickbooksPurchase } from "../handlers/update-quickbooks-purchase.handler.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";

// Define the tool metadata
const toolName = "update_purchase";
const toolDescription =
  "Update a purchase in QuickBooks Online. Give its Id and SyncToken (as read) and the fields to change: each replaces " +
  "that field whole (Line replaces every line); the rest is kept as QuickBooks has it. Sent as the full purchase " +
  "(QuickBooks refuses a sparse one), refused if the purchase changed since it was read, and read back.";

// Define the expected input schema for updating a purchase
const toolSchema = z.object({
  purchase: z
    .object({
      Id: z.string().min(1).describe("Purchase ID"),
      SyncToken: z.string().min(1).describe("The purchase's SyncToken, as read"),
    })
    .passthrough()
    .describe("The purchase's Id and SyncToken, and the fields to change (e.g. Line, PrivateNote, TxnDate)"),
});

type ToolParams = z.infer<typeof toolSchema>;

// Define the tool handler
const toolHandler = async (args: any) => {
  const response = await updateQuickbooksPurchase(args.params.purchase);

  if (response.isError) {
    return {
      content: [
        { type: "text" as const, text: `Error updating purchase: ${response.error}` },
      ],
    };
  }

  return {
    content: [
      { type: "text" as const, text: `Purchase updated:` },
      { type: "text" as const, text: JSON.stringify(response.result) },
    ],
  };
};

export const UpdatePurchaseTool: ToolDefinition<typeof toolSchema> = {
  name: toolName,
  description: toolDescription,
  schema: toolSchema,
  handler: toolHandler,
};
