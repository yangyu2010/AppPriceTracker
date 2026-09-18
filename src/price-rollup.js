/**
 * 定价日聚合（方案 5.3 / 2.5）。
 *
 * 键：date_beijing + country + app_id + item_key。
 * 覆盖写语义：同一北京日每 4 小时会被重算 6 次，replaceDaily 先删该日旧行再写。
 * 北京日↔UTC 文件映射走 pricing-util 的 beijingDayToUtcRange。
 *
 * 用法：
 *   node src/price-rollup.js             # 重算今天（北京日）+ 昨天
 *   node src/price-rollup.js --date 2026-09-18   # 重算指定北京日
 *   node src/price-rollup.js --all       # 全量补算（有 points 的所有 UTC 日期）
 */
import { loadPointsBeijingDay, loadPointsRange, loadDaily, replaceDaily, listFiles } from "./price-store.js";
import { beijingDayToUtcRange, beijingDateOf } from "./pricing-util.js";

/**
 * 对某个北京日做 rollup。
 * 返回写入的 daily 行数。
 */
export async function rollupBeijingDay(beijingDate) {
  const range = beijingDayToUtcRange(beijingDate);
  const points = await loadPointsBeijingDay(beijingDate, range);

  // 每天每个 (app_id, country, item_key) 一组
  const groups = new Map();
  for (const p of points) {
    const key = `${p.app_id}|${p.country}|${p.item_key}`;
    if (!groups.has(key)) {
      groups.set(key, {
        app_id: p.app_id,
        country: p.country,
        item_key: p.item_key,
        item_kind: p.item_kind,
        name: p.name,
        currency: p.currency,
        rows: [],
      });
    }
    groups.get(key).rows.push(p);
  }

  const dailyRows = [];
  for (const [, g] of groups) {
    const sorted = [...g.rows].sort((a, b) => a.ts.localeCompare(b.ts));
    const prices = sorted.map((r) => r.price).filter((v) => typeof v === "number" && isFinite(v));
    const slots = new Set(sorted.map((r) => r.ts)).size;

    dailyRows.push({
      date_beijing: beijingDate,
      country: g.country,
      app_id: g.app_id,
      item_key: g.item_key,
      item_kind: g.item_kind,
      name: g.name,
      currency: g.currency,
      open_price: sorted.length > 0 ? sorted[0].price : null,
      close_price: sorted.length > 0 ? sorted[sorted.length - 1].price : null,
      min_price: prices.length ? Math.min(...prices) : null,
      max_price: prices.length ? Math.max(...prices) : null,
      samples: sorted.length,
      appeared: slots, // 该北京日出现过的 4 小时槽数
    });
  }

  await replaceDaily(beijingDate, dailyRows);
  console.log(`[rollup] ${beijingDate} (Beijing): ${dailyRows.length} daily rows from ${points.length} points`);
  return dailyRows.length;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--all")) {
    const files = await listFiles("points");
    const dates = [...new Set(files.map((f) => f.date))].sort();
    console.log(`[rollup] processing all ${dates.length} UTC dates...`);
    // points 按 UTC 日存，先按 UTC 日逐个读，再按北京日聚合。
    // 北京日横跨两个 UTC 文件，直接对 UTC 日调用 beijingDayToUtcRange 会重复算。
    // 改用「逐个 UTC 日读 points → 转成北京日全集 → 去重再聚合」。
    const beijingDays = new Set();
    for (const d of dates) {
      beijingDays.add(beijingDateOf(d + "T12:00:00Z"));
    }
    let count = 0;
    for (const bd of [...beijingDays].sort()) {
      count += await rollupBeijingDay(bd);
    }
    console.log(`[rollup] done, processed ${count} daily rows`);
    return;
  }

  const dateIdx = args.indexOf("--date");
  if (dateIdx >= 0 && args[dateIdx + 1]) {
    await rollupBeijingDay(args[dateIdx + 1]);
    return;
  }

  // 默认：今天（北京日，force）+ 昨天（北京日）
  const todayBj = beijingDateOf(new Date().toISOString());
  const yesterdayBj = beijingDateOf(new Date(Date.now() - 86400000).toISOString());
  await rollupBeijingDay(todayBj);
  if (yesterdayBj !== todayBj) await rollupBeijingDay(yesterdayBj);
}

// 支持被 price-crawl.js 直接 import 调用；直接运行 node 时走 main。
import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error("[rollup] fatal:", err);
    process.exit(1);
  });
}

export { main as runMain };