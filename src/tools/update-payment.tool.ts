import { updateQuickbooksPayment } from "../handlers/update-quickbooks-payment.handler.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";

const toolName = "update_payment";
const toolDescription = "Update an existing payment in QuickBooks Online.";

const lineSchema = z.object({
  amount: z.number().positive().describe("Amount to apply to this transaction"),
  linked_txn: z.array(z.object({
    txn_id: z.string().min(1).describe("Transaction ID (e.g. the invoice's)"),
    txn_type: z.string().min(1).describe("Invoice or CreditMemo"),
  })).min(1).describe("Linked transactions"),
});

const toolSchema = z.object({
  id: z.string().min(1).describe("Payment ID"),
  sync_token: z.string().min(1).describe("Sync token for optimistic locking"),
  customer_ref: z.string().optional().describe("Customer ID"),
  total_amt: z.number().optional().describe("Total payment amount"),
  payment_method_ref: z.string().optional().describe("Payment method ID"),
  private_note: z.string().optional().describe("Private note"),
  payment_ref_num: z.string().min(1).max(21).optional().describe(
    "Reference no. for the payment (PaymentRefNum), e.g. an e-transfer reference. QuickBooks keeps 21 characters."
  ),
  deposit_to_account: z.string().min(1).optional().describe(
    "Account ID to move the payment to (DepositToAccountRef), e.g. Undeposited Funds or a bank account. Refused if the payment is already in a bank deposit."
  ),
  line: z.array(lineSchema).min(1).optional().describe(
    "The payment's FULL Line array: which invoices it applies to and how much (it replaces every line). Lines may link an Invoice or a CreditMemo. Refused if what the lines apply (invoice lines minus credit-memo lines) would exceed the payment's total, or go below zero."
  ),
});

const toolHandler = async ({ params }: any) => {
  const response = await updateQuickbooksPayment(params);
  if (response.isError) {
    return { content: [{ type: "text" as const, text: `Error updating payment: ${response.error}` }] };
  }
  return {
    content: [
      { type: "text" as const, text: `Payment updated successfully:` },
      { type: "text" as const, text: JSON.stringify(response.result, null, 2) },
    ],
  };
};

export const UpdatePaymentTool: ToolDefinition<typeof toolSchema> = {
  name: toolName,
  description: toolDescription,
  schema: toolSchema,
  handler: toolHandler,
};
