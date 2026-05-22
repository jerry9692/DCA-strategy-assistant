import type { UiError } from "./types";

export async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  const payload = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const detail = payload?.detail;
    if (typeof detail === "object" && detail?.message) {
      throw { message: detail.message, code: detail.code, retryable: Boolean(detail.retryable) };
    }
    if (Array.isArray(detail)) {
      const first = detail[0];
      const field = Array.isArray(first?.loc) ? first.loc.filter((item: unknown) => item !== "body").join(".") : "";
      const reason = first?.msg ? String(first.msg) : "请求参数不合法";
      throw { message: field ? `${field}: ${reason}` : reason, code: "validation_failed", retryable: false };
    }
    throw { message: typeof detail === "string" ? detail : "请求失败", retryable: true };
  }
  if (!payload) {
    throw { message: "后端返回了空响应，请重试。", retryable: true };
  }
  return payload as T;
}

export function toUiError(err: unknown): UiError {
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
