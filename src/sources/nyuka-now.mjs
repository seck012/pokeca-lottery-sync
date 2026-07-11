import { fetch } from "undici";
import * as cheerio from "cheerio";

const SOURCE_URL = "https://nyuka-now.com/archives/2459";

export async function scrapeNyukaNow() {
  const res = await fetch(SOURCE_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; PokecaLotterySync/1.0)"
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
      detail_url: SOURCE_URL
    };

    let storeCandidate = null;
    const prevH3 = $(table).prevAll("h3, h4").first().text().trim();
    if (prevH3) storeCandidate = prevH3;

    $(table).find("tr").each((__, tr) => {
      const key = $(tr).find("th").first().text().trim();
      const td = $(tr).find("td").first();
      const val = td.text().trim();
      const href = td.find("a").attr("href");

      if (!key) return;

      if (key.includes("対象商品")) obj.product_raw = val;
      else if (key.includes("抽選形式")) obj.lottery_type = val;
      else if (key.includes("開始日")) obj.entry_start_raw = val;
      else if (key.includes("終了日") || key.includes("締切")) obj.entry_end_raw = val;
      else if (key.includes("当選発表")) obj.announce_at_raw = val;
      else if (key.includes("応募条件")) obj.conditions = val;
      else if (key.includes("応募ページ") || key.includes("詳細ページ")) {
        obj.apply_url = href || null;
      }
    });

    if (storeCandidate) obj.store = storeCandidate;

    if (obj.product_raw && (obj.entry_end_raw || obj.apply_url)) {
      items.push(obj);
    }
  });

  console.log(`[nyuka-now] extracted ${items.length} items`);
  return items;
}
