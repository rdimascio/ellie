import type { DecisionQuestion, DecisionRequest } from "./index.ts";

export const MAX_REQUEST_BYTES = 256 * 1024;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 15_000;

class DecisionHttpError extends Error {}

export function timeout(value: number | undefined): number {
  const result = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(result) || result < 1 || result > 120_000)
    throw new Error("Invalid decision timeout");
  return result;
}

export function validateRequest(request: DecisionRequest): void {
  if (!request || !(request.signal instanceof AbortSignal) || request.signal.aborted)
    throw new Error("Decision request cancelled");
  const questions = request.questions;
  if (
    !questions ||
    typeof questions !== "object" ||
    Array.isArray(questions) ||
    Object.keys(questions).length === 0 ||
    Object.keys(questions).length > 32
  )
    throw new Error("Invalid decision request");
  for (const [id, question] of Object.entries(questions)) {
    if (
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(id) ||
      !question ||
      typeof question !== "object" ||
      typeof question.instructions !== "string" ||
      !question.instructions.trim() ||
      question.instructions.length > 4_096
    )
      throw new Error("Invalid decision request");
    if (question.type === "choice") {
      const criteria = question.criteria;
      if (
        !criteria ||
        typeof criteria !== "object" ||
        Array.isArray(criteria) ||
        Object.keys(criteria).length < 2 ||
        Object.keys(criteria).length > 255 ||
        Object.entries(criteria).some(
          ([name, description]) =>
            !name ||
            name.length > 128 ||
            (description !== null &&
              (typeof description !== "string" || description.length > 4_096)),
        )
      )
        throw new Error("Invalid decision request");
    } else if (question.type === "score") {
      if (
        !Array.isArray(question.criteria) ||
        question.criteria.length < 2 ||
        question.criteria.length > 255 ||
        question.criteria.some(
          (level) => typeof level !== "string" || !level.trim() || level.length > 4_096,
        )
      )
        throw new Error("Invalid decision request");
    } else if (question.type !== "noul") {
      throw new Error("Invalid decision request");
    }
  }
}

export function jsonBody(value: unknown): string {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw new Error("Invalid decision request");
  }
  if (typeof body !== "string" || Buffer.byteLength(body) > MAX_REQUEST_BYTES)
    throw new Error("Decision request too large");
  return body;
}

/** Explicit race covers injected fetch implementations that ignore AbortSignal. */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: string,
  requestSignal: AbortSignal,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const controller = new AbortController();
  let rejectAbort!: (reason: Error) => void;
  const abort = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => {
    controller.abort();
    rejectAbort(new DecisionHttpError("Decision request cancelled"));
  };
  requestSignal.addEventListener("abort", onAbort, { once: true });
  if (requestSignal.aborted) onAbort();
  const timer = setTimeout(() => {
    controller.abort();
    rejectAbort(new DecisionHttpError("Decision request timed out"));
  }, timeoutMs);
  try {
    const task = (async (): Promise<unknown> => {
      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
        redirect: "manual",
      });
      const discardBody = (): void => {
        if (response.body) void response.body.cancel().catch(() => {});
      };
      if (controller.signal.aborted) {
        discardBody();
        throw new DecisionHttpError("Decision request cancelled");
      }
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        discardBody();
        throw new DecisionHttpError("Decision endpoint redirected");
      }
      if (!response.ok) {
        discardBody();
        const status =
          Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
            ? response.status
            : 0;
        throw new DecisionHttpError(`Decision endpoint returned HTTP ${status}`);
      }
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null && Number(contentLength) > MAX_RESPONSE_BYTES) {
        discardBody();
        throw new DecisionHttpError("Decision response too large");
      }
      if (!response.body) throw new DecisionHttpError("Invalid decision response");
      const reader = response.body.getReader();
      const cancelRead = (): void => {
        void reader.cancel().catch(() => {});
      };
      controller.signal.addEventListener("abort", cancelRead, { once: true });
      if (controller.signal.aborted) cancelRead();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_RESPONSE_BYTES) throw new DecisionHttpError("Decision response too large");
          chunks.push(value);
        }
      } finally {
        controller.signal.removeEventListener("abort", cancelRead);
        cancelRead();
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new DecisionHttpError("Invalid decision response");
      }
    })();
    // The task's rejection is observed by Promise.race even after abort wins.
    return await Promise.race([task, abort]);
  } catch (error) {
    if (error instanceof DecisionHttpError) throw error;
    throw new Error("Decision endpoint failed");
  } finally {
    clearTimeout(timer);
    requestSignal.removeEventListener("abort", onAbort);
  }
}

export function serializeQuestions(
  questions: Record<string, DecisionQuestion>,
): Record<string, DecisionQuestion> {
  return questions;
}
