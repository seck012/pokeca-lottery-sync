import { fetch } from "undici";
import * as cheerio from "cheerio";

const SOURCE_URL = "https://nyuka-now.com/archives/2459";

function cleanText(text) {
  return (text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isInternalNyukaUrl(url) {
  return /^https?:\/\/nyuka-now\.com\/archives\//i.test(url || "");
}

function scoreApplyUrl(url) {
  if (!url) return -1;
  if (/docs\.google\.com\/forms/i.test(url)) return 100;
  if (/shop\.pokemon\.co\.jp/i.test(url)) return 95;
  if (/kidsrepublic\.jp/i.test(url)) return 90;
  if (/ryuunoshippo/i.test(url)) return 88;
  if (/joshin/i.test(url)) return 88;
  if (/aeon/i.test(url)) return 85;
  if (/select-type\.com/i.test(url)) return 84;
  if (/livepocket\.jp/i.test(url)) return 80;
  if (/membercard\.jp/i.test(url)) return 78;
  if (/x\.com|twitter\.com/i.test(url)) return 10;
  if (isInternalNyukaUrl(url)) return 0;
  return 50;
}

function chooseBestApplyUrl(urls) {
  const unique = [...new Set((urls || []).filter(Boolean))]
    .filter(url => !isInternalNyukaUrl(url));

  if (unique.length === 0) return null;

  unique.sort((a, b) => scoreApplyUrl(b) - scoreApplyUrl(a));
  return unique[0] || null;
}

function extractProductItems($, td) {
  const items = [];

  const lis = td.find("li");
  if (lis.length > 0) {
    lis.each((_, li) => {
      const txt = cleanText($(li).text());
      if (txt) items.push(txt);
    });
  } else {
    const anchorTexts = td.find("a").map((_, a) => cleanText($(a).text())).get().filter(Boolean);
    if (anchorTexts.length > 0) {
      items.push(...anchorTexts);
    } else {
      const txt = cleanText(td.text());
      if (txt) items.push(txt);
    }
  }

  return [...new Set(items)];
}

function parseTable($, table, sectionHeading) {
  const obj = {
    source: "nyuka-now",
    detail_url: SOURCE_URL,
    section_heading: cleanText(sectionHeading),
    store_raw: cleanText(sectionHeading),
    product_items_raw: [],
    entry_start_raw: null,
    entry_end_raw: null,
    announce_at_raw: null,
    conditions_raw: null,
    apply_url_raw: null
  };

  const applyCandidates = [];

  $(table).find("tr").each((_, tr) => {
    const key = cleanText($(tr).find("th").first().text());
    const td = $(tr).find("td").first();

    if (!key || td.length === 0) return;

    const val = cleanText(td.text());

    if (key.includes("対象商品")) {
      obj.product_items_raw = extractProductItems($, td);
    } else if (key.includes("開始日")) {
      obj.entry_start_raw = val;
    } else if (key.includes("終了日") || key.includes("締切")) {
      obj.entry_end_raw = val;
    } else if (key.includes("当選発表")) {
      obj.announce_at_raw = val;
    } else if (key.includes("応募条件")) {
      obj.conditions_raw = val;
    } else if (key.includes("詳細ページ") || key.includes("応募ページ")) {
      td.find("a[href]").each((__, a) => {
        const href = $(a).attr("href");
        if (href) applyCandidates.push(href);
      });
    }
  });

  obj.apply_url_raw = chooseBestApplyUrl(applyCandidates);

  if (!obj.store_raw) return null;
  if (!obj.product_items_raw || obj.product_items_raw.length === 0) return null;
  if (!obj.apply_url_raw && !obj.entry_end_raw) return null;

  return obj;
}

export async function scrapeNyukaNow() {
  const res = await fetch(SOURCE_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; PokecaLotterySync/3.0)"
    }
  });

  if (!res.ok) {
    throw new Error(`nyuka-now fetch failed: ${res.status}`);
  }

  const html = await res.text();
  const $ = cheerio.load(html);

  const startH2 = $("h2").filter((_, el) => {
    const txt = cleanText($(el).text());
    return txt.includes("抽選・予約応募受付中のストア");
  }).first();

  if (startH2.length === 0) {
    throw new Error("target section '抽選・予約応募受付中のストア' not found");
  }

  const items = [];
  let currentHeading = null;
  let node = startH2.next();

  while (node.length > 0) {
    const tag = (node.get(0)?.tagName || node.get(0)?.name || "").toLowerCase();

    if (tag === "h2") break;

    if (tag === "h3") {
      currentHeading = cleanText(node.text());
    }

    if (tag === "table" && currentHeading) {
      const parsed = parseTable($, node, currentHeading);
      if (parsed) items.push(parsed);
    }

    node = node.next();
  }

  console.log(`[nyuka-now] extracted ${items.length} raw table records`);
  return items;
}
