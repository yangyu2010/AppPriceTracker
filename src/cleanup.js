/**
 * 数据保留与清理（方案 5.5）。
 *
 * 规则：points / crawls 保留 90 天，daily rollup 永久保留（看板 1月/3月档依赖）。
 *
 * 用法：
 *   node src/cleanup.js --older-than 90 --scope pricing
 *   node src/cleanup.js --scope all        # 全部定价子目录
 *   node src/cleanup.js                     # 默认 pricing + 90 天
 *
 * 只删 data/pricing/points 与 data/pricing/crawls（by UTC 日期文件），
 * data/pricing/rollup/daily、meta、current.json、alerts.jsonl 永不动。
 */
import { listFiles, deletePricingFile } from "./price-store.js";

async function main() {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--older-than");
  const days = idx >= 0 && args[idx + 1] ? parseInt(args[idx + 1], 10) : 90;
  const scopeIdx = args.indexOf("--scope");
  const scope = scopeIdx >= 0 && args[scopeIdx + 1] ? args[scopeIdx + 1] : "pricing";
  if (!["pricing", "all"].includes(scope)) {
    console.error(`[cleanup] unknown scope "${scope}" (pricing|all)`);
    process.exit(1);
  }

  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  console.log(`[cleanup] scope=${scope} removing files older than ${cutoffStr} (${days} days)`);

  const subs = scope === "all" ? ["points", "crawls"] : ["points", "crawls"]; // pricing 总是两处
  let deleted = 0;
  let kept = 0;

  for (const sub of subs) {
    const files = await listFiles(sub);
    for (const file of files) {
      if (file.date < cutoffStr) {
        const ok = await deletePricingFile(file.path);
        if (ok) {
          console.log(`[cleanup] deleted ${file.path} (${file.date})`);
          deleted++;
        } else {
          console.warn(`[cleanup] failed to delete ${file.path}`);
        }
      } else {
        kept++;
      }
    }
  }

  console.log(`[cleanup] done: ${deleted} deleted, ${kept} kept`);
}

main().catch((err) => {
  console.error("[cleanup] fatal:", err);
  process.exit(1);
});