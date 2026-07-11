export function dedupeItems(items) {
  const map = new Map();

  for (const item of items) {
    const existing = map.get(item.id);
    if (!existing) {
      map.set(item.id, item);
      continue;
    }

    const existingScore = scoreItem(existing);
    const newScore = scoreItem(item);
    if (newScore > existingScore) {
      map.set(item.id, item);
    }
  }

  return Array.from(map.values()).sort((a, b) => {
    if (a.entry_end && b.entry_end) {
      return new Date(a.entry_end) - new Date(b.entry_end);
    }
    if (a.entry_end) return -1;
    if (b.entry_end) return 1;
    return 0;
  });
}

function scoreItem(item) {
  let score = 0;
  if (item.apply_url) score += 3;
  if (item.entry_end) score += 2;
  if (item.entry_start) score += 1;
  if (item.announce_at) score += 1;
  if (item.conditions) score += 1;
  if (item.region) score += 1;
  return score;
}
