import { createQuickbooksBill } from "../handlers/create-quickbooks-bill.handler.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";

const toolName = "create-bill";
const toolDescription =
  "Create a bill in QuickBooks Online. Refuses if a matching record already exists unless allow_duplicate is true. " +
  "Optional attachment uploads a base64 file and links it; the response includes _attachment.";

const refSchema = z.object({
  value: z.string(),
  name: z.string().optional(),
});

const lineSchema = z.object({
  Amount: z.number(),
  DetailType: z.string(),
  Description: z.string().optional(),
  // Flat (legacy) — handler will auto-nest
  AccountRef: refSchema.optional(),
  // QBO-spec nested structure
  AccountBasedExpenseLineDetail: z.object({
    AccountRef: refSchema,
    BillableStatus: z.string().optional(),
    CustomerRef: refSchema.optional(),
    ClassRef: refSchema.optional(),
    TaxCodeRef: refSchema.optional(),
  }).optional(),
  ItemBasedExpenseLineDetail: z.object({
    ItemRef: refSchema,
    Qty: z.number().optional(),
    UnitPrice: z.number().optional(),
    BillableStatus: z.string().optional(),
    CustomerRef: refSchema.optional(),
  }).optional(),
}).passthrough();

const toolSchema = z.object({
  bill: z.object({
    Line: z.array(lineSchema),
    VendorRef: refSchema,
    TxnDate: z.string().optional(),
    DueDate: z.string().optional(),
    DocNumber: z.string().optional(),
    PrivateNote: z.string().optional(),
    APAccountRef: refSchema.optional(),
    Balance: z.number().optional(),
    TotalAmt: z.number().optional(),
  }).passthrough(),
  attachment: z.object({
    file_name: z.string().min(1),
    base64_content: z.string().min(1),
    content_type: z.string().optional().describe("Inferred from file_name if omitted"),
    note: z.string().optional(),
    include_on_send: z.boolean().optional(),
  }).optional().describe("Upload this file and link it to the new record in the same call. Returns attachable_id."),
  // Next to `bill`, not inside it: the bill object is sent to QBO as given.
  allow_duplicate: z.boolean().optional().describe("Skip the duplicate check and create anyway"),
});

const toolHandler = async (args: { [x: string]: any }) => {
  const response = await createQuickbooksBill(args.params.bill, args.params.attachment, args.params.allow_duplicate);
  if (response.isError) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Error creating bill: ${response.error}`,
        },
      ],
    };
  }
  const bill = response.result;
  // With an attachment, lead with its outcome: the ids, or a warning that the bill exists
  // without its file.
  const attached = bill._attachment;
  const lead = attached?.error
    ? `WARNING: ${attached.error}`
    : attached?.attachable_id
      ? `Bill created: Id ${bill.Id}, attachment ${attached.attachable_id}`
      : undefined;
  return {
    content: [
      ...(lead ? [{ type: "text" as const, text: lead }] : []),
      {
        type: "text" as const,
        text: JSON.stringify(bill),
      }
    ],
  };
};

export const CreateBillTool: ToolDefinition<typeof toolSchema> = {
  name: toolName,
  description: toolDescription,
  schema: toolSchema,
  handler: toolHandler,
};