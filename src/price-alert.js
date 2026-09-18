/**
 * 变更告警（方案 7.5）。
 *
 * 只在相对上一轮发生变化时输出，不变不刷屏：
 *   - 价格变动（delta !== 0）
 *   - 内购出现 / 消失（appeared 翻转）
 *   - 状态变化（status 变化，如 ok → unavailable / error）
 *
 * 输出：终端 / Job Summary；另追加写 data/pricing/alerts.jsonl。
 * unavailable / 采集失败类状态告警按北京日去重，当日只报一次。
 */
import { loadAlerts, appendAlert } from "./price-store.js";
import { beijingDateOf, esc } from "./pricing-util.js";

/**
 * 对比当前 current 与上一轮 prevCurrent，产出并落盘告警。
 * prevCurrent 为 null（首次运行）时只做基线，不报任何告警。
 */
export async function runAlerts({ ts, current, prevCurrent }) {
  const today = beijingDateOf(ts);
  let existingAlerts = [];
  try {
    existingAlerts = await loadAlerts();
  } catch {
    existingAlerts = [];
  }
  // 当日已报过的状态类告警（country|app_id|event）→ 去重
  const statusReported = new Set(
    existingAlerts
      .filter((a) => a.event === "status_change" && a.ts.startsWith(today.slice(0, 8)) && beijingDateOf(a.ts) === today)
      .map((a) => `${a.country}|${a.app_id}|${a.event}`)
  );

  const events = [];

  for (const app of current.apps) {
    const prevApp = prevCurrent?.apps?.find(
      (p) => String(p.app_id) === String(app.app_id) && p.country === app.country
    );

    const appId = String(app.app_id);

    // 1) 价格变动（delta !== 0 且非首次出现）
    for (const item of app.items || []) {
      if (item.delta === null || item.delta === undefined || item.delta === 0) continue;
      const prevPrice =
        item.delta !== null && typeof item.price === "number"
          ? Math.round((item.price - item.delta) * 100) / 100
          : null;
      events.push({
        event: "price_change",
        ts,
        country: app.country,
        app_id: appId,
        item_key: item.item_key,
        kind: item.item_kind || "iap",
        old_price: prevPrice,
        new_price: item.price,
      });
    }

    // 2) 内购出现（上一轮无此 item_key，本轮有）
    if (prevApp) {
      const prevKeys = new Set((prevApp.items || []).map((i) => i.item_key));
      for (const item of app.items || []) {
        if (prevKeys.has(item.item_key)) continue;
        events.push({
          event: "appeared",
          ts,
          country: app.country,
          app_id: appId,
          item_key: item.item_key,
          kind: item.item_kind || "iap",
          old_price: null,
          new_price: item.price,
        });
      }

      // 3) 内购消失（上一轮有，本轮无）
      const curKeys = new Set((app.items || []).map((i) => i.item_key));
      for (const prevItem of prevApp.items || []) {
        if (curKeys.has(prevItem.item_key)) continue;
        events.push({
          event: "disappeared",
          ts,
          country: app.country,
          app_id: appId,
          item_key: prevItem.item_key,
          kind: prevItem.item_kind || "iap",
          old_price: prevItem.price,
          new_price: null,
        });
      }
    }

    // 4) 状态变化；unavailable/error 当日只报一次
    if (prevApp && prevApp.status !== app.status) {
      const key = `${app.country}|${appId}|status_change`;
      if (statusReported.has(key)) {
        // 当日已报过，跳过
      } else {
        events.push({
          event: "status_change",
          ts,
          country: app.country,
          app_id: appId,
          item_key: "__app__",
          kind: "status",
          old_price: prevApp.status,
          new_price: app.status,
        });
        statusReported.add(key);
      }
    }
  }

  if (events.length === 0) {
    console.log("[alerts] 无变化，不输出告警");
    return [];
  }

  for (const e of events) {
    await appendAlert(e);
    console.log(
      `[alert] ${e.event} ${e.country}/${e.app_id}${e.item_key ? "/" + e.item_key : ""} ` +
        `old=${fmtPrice(e.old_price)} new=${fmtPrice(e.new_price)}`
    );

    // GitHub Actions Job Summary
    if (process.env.GITHUB_STEP_SUMMARY) {
      const { appendFile } = await import("node:fs/promises");
      const lines = events.map(
        (ev) =>
          `| ${beijingDateOf(ev.ts) + " " + ev.ts.slice(11, 16)} | ${ev.country.toUpperCase()} | ${esc(ev.app_id)} | ${esc(ev.item_key || "—")} | ${ev.event} | ${fmtPrice(ev.old_price)} → ${fmtPrice(ev.new_price)} |`
      );
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `### Price Alerts (北京时间)\n\n| 时间 | 区 | App | 项目 | 事件 | 价格变化 |\n|---|---|---|---|---|---|\n${lines.join("\n")}\n`,
        "utf-8"
      );
    }
  }
  console.log(`[alerts] ${events.length} alerts written`);
  return events;
}

function fmtPrice(v) {
  if (v === null || v === undefined) return "—";
  return String(v);
}