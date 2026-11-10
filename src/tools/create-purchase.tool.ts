import { createQuickbooksPurchase } from "../handlers/create-quickbooks-purchase.handler.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";

// Define the tool metadata
const toolName = "create_purchase";
const toolDescription =
  "Create a purchase in QuickBooks Online. Refuses if a matching record already exists unless allow_duplicate is true. " +
  "Optional attachment uploads a base64 file and links it; the response includes _attachment.";

// Define the expected input schema for creating a purchase
const toolSchema = z.object({
  purchase: z.any(),
  attachment: z.object({
    file_name: z.string().min(1),
    base64_content: z.string().min(1),
    content_type: z.string().optional().describe("Inferred from file_name if omitted"),
    note: z.string().optional(),
    include_on_send: z.boolean().optional(),
  }).optional().describe("Upload this file and link it to the new record in the same call. Returns attachable_id."),
  // Next to `purchase`, not inside it: the purchase object is sent to QBO as given.
  allow_duplicate: z.boolean().optional().describe("Skip the duplicate check and create anyway"),
});

type ToolParams = z.infer<typeof toolSchema>;

// Define the tool handler
const toolHandler = async (args: any) => {
  const response = await createQuickbooksPurchase(
    args.params.purchase,
    args.params.attachment,
    args.params.allow_duplicate
  );

  if (response.isError) {
    return {
      content: [
        { type: "text" as const, text: `Error creating purchase: ${response.error}` },
      ],
    };
  }

  // With an attachment, lead with its outcome: the ids, or a warning that the purchase exists
  // without its file.
  const purchase = response.result;
  const attached = purchase._attachment;
  const created = attached?.attachable_id
    ? `Purchase created: Id ${purchase.Id}, attachment ${attached.attachable_id}`
    : `Purchase created:`;
  return {
    content: [
      ...(attached?.error ? [{ type: "text" as const, text: `WARNING: ${attached.error}` }] : []),
      { type: "text" as const, text: created },
      { type: "text" as const, text: JSON.stringify(purchase) },
    ],
  };
};

export const CreatePurchaseTool: ToolDefinition<typeof toolSchema> = {
  name: toolName,
  description: toolDescription,
  schema: toolSchema,
  handler: toolHandler,
}; 