import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import scrapeNyukaNow from "./sources/nyuka-now.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(ROOT_DIR, "output");

const WEEKDAY_JP = ["日", "月", "火", "水", "木", "金", "土"];

function cleanText(value = "") {
  return String(value).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
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
  s = s.replace(/BOX、\s*スターターセットex/g, "BOX / スターターセットex");

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

// JST基準で曜日付き日付表示 (JST正午で計算するのでランナーTZに依存しない)
function toDeadlineText(iso) {
  if (!iso) return "不明";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return "不明";

  const month = Number(m[2]);
  const day = Number(m[3]);
  const hh = m[4];
  const mi = m[5];

  const jstNoon = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00+09:00`);
  const wd = WEEKDAY_JP[jstNoon.getDay()];

  return `${month}/${day}(${wd}) ${hh}:${mi}`;
}

function normalizeStatus(deadlineIso) {
  if (!deadlineIso) return "open";
  const end = new Date(deadlineIso).getTime();
  if (Number.isNaN(end)) return "open";
  return end < Date.now() ? "closed" : "open";
}

function pickApplyUrl(row) {
  const candidates = [
    row.apply_url, row.applyUrl,
    row.detail_url, row.detailUrl,
  ]
    .map((x) => cleanText(x || ""))
    .filter(Boolean);

  const strong = candidates.filter((u) => !/nyuka-now\.com/i.test(u));
  const weak = candidates.filter((u) => /nyuka-now\.com/i.test(u));
  return strong[0] || weak[0] || "";
}

function unwrapUrl(url = "") {
  if (!url) return "";
  try {
    const u = new URL(url);
    const pc = u.searchParams.get("pc");
    if (u.hostname.endsWith("rakuten.co.jp") && pc) return pc;
    for (const key of ["url", "target", "u", "redirect"]) {
      const v = u.searchParams.get(key);
      if (v && /^https?:\/\//i.test(v)) return v;
    }
    return url;
  } catch {
    return url;
  }
}

function mergeSameGroup(items) {
  const map = new Map();
  for (const it of items) {
    const groupKey = [
      it.store,
      it.deadline_iso || "no-deadline",
      it.apply_url,
    ].join("|");

    if (!map.has(groupKey)) {
      map.set(groupKey, { ...it, products: [it.product] });
    } else {
      const prev = map.get(groupKey);
      if (!prev.products.includes(it.product)) prev.products.push(it.product);
    }
  }
  return [...map.values()].map((it) => ({
    ...it,
    product: it.products.join(" / "),
  }));
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

async function writeSuccessOnFailure({ reason, error, rawCount }) {
  const latestPath = path.join(OUTPUT_DIR, "latest.json");
  const existing = await readExisting(latestPath);

  const latestArray = existing && existing.length > 0 ? existing : [];

  await fs.writeFile(latestPath, JSON.stringify(latestArray, null, 2));
  await fs.writeFile(
    path.join(OUTPUT_DIR, "debug.json"),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        rawCount: rawCount ?? 0,
        latestCount: latestArray.length,
        note: reason,
        error: error ? String(error.message || error) : null,
        kept_previous: existing && existing.length > 0,
      },
      null,
      2
    )
  );

  console.log(
    `[info] soft-success: ${reason} (kept ${latestArray.length} items)`
  );
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
    console.error(
      "[warn] scrape failed:",
      err && err.message ? err.message : err
    );
  }

  // 取得失敗 or 0件 → ジョブは緑のまま終わる
  if (scrapeError || !Array.isArray(rawItems) || rawItems.length === 0) {
    await writeSuccessOnFailure({
      reason: scrapeError
        ? "scrape_failed_soft_success"
        : "scrape_zero_items_soft_success",
      error: scrapeError,
      rawCount: rawItems.length,
    });
    return;
  }

  const dropped = [];
  const normalized = [];

  for (const row of rawItems) {
    const store = normalizeStore(row.store);
    const productSingle = normalizeProduct(row.product, row.products);
    const applyUrlRaw = pickApplyUrl(row);
    const applyUrl = unwrapUrl(applyUrlRaw);

    const deadlineIso = parseJapaneseDateToIso(row.entryEndText || "");
    const deadlineText = toDeadlineText(deadlineIso);
    const status = normalizeStatus(deadlineIso);

    if (!productSingle) {
      dropped.push({ reason: "bad_product", store, rawProduct: row.product });
      continue;
    }
    if (!applyUrl) {
      dropped.push({ reason: "missing_apply_url", store, product: productSingle });
      continue;
    }

    normalized.push({
      store,
      product: productSingle,
      deadline_text: deadlineText,
      deadline_iso: deadlineIso,
      apply_url: applyUrl,
      status,
    });
  }

  const merged = mergeSameGroup(normalized);

  const finalized = merged.map((it) => {
    const id = makeId([it.store, it.product, it.apply_url, it.deadline_iso || it.deadline_text]);
    const title = `【${it.store}】${it.product}`;
    const notes = [
      `id:${id}`,
      `応募URL:${it.apply_url}`,
      `締切:${it.deadline_text}`,
    ].join("\n");

    return {
      id,
      title,
      store: it.store,
      product: it.product,
      deadline_text: it.deadline_text,
      deadline_iso: it.deadline_iso,
      has_deadline: Boolean(it.deadline_iso),
      apply_url: it.apply_url,
      status: it.status,
      notes,
    };
  });

  const openItems = finalized.filter((x) => x.status === "open");
  const latest = openItems.length > 0 ? openItems : finalized;

  console.log(`[info] normalized items: ${normalized.length}`);
  console.log(`[info] merged items: ${merged.length}`);
  console.log(`[info] latest items: ${latest.length}`);

  if (latest.length === 0) {
    await writeSuccessOnFailure({
      reason: "latest_would_be_empty_soft_success",
      error: null,
      rawCount: rawItems.length,
    });
    return;
  }

  const normalizedJson = JSON.stringify(merged, null, 2);
  const latestJson = JSON.stringify(latest, null, 2);
  const debugJson = JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      rawCount: rawItems.length,
      normalizedCount: normalized.length,
      mergedCount: merged.length,
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

main().catch(async (err) => {
  // 想定外エラーもソフト成功で吸収 (デプロイは続行させる)
  try {
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    await writeSuccessOnFailure({
      reason: "unexpected_error_soft_success",
      error: err,
      rawCount: 0,
    });
  } catch (writeErr) {
    console.error("Error while writing soft-success artifacts:", writeErr);
    process.exit(1);
  }
});
