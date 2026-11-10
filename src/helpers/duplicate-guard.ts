/**
 * Duplicate guard for create_invoice, create_payment, create-bill and create_purchase: before
 * creating, look for a record that already matches, so a retried or repeated call does not post the
 * same transaction twice. (The bill and purchase rules are documented on their functions below.)
 *
 * - Invoice with a doc_number: any invoice with that DocNumber is a duplicate.
 * - Invoice without one: an invoice for the same customer, in the date window, whose
 *   SalesItemLineDetail amounts sum to ours within a cent.
 * - Payment: a payment for the same customer, in the date window, that either has the same
 *   PaymentRefNum, or has the same TotalAmt AND is applied to the same set of invoices. The same
 *   customer paying the same amount against different invoices on the same day is normal.
 *
 * The date window is the exact TxnDate when the caller gives one, else the last 3 days (UTC).
 */

/** How far back to look when the caller gives no TxnDate. */
const LOOKBACK_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Candidates fetched per check. */
const CANDIDATE_LIMIT = 50;

export interface InvoiceDuplicateInput {
  customer_ref: string;
  doc_number?: string;
  txn_date?: string;
  line_items: Array<{ qty: number; unit_price: number }>;
}

export interface PaymentDuplicateInput {
  customer_ref: string;
  total_amt: number;
  txn_date?: string;
  payment_ref_num?: string;
  line?: Array<{ linked_txn: Array<{ txn_id: string; txn_type: string }> }>;
}

/** TxnDate criteria: the exact date when given, else today (UTC) minus LOOKBACK_DAYS onward. */
export function dateWindow(txn_date?: string): Array<Record<string, any>> {
  if (txn_date) {
    return [{ field: "TxnDate", value: txn_date, operator: "=" }];
  }
  const since = new Date(Date.now() - LOOKBACK_DAYS * DAY_MS).toISOString().slice(0, 10);
  return [{ field: "TxnDate", value: since, operator: ">=" }];
}

/** Run a node-quickbooks find* call as a Promise; a synchronous throw also rejects. */
function find(
  quickbooks: any,
  method: "findInvoices" | "findPayments" | "findBills" | "findPurchases",
  criteria: any
): Promise<any> {
  return new Promise((resolve, reject) => {
    quickbooks[method](criteria, (err: any, result: any) => (err ? reject(err) : resolve(result)));
  });
}

/** Whole cents, so amounts compare exactly rather than as floats. */
const toCents = (amount: number): number => Math.round(amount * 100);

export async function findDuplicateInvoice(quickbooks: any, input: InvoiceDuplicateInput): Promise<any | null> {
  if (input.doc_number) {
    const response = await find(quickbooks, "findInvoices", { DocNumber: input.doc_number });
    const invoices: any[] = response.QueryResponse.Invoice || [];
    return invoices[0] || null;
  }

  const response = await find(quickbooks, "findInvoices", [
    { field: "CustomerRef", value: input.customer_ref, operator: "=" },
    ...dateWindow(input.txn_date),
    { field: "limit", value: CANDIDATE_LIMIT },
  ]);
  const invoices: any[] = response.QueryResponse.Invoice || [];
  const ours = toCents(input.line_items.reduce((sum, l) => sum + l.qty * l.unit_price, 0));

  const match = invoices.find((invoice) => {
    const theirs = toCents(
      (invoice.Line || [])
        .filter((line: any) => line.DetailType === "SalesItemLineDetail")
        .reduce((sum: number, line: any) => sum + Number(line.Amount), 0)
    );
    return Math.abs(theirs - ours) <= 1; // within ±$0.01
  });
  return match || null;
}

/** The set of Invoice ids, as one comparable string: sorted, de-duplicated, "" when none. */
const invoiceSetKey = (links: Array<{ id: unknown; type: unknown }>): string =>
  [...new Set(links.filter((l) => String(l.type).toLowerCase() === "invoice").map((l) => String(l.id)))]
    .sort()
    .join(",");

export async function findDuplicatePayment(quickbooks: any, input: PaymentDuplicateInput): Promise<any | null> {
  // TotalAmt is compared here rather than in the query: a PaymentRefNum match counts at any amount.
  const response = await find(quickbooks, "findPayments", [
    { field: "CustomerRef", value: input.customer_ref, operator: "=" },
    ...dateWindow(input.txn_date),
    { field: "limit", value: CANDIDATE_LIMIT },
  ]);
  const payments: any[] = response.QueryResponse.Payment || [];

  const ourAmount = toCents(input.total_amt);
  const ourInvoices = invoiceSetKey(
    (input.line || []).flatMap((l) => l.linked_txn).map((lt) => ({ id: lt.txn_id, type: lt.txn_type }))
  );

  const match = payments.find((payment) => {
    if (input.payment_ref_num && payment.PaymentRefNum === input.payment_ref_num) {
      return true;
    }
    const theirInvoices = invoiceSetKey(
      (payment.Line || [])
        .flatMap((line: any) => line.LinkedTxn || [])
        .map((lt: any) => ({ id: lt.TxnId, type: lt.TxnType }))
    );
    return toCents(Number(payment.TotalAmt)) === ourAmount && theirInvoices === ourInvoices;
  });
  return match || null;
}

/** The line types that carry a Bill's or Purchase's expense amounts. */
const EXPENSE_DETAIL_TYPES = ["AccountBasedExpenseLineDetail", "ItemBasedExpenseLineDetail"];

/**
 * A Bill's or Purchase's expense lines summed, in cents. A line counts when its DetailType, or its
 * detail object, is an expense type; subtotal lines do not count. Tax is not on the lines, so this
 * compares like with like where TotalAmt (which includes tax) would not.
 */
function expenseLinesCents(lines: unknown): number {
  return toCents(
    (Array.isArray(lines) ? lines : [])
      .filter((line: any) => EXPENSE_DETAIL_TYPES.some((type) => line.DetailType === type || line[type]))
      .reduce((sum: number, line: any) => sum + Number(line.Amount), 0)
  );
}

/**
 * Bill (`bill` is the QBO-shaped object about to be sent):
 * - With a DocNumber (the vendor's invoice number): a bill from the same vendor with that DocNumber,
 *   at any date. DocNumbers repeat across vendors, so the vendor is part of the match.
 * - Without one: a bill from the same vendor, in the date window, whose expense lines sum to ours
 *   within a cent.
 * A bill with no VendorRef is not checked; QBO rejects it.
 */
export async function findDuplicateBill(quickbooks: any, bill: any): Promise<any | null> {
  const vendor = bill.VendorRef?.value;
  if (!vendor) return null;
  const sameVendor = { field: "VendorRef", value: String(vendor), operator: "=" };

  if (bill.DocNumber) {
    const response = await find(quickbooks, "findBills", [
      sameVendor,
      { field: "DocNumber", value: String(bill.DocNumber), operator: "=" },
    ]);
    const bills: any[] = response.QueryResponse.Bill || [];
    return bills[0] || null;
  }

  const response = await find(quickbooks, "findBills", [
    sameVendor,
    ...dateWindow(bill.TxnDate),
    { field: "limit", value: CANDIDATE_LIMIT },
  ]);
  const bills: any[] = response.QueryResponse.Bill || [];
  const ours = expenseLinesCents(bill.Line);
  return bills.find((existing) => Math.abs(expenseLinesCents(existing.Line) - ours) <= 1) || null;
}

/**
 * QBO cannot filter purchases by account, payee or payment type, so a check without a DocNumber
 * fetches every purchase in the window and compares here. 1000 is QBO's page maximum.
 */
const PURCHASE_CANDIDATE_LIMIT = 1000;

/** Same payee: the same id (or both have none), and the same type when both sides give one. */
function samePayee(theirs: any, ours: any): boolean {
  if (String(theirs?.value ?? "") !== String(ours?.value ?? "")) return false;
  if (!theirs?.type || !ours?.type) return true;
  return String(theirs.type).toLowerCase() === String(ours.type).toLowerCase();
}

/**
 * Purchase (`purchase` is the object about to be sent, unchecked — the tool takes z.any()):
 * - With a DocNumber (cheque or reference number): a purchase from the same account, to the same
 *   payee, with that DocNumber, at any date.
 * - Without one: a purchase in the date window from the same account, with the same PaymentType,
 *   the same Credit flag (a card refund is not a charge), the same payee, and expense lines that sum
 *   to ours within a cent.
 * A purchase with no AccountRef is not checked; QBO rejects it.
 */
export async function findDuplicatePurchase(quickbooks: any, purchase: any): Promise<any | null> {
  const account = purchase?.AccountRef?.value;
  if (!account) return null;
  const sameAccountAndPayee = (existing: any) =>
    String(existing.AccountRef?.value) === String(account) && samePayee(existing.EntityRef, purchase.EntityRef);

  if (purchase.DocNumber) {
    const response = await find(quickbooks, "findPurchases", [
      { field: "DocNumber", value: String(purchase.DocNumber), operator: "=" },
    ]);
    const purchases: any[] = response.QueryResponse.Purchase || [];
    return purchases.find(sameAccountAndPayee) || null;
  }

  const response = await find(quickbooks, "findPurchases", [
    ...dateWindow(purchase.TxnDate),
    { field: "limit", value: PURCHASE_CANDIDATE_LIMIT },
  ]);
  const purchases: any[] = response.QueryResponse.Purchase || [];
  const ours = expenseLinesCents(purchase.Line);
  const match = purchases.find(
    (existing) =>
      sameAccountAndPayee(existing) &&
      existing.PaymentType === purchase.PaymentType &&
      Boolean(existing.Credit) === Boolean(purchase.Credit) &&
      Math.abs(expenseLinesCents(existing.Line) - ours) <= 1
  );
  return match || null;
}

/** The parties a refusal names, in order, when the record has them. */
const PARTY_REFS: Array<[string, string]> = [
  ["CustomerRef", "customer"],
  ["VendorRef", "vendor"],
  ["EntityRef", "payee"],
  ["AccountRef", "account"],
];

/** One-line description of an existing record, for the refusal message. */
export function describeHit(kind: string, hit: any): string {
  const number = hit.DocNumber || hit.PaymentRefNum || "n/a";
  const parties = PARTY_REFS.filter(([key]) => hit[key]).map(
    ([key, label]) => `, ${label} ${hit[key].name || hit[key].value}`
  );
  return `${kind} already exists: Id ${hit.Id}, #${number}, $${hit.TotalAmt}, ${hit.TxnDate}${parties.join("")}.`;
}
