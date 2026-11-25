import { getQuickbooksReconciledThrough, RECONCILED_MAX_DAYS } from "../handlers/get-quickbooks-reconciled-through.handler.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";

const toolName = "get_reconciled_through";
const toolDescription =
  "Read only. The latest date QuickBooks shows a reconciled transaction on one account (its transaction list, filtered to reconciled " +
  "transactions, as delete_deposit checks). QuickBooks has no reconciliation statement date: this can be earlier than the statement's end.";
const toolSchema = z.object({
  account_id: z.string().regex(/^\d+$/).describe("The QuickBooks account id (e.g. the bank account deposits go to)"),
  as_of: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/).optional().describe("The last day looked at, YYYY-MM-DD (default today)"),
  days: z.number().int().min(1).max(RECONCILED_MAX_DAYS).optional().describe(`How many days back from as_of (default 120, at most ${RECONCILED_MAX_DAYS})`),
});

const toolHandler = async ({ params }: any) => {
  const response = await getQuickbooksReconciledThrough(params);
  if (response.isError) {
    return { content: [{ type: "text" as const, text: `Error reading the reconciled date: ${response.error}` }] };
  }
  return {
    content: [
      { type: "text" as const, text: "Reconciled through:" },
      { type: "text" as const, text: JSON.stringify(response.result, null, 2) },
    ],
  };
};

export const GetReconciledThroughTool: ToolDefinition<typeof toolSchema> = {
  name: toolName,
  description: toolDescription,
  schema: toolSchema,
  handler: toolHandler,
};
