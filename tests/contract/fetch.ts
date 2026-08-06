/**
 * Общая сетевая обвязка контрактных тестов: ретраи на транзиентных статусах,
 * таймаут, sha256. Вынесена из site-contract.test.ts, когда семантическим
 * контрактам (site-semantics, site-ssr-api) понадобилась та же логика.
 */
import { createHash } from "node:crypto";

export const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export class TransientNetworkError extends Error {}

export type Download = { text: string; sha256: string; bytes: number };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithRetry(url: string, attempts = 3): Promise<Response> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "application/javascript, application/json, text/plain, */*" },
      });
      if (!RETRYABLE.has(response.status)) return response;
      last = new TransientNetworkError(`${url}: HTTP ${response.status}`);
    } catch (error) {
      last = error;
    } finally {
      clearTimeout(timer);
    }
    if (attempt + 1 < attempts) await sleep(400 * 2 ** attempt);
  }
  throw new TransientNetworkError(`${url}: unavailable after ${attempts} attempts (${String(last)})`);
}

export async function download(url: string): Promise<Download> {
  const response = await fetchWithRetry(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    text: new TextDecoder().decode(bytes),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
  };
}

export async function json(url: string): Promise<{ response: Response; body: unknown }> {
  const response = await fetchWithRetry(url);
  if (!response.ok) return { response, body: null };
  const body = await response.json();
  return { response, body };
}
