import https from "https";
import { createReadStream } from "fs";
import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { formatError } from "./format-error.js";
import { inferContentType } from "./attachable-file-source.js";

// QBO Attachable upload — file types accepted by the QBO /upload endpoint.
// Source: developer.intuit.com Attachable API reference (16 unique MIME types
// covering 17 documented file extensions; .ai and .eps both map to
// application/postscript).
//
// Two entries deviate from RFC standards but match QBO's documented spec
// literally — keep them so payloads round-trip without QBO rejecting them:
//   - image/jpg  (RFC standard is image/jpeg; QBO accepts both)
//   - image/tif  (RFC standard is image/tiff; QBO accepts both)
//
// One entry is corrected from a documentation typo:
//   - QBO docs list application/vnd/ms-excel for .xls. A forward slash in a
//     MIME subtype is invalid per RFC 6838. We use the correct form here.
export const ALLOWED_UPLOAD_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "application/postscript",          // .ai, .eps
  "text/csv",                        // .csv
  "application/msword",              // .doc
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "image/gif",                       // .gif
  "image/jpeg",                      // .jpeg
  "image/jpg",                       // .jpg
  "application/vnd.oasis.opendocument.spreadsheet", // .ods
  "application/pdf",                 // .pdf
  "image/png",                       // .png
  "text/rtf",                        // .rtf
  "image/tif",                       // .tif
  "text/plain",                      // .txt
  "application/vnd.ms-excel",        // .xls
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "text/xml",                        // .xml
]);

// QBO documents a 100 MB per-request cap on /upload. We enforce client-side
// BEFORE allocating Buffer.from(base64) so an unbounded base64 string cannot
// be decoded into memory.
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

// The file part of the multipart body: either bytes already in memory
// (base64 path) or a local file streamed from disk (file_path / file_url,
// the latter spooled to a temp file by the fetch helper).
export type UploadFileSource = { buffer: Buffer } | { path: string; size: number };

/** The refusal for a content type QBO's /upload does not accept. */
export function unsupportedContentType(contentType: string): string {
  return `Unsupported content_type "${contentType}". Allowed: ${[...ALLOWED_UPLOAD_CONTENT_TYPES].sort().join(", ")}`;
}

