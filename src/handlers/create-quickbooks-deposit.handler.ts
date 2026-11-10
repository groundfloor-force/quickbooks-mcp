import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";

export interface CreateDepositInput {
  deposit_to_account_ref: string;
  line_items: Array<{
    amount: number;
    account_ref?: string;
    entity_ref?: { type: string; value: string };
    description?: string;
    payment_id?: string;
    linked_txn?: { txn_id: string; txn_type: string; txn_line_id?: string };
  }>;
  txn_date?: string;
  private_note?: string;
}

type DepositLine = CreateDepositInput["line_items"][number];
type LinkedTxn = { TxnId: string; TxnType: string; TxnLineId: string };

/** Undeposited Funds is recognised by its account name, matched case-insensitively. */
const isUndepositedFunds = (line: any): boolean =>
  /undeposited funds/i.test(String(line.JournalEntryLineDetail?.AccountRef?.name));

/**
 * The Id of a journal entry's one Undeposited Funds line, which is the line a deposit links to.
 * None, or more than one, is for the caller to settle with txn_line_id; the error lists the lines.
 */
async function undepositedFundsLineId(
  quickbooks: any,
  journalEntryId: string
): Promise<{ id: string } | { error: string }> {
  const journalEntry: any = await new Promise((resolve, reject) => {
    quickbooks.getJournalEntry(journalEntryId, (err: any, entity: any) => (err ? reject(err) : resolve(entity)));
  });
  const lines: any[] = Array.isArray(journalEntry.Line) ? journalEntry.Line : [];
  const undeposited = lines.filter(isUndepositedFunds);
  if (undeposited.length === 1) return { id: String(undeposited[0].Id) };

  const listed = lines
    .map((line) => {
      const account = line.JournalEntryLineDetail?.AccountRef;
      return `${line.Id}: ${account?.name ?? account?.value} ${line.Amount}`;
    })
    .join(", ");
  return {
    error:
      `Journal entry ${journalEntryId} has ${undeposited.length} Undeposited Funds lines; pass txn_line_id. ` +
      `Lines: ${listed || "none"}.`,
  };
}

/**
 * The LinkedTxn for a line that links a transaction (payment_id or linked_txn), null for an
 * account line, or an error for the caller. TxnLineId is "0" unless given, except a JournalEntry,
 * whose Undeposited Funds line is looked up.
 */
async function linkedTxnFor(quickbooks: any, l: DepositLine): Promise<{ txn: LinkedTxn } | { error: string } | null> {
  if (l.payment_id) return { txn: { TxnId: l.payment_id, TxnType: "Payment", TxnLineId: "0" } };
  const link = l.linked_txn;
  if (!link) return null;
  if (link.txn_line_id !== undefined || link.txn_type !== "JournalEntry") {
    return { txn: { TxnId: link.txn_id, TxnType: link.txn_type, TxnLineId: link.txn_line_id ?? "0" } };
  }
  const resolved = await undepositedFundsLineId(quickbooks, link.txn_id);
  if ("error" in resolved) return resolved;
  return { txn: { TxnId: link.txn_id, TxnType: "JournalEntry", TxnLineId: resolved.id } };
}

export async function createQuickbooksDeposit(data: CreateDepositInput): Promise<ToolResponse<any>> {
  try {
    const quickbooks = await QuickbooksClient.getInstance();

    // One line at a time: a JournalEntry line may need a read, and any refusal stops before creating.
    const lines: any[] = [];
    for (const [idx, l] of data.line_items.entries()) {
      const linked = await linkedTxnFor(quickbooks, l);
      if (linked && "error" in linked) {
        return { result: null, isError: true, error: linked.error };
      }
      lines.push(
        linked
          ? {
              // Linked line: pulls a transaction sitting in Undeposited Funds into this
              // deposit. Carries LinkedTxn only — no DetailType/DepositLineDetail.
              Id: `${idx + 1}`,
              Amount: l.amount,
              Description: l.description,
              LinkedTxn: [linked.txn],
            }
          : {
              Id: `${idx + 1}`,
              Amount: l.amount,
              Description: l.description,
              DetailType: "DepositLineDetail",
              DepositLineDetail: {
                AccountRef: l.account_ref ? { value: l.account_ref } : undefined,
                Entity: l.entity_ref ? { Type: l.entity_ref.type, EntityRef: { value: l.entity_ref.value } } : undefined,
              },
            }
      );
    }

    const payload: any = {
      DepositToAccountRef: { value: data.deposit_to_account_ref },
      Line: lines,
    };

    if (data.txn_date) payload.TxnDate = data.txn_date;
    if (data.private_note) payload.PrivateNote = data.private_note;

    return new Promise((resolve) => {
      (quickbooks as any).createDeposit(payload, (err: any, created: any) => {
        if (err) resolve({ result: null, isError: true, error: formatError(err) });
        else resolve({ result: created, isError: false, error: null });
      });
    });
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}

