import type { UiError } from "./types";

export class UiAbortError extends Error {
  constructor() {
    super("请求已取消。");
    this.name = "UiAbortError";
  }
}

export async function readJson<T>(res: Response): Promise<T> {
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (!contentType.includes("application/json")) {
    const snippet = text.slice(0, 200);
    if (text.startsWith("<!DOCTYPE") || text.startsWith("<html")) {
      throw { message: `后端服务未就绪（收到 HTML 页面而非 JSON 数据）。请确认后端服务已启动且端口 8000 可访问。`, code: "backend_unavailable", retryable: true, snippet };
    }
    throw { message: `后端返回了非 JSON 响应 (${contentType || "未知类型"})，请检查后端服务。`, code: "bad_response", retryable: true, snippet };
  }
  let payload: unknown = null;
  try {
    if (text) payload = JSON.parse(text);
  } catch {
    throw { message: "后端返回了无法解析的数据，请重试。", code: "parse_error", retryable: true };
  }
  if (!res.ok) {
    const detail = (payload as Record<string, unknown> | null)?.detail;
    if (typeof detail === "object" && detail !== null && "message" in detail) {
      const d = detail as { message?: unknown; code?: unknown; retryable?: unknown };
      throw { message: String(d.message || "请求失败"), code: typeof d.code === "string" ? d.code : undefined, retryable: d.retryable !== false };
    }
    if (Array.isArray(detail)) {
      const first = (detail as Array<{ loc?: unknown; msg?: unknown }>)[0];
      const field = Array.isArray(first?.loc) ? (first.loc as unknown[]).filter((item) => item !== "body").join(".") : "";
      const reason = first?.msg ? String(first.msg) : "请求参数不合法";
      throw { message: field ? `${field}: ${reason}` : reason, code: "validation_failed", retryable: false };
    }
    throw { message: typeof detail === "string" ? detail : `请求失败 (HTTP ${res.status})`, retryable: true };
  }
  if (!payload) {
    throw { message: "后端返回了空响应，请重试。", retryable: true };
  }
  return payload as T;
}

export function toUiError(err: unknown): UiError {
  // AbortError from a cancelled fetch should surface as a benign
  // message, not a "请求失败" banner. The hook layer also checks for
  // this and skips the state update entirely.
  if (err instanceof Error && err.name === "AbortError") {
    return { message: "请求已取消。", code: "aborted", retryable: false };
  }
  if (err instanceof UiAbortError) {
    return { message: err.message, code: "aborted", retryable: false };
  }
  if (typeof err === "object" && err !== null && "message" in err) {
    const shaped = err as { message?: unknown; code?: unknown; retryable?: unknown };
    return {
      message: String(shaped.message || "请求失败"),
      code: typeof shaped.code === "string" ? shaped.code : undefined,
      retryable: shaped.retryable !== false,
    };
  }
  return { message: "请求失败", retryable: true };
}
