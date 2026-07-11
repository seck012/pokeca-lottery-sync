import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import scrapeNyukaNow from "./sources/nyuka-now.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(ROOT_DIR, "output");

function cleanText(value = "") {
  return String(value)
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function makeId(parts) {
  return crypto
    .createHash("sha1")
    .update(parts.filter(Boolean).join("|"))
    .digest("hex")
    .slice(0, 16);
}

function normalizeStore(store = "") {
  const s = cleanText(store);

  if (!s) return "不明店舗";

  return s
    .replace(/\s+/g, " ")
    .replace(/（店舗一覧）/g, "")
    .trim();
}

function normalizeProduct(product = "", products = []) {
  let s = cleanText(product);

  if ((!s || s === "不明商品") && Array.isArray(products) && products.length > 0) {
    s = products
      .map((x) => cleanText(x))
      .filter(Boolean)
      .join(" / ");
  }

  s = s.replace(/^ポケモンカード\s*/g, "").trim();

  // 商品名ではないノイズを除外
  const NG_PATTERNS = [
    /^当選者/,
    /^応募には/,
    /^※/,
    /^詳細は/,
    /^ジョーシンアプリ/,
    /^シーガルモバイル会員限定/,
    /^WEB抽選受付/,
    /^アプリ抽選受付/,
    /^店頭販売/,
    /^オンライン販売/,
    /Amazonでの販売予想価格/,
  ];

  if (!s) return "";
  if (NG_PATTERNS.some((re) => re.test(s))) return "";

  // 長すぎる説明文を少し掃除
  s = s
    .replace(/応募には.+$/g, "")
    .replace(/※.+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return s;
}

function parseJapaneseDateToIso(text = "") {
  const raw = cleanText(text);
  if (!raw) return null;

  const yearNow = new Date().getUTCFullYear();

  const buildIso = (year, month, day, hour = "23", minute = "59") => {
    const yyyy = String(year).padStart(4, "0");
    const mm = String(month).padStart(2, "0");
    const dd = String(day).padStart(2, "0");
    const hh = String(hour).padStart(2, "0");
    const mi = String(minute).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}T${hh}:${mi}:00+09:00`;
  };

  let m;

  // 2026年7月24日(金) 18時以降順次
  m = raw.match(/(\d{4})年(\d{1,2})月(\d{1,2})日.*?(\d{1,2})時(?:(\d{1,2})分?)?/);
  if (m) return buildIso(m[1], m[2], m[3], m[4], m[5] ?? "00");

  // 2026年7月24日(金) 18:00
  m = raw.match(/(\d{4})年(\d{1,2})月(\d{1,2})日.*?(\d{1,2})[:：](\d{2})/);
  if (m) return buildIso(m[1], m[2], m[3], m[4], m[5]);

  // 7月12日(日)23:59
  m = raw.match(/(\d{1,2})月(\d{1,2})日.*?(\d{1,2})[:：](\d{2})/);
  if (m) return buildIso(yearNow, m[1], m[2], m[3], m[4]);

  // 7月12日(日)23時59分
  m = raw.match(/(\d{1,2})月(\d{1,2})日.*?(\d{1,2})時(\d{1,2})分?/);
  if (m) return buildIso(yearNow, m[1], m[2], m[3], m[4]);

  // 7/30 12:00
  m = raw.match(/(\d{1,2})\/(\d{1,2})\s*(\d{1,2})[:：](\d{2})/);
  if (m) return buildIso(yearNow, m[1], m[2], m[3], m[4]);

  // 7/29
  m = raw.match(/(\d{1,2})\/(\d{1,2})/);
  if (m) return buildIso(yearNow, m[1], m[2], "23", "59");

  // 7月21日
  m = raw.match(/(\d{1,2})月(\d{1,2})日/);
  if (m) return buildIso(yearNow, m[1], m[2], "23", "59");

  return null;
}

function toDeadlineText(rawText = "", iso = null) {
  if (iso) {
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (m) {
      const month = Number(m[2]);
      const day = Number(m[3]);
      const hh = m[4];
      const mi = m[5];
      return `${month}/${day} ${hh}:${mi}`;
    }
  }

  const raw = cleanText(rawText);
  return raw || "不明";
}

function normalizeStatus(deadlineIso) {
  if (!deadlineIso) return "open";
  const now = Date.now();
  const end = new Date(deadlineIso).getTime();
  if (Number.isNaN(end)) return "open";
  return end < now ? "closed" : "open";
}

function pickApplyUrl(row) {
  return (
    cleanText(row.apply_url) ||
    cleanText(row.applyUrl) ||
    cleanText(row.detail_url) ||
    cleanText(row.detailUrl) ||
    ""
  );
}

function dedupe(items) {
  const map = new Map();

  for (const item of items) {
    const key = [
      item.store,
      item.product,
      item.apply_url,
      item.deadline_iso || item.deadline_text,
    ].join("|");

    if (!map.has(key)) {
      map.set(key, item);
    }
  }

  return [...map.values()];
}

async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const rawItems = await scrapeNyukaNow();
  console.log(`[info] raw items: ${rawItems.length}`);

  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new Error("no items scraped");
  }

  const dropped = [];
  const normalized = [];

  for (const row of rawItems) {
    const store = normalizeStore(row.store);
    const product = normalizeProduct(row.product, row.products);
    const applyUrl = pickApplyUrl(row);
    const deadlineIso = parseJapaneseDateToIso(row.entryEndText || "");
    const deadlineText = toDeadlineText(row.entryEndText || "", deadlineIso);
    const status = normalizeStatus(deadlineIso);

    if (!product) {
      dropped.push({
        reason: "bad_product",
        store,
        rawProduct: row.product,
      });
      continue;
    }

    if (!applyUrl) {
      dropped.push({
        reason: "missing_apply_url",
        store,
        product,
      });
      continue;
    }

    const item = {
      id: makeId([store, product, applyUrl, deadlineText]),
      source: "nyuka-now",
      store,
      product,
      deadline_text: deadlineText,
      deadline_iso: deadlineIso,
      apply_url: applyUrl,
      status,
      raw: {
        entryEndText: row.entryEndText || "",
        lotteryType: row.lotteryType || "",
        detailUrl: row.detailUrl || row.detail_url || "",
      },
    };

    normalized.push(item);
  }

  const deduped = dedupe(normalized);

  // closedを落としすぎると空になるので、まずは open 優先、なければ全件
  const openItems = deduped.filter((x) => x.status === "open");
  const latest = openItems.length > 0 ? openItems : deduped;

  console.log(`[info] normalized items: ${normalized.length}`);
  console.log(`[info] deduped items: ${deduped.length}`);
  console.log(`[info] latest items: ${latest.length}`);

  if (latest.length === 0) {
    throw new Error("latest.json would be empty");
  }

  const normalizedJson = JSON.stringify(deduped, null, 2);
  const latestJson = JSON.stringify(
    latest.map((x) => ({
      id: x.id,
      store: x.store,
      product: x.product,
      deadline_text: x.deadline_text,
      deadline_iso: x.deadline_iso,
      apply_url: x.apply_url,
      status: x.status,
    })),
    null,
    2
  );

  const debugJson = JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      rawCount: rawItems.length,
      normalizedCount: normalized.length,
      dedupedCount: deduped.length,
      latestCount: latest.length,
      droppedCount: dropped.length,
      droppedSample: dropped.slice(0, 20),
      sample: latest.slice(0, 20),
    },
    null,
    2
  );

  await fs.writeFile(path.join(OUTPUT_DIR, "normalized.json"), normalizedJson);
  await fs.writeFile(path.join(OUTPUT_DIR, "latest.json"), latestJson);
  await fs.writeFile(path.join(OUTPUT_DIR, "debug.json"), debugJson);

  console.log("[info] output files written");
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
