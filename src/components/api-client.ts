// Small fetch wrapper for the browser: JSON in, JSON out, typed error.
export class ApiError extends Error {
  code: string;
  status: number;
  details?: unknown;
  constructor(code: string, status: number, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export async function apiCall<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiError(e.code ?? "HTTP_ERROR", res.status, e.message ?? `Request failed (${res.status}).`, e.details);
  }
  return data as T;
}
