import { scrapeNyukaNow } from "./sources/nyuka-now.mjs";
import fs from "node:fs/promises";
import crypto from "node:crypto";

const MAX_ITEMS = 300;

function cleanText(text) {
  return (text || "")
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}

function sha1(text) {
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 16);
}

function parseJPDate(raw) {
  const t = cleanText(raw);
  if (!t || t === "不明" || t === "-") return null;

  const m = t.match(/(\d{1,2})\/(\d{1,2})(?:.*?(\d{1,2}):(\d{2}))?/);
  if (!m) return null;

  const year = new Date().getFullYear();
  const month = m[1].padStart(2, "0");
  const day = m[2].padStart(2, "0");
  const hour = m[3] ? m[3].padStart(2, "0") : "23";
  const minute = m[4] ? m[4].padStart(2, "0") : "59";

  const iso = new Date(`${year}-${month}-${day}T${hour}:${minute}:00+09:00`);
  if (Number.isNaN(iso.getTime())) return null;

  return iso.toISOString();
}

function formatDeadlineText(isoString) {
  if (!isoString) return "不明";

  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return "不明";

  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const month = jst.getUTCMonth() + 1;
  const day = jst.getUTCDate();
  const hh = String(jst.getUTCHours()).padStart(2, "0");
  const mm = String(jst.getUTCMinutes()).padStart(2, "0");

  if (hh === "23" && mm === "59") {
    return `${month}/${day}`;
  }

  return `${month}/${day} ${hh}:${mm}`;
}

function normalizeStoreName(name, url) {
  const t = cleanText(name);

  if (t && t !== "不明店舗") {
    if (/ヨドバシ/i.test(t)) return "ヨドバシカメラ";
    if (/ポケモンセンター/i.test(t)) return "ポケモンセンターオンライン";
    if (/キッズリパブリック/i.test(t)) return "キッズリパブリック";
    if (/LivePocket|ライブポケット/i.test(t)) return "LivePocket";
    if (/ビックカメラ/i.test(t)) return "ビックカメラ";
    if (/イオン/i.test(t)) return "イオン";
    if (/楽天ブックス/i.test(t)) return "楽天ブックス";
    if (/Amazon/i.test(t)) return "Amazon";
    return t;
  }

  const u = url || "";
  if (/limited\.yodobashi\.com/i.test(u)) return "ヨドバシカメラ";
  if (/kidsrepublic\.jp/i.test(u)) return "キッズリパブリック";
  if (/shop\.pokemon\.co\.jp/i.test(u)) return "ポケモンセンターオンライン";
  if (/livepocket\.jp/i.test(u)) return "LivePocket";
  if (/biccamera\.com/i.test(u)) return "ビックカメラ";
  if (/amazon\./i.test(u)) return "Amazon";
  if (/rakuten/i.test(u)) return "楽天系ストア";
  if (/7net/i.test(u)) return "セブンネット";
  if (/hmv/i.test(u)) return "HMV";
  if (/suruga-ya/i.test(u)) return "駿河屋";

  return "不明店舗";
}

function isBadProduct(text) {
  const t = cleanText(text);
  if (!t) return true;

  const banned = [
    "当選者は",
    "購入可能",
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

  if (banned.some(word => t.includes(word))) return true;
  if (t.length < 3) return true;

  return false;
}

function normalizeProduct(text) {
  let t = cleanText(text);

  if (!t) return null;

  t = t
    .replace(/^ポケモンカードゲーム\s*/i, "")
    .replace(/^ポケモンカード\s*/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (isBadProduct(t)) return null;

  if (t.length > 80) {
    const parts = t.split(/[／/・,、]/).map(s => cleanText(s)).filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0]} ほか${parts.length - 1}件`;
    }
    return t.slice(0, 77) + "...";
  }

  return t;
}

function classifyStatus(deadlineIso) {
  if (!deadlineIso) return "open";

  const now = new Date();
  const deadline = new Date(deadlineIso);

  if (deadline < now) return "closed";
  return "open";
}

function chooseBestRecord(existing, incoming) {
  const score = (x) => {
    let s = 0;
    if (x.store && x.store !== "不明店舗") s += 5;
    if (x.apply_url && !/x\.com|twitter\.com/i.test(x.apply_url)) s += 4;
    if (x.deadline_iso) s += 3;
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

  const normalized = raw.map(r => {
    const apply_url = r.apply_url_raw || null;
    const store = normalizeStoreName(r.store_raw, apply_url);
    const product = normalizeProduct(r.product_raw);
    const deadline_iso = parseJPDate(r.entry_end_raw);
    const deadline_text = formatDeadlineText(deadline_iso);
    const status = classifyStatus(deadline_iso);

    const idSeed = [
      store,
      product,
      apply_url || "",
      deadline_iso || ""
    ].join("|");

    return {
      id: sha1(idSeed),
      store,
      product,
      deadline_text,
      deadline_iso,
      apply_url,
      status,
      _debug: {
        source: r.source,
        detail_url: r.detail_url,
        section_heading: r.section_heading || null,
        product_raw: r.product_raw || null,
        entry_end_raw: r.entry_end_raw || null,
        conditions_raw: r.conditions_raw || null
      }
    };
  }).filter(x => {
    if (!x.product) return false;
    if (!x.apply_url) return false;
    if (x.store === "不明店舗" && /x\.com|twitter\.com/i.test(x.apply_url)) return false;
    return true;
  });

  const dedupedMap = new Map();
  for (const item of normalized) {
    const existing = dedupedMap.get(item.id);
    if (!existing) {
      dedupedMap.set(item.id, item);
    } else {
      dedupedMap.set(item.id, chooseBestRecord(existing, item));
    }
  }

  const deduped = Array.from(dedupedMap.values())
    .sort((a, b) => {
      if (!a.deadline_iso && !b.deadline_iso) return a.store.localeCompare(b.store, "ja");
      if (!a.deadline_iso) return 1;
      if (!b.deadline_iso) return -1;
      return new Date(a.deadline_iso) - new Date(b.deadline_iso);
    })
    .slice(0, MAX_ITEMS);

  const latest = deduped
    .filter(x => x.status === "open")
    .map(({ _debug, ...rest }) => rest);

  const debug = deduped.map(x => x);

  console.log(`[info] normalized: ${normalized.length}, deduped: ${deduped.length}, latest: ${latest.length}`);

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
    sample: latest.slice(0, 5)
  }, null, 2));

  console.log("[ok] output files written");
}

main().catch(err => {
  console.error("[fatal]", err);
  process.exit(1);
});