// Approximate decoded size of a base64 string without decoding it. base64
// expands 3 bytes -> 4 chars; subtract padding to get the decoded length.
function approximateDecodedSize(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/** The type a base64 file is sent as: the caller's, else inferred from file_name. */
function base64ContentType(input: { file_name: string; content_type?: string }): string {
  return input.content_type ?? inferContentType(input.file_name) ?? "application/octet-stream";
}

/**
 * Why a base64 file cannot be uploaded (a type QBO does not accept, or over 100 MB), or null
 * when it can. Checked without decoding, so it is cheap to run before anything else happens.
 */
export function base64AttachmentProblem(input: {
  file_name: string;
  base64_content: string;
  content_type?: string;
}): string | null {
  const contentType = base64ContentType(input);
  if (!ALLOWED_UPLOAD_CONTENT_TYPES.has(contentType)) {
    return unsupportedContentType(contentType);
  }
  const approxSize = approximateDecodedSize(input.base64_content);
  if (approxSize > MAX_UPLOAD_BYTES) {
    return `File too large: approximately ${approxSize} bytes exceeds QBO's ${MAX_UPLOAD_BYTES} byte (100 MB) upload limit.`;
  }
  return null;
}

/** Decodes base64 content that base64AttachmentProblem has already passed. */
export function decodeBase64Attachment(base64: string): Buffer {
  const fileBuffer = Buffer.from(base64, "base64");
  /* istanbul ignore next — defensive: the approxSize check already
     rejects oversized input; this guards only the malformed-base64 edge
     case where decoded length unexpectedly exceeds the approximation. */
  if (fileBuffer.length > MAX_UPLOAD_BYTES) {
    throw new Error(
      `File too large: ${fileBuffer.length} bytes exceeds QBO's ${MAX_UPLOAD_BYTES} byte (100 MB) upload limit.`
    );
  }
  return fileBuffer;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\r\n"\\]/g, "_");
}

// Map a status code to a user-safe error message. The raw QBO response body
// can include realm IDs, internal trace identifiers, and other detail that
// should not be returned to an MCP client — the LLM has no business seeing
// internal QBO error envelopes. Raw bodies are still logged server-side for
// operator debugging.
function redactedUploadError(statusCode: number | undefined): string {
  if (!statusCode) return "QBO upload failed: network error";
  if (statusCode === 401 || statusCode === 403) return `QBO upload failed (${statusCode}): authentication or authorization error`;
  if (statusCode === 413) return `QBO upload failed (${statusCode}): payload too large`;
  if (statusCode >= 400 && statusCode < 500) return `QBO upload failed (${statusCode}): client error`;
  if (statusCode >= 500) return `QBO upload failed (${statusCode}): QBO server error`;
  /* istanbul ignore next — defensive: <400 status codes never reach this function */
  return `QBO upload failed (${statusCode}): unexpected status`;
}

// Raw multipart/form-data POST to /v3/company/{realmId}/upload. node-quickbooks
// does not wrap this endpoint, so we construct the request manually.
//
// QBO supports multi-file uploads in a single request, but this sends
// exactly one file per request — single-file covers the 99% MCP/LLM case and
// multi-file would require a different input schema. Out of scope here.
//
// Resolves with QBO's parsed response. A per-file Fault inside a 200 response
// (AttachableResponse[0].Fault) is a failure: QBO stored nothing.
export async function postAttachableUpload(
  file: UploadFileSource,
  metadata: Record<string, unknown>
): Promise<any> {
  const { accessToken, realmId, isSandbox } = await QuickbooksClient.getAuthCredentials();
  const boundary = `----QBOBoundary${Date.now()}`;
  const metadataJson = JSON.stringify(metadata);
  const fileName = sanitizeFilename(metadata.FileName as string);
  const contentType = metadata.ContentType as string;

  const preamble = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file_metadata_01"\r\n` +
      `Content-Type: application/json\r\n` +
      `\r\n` +
      `${metadataJson}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file_content_01"; filename="${fileName}"\r\n` +
      `Content-Type: ${contentType}\r\n` +
      `\r\n`
  );
  const closer = Buffer.from(`\r\n--${boundary}--\r\n`);
  // Exact Content-Length lets us stream the file part without chunked
  // transfer encoding, which the QBO endpoint does not reliably accept.
  const fileSize = "buffer" in file ? file.buffer.length : file.size;
  const contentLength = preamble.length + fileSize + closer.length;

  const host = isSandbox
    ? "sandbox-quickbooks.api.intuit.com"
    : "quickbooks.api.intuit.com";
  const requestPath = `/v3/company/${realmId}/upload`;

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: host,
        path: requestPath,
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": contentLength,
          Accept: "application/json",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const responseText = Buffer.concat(chunks).toString("utf-8");
          if (res.statusCode && res.statusCode >= 400) {
            console.error(`[qbo-attachable-upload] QBO ${res.statusCode}: ${responseText}`);
            reject(new Error(redactedUploadError(res.statusCode)));
            return;
          }
          let parsed: any;
          try {
            parsed = JSON.parse(responseText);
          } catch {
            console.error(`[qbo-attachable-upload] QBO ${res.statusCode} non-JSON: ${responseText}`);
            reject(new Error(redactedUploadError(res.statusCode)));
            return;
          }
          const fault = parsed?.AttachableResponse?.[0]?.Fault;
          if (fault) {
            console.error(`[qbo-attachable-upload] QBO ${res.statusCode} per-file fault: ${responseText}`);
            // formatError scrubs the fault's Detail; drop its "Error: " prefix, which the
            // caller's own formatError adds back.
            reject(new Error(formatError({ Fault: fault }).replace(/^Error: /, "")));
            return;
          }
          resolve(parsed);
        });
      }
    );
    req.on("error", (err) => {
      console.error(`[qbo-attachable-upload] network error: ${err.message}`);
      reject(new Error(redactedUploadError(undefined)));
    });

    req.write(preamble);
    if ("buffer" in file) {
      req.write(file.buffer);
      req.write(closer);
      req.end();
    } else {
      // Stream the file part from disk — memory stays flat for large files.
      // The read is bounded to the stat'ed size so a file that GROWS between
      // stat and read cannot overrun the declared Content-Length; a file that
      // SHRINKS is caught by the bytesRead check below.
      const readStream = createReadStream(file.path, { end: file.size - 1 });
      /* istanbul ignore next — defensive: fires only on network failure
         mid-stream; prevents the unpiped read stream from leaking its fd. */
      req.on("error", () => readStream.destroy());
      /* istanbul ignore next — defensive: the file was stat'ed moments ago;
         this fires only if it vanishes or the disk errors mid-read. */
      readStream.on("error", (err) => {
        console.error(`[qbo-attachable-upload] file read error: ${err.message}`);
        req.destroy(err);
        reject(new Error(`Failed reading file for upload: ${err.message}`));
      });
      readStream.pipe(req, { end: false });
      readStream.on("end", () => {
        /* istanbul ignore next — defensive: file truncated between stat and
           read; without this check QBO would wait for bytes that never come. */
        if (readStream.bytesRead !== file.size) {
          req.destroy();
          reject(
            new Error(
              `File changed during upload: read ${readStream.bytesRead} of ${file.size} expected bytes.`
            )
          );
          return;
        }
        req.write(closer);
        req.end();
      });
    }
  });
}

