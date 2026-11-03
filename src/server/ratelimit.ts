// Small in-memory sliding-window limiter (per server instance). Good enough to slow down
// password guessing and runaway AI calls in the demo; use a shared store (e.g. Redis) at scale.
const buckets = new Map<string, number[]>();

export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()) {
  const recent = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    buckets.set(key, recent);
    return { ok: false as const, retryAfterSec: Math.ceil((windowMs - (now - recent[0])) / 1000) };
  }
  recent.push(now);
  buckets.set(key, recent);
  if (buckets.size > 10_000) {
    for (const [k, v] of buckets) if (!v.some((t) => now - t < windowMs)) buckets.delete(k);
  }
  return { ok: true as const, retryAfterSec: 0 };
}

/** Checks whether the key is currently over its limit without recording a hit. */
export function peekRateLimit(key: string, limit: number, windowMs: number, now = Date.now()) {
  const recent = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  return recent.length >= limit
    ? { ok: false as const, retryAfterSec: Math.ceil((windowMs - (now - recent[0])) / 1000) }
    : { ok: true as const, retryAfterSec: 0 };
}

export function resetRateLimit(key: string) {
  buckets.delete(key);
}

export function clientIp(req: Request) {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";
}
