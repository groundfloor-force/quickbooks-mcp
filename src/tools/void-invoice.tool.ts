import { voidQuickbooksInvoice } from "../handlers/void-quickbooks-invoice.handler.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";

const toolName = "void_invoice";
const toolDescription =
  "Void an invoice in QuickBooks Online. Keeps the record at $0 with an audit trail — use this instead of delete. Refuses invoices with payments applied unless allow_paid is true.";

const toolSchema = z.object({
  invoice_id: z.string().min(1).describe("QBO Invoice Id"),
  allow_paid: z.boolean().optional().describe("Void even if payments are applied"),
});

const toolHandler = async ({ params }: any) => {
  const response = await voidQuickbooksInvoice(params);
  if (response.isError) {
    return { content: [{ type: "text" as const, text: `Error voiding invoice: ${response.error}` }] };
  }
  return {
    content: [
      { type: "text" as const, text: `Invoice voided:` },
      { type: "text" as const, text: JSON.stringify(response.result, null, 2) },
    ],
  };
};

export const VoidInvoiceTool: ToolDefinition<typeof toolSchema> = {
  name: toolName,
  description: toolDescription,
  schema: toolSchema,
  handler: toolHandler,
};
