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
  return s.replace(/\s+/g, " ").replace(/（店舗一覧）/g, "").trim();
}

function normalizeProduct(product = "", products = []) {
  let s = cleanText(product);

  if ((!s || s === "不明商品") && Array.isArray(products) && products.length > 0) {
    s = products.map((x) => cleanText(x)).filter(Boolean).join(" / ");
  }

  s = s.replace(/^ポケモンカード\s*/g, "").trim();

  const NG = [
    /^当選者/, /^応募には/, /^※/, /^詳細は/,
    /^ジョーシンアプリ/, /^シーガルモバイル会員限定/,
    /^WEB抽選受付/, /^アプリ抽選受付/, /^店頭販売/, /^オンライン販売/,
    /Amazonでの販売予想価格/,
  ];

  if (!s) return "";
  if (NG.some((re) => re.test(s))) return "";

  s = s.replace(/応募には.+$/g, "").replace(/※.+$/g, "").replace(/\s+/g, " ").trim();
  return s;
}

function parseJapaneseDateToIso(text = "") {
  const raw = cleanText(text);
  if (!raw) return null;
  const yearNow = new Date().getUTCFullYear();

  const buildIso = (y, mo, d, h = "23", mi = "59") =>
    `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}:00+09:00`;

  let m;
  m = raw.match(/(\d{4})年(\d{1,2})月(\d{1,2})日.*?(\d{1,2})時(?:(\d{1,2})分?)?/);
  if (m) return buildIso(m[1], m[2], m[3], m[4], m[5] ?? "00");

  m = raw.match(/(\d{4})年(\d{1,2})月(\d{1,2})日.*?(\d{1,2})[:：](\d{2})/);
  if (m) return buildIso(m[1], m[2], m[3], m[4], m[5]);

  m = raw.match(/(\d{1,2})月(\d{1,2})日.*?(\d{1,2})[:：](\d{2})/);
  if (m) return buildIso(yearNow, m[1], m[2], m[3], m[4]);

  m = raw.match(/(\d{1,2})月(\d{1,2})日.*?(\d{1,2})時(\d{1,2})分?/);
  if (m) return buildIso(yearNow, m[1], m[2], m[3], m[4]);

  m = raw.match(/(\d{1,2})\/(\d{1,2})\s*(\d{1,2})[:：](\d{2})/);
  if (m) return buildIso(yearNow, m[1], m[2], m[3], m[4]);

  m = raw.match(/(\d{1,2})\/(\d{1,2})/);
  if (m) return buildIso(yearNow, m[1], m[2], "23", "59");

  m = raw.match(/(\d{1,2})月(\d{1,2})日/);
  if (m) return buildIso(yearNow, m[1], m[2], "23", "59");

  return null;
}

function toDeadlineText(rawText = "", iso = null) {
  if (iso) {
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (m) return `${Number(m[2])}/${Number(m[3])} ${m[4]}:${m[5]}`;
  }
  const raw = cleanText(rawText);
  return raw || "不明";
}

function normalizeStatus(deadlineIso) {
  if (!deadlineIso) return "open";
  const end = new Date(deadlineIso).getTime();
  if (Number.isNaN(end)) return "open";
  return end < Date.now() ? "closed" : "open";
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
  for (const it of items) {
    const key = [it.store, it.product, it.apply_url, it.deadline_iso || it.deadline_text].join("|");
    if (!map.has(key)) map.set(key, it);
  }
  return [...map.values()];
}

async function readExisting(file) {
  try {
    const txt = await fs.readFile(file, "utf-8");
    const j = JSON.parse(txt);
    return Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  let rawItems = [];
  let scrapeError = null;

  try {
    rawItems = await scrapeNyukaNow();
    console.log(`[info] raw items: ${rawItems.length}`);
  } catch (err) {
    scrapeError = err;
    console.error("[warn] scrape failed:", err && err.message ? err.message : err);
  }

  // 取得失敗時: 既存 latest.json を残して debug.json だけ更新して成功終了
  if (scrapeError || !Array.isArray(rawItems) || rawItems.length === 0) {
    const latestPath = path.join(OUTPUT_DIR, "latest.json");
    const existingLatest = await readExisting(latestPath);

    if (existingLatest && existingLatest.length > 0) {
      const debug = {
        generated_at: new Date().toISOString(),
        rawCount: rawItems.length,
        note: "scrape_failed_kept_previous_latest",
        error: scrapeError ? String(scrapeError.message || scrapeError) : null,
        latestCount: existingLatest.length,
      };
      await fs.writeFile(path.join(OUTPUT_DIR, "debug.json"), JSON.stringify(debug, null, 2));
      console.log("[info] scrape failed but previous latest.json kept");
      return;
    }

    // 既存すら無ければ本当に失敗
    throw scrapeError || new Error("no items scraped");
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
      dropped.push({ reason: "bad_product", store, rawProduct: row.product });
      continue;
    }
    if (!applyUrl) {
      dropped.push({ reason: "missing_apply_url", store, product });
      continue;
    }

    normalized.push({
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
    });
  }

  const deduped = dedupe(normalized);
  const openItems = deduped.filter((x) => x.status === "open");
  const latest = openItems.length > 0 ? openItems : deduped;

  console.log(`[info] normalized items: ${normalized.length}`);
  console.log(`[info] deduped items: ${deduped.length}`);
  console.log(`[info] latest items: ${latest.length}`);

  if (latest.length === 0) {
    // 新規に空になる場合も既存を保護
    const existingLatest = await readExisting(path.join(OUTPUT_DIR, "latest.json"));
    if (existingLatest && existingLatest.length > 0) {
      const debug = {
        generated_at: new Date().toISOString(),
        rawCount: rawItems.length,
        normalizedCount: normalized.length,
        dedupedCount: deduped.length,
        latestCount: 0,
        note: "would_be_empty_kept_previous_latest",
      };
      await fs.writeFile(path.join(OUTPUT_DIR, "debug.json"), JSON.stringify(debug, null, 2));
      console.log("[info] latest would be empty, kept previous latest.json");
      return;
    }
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
