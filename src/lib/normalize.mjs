import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const JST = "Asia/Tokyo";

function parseJPDate(raw, referenceYear) {
  if (!raw || raw === "不明" || raw === "-") return null;

  const cleaned = raw.replace(/[（(].*?[）)]/g, "").trim();

  const m = cleaned.match(/(\d{1,2})\/(\d{1,2})(?:.*?(\d{1,2}):(\d{2}))?/);
  if (!m) return null;

  const [, mm, dd, hh, mi] = m;
  const year = referenceYear || dayjs().tz(JST).year();
  const hour = hh ? parseInt(hh, 10) : 23;
  const minute = mi ? parseInt(mi, 10) : 59;

  const d = dayjs.tz(
    `${year}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`,
    JST
  );

  if (!d.isValid()) return null;
  return d.toISOString();
}

function classifyStatus(entry_start, entry_end) {
  const now = dayjs().tz(JST);
  if (entry_end && dayjs(entry_end).isBefore(now)) return "closed";
  if (entry_start && dayjs(entry_start).isAfter(now)) return "upcoming";
  return "open";
}

async function sha1(text) {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-1", buf);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

export function normalizeAll(rawItems) {
  const referenceYear = dayjs().tz(JST).year();
  const results = [];

  for (const r of rawItems) {
    const entry_start = parseJPDate(r.entry_start_raw, referenceYear);
    const entry_end = parseJPDate(r.entry_end_raw, referenceYear);
    const announce_at = parseJPDate(r.announce_at_raw, referenceYear);
    const status = classifyStatus(entry_start, entry_end);

    const store = (r.store || "不明店舗").trim();
    const product = (r.product_raw || "").trim();

    if (!product) continue;

    results.push({
      _pending_id: `${r.source}|${store}|${product}|${entry_end || ""}`,
      source: r.source,
      product,
      store,
      region: r.region || null,
      lottery_type: r.lottery_type || null,
      entry_start,
      entry_end,
      announce_at,
      apply_url: r.apply_url || null,
      detail_url: r.detail_url,
      conditions: r.conditions || null,
      status,
      last_seen_at: new Date().toISOString()
    });
  }

  return Promise.all(
    results.map(async item => {
      const { _pending_id, ...rest } = item;
      const id = await sha1(_pending_id);
      return { id, ...rest };
    })
  );
}
