/**
 * 定价专用存储层。所有读写都限定在 PRICING_DIR（data/pricing/）下。
 */
import { appendFile, readFile, writeFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";

import { PRICING_DIR, isoToPath } from "./pricing-util.js";

// ---- 通用 ----

async function appendJsonl(filePath, row) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await appendFile(filePath, JSON.stringify(row) + "\n", "utf-8");
}

function tsToDatePath(ts) {
  return isoToPath(ts.slice(0, 10)); // "2026/09/18"
}

// ---- crawls / points 写入（方案 5.1 / 5.2）----

/**
 * 本地/CI 手动重跑同一轮（同一 4h slot）时避免重复观测：
 * 同一文件内按 (ts, country, app_id, source | item_key) 去重，已存在则跳过。
 * 返回本次实际写入的行数（便于调试）。
 */
async function appendDeduped(file, rows, keyOf) {
  const seen = new Set();
  try {
    const text = await readFile(file, "utf-8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        seen.add(keyOf(JSON.parse(line)));
      } catch { /* 忽略损坏行 */ }
    }
  } catch { /* 文件不存在 = 全新 */ }
  let written = 0;
  for (const row of rows) {
    const key = keyOf(row);
    if (seen.has(key)) continue;
    seen.add(key);
    await appendJsonl(file, row);
    written++;
  }
  return written;
}

export async function appendCrawls(rows) {
  if (rows.length === 0) return 0;
  const file = join(PRICING_DIR, "crawls", `${tsToDatePath(rows[0].ts)}.jsonl`);
  return appendDeduped(file, rows, (r) => `${r.ts}|${r.country}|${r.app_id}|${r.source}`);
}

export async function appendPoints(rows) {
  if (rows.length === 0) return 0;
  const file = join(PRICING_DIR, "points", `${tsToDatePath(rows[0].ts)}.jsonl`);
  return appendDeduped(file, rows, (r) => `${r.ts}|${r.country}|${r.app_id}|${r.item_key}`);
}

// ---- rollup/daily 覆盖写（方案 5.3，复用 replaceDaily 的语义）----

/**
 * 覆盖式写入北京日 D 的 daily 行。
 * dateBeijing: "YYYY-MM-DD"
 * 文件按北京年-月组织：rollup/daily/2026-09.jsonl；同月其它日期的行保留。
 */
export async function replaceDaily(dateBeijing, rows) {
  const month = dateBeijing.slice(0, 7); // "2026-09"
  const filePath = join(PRICING_DIR, "rollup", "daily", `${month}.jsonl`);
  const dir = dirname(filePath);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });

  const kept = [];
  try {
    const text = await readFile(filePath, "utf-8");
    for (const line of text.trim().split("\n")) {
      if (!line) continue;
      const row = JSON.parse(line);
      if (row.date_beijing !== dateBeijing) kept.push(row);
    }
  } catch {
    // 文件不存在，从空开始
  }

  const merged = [...kept, ...rows];
  merged.sort((a, b) => (a.date_beijing === b.date_beijing ? 0 : a.date_beijing < b.date_beijing ? -1 : 1));
  await writeFile(filePath, merged.map((r) => JSON.stringify(r)).join("\n") + (merged.length ? "\n" : ""), "utf-8");
}

// ---- 读取 ----

/** 读取指定 UTC 日期文件（含当日全部行）。 */
async function readDateFile(sub, date) {
  const rows = [];
  const file = join(PRICING_DIR, sub, `${isoToPath(date)}.jsonl`);
  try {
    const text = await readFile(file, "utf-8");
    for (const line of text.trim().split("\n")) {
      if (line) rows.push(JSON.parse(line));
    }
  } catch {
    // 文件不存在
  }
  return rows;
}

/** 按 UTC 日期范围读 points。from/to: "YYYY-MM-DD"。 */
export async function loadPointsRange(from, to) {
  const rows = [];
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  let [y, m, d] = [fy, fm, fd];
  while (y < ty || (y === ty && (m < tm || (m === tm && d <= td)))) {
    rows.push(...(await readDateFile("points", `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`)));
    d++;
    const dt = new Date(Date.UTC(y, m - 1, d));
    y = dt.getUTCFullYear();
    m = dt.getUTCMonth() + 1;
    d = dt.getUTCDate();
  }
  return rows;
}

