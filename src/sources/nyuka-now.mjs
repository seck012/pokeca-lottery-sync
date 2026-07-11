import * as cheerio from "cheerio";

const SOURCE_URL = "https://nyuka-now.com/archives/2459";

function cleanText(value = "") {
  return String(value)
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function absolutize(url) {
  try {
    return new URL(url, SOURCE_URL).toString();
  } catch {
    return "";
  }
}

function firstHref($td) {
  if (!$td || !$td.length) return "";
  const href = $td.find("a[href]").first().attr("href");
  return href ? absolutize(href) : "";
}

function cleanProduct(value = "") {
  let s = cleanText(value);

  s = s.replace(/^ポケモンカード\s*/, "");
  s = s.replace(/\s+/g, " ").trim();

  if (!s) return "";

  // 商品名ではない文を除外
  if (/^(当選者|応募には|※|詳細は|ジョーシンアプリ|シーガルモバイル会員限定)/.test(s)) {
    return "";
  }
  if (/^(WEB抽選受付|アプリ抽選受付|店頭販売|オンライン販売)/.test(s)) {
    return "";
  }
  if (/Amazonでの販売予想価格/.test(s)) {
    return "";
  }

  return s;
}

function pickProducts($, $td) {
  const liItems = $td
    .find("li")
    .map((_, el) => cleanProduct($(el).text()))
    .get()
    .filter(Boolean);

  const linkItems = $td
    .find("a")
    .map((_, el) => cleanProduct($(el).text()))
    .get()
    .filter(Boolean);

  const rawText = cleanProduct($td.text());

  const list =
    liItems.length > 0
      ? liItems
      : linkItems.length > 0
      ? linkItems
      : rawText
      ? [rawText]
      : [];

  return [...new Set(list)];
}

function extractRows($, $table) {
  const rows = new Map();

  $table.find("tr").each((_, tr) => {
    const $tr = $(tr);
    const key = cleanText($tr.find("th").first().text());
    const $td = $tr.find("td").first();

    if (key && $td.length) {
      rows.set(key, $td);
    }
  });

  return rows;
}

function nextTableForHeading($, $h3) {
  let $node = $h3.next();

  while ($node.length) {
    if ($node.is("h2, h3")) break;

    if ($node.is("table")) {
      return $node;
    }

    const $nested = $node.find("table").first();
    if ($nested.length) {
      return $nested;
    }

    $node = $node.next();
  }

  return null;
}

export async function scrapeNyukaNow() {
  const res = await fetch(SOURCE_URL, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
      "accept-language": "ja,en;q=0.9",
      accept: "text/html,application/xhtml+xml",
    },
  });

  if (!res.ok) {
    throw new Error(`nyuka-now fetch failed: ${res.status}`);
  }

  const html = await res.text();
  const $ = cheerio.load(html);

  const $root = $("article").first().length
    ? $("article").first()
    : $("main").first().length
    ? $("main").first()
    : $.root();

  const items = [];

  $root.find("h3").each((_, h3) => {
    const $h3 = $(h3);
    const store = cleanText($h3.text());

    if (!store) return;

    const $table = nextTableForHeading($, $h3);
    if (!$table || !$table.length) return;

    const rows = extractRows($, $table);

    const productTd = rows.get("対象商品");
    const endTd = rows.get("終了日");

    // 抽選テーブル以外は無視
    if (!productTd || !endTd) return;

    const products = pickProducts($, productTd);

    const detailUrl = firstHref(rows.get("詳細ページ"));
    const applyPageUrl = firstHref(rows.get("応募ページ"));
    const fallbackProductUrl = firstHref(productTd);
    const applyUrl = applyPageUrl || detailUrl || fallbackProductUrl;

    const base = {
      source: "nyuka-now",
      sourceUrl: SOURCE_URL,
      store,
      lotteryType: cleanText(rows.get("抽選形式")?.text() || ""),
      entryStartText: cleanText(rows.get("開始日")?.text() || ""),
      entryEndText: cleanText(endTd.text() || ""),
      announceText: cleanText(rows.get("当選発表")?.text() || ""),
      conditions: cleanText(rows.get("応募条件")?.text() || ""),
      applyUrl,
      apply_url: applyUrl,
      detailUrl: detailUrl || fallbackProductUrl,
      detail_url: detailUrl || fallbackProductUrl,
    };

    if (products.length === 0) {
      items.push({
        ...base,
        product: "不明商品",
        products: [],
      });
      return;
    }

    for (const product of products) {
      items.push({
        ...base,
        product,
        products,
      });
    }
  });

  return items;
}

export default scrapeNyukaNow;