export interface Base64AttachmentInput {
  file_name: string;
  base64_content: string;
  content_type?: string;
  note?: string;
  category?: string;
  /** The QBO record the file is linked to. */
  entity?: { type: string; value: string; include_on_send?: boolean };
}

/**
 * Uploads a base64 file to QBO, linked to `entity` when given, and returns the new Attachable's
 * id with QBO's raw response. Throws on any failure: an unsupported type or oversized file
 * (before any request), the fixed redacted upload messages, a per-file fault, or a response
 * without an Attachable id.
 */
export async function uploadBase64Attachment(
  input: Base64AttachmentInput
): Promise<{ attachable_id: string; raw: any }> {
  const problem = base64AttachmentProblem(input);
  if (problem) {
    throw new Error(problem);
  }

  const metadata: Record<string, unknown> = {
    FileName: input.file_name,
    ContentType: base64ContentType(input),
  };
  if (input.note) metadata.Note = input.note;
  if (input.category) metadata.Category = input.category;
  if (input.entity) {
    const ref: Record<string, unknown> = {
      EntityRef: { type: input.entity.type, value: input.entity.value },
    };
    if (typeof input.entity.include_on_send === "boolean") {
      ref.IncludeOnSend = input.entity.include_on_send;
    }
    metadata.AttachableRef = [ref];
  }

  const raw = await postAttachableUpload({ buffer: decodeBase64Attachment(input.base64_content) }, metadata);
  const id = raw?.AttachableResponse?.[0]?.Attachable?.Id;
  if (!id) {
    throw new Error("QBO upload returned no Attachable id");
  }
  return { attachable_id: String(id), raw };
}

/** The optional `attachment` on create-bill and create_purchase. */
export interface NewRecordAttachment {
  file_name: string;
  base64_content: string;
  content_type?: string;
  note?: string;
  include_on_send?: boolean;
}

/**
 * Uploads `attachment` linked to a record that was just created, and reports the outcome as the
 * record's `_attachment`. Never throws: the record exists either way, so a failed upload is
 * returned as an error message telling the caller how to attach the file separately.
 */
export async function attachToNewRecord(
  entityType: "Bill" | "Purchase",
  id: string,
  attachment: NewRecordAttachment
): Promise<{ attachable_id: string } | { error: string }> {
  try {
    const { attachable_id } = await uploadBase64Attachment({
      file_name: attachment.file_name,
      base64_content: attachment.base64_content,
      content_type: attachment.content_type,
      note: attachment.note,
      entity: { type: entityType, value: id, include_on_send: attachment.include_on_send },
    });
    return { attachable_id };
  } catch (e) {
    return {
      error:
        `${entityType} ${id} was created but the attachment failed: ${formatError(e)}. ` +
        `Attach it with create_attachable (entity_ref_type ${entityType}, entity_ref_value ${id}).`,
    };
  }
}
