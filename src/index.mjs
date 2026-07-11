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

  // BOX、で終わっていて次が繋がっていないケースを掃除
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

// JST基準で曜日付き日付表示
function toDeadlineText(iso) {
  if (!iso) return "不明";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "不明";

  // ISO文字列から直接パーツを取り出す（JSTタイムゾーン付きで作っているため信頼できる）
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return "不明";

  const month = Number(m[2]);
  const day = Number(m[3]);
  const hh = m[4];
  const mi = m[5];

  // 曜日は JST の日付で計算
  const jstDate = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00+09:00`);
  const wd = WEEKDAY_JP[jstDate.getUTCDay()];

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

  // nyuka-now.com はまとめサイト自身なので優先度を最低にする
  const strong = candidates.filter((u) => !/nyuka-now\.com/i.test(u));
  const weak = candidates.filter((u) => /nyuka-now\.com/i.test(u));

  return strong[0] || weak[0] || "";
}

// アフィリエイト等のリダイレクトURLを素のURLに展開
function unwrapUrl(url = "") {
  if (!url) return "";
  try {
    const u = new URL(url);

    // 楽天のリダイレクト: hb.afl.rakuten.co.jp/... ?pc=https%3A%2F%2F...
    const pc = u.searchParams.get("pc");
    if (u.hostname.endsWith("rakuten.co.jp") && pc) {
      return pc;
    }

    // その他: url= や target= に URL が入っているタイプ
    for (const key of ["url", "target", "u", "redirect"]) {
      const v = u.searchParams.get(key);
      if (v && /^https?:\/\//i.test(v)) return v;
    }

    return url;
  } catch {
    return url;
  }
}

// 1店舗×同一締切×同一応募URLをまとめる
function mergeSameGroup(items) {
  const map = new Map();

  for (const it of items) {
    const groupKey = [
      it.store,
      it.deadline_iso || "no-deadline",
      it.apply_url,
    ].join("|");

    if (!map.has(groupKey)) {
      map.set(groupKey, {
        ...it,
        products: [it.product],
      });
    } else {
      const prev = map.get(groupKey);
      if (!prev.products.includes(it.product)) {
        prev.products.push(it.product);
      }
    }
  }

  return [...map.values()].map((it) => {
    const productJoined = it.products.join(" / ");
    return {
      ...it,
      product: productJoined,
    };
  });
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
    throw scrapeError || new Error("no items scraped");
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

  // 1店舗×同一締切×同一URL でまとめる
  const merged = mergeSameGroup(normalized);

  // 最終形にID・title・notes・has_deadlineを付ける
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

  // open優先、なければ全件
  const openItems = finalized.filter((x) => x.status === "open");
  const latest = openItems.length > 0 ? openItems : finalized;

  console.log(`[info] normalized items: ${normalized.length}`);
  console.log(`[info] merged items: ${merged.length}`);
  console.log(`[info] latest items: ${latest.length}`);

  if (latest.length === 0) {
    const existingLatest = await readExisting(path.join(OUTPUT_DIR, "latest.json"));
    if (existingLatest && existingLatest.length > 0) {
      const debug = {
        generated_at: new Date().toISOString(),
        rawCount: rawItems.length,
        normalizedCount: normalized.length,
        mergedCount: merged.length,
        latestCount: 0,
        note: "would_be_empty_kept_previous_latest",
      };
      await fs.writeFile(path.join(OUTPUT_DIR, "debug.json"), JSON.stringify(debug, null, 2));
      console.log("[info] latest would be empty, kept previous latest.json");
      return;
    }
    throw new Error("latest.json would be empty");
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

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
