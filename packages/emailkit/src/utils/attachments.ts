import type { Attachment } from "../types";
import { mapWithConcurrency } from "./concurrency";

const ATTACHMENT_FETCH_CONCURRENCY = 8;

export const isAbortError = (error: unknown, signal?: AbortSignal): boolean =>
  signal?.aborted === true ||
  (error instanceof Error && error.name === "AbortError");

export const retrieveAttachmentsInParallel = async ({
  attachments,
  signal,
  retrieve,
  onError,
}: {
  attachments: Attachment[];
  signal?: AbortSignal;
  retrieve: (attachment: Attachment, index: number) => Promise<Attachment>;
  onError?: (attachment: Attachment, error: unknown, index: number) => void;
}): Promise<Attachment[]> =>
  mapWithConcurrency(
    attachments,
    ATTACHMENT_FETCH_CONCURRENCY,
    async (attachment, index) => {
      try {
        return await retrieve(attachment, index);
      } catch (error) {
        if (isAbortError(error, signal)) throw error;
        onError?.(attachment, error, index);
        return attachment;
      }
    },
  );
