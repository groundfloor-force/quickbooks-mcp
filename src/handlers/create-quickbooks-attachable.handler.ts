import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import {
  fetchUrlToTempFile,
  inferContentType,
  resolveLocalFile,
} from "../helpers/attachable-file-source.js";
import {
  ALLOWED_UPLOAD_CONTENT_TYPES,
  MAX_UPLOAD_BYTES,
  base64AttachmentProblem,
  decodeBase64Attachment,
  postAttachableUpload,
  unsupportedContentType,
  type UploadFileSource,
} from "../helpers/attachable-upload.js";

export interface CreateAttachableInput {
  file_name: string;
  note?: string;
  category?: string;
  content_type?: string;
  base64_content?: string;
  file_path?: string;
  file_url?: string;
  attachable_ref?: {
    entity_ref_type: string;
    entity_ref_value: string;
    include_on_send?: boolean;
  };
}

export async function createQuickbooksAttachable(
  data: CreateAttachableInput
): Promise<ToolResponse<any>> {
  try {
    // Build payload — same shape whether or not we're uploading binary content.
    const payload: Record<string, unknown> = { FileName: data.file_name };
    if (data.note) payload.Note = data.note;
    if (data.category) payload.Category = data.category;
    if (data.content_type) payload.ContentType = data.content_type;
    if (data.attachable_ref) {
      const entityRef: Record<string, unknown> = {
        EntityRef: {
          type: data.attachable_ref.entity_ref_type,
          value: data.attachable_ref.entity_ref_value,
        },
      };
      if (typeof data.attachable_ref.include_on_send === "boolean") {
        entityRef.IncludeOnSend = data.attachable_ref.include_on_send;
      }
      payload.AttachableRef = [entityRef];
    }

    // ── Binary upload path ────────────────────────────────────────────────
    // Source precedence: file_url / file_path (mutually exclusive) win over
    // base64_content; base64_content alone preserves the original behavior.
    if (data.file_url && data.file_path) {
      return {
        result: null,
        isError: true,
        error: "Provide either file_url or file_path, not both.",
      };
    }

    const hasFileSource = Boolean(data.file_url || data.file_path || data.base64_content);
    if (hasFileSource) {
      // Resolve the file source first (cheap, no auth), then validate type.
      let fileSource: UploadFileSource;
      let fetchedContentType: string | null = null;
      let cleanup: (() => Promise<void>) | null = null;

      if (data.file_url) {
        const fetched = await fetchUrlToTempFile(data.file_url, MAX_UPLOAD_BYTES);
        fileSource = { path: fetched.path, size: fetched.size };
        fetchedContentType = fetched.contentTypeHeader;
        cleanup = fetched.cleanup;
      } else if (data.file_path) {
        const local = await resolveLocalFile(data.file_path, MAX_UPLOAD_BYTES);
        fileSource = { path: local.path, size: local.size };
      } else {
        // base64 path — validate the content type and size BEFORE decoding, so
        // an unsupported type or oversized input is rejected without allocating
        // the decoded buffer (same error precedence as the original implementation).
        const problem = base64AttachmentProblem({
          file_name: data.file_name,
          base64_content: data.base64_content!,
          content_type: data.content_type,
        });
        if (problem) {
          return { result: null, isError: true, error: problem };
        }
        fileSource = { buffer: decodeBase64Attachment(data.base64_content!) };
      }

      try {
        // Content type: explicit override > inferred from file_name /
        // file_path / file_url PATH extension (query strings excluded so
        // '?file=x.pdf' can't spoof the type). The URL's Content-Type header
        // is deliberately not trusted as-is — servers routinely send
        // octet-stream — but a QBO-supported header value (case-insensitive
        // per RFC 2045) is accepted as a last resort.
        const urlPathname = data.file_url ? new URL(data.file_url).pathname : undefined;
        const headerToken = fetchedContentType
          ? fetchedContentType.split(";")[0].trim().toLowerCase()
          : null;
        const effectiveContentType =
          data.content_type ??
          inferContentType(data.file_name, data.file_path, urlPathname) ??
          (headerToken && ALLOWED_UPLOAD_CONTENT_TYPES.has(headerToken) ? headerToken : null) ??
          "application/octet-stream";
        if (!ALLOWED_UPLOAD_CONTENT_TYPES.has(effectiveContentType)) {
          return {
            result: null,
            isError: true,
            error: unsupportedContentType(effectiveContentType),
          };
        }
        payload.ContentType = effectiveContentType;

        const uploadResult = await postAttachableUpload(fileSource, payload);
        return { result: uploadResult, isError: false, error: null };
      } finally {
        if (cleanup) await cleanup();
      }
    }

    // ── Metadata-only path (preserved behavior, post-#41 auth) ────────────
    const quickbooks = await QuickbooksClient.getInstance();
    return new Promise((resolve) => {
      (quickbooks as any).createAttachable(payload, (err: any, created: any) => {
        if (err) resolve({ result: null, isError: true, error: formatError(err) });
        else resolve({ result: created, isError: false, error: null });
      });
    });
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}
