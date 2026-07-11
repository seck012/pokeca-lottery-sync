import { scrapeNyukaNow } from "./sources/nyuka-now.mjs";
import { normalizeAll } from "./lib/normalize.mjs";
import { dedupeItems } from "./lib/dedupe.mjs";
import fs from "node:fs/promises";

const MAX_ITEMS = 300;

async function main() {
  const results = await Promise.allSettled([
    scrapeNyukaNow()
  ]);

  const raw = results.flatMap(r =>
    r.status === "fulfilled" ? r.value : []
  );

  console.log(`[info] raw items: ${raw.length}`);

  if (raw.length === 0) {
    console.error("[error] no items scraped from any source");
    process.exit(1);
  }

  if (raw.length > 1000) {
    console.error(`[error] suspicious item count: ${raw.length}`);
    process.exit(1);
  }

  const normalized = normalizeAll(raw);
  const deduped = dedupeItems(normalized).slice(0, MAX_ITEMS);
  const latest = deduped.filter(x => x.status === "open" || x.status === "upcoming");

  console.log(`[info] normalized: ${normalized.length}, deduped: ${deduped.length}, latest: ${latest.length}`);

  await fs.mkdir("output", { recursive: true });
  await fs.writeFile("output/normalized.json", JSON.stringify(deduped, null, 2));
  await fs.writeFile("output/latest.json", JSON.stringify(latest, null, 2));
  await fs.writeFile("output/debug.json", JSON.stringify({
    rawCount: raw.length,
    normalizedCount: normalized.length,
    dedupedCount: deduped.length,
    latestCount: latest.length,
    generatedAt: new Date().toISOString()
  }, null, 2));

  console.log("[ok] output files written");
}

main().catch(err => {
  console.error("[fatal]", err);
  process.exit(1);
});
