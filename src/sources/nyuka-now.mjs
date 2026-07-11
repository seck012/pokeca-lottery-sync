import * as cheerio from "cheerio";

const SOURCE_URL = "https://nyuka-now.com/archives/2459";

const UA_LIST = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
];

function pickUa(i) {
  return UA_LIST[i % UA_LIST.length];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url, { retries = 3, timeoutMs = 15000 } = {}) {
  let lastErr;

  for (let i = 0; i < retries; i += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    const bustedUrl = url + (url.includes("?") ? "&" : "?") + "ts=" + Date.now();

    try {
      const res = await fetch(bustedUrl, {
        signal: ctrl.signal,
        redirect: "follow",
        headers: {
          "user-agent": pickUa(i),
          "accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "accept-language": "ja,en-US;q=0.9,en;q=0.8",
          "accept-encoding": "gzip, deflate, br",
          "cache-control": "no-cache",
          "pragma": "no-cache",
          "referer": "https://www.google.com/",
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
          "sec-fetch-site": "cross-site",
          "sec-fetch-user": "?1",
          "upgrade-insecure-requests": "1",
        },
      });

      clearTimeout(timer);

      if (!res.ok) {
        throw new Error(
          "nyuka-now http " + res.status + " (attempt " + (i + 1) + ")"
        );
      }

      const html = await res.text();

      if (!html || html.length < 1000) {
        throw new Error(
          "nyuka-now body too short: " +
            (html ? html.length : 0) +
            " bytes (attempt " +
            (i + 1) +
            ")"
        );
      }

      return html;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      const wait = 1500 * Math.pow(2, i);
      console.error(
        "[warn] nyuka-now fetch attempt " +
          (i + 1) +
          " failed: " +
          (err && err.message ? err.message : String(err)) +
          " -> retry in " +
          wait +
          "ms"
      );
      await sleep(wait);
    }
  }

  throw new Error(
    "nyuka-now fetch failed after retries: " +
      (lastErr && lastErr.message ? lastErr.message : String(lastErr))
  );
}

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
  const html = await fetchWithRetry(SOURCE_URL, {
    retries: 3,
    timeoutMs: 15000,
  });

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
