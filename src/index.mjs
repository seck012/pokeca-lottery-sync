import { scrapeNyukaNow } from "./sources/nyuka-now.mjs";
import fs from "node:fs/promises";
import crypto from "node:crypto";

const MAX_ITEMS = 300;

function cleanText(text) {
  return (text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sha1(text) {
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 16);
}

function normalizeStoreName(name) {
  const t = cleanText(name);

  if (!t) return "不明店舗";

  const rules = [
    [/竜のしっぽ/i, "竜のしっぽ各店"],
    [/キッズリパブリック/i, "キッズリパブリック（アプリ）"],
    [/ポケモンカードラウンジ渋谷店/i, "ポケモンカードラウンジ渋谷店"],
    [/ジョーシン/i, "ジョーシン（アプリ）"],
    [/三洋堂書店/i, "三洋堂書店"],
    [/トレカプラザ55通販/i, "トレカプラザ55通販"],
    [/フルコンプ/i, "フルコンプ 一部店舗"],
    [/シーガル/i, "シーガル各店"],
    [/イオン九州/i, "イオン九州"],
    [/ポケモンセンター/i, "ポケモンセンターオンライン"],
    [/ヨドバシ/i, "ヨドバシカメラ"],
    [/ビックカメラ/i, "ビックカメラ"],
    [/ヤマダ/i, "ヤマダデンキ"],
    [/古本市場/i, "古本市場"],
    [/駿河屋/i, "駿河屋"],
    [/セブンネット/i, "セブンネット"],
    [/楽天ブックス/i, "楽天ブックス"],
    [/イオン/i, "イオン"]
  ];

  for (const [pattern, normalized] of rules) {
    if (pattern.test(t)) return normalized;
  }

  // LivePocket / Amazon / 楽天系ストア のような「プラットフォーム名」は採用しない
  if (/LivePocket|Amazon|楽天系ストア/i.test(t)) return "不明店舗";

  return t;
}

function normalizeProductItem(text) {
  let t = cleanText(text);

  if (!t) return null;

  t = t
    .replace(/^ポケモンカードゲーム\s*/i, "")
    .replace(/^ポケモンカード\s*/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  const banned = [
    "当選者は",
    "購入可能",
    "販売予想価格",
    "価格",
    "応募条件",
    "おひとりさま",
    "まで購入可能",
    "注意事項",
    "会員限定",
    "抽選形式",
    "開始日",
    "終了日",
    "当選発表",
    "詳細ページ",
    "応募ページ"
  ];

  if (banned.some(word => t.includes(word))) return null;
  if (t.length < 2) return null;

  return t;
}

function summarizeProducts(items) {
  const normalized = [...new Set(
    (items || [])
      .map(normalizeProductItem)
      .filter(Boolean)
  )];

  if (normalized.length === 0) return null;
  if (normalized.length === 1) return normalized[0];
  if (normalized.length === 2) return `${normalized[0]} / ${normalized[1]}`;

  return `${normalized[0]} ほか${normalized.length - 1}件`;
}

function parseJapaneseDeadline(raw) {
  const t = cleanText(raw);
  if (!t || t === "不明" || t === "-") {
    return { iso: null, text: "不明" };
  }

  let month = null;
  let day = null;
  let hour = "23";
  let minute = "59";

  let m = t.match(/(\d{1,2})月(\d{1,2})日(?:\([^)]*\))?(?:(\d{1,2})[:時](\d{2})?)?/);
  if (m) {
    month = m[1];
    day = m[2];
    if (m[3]) hour = String(m[3]).padStart(2, "0");
    if (m[4]) {
      minute = String(m[4]).padStart(2, "0");
    } else if (/時/.test(t) && !/:/.test(t)) {
      minute = "00";
    }
  } else {
    m = t.match(/(\d{1,2})\/(\d{1,2})(?:.*?(\d{1,2})[:時](\d{2})?)?/);
    if (m) {
      month = m[1];
      day = m[2];
      if (m[3]) hour = String(m[3]).padStart(2, "0");
      if (m[4]) {
        minute = String(m[4]).padStart(2, "0");
      } else if (/時/.test(t) && !/:/.test(t)) {
        minute = "00";
      }
    }
  }

  if (!month || !day) {
    return { iso: null, text: "不明" };
  }

  const year = new Date().getFullYear();
  const month2 = String(month).padStart(2, "0");
  const day2 = String(day).padStart(2, "0");
  const isoDate = new Date(`${year}-${month2}-${day2}T${hour}:${minute}:00+09:00`);

  if (Number.isNaN(isoDate.getTime())) {
    return { iso: null, text: "不明" };
  }

  const hasExplicitTime =
    /:\d{2}/.test(t) || /\d{1,2}時/.test(t);

  const text = hasExplicitTime
    ? `${Number(month)}/${Number(day)} ${hour}:${minute}`
    : `${Number(month)}/${Number(day)}`;

  return {
    iso: isoDate.toISOString(),
    text
  };
}

function classifyStatus(deadlineIso) {
  if (!deadlineIso) return "open";

  const now = new Date();
  const deadline = new Date(deadlineIso);

  if (deadline < now) return "closed";
  return "open";
}

function chooseBetter(existing, incoming) {
  const score = (x) => {
    let s = 0;
    if (x.store && x.store !== "不明店舗") s += 5;
    if (x.deadline_iso) s += 4;
    if (x.apply_url) s += 3;
    if (x.product && !x.product.includes("ほか")) s += 2;
    return s;
  };

  return score(incoming) > score(existing) ? incoming : existing;
}

async function main() {
  const results = await Promise.allSettled([
    scrapeNyukaNow()
  ]);

  const raw = results.flatMap(r => r.status === "fulfilled" ? r.value : []);
  console.log(`[info] raw items: ${raw.length}`);

  if (raw.length === 0) {
    console.error("[error] no items scraped");
    process.exit(1);
  }

  const dropped = [];
  const normalized = [];

  for (const r of raw) {
    const store = normalizeStoreName(r.store_raw || r.section_heading);
    const product = summarizeProducts(r.product_items_raw || []);
    const deadline = parseJapaneseDeadline(r.entry_end_raw);
    const apply_url = cleanText(r.apply_url_raw);

    if (!product) {
      dropped.push({ reason: "bad_product", raw: r });
      continue;
    }

    if (!apply_url) {
      dropped.push({ reason: "missing_apply_url", raw: r });
      continue;
    }

    if (store === "不明店舗") {
      dropped.push({ reason: "unknown_store", raw: r });
      continue;
    }

    const idSeed = [
      store,
      product,
      apply_url,
      deadline.iso || ""
    ].join("|");

    normalized.push({
      id: sha1(idSeed),
      store,
      product,
      deadline_text: deadline.text,
      deadline_iso: deadline.iso,
      apply_url,
      status: classifyStatus(deadline.iso),
      _debug: {
        source: r.source,
        detail_url: r.detail_url,
        section_heading: r.section_heading || null,
        product_items_raw: r.product_items_raw || [],
        entry_end_raw: r.entry_end_raw || null,
        conditions_raw: r.conditions_raw || null
      }
    });
  }

  const dedupedMap = new Map();
  for (const item of normalized) {
    const existing = dedupedMap.get(item.id);
    if (!existing) {
      dedupedMap.set(item.id, item);
    } else {
      dedupedMap.set(item.id, chooseBetter(existing, item));
    }
  }

  const deduped = Array.from(dedupedMap.values())
    .sort((a, b) => {
      if (!a.deadline_iso && !b.deadline_iso) {
        return a.store.localeCompare(b.store, "ja");
      }
      if (!a.deadline_iso) return 1;
      if (!b.deadline_iso) return -1;
      return new Date(a.deadline_iso) - new Date(b.deadline_iso);
    })
    .slice(0, MAX_ITEMS);

  const latest = deduped
    .filter(x => x.status === "open")
    .map(({ _debug, ...rest }) => rest);

  if (latest.length === 0) {
    console.error("[error] latest.json would be empty");
    process.exit(1);
  }

  await fs.mkdir("output", { recursive: true });
  await fs.writeFile("output/latest.json", JSON.stringify(latest, null, 2));
  await fs.writeFile("output/normalized.json", JSON.stringify(deduped, null, 2));
  await fs.writeFile("output/debug.json", JSON.stringify({
    generatedAt: new Date().toISOString(),
    rawCount: raw.length,
    normalizedCount: normalized.length,
    dedupedCount: deduped.length,
    latestCount: latest.length,
    droppedCount: dropped.length,
    droppedSample: dropped.slice(0, 10).map(x => ({
      reason: x.reason,
      section_heading: x.raw.section_heading || null,
      product_items_raw: x.raw.product_items_raw || [],
      apply_url_raw: x.raw.apply_url_raw || null,
      entry_end_raw: x.raw.entry_end_raw || null
    })),
    sample: latest.slice(0, 8)
  }, null, 2));

  console.log("[ok] output files written");
}

main().catch(err => {
  console.error("[fatal]", err);
  process.exit(1);
});