/** 按 UTC 日期范围读 crawls。 */
export async function loadCrawlsRange(from, to) {
  const rows = [];
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  let [y, m, d] = [fy, fm, fd];
  while (y < ty || (y === ty && (m < tm || (m === tm && d <= td)))) {
    rows.push(...(await readDateFile("crawls", `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`)));
    d++;
    const dt = new Date(Date.UTC(y, m - 1, d));
    y = dt.getUTCFullYear();
    m = dt.getUTCMonth() + 1;
    d = dt.getUTCDate();
  }
  return rows;
}

/** 按北京日读取 points（跨 UTC 两个文件 + ts 过滤，见方案 2.5 映射）。 */
export async function loadPointsBeijingDay(beijingDate, { tsFrom, tsTo }) {
  const rows = await loadPointsRange(tsFrom.slice(0, 10), tsTo.slice(0, 10));
  return rows.filter((p) => p.ts >= tsFrom && p.ts < tsTo);
}

/** 读取指定月份集合的 daily rollup。months: ["2026-09"]。 */
export async function loadDaily(months) {
  const rows = [];
  for (const m of months) {
    const file = join(PRICING_DIR, "rollup", "daily", `${m}.jsonl`);
    try {
      const text = await readFile(file, "utf-8");
      for (const line of text.trim().split("\n")) {
        if (line) rows.push(JSON.parse(line));
      }
    } catch {
      // 文件不存在
    }
  }
  return rows;
}

/** 读取 alerts.jsonl 全部行。 */
export async function loadAlerts() {
  const file = join(PRICING_DIR, "alerts.jsonl");
  const rows = [];
  try {
    const text = await readFile(file, "utf-8");
    for (const line of text.trim().split("\n")) {
      if (line) rows.push(JSON.parse(line));
    }
  } catch {
    // 文件不存在
  }
  return rows;
}

/** 追加一行告警。 */
export async function appendAlert(row) {
  const file = join(PRICING_DIR, "alerts.jsonl");
  await appendJsonl(file, row);
}

// ---- meta（方案 4.2：只缓存 name/artwork/currency，绝不缓存 price）----

/**
 * 读定价专用 meta。
 * 返回 { apps: { [app_id|country]: {...} }, fetched_at } 或 null。
 */
export async function loadPricingMeta() {
  try {
    return JSON.parse(await readFile(join(PRICING_DIR, "meta/apps.json"), "utf-8"));
  } catch {
    return null;
  }
}

/**
 * 保存定价专用 meta。m: Map<"app_id|country", {name, artworkUrl, currency, kind}>
 */
export async function savePricingMeta(appsMap, fetchedAt) {
  const dir = join(PRICING_DIR, "meta");
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "apps.json"),
    JSON.stringify({ apps: Object.fromEntries(appsMap), fetched_at: fetchedAt }, null, 2) + "\n"
  );
}

// ---- 清理（方案 5.5）----

/**
 * 列出 data/pricing/<sub>/ 下的所有文件路径及 UTC 日期。
 * sub: "points" | "crawls"
 */
export async function listFiles(sub) {
  const files = [];
  const base = join(PRICING_DIR, sub);
  try {
    const years = await readdir(base);
    for (const year of years) {
      const yearDir = join(base, year);
      if (!(await stat(yearDir)).isDirectory()) continue;
      const months = await readdir(yearDir);
      for (const month of months) {
        const monthDir = join(yearDir, month);
        if (!(await stat(monthDir)).isDirectory()) continue;
        const days = await readdir(monthDir);
        for (const day of days) {
          if (day.endsWith(".jsonl")) {
            files.push({
              path: join(sub, year, month, day),
              date: `${year}-${month}-${day.replace(".jsonl", "")}`,
            });
          }
        }
      }
    }
  } catch {
    // 目录不存在
  }
  return files;
}

/** 删除定价数据目录下的文件（用于清理）。 */
export async function deletePricingFile(relPath) {
  try {
    await unlink(join(PRICING_DIR, relPath));
    return true;
  } catch {
    return false;
  }
}