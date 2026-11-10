/**
 * Invoice line amounts may be negative (a staff adjustment) or zero. An invoice as a whole may not
 * total below zero: that is money owed TO the customer, which is a credit memo, not an invoice.
 * Totals are summed in cents so float noise cannot turn a zero total negative. Tax is left out: on a
 * non-negative line total it cannot make the invoice negative.
 */

const toCents = (n: number): number => Math.round(n * 100);

/** create_invoice: the sum of qty x unit_price over the lines, in cents. */
export function createLinesTotalCents(lines: Array<{ qty: number; unit_price: number }>): number {
  return lines.reduce((sum, l) => sum + toCents(Number(l.qty) * Number(l.unit_price)), 0);
}

/**
 * update_invoice: the line total of a patch's Line array, in cents. Sales lines count at Amount (or
 * Qty x UnitPrice when Amount is absent); discount lines reduce it; subtotal and other lines are ignored.
 */
export function patchLinesTotalCents(lines: any[]): number {
  let total = 0;
  for (const l of lines) {
    if (l?.DetailType === "SalesItemLineDetail") {
      const amount =
        typeof l.Amount === "number"
          ? l.Amount
          : Number(l.SalesItemLineDetail?.Qty ?? 0) * Number(l.SalesItemLineDetail?.UnitPrice ?? 0);
      total += toCents(amount);
    } else if (l?.DetailType === "DiscountLineDetail") {
      total -= toCents(Math.abs(Number(l.Amount ?? 0)));
    }
  }
  return total;
}

/** The refusal for a total below zero, or null when the total is zero or more. */
export function belowZeroError(totalCents: number): string | null {
  if (totalCents >= 0) return null;
  return (
    `Invoice total would be below zero (${(totalCents / 100).toFixed(2)}). ` +
    "A line may be negative, but an invoice cannot total less than zero; use a credit memo for money owed to the customer."
  );
}
