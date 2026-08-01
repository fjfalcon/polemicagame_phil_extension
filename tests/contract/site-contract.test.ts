import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import phaseFixture from "../fixtures/phase-labels.ru.json";
import siteFixture from "../fixtures/site-contract.json";
import { SITE, TEXT, classifyPhaseText } from "@core/selectors";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const UPDATE_FIXTURES = process.env.UPDATE_CONTRACT_FIXTURES === "1";
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

type BundleKey = keyof typeof siteFixture.bundles;
type Download = { text: string; sha256: string; bytes: number };

class TransientNetworkError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, attempts = 3): Promise<Response> {
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

async function download(url: string): Promise<Download> {
  const response = await fetchWithRetry(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    text: new TextDecoder().decode(bytes),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
  };
}

async function json(url: string): Promise<{ response: Response; body: unknown }> {
  const response = await fetchWithRetry(url);
  if (!response.ok) return { response, body: null };
  const body = await response.json();
  return { response, body };
}

function classesFromSelector(selector: string): string[] {
  return [...selector.matchAll(/\.(-?[_a-zA-Z]+[\w-]*)/g)].map((match) => match[1]);
}

function stringLiterals(source: string): string[] {
  const values: string[] = [];
  for (const match of source.matchAll(/(["'])(?:\\.|(?!\1)[^\\])*\1/g)) {
    const raw = match[0];
    try {
      values.push(raw[0] === '"' ? JSON.parse(raw) : raw.slice(1, -1).replace(/\\'/g, "'"));
    } catch {
      // A malformed/dynamic literal is irrelevant to exact locale contracts.
    }
  }
  return values;
}

function localeEntries(source: string): Map<string, string[]> {
  const entries = new Map<string, string[]>();
  const pair = /(?:^|[,{])\s*(?:([A-Za-z_][\w]*)|["']([^"']+)["'])\s*:\s*(["'])((?:\\.|(?!\3).)*)\3/g;
  for (const match of source.matchAll(pair)) {
    const key = match[1] || match[2];
    const quote = match[3];
    let value = match[4];
    try {
      value = quote === '"' ? JSON.parse(`"${value}"`) : value.replace(/\\'/g, "'");
    } catch {
      continue;
    }
    const list = entries.get(key) ?? [];
    list.push(value);
    entries.set(key, list);
  }
  return entries;
}

function expectArrayOfObjects(value: unknown, label: string): asserts value is Record<string, unknown>[] {
  expect(Array.isArray(value), `${label}: expected an array`).toBe(true);
  expect((value as unknown[]).length, `${label}: expected at least one row`).toBeGreaterThan(0);
  expect(typeof (value as unknown[])[0], `${label}: expected object rows`).toBe("object");
}

describe("live Polemica bundle contracts", () => {
  test("SITE classes, locale markers, phase labels and bundle hashes", async ({ skip }) => {
    let downloads: Record<BundleKey, Download>;
    try {
      downloads = Object.fromEntries(
        await Promise.all(
          (Object.entries(siteFixture.bundles) as Array<[
            BundleKey,
            (typeof siteFixture.bundles)[BundleKey],
          ]>).map(async ([key, fixture]) => [key, await download(fixture.url)] as const),
        ),
      ) as Record<BundleKey, Download>;
    } catch (error) {
      if (error instanceof TransientNetworkError) skip(`site unavailable: ${error.message}`);
      throw error;
    }

    const changed: string[] = [];
    for (const [key, result] of Object.entries(downloads) as Array<[BundleKey, Download]>) {
      const previous = siteFixture.bundles[key].sha256;
      if (previous !== result.sha256) {
        changed.push(`${key}: ${previous} -> ${result.sha256} (${result.bytes} bytes)`);
      }
    }
    if (changed.length) {
      console.warn(`Сайт пересобрался, стоит перепроверить селекторы:\n${changed.join("\n")}`);
    }

    const allBundles = Object.values(downloads)
      .map((item) => item.text)
      .join("\n");
    const expectedAbsentKeys = new Set([
      "playerMenuWithRole",
      "roleSymbols",
      "substageActive",
      // These are extension-generated classes historically kept under SITE.
      "penaltyDots",
      "penaltyDot",
      "bestMoveDot",
    ]);
    expect([...expectedAbsentKeys].sort()).toEqual([
      "bestMoveDot",
      "penaltyDot",
      "penaltyDots",
      "playerMenuWithRole",
      "roleSymbols",
      "substageActive",
    ]);

    const missingClasses: string[] = [];
    for (const [key, selector] of Object.entries(SITE)) {
      if (expectedAbsentKeys.has(key)) continue;
      const selectors = Array.isArray(selector) ? selector : [selector];
      for (const className of new Set(selectors.flatMap(classesFromSelector))) {
        if (!allBundles.includes(className)) missingClasses.push(`${key}: .${className}`);
      }
    }
    expect(
      missingClasses,
      "A class consumed by SITE disappeared from all live bundles; update code or explicitly review as dead",
    ).toEqual([]);

    const locale = downloads.localeRu.text;
    const localeLower = stringLiterals(locale).join("\n").toLowerCase();
    const englishBestEffort = new Set([
      ...TEXT.night.filter((marker) => /^[a-z]/.test(marker)),
      ...TEXT.day.filter((marker) => /^[a-z]/.test(marker)),
      ...TEXT.dayStrong.filter((marker) => /^[a-z]/.test(marker)),
    ]);
    const missingMarkers = [...new Set([...TEXT.night, ...TEXT.day, ...TEXT.dayStrong])].filter(
      (marker) => !englishBestEffort.has(marker) && !localeLower.includes(marker),
    );
    expect(missingMarkers, "Russian phase marker no longer corresponds to any RU locale string").toEqual([]);

    const localeValues = new Set(stringLiterals(locale));
    const missingFixtureLabels = phaseFixture.labels
      .filter(({ text }) => !localeValues.has(text))
      .map(({ key, text }) => `${key}: ${text}`);
    expect(
      missingFixtureLabels,
      "Cached offline phase fixture drifted from RU.js; run with UPDATE_CONTRACT_FIXTURES=1 after review",
    ).toEqual([]);
    for (const { text, phase } of phaseFixture.labels) {
      expect(classifyPhaseText(text.toLowerCase()), `classify live locale label: ${text}`).toBe(phase);
    }

    const knownPhaseKeys: Record<string, "day" | "night"> = {
      card_distribution: "night",
      familiarity_with_mafia: "night",
      first_night: "night",
      night: "night",
      mafia_acts: "night",
      checks: "night",
      doctor_acts: "night",
      auction: "night",
      morning: "day",
      day: "day",
      discussion: "day",
      voting: "day",
      voting_summary: "day",
      extra_speeches: "day",
      farewell_minute: "day",
      mafia_miss: "day",
    };
    const parsedEntries = localeEntries(locale);
    const unclassified: string[] = [];
    for (const [key, phase] of Object.entries(knownPhaseKeys)) {
      for (const value of parsedEntries.get(key) ?? []) {
        if (classifyPhaseText(value.toLowerCase()) !== phase) unclassified.push(`${key}: ${value}`);
      }
    }
    expect(unclassified, "A live stage label is not classified into its expected phase").toEqual([]);

    if (UPDATE_FIXTURES && changed.length) {
      const next = structuredClone(siteFixture) as typeof siteFixture;
      for (const key of Object.keys(next.bundles) as BundleKey[]) {
        next.bundles[key].sha256 = downloads[key].sha256;
      }
      fs.writeFileSync(
        path.join(ROOT, "tests/fixtures/site-contract.json"),
        `${JSON.stringify(next, null, 2)}\n`,
      );
      console.warn("Updated tests/fixtures/site-contract.json after explicit UPDATE_CONTRACT_FIXTURES=1");
    }
  });
});

describe("live Polemica HTTP API contracts", () => {
  test("ratings/default/get-list returns user_id and username", async ({ skip }) => {
    let result: Awaited<ReturnType<typeof json>>;
    try {
      result = await json("https://polemicagame.com/ratings/default/get-list?limit=10");
    } catch (error) {
      if (error instanceof TransientNetworkError) skip(`site unavailable: ${error.message}`);
      throw error;
    }
    expect(result.response.status).toBe(200);
    expectArrayOfObjects(result.body, "ratings/default/get-list");
    expect(result.body[0]).toEqual(
      expect.objectContaining({ user_id: expect.anything(), username: expect.any(String) }),
    );
  });

  test("profile statistic, role statistic and games endpoints retain consumed shapes", async ({ skip }) => {
    let rating: Awaited<ReturnType<typeof json>>;
    try {
      rating = await json("https://polemicagame.com/ratings/default/get-list?limit=1");
    } catch (error) {
      if (error instanceof TransientNetworkError) skip(`site unavailable: ${error.message}`);
      throw error;
    }
    expect(rating.response.status).toBe(200);
    expectArrayOfObjects(rating.body, "ratings seed");
    const userId = rating.body[0].user_id;
    expect(userId).not.toBeNull();

    const urls = {
      statistic: `https://polemicagame.com/profile/default/get-statistic?user_id=${encodeURIComponent(String(userId))}`,
      role: `https://polemicagame.com/profile/default/get-role-statistic?user_id=${encodeURIComponent(String(userId))}`,
      games: `https://polemicagame.com/profile/default/get-games?userId=${encodeURIComponent(String(userId))}&page=1&limit=1`,
    };
    let responses: Record<keyof typeof urls, Awaited<ReturnType<typeof json>>>;
    try {
      responses = Object.fromEntries(
        await Promise.all(
          (Object.entries(urls) as Array<[keyof typeof urls, string]>).map(async ([key, url]) => [
            key,
            await json(url),
          ]),
        ),
      ) as typeof responses;
    } catch (error) {
      if (error instanceof TransientNetworkError) skip(`site unavailable: ${error.message}`);
      throw error;
    }
    if (Object.values(responses).some(({ response }) => response.status === 401 || response.status === 403)) {
      skip("profile APIs require an authenticated session in this environment");
    }
    for (const [name, result] of Object.entries(responses)) {
      expect(result.response.status, `${name} endpoint moved or became unavailable`).toBe(200);
    }

    expect(typeof responses.statistic.body).toBe("object");
    expect(responses.statistic.body).not.toBeNull();
    const statistic = responses.statistic.body as Record<string, unknown>;
    for (const role of ["civilian", "sheriff", "mafia", "godfather"]) {
      expect(statistic[role], `get-statistic.${role}`).toEqual(
        expect.objectContaining({ games_count: expect.anything(), wins_count: expect.anything() }),
      );
    }

    expectArrayOfObjects(responses.role.body, "get-role-statistic");
    expect(responses.role.body[0]).toEqual(
      expect.objectContaining({ games_count: expect.anything(), wins_count: expect.anything() }),
    );

    expect(responses.games.body).toEqual(
      expect.objectContaining({ rows: expect.any(Array), totalCount: expect.anything() }),
    );
    const rows = (responses.games.body as { rows: unknown[] }).rows;
    if (rows.length) {
      expect(rows[0]).toEqual(
        expect.objectContaining({ role: expect.anything(), result: expect.anything() }),
      );
    }
  });
});
