import { fetch } from "undici";
import * as cheerio from "cheerio";

const SOURCE_URL = "https://nyuka-now.com/archives/2459";

function cleanText(text) {
  return (text || "")
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}

function normalizeStoreName(name) {
  const t = cleanText(name);

  if (!t) return null;

  const rules = [
    [/ヨドバシ/i, "ヨドバシカメラ"],
    [/ポケモンセンター/i, "ポケモンセンターオンライン"],
    [/キッズリパブリック/i, "キッズリパブリック"],
    [/ライブポケット|LivePocket/i, "LivePocket"],
    [/ビックカメラ/i, "ビックカメラ"],
    [/ヤマダ/i, "ヤマダデンキ"],
    [/イオン/i, "イオン"],
    [/楽天ブックス/i, "楽天ブックス"],
    [/Amazon/i, "Amazon"],
    [/HMV/i, "HMV"],
    [/TSUTAYA/i, "TSUTAYA"],
    [/セブンネット/i, "セブンネット"],
    [/古本市場/i, "古本市場"],
    [/駿河屋/i, "駿河屋"]
  ];

  for (const [pattern, normalized] of rules) {
    if (pattern.test(t)) return normalized;
  }

  return t;
}

function inferStoreFromUrl(url) {
  if (!url) return null;

  const map = [
    [/limited\.yodobashi\.com/i, "ヨドバシカメラ"],
    [/kidsrepublic\.jp/i, "キッズリパブリック"],
    [/shop\.pokemon\.co\.jp/i, "ポケモンセンターオンライン"],
    [/livepocket\.jp/i, "LivePocket"],
    [/biccamera\.com/i, "ビックカメラ"],
    [/rakuten/i, "楽天系ストア"],
    [/amazon\./i, "Amazon"],
    [/7net/i, "セブンネット"],
    [/hmv\.co\.jp/i, "HMV"],
    [/suruga-ya/i, "駿河屋"]
  ];

  for (const [pattern, name] of map) {
    if (pattern.test(url)) return name;
  }

  return null;
}

function looksLikeBadProduct(text) {
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

  return banned.some(word => t.includes(word));
}

function pickBestApplyUrl(links) {
  if (!Array.isArray(links) || links.length === 0) return null;

  const unique = [...new Set(links.filter(Boolean))];

  const score = (url) => {
    if (/shop\.pokemon\.co\.jp/i.test(url)) return 100;
    if (/limited\.yodobashi\.com/i.test(url)) return 95;
    if (/kidsrepublic\.jp/i.test(url)) return 90;
    if (/livepocket\.jp/i.test(url)) return 80;
    if (/rakuten|amazon|biccamera|7net|hmv|suruga-ya/i.test(url)) return 70;
    if (/x\.com|twitter\.com/i.test(url)) return 10;
    return 50;
  };

  unique.sort((a, b) => score(b) - score(a));
  return unique[0] || null;
}

export async function scrapeNyukaNow() {
  const res = await fetch(SOURCE_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; PokecaLotterySync/2.0)"
    }
  });

  if (!res.ok) {
    throw new Error(`nyuka-now fetch failed: ${res.status}`);
  }

  const html = await res.text();
  const $ = cheerio.load(html);
  const items = [];

  $("table").each((_, table) => {
    const obj = {
      source: "nyuka-now",
      detail_url: SOURCE_URL,
      links: []
    };

    const $table = $(table);

    const headingCandidates = [];
    $table.prevAll("h2, h3, h4").slice(0, 3).each((__, el) => {
      const txt = cleanText($(el).text());
      if (txt) headingCandidates.push(txt);
    });

    obj.section_heading = headingCandidates[0] || null;

    $table.find("a[href]").each((__, a) => {
      const href = $(a).attr("href");
      if (href) obj.links.push(href);
    });

    $table.find("tr").each((__, tr) => {
      const key = cleanText($(tr).find("th").first().text());
      const td = $(tr).find("td").first();
      const val = cleanText(td.text());
      const href = td.find("a").attr("href");

      if (!key) return;

      if (key.includes("対象商品")) obj.product_raw = val;
      else if (key.includes("抽選形式")) obj.lottery_type = val;
      else if (key.includes("開始日")) obj.entry_start_raw = val;
      else if (key.includes("終了日") || key.includes("締切")) obj.entry_end_raw = val;
      else if (key.includes("当選発表")) obj.announce_at_raw = val;
      else if (key.includes("応募条件")) obj.conditions_raw = val;
      else if (key.includes("応募ページ") || key.includes("詳細ページ")) {
        if (href) obj.links.push(href);
      }
    });

    const storeFromHeading = normalizeStoreName(obj.section_heading);
    const storeFromUrl = inferStoreFromUrl(pickBestApplyUrl(obj.links));
    obj.store_raw = storeFromHeading || storeFromUrl || "不明店舗";

    obj.apply_url_raw = pickBestApplyUrl(obj.links);

    if (!obj.product_raw || looksLikeBadProduct(obj.product_raw)) return;
    if (!obj.apply_url_raw && !obj.entry_end_raw) return;

    items.push(obj);
  });

  console.log(`[nyuka-now] extracted ${items.length} items`);
  return items;
}
