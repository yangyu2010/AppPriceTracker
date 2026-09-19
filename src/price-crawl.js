/**
 * 定价采集（方案第 4 / 6 节）。
 *
 * 全程串行，每两次请求之间至少间隔 REQUEST_INTERVAL_MS（方案 4.2）。
 * 每轮：lookup 判定付费/免费 → 再拉产品页解析内购（付费 App 同时记下载价 + 内购）。
 * 实测：密集并发（3~5 并发、无间隔）会触发 Apple HTTP 429；30s 间隔零 429。
 *
 * 用法：
 *   node src/price-crawl.js --once              # 一轮（CI 用）
 *   node src/price-crawl.js --loop --interval 14400   # 本地每 4 小时
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { PRICING_DIR } from "./pricing-util.js";
import { alignSlot, beijingDateOf, classifyPricing, parsePriceFromFormatted, COUNTRY_NAMES, PLATFORMS } from "./pricing-util.js";
import { appendCrawls, appendPoints, loadPointsRange, loadCrawlsRange, loadPricingMeta, savePricingMeta, loadAlerts, appendAlert, loadDaily } from "./price-store.js";
import { rollupBeijingDay } from "./price-rollup.js";
import { runAlerts } from "./price-alert.js";

// ============================================================
// 请求节流常量（方案 4.2：「这个间隔是个常量，方便按实际情况修改」）
// ============================================================
const REQUEST_INTERVAL_MS = 30_000; // 两次请求之间的最小间隔
const RETRY_DELAY_MS = 2_000;       // 失败重试前的等待
const RETRY_COUNT = 1;              // 失败后重试次数
const LOOKUP_BATCH_SIZE = 100;      // lookup 每批最多 ID 数
// ============================================================

const LOOKUP_URL = "https://itunes.apple.com/lookup";
const STORE_URL = "https://apps.apple.com";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

const DEFAULT_HEADERS = {
  "User-Agent": USER_AGENT,
  "Accept-Language": "en-US,en;q=0.9",
  Accept: "text/html,application/json,*/*;q=0.8",
};

// 串行节流：整个进程共享一个"上次请求时间"
let lastRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 串行节流 fetch。
 * 每次调用前确保距上次请求 >= REQUEST_INTERVAL_MS。
 * 429 / 5xx / 网络错误 重试 RETRY_COUNT 次，间隔 RETRY_DELAY_MS。
 * 返回 { ok, status, text, json, error }
 */
async function throttledFetch(url, { headers = {}, label = "" } = {}) {
  for (let attempt = 0; attempt <= RETRY_COUNT; attempt++) {
    const wait = lastRequestAt ? REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt) : 0;
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();

    try {
      const resp = await fetch(url, { headers: { ...DEFAULT_HEADERS, ...headers } });
      if (resp.status === 429 || resp.status >= 500) {
        console.warn(`  [retry] ${label || url} HTTP ${resp.status} (attempt ${attempt + 1}/${RETRY_COUNT + 1})`);
        if (attempt < RETRY_COUNT) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        return { ok: false, status: resp.status, error: `HTTP ${resp.status}` };
      }
      return { ok: true, status: resp.status, resp };
    } catch (err) {
      console.warn(`  [retry] ${label || url} network error: ${err.message}`);
      if (attempt < RETRY_COUNT) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      return { ok: false, status: 0, error: String(err.message || err) };
    }
  }
}

// ---------------- 配置加载与启动校验（方案第 3 节） ----------------

function validateConfig(config) {
  const errors = [];
  const seen = new Set();

  for (const app of config.apps) {
    const country = String(app.country || "");
    if (!/^[a-z]{2}$/.test(country)) {
      errors.push(`app id=${app.id}: country 必须为两字母小写店面码，实际 "${country}"`);
      continue;
    }
    if (!COUNTRY_NAMES[country]) {
      errors.push(`app id=${app.id}: country "${country}" 不在合法店面白名单`);
      continue;
    }
    if (!/^\d+$/.test(String(app.id))) {
      errors.push(`country=${country}: id 必须为数字字符串，实际 "${app.id}"`);
      continue;
    }
    const key = `${app.id}|${country}`;
    if (seen.has(key)) {
      errors.push(`重复配置 (id=${app.id}, country=${country}) 不允许出现两行`);
      continue;
    }
    seen.add(key);

    const platforms = Array.isArray(app.platforms)
      ? app.platforms
      : String(app.platforms || "")
          .split("/")
          .map((s) => s.trim())
          .filter(Boolean);
    if (platforms.length === 0 || platforms.some((p) => !PLATFORMS.includes(p))) {
      errors.push(`(id=${app.id}, country=${country}): platforms 必须非空且只允许 ${PLATFORMS.join("/")}`);
      continue;
    }
    if (app.pricing !== undefined) {
      console.warn(
        `[config] (id=${app.id}, country=${country}): pricing 已废弃，忽略 "${app.pricing}"，由 lookup 判定付费/免费`
      );
    }
    app._platforms = platforms;
  }

  return { errors, seen };
}

// ---------------- lookup（方案 4.1） ----------------

/**
 * 按 country 分批 lookup。返回 Map<appId, info> + crawls 行（每 app_id 一行）。
 * info 直接取自 lookup 结果（驼峰字段，见 4.1 表格）。
 */
async function lookupByCountry(country, ids) {
  const infoMap = new Map();
  const crawls = [];
  const unique = [...new Set(ids)];
  const batchCount = Math.ceil(unique.length / LOOKUP_BATCH_SIZE);
  const lang = "en_us";

  for (let i = 0; i < unique.length; i += LOOKUP_BATCH_SIZE) {
    const batch = unique.slice(i, i + LOOKUP_BATCH_SIZE);
    const batchNum = Math.floor(i / LOOKUP_BATCH_SIZE) + 1;
    const url = `${LOOKUP_URL}?id=${batch.join(",")}&country=${country}&lang=${lang}`;
    const r = await throttledFetch(url, { label: `lookup ${country} batch ${batchNum}/${batchCount}` });

    const base = {
      ts: alignSlot(),
      country,
      source: "lookup",
      lang_requested: lang,
      locale_fallback: false,
    };

    if (!r.ok) {
      for (const id of batch) {
        crawls.push({
          ...base,
          app_id: id,
          status: "error",
          http_status: r.status,
          error: r.error || "lookup failed",
        });
      }
      continue;
    }

    const data = await r.resp.json().catch(() => null);
    const httpStatus = r.status;
    if (!data || typeof data.resultCount !== "number") {
      for (const id of batch) {
        crawls.push({
          ...base,
          app_id: id,
          status: "error",
          http_status: httpStatus,
          error: "lookup: 无法解析 JSON",
        });
      }
      continue;
    }

    const foundIds = new Set((data.results || []).map((e) => String(e.trackId)));
    for (const entry of data.results || []) {
      const id = String(entry.trackId);
      if (!batch.includes(id)) continue;
      infoMap.set(id, {
        app_id: id,
        name: entry.trackName || "",
        artwork_url: entry.artworkUrl512 || "",
        kind: entry.kind || "",
        price: entry.price,
        formatted_price: entry.formattedPrice || "",
        currency: entry.currency || "",
      });
    }

    for (const id of batch) {
      if (!foundIds.has(id)) {
        // resultCount 正常但缺这个 id → 该店无此 App（未上架/下架）
        crawls.push({ ...base, app_id: id, status: "unavailable", http_status: httpStatus });
      } else {
        const info = infoMap.get(id);
        crawls.push({
          ...base,
          app_id: id,
          status: "ok",
          http_status: httpStatus,
          track_name: info.name,
          kind: info.kind,
          price: info.price,
          formatted_price: info.formatted_price,
          currency: info.currency,
        });
      }
    }
  }
  return { infoMap, crawls };
}

// ---------------- 产品页（方案 4.2 / 13.4） ----------------

/** 解码 HTML 实体（轻量，够商品名/价格用）。 */
function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

/**
 * 解析产品页 HTML，返回 IAP 列表与页面有效性信息。
 *
 * 验证结论（13.4-2）：新版 Svelte 页 items_V3 JSON 已失效（0 条），
 * 真实生效结构是 dt（In-App Purchases）+ dd > details > li > div.text-pair。
 * 解析以 dt/dd 为主。
 */
function parseStorePage(html, id) {
  // 1. canonical 校验：必须是 /app/<slug>/id{id}
  const canonMatch = html.match(/<link[^>]*rel="canonical"[^>]*href="([^"]+)"/i);
  const canonical = canonMatch ? canonMatch[1] : "";
  const isProductPage = /\/app\/.*\/id\d+/.test(canonical) && canonical.includes(`id${id}`);

  // 2. html lang
  const langMatch = html.match(/<html[^>]*lang="([^"]+)"/i);
  const htmlLang = langMatch ? langMatch[1] : "";
  const langIsEnglish = /^en(-|$)/i.test(htmlLang);

  // 3. 找信息栏标题 dt：英文 In-App Purchases 优先，其次 App内购买
  //    注意：用正则 exec 的 index 定位 dt 起点，绝不能用 indexOf(headingText)——
  //    "In-App Purchases" 字样在 head/JSON-LD/JS 里会出现很多次，indexOf 会
  //    命中最早的那处而非真正的 <dt>，导致后续 dd 块定位错误、解析不到 IAP。
  const dtRe = /<dt[^>]*>([\s\S]*?)<\/dt>/gi;
  let headingIndex = -1;
  let headingText = "";
  let m;
  while ((m = dtRe.exec(html)) !== null) {
    const text = decodeEntities(m[1].replace(/<[^>]+>/g, ""));
    if (/In-App Purchases/i.test(text)) {
      headingIndex = m.index;
      headingText = text;
      break;
    }
  }
  let headingIsEnglish = /In-App Purchases/i.test(headingText);
  if (headingIndex < 0) {
    const dtRe2 = /<dt[^>]*>([\s\S]*?)<\/dt>/gi;
    while ((m = dtRe2.exec(html)) !== null) {
      const text = decodeEntities(m[1].replace(/<[^>]+>/g, ""));
      if (/内购买|アプリ内購入/i.test(text)) {
        headingIndex = m.index;
        headingText = text;
        headingIsEnglish = false;
        break;
      }
    }
  }

  // 4. 在 heading dt 之后的第一个 <dd> 块内解析 text-pair
  const items = [];
  if (headingIndex >= 0) {
    const dtIndex = headingIndex;
    const ddStart = html.indexOf("<dd", dtIndex);
    if (ddStart >= 0) {
      const ddEnd = html.indexOf("</dd>", ddStart);
      const ddBlock = ddEnd >= 0 ? html.slice(ddStart, ddEnd + 5) : html.slice(ddStart);
      const pairRe =
        /class="[^"]*text-pair[^"]*"[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/g;
      let pm;
      while ((pm = pairRe.exec(ddBlock)) !== null) {
        const name = decodeEntities(pm[1].replace(/<[^>]+>/g, ""));
        const priceText = decodeEntities(pm[2].replace(/<[^>]+>/g, ""));
        if (name && priceText) items.push({ name, price_text: priceText });
      }
    }
  }

  // locale_fallback（方案 2.4 判定标准 1、2）
  const localeFallback = !langIsEnglish || !headingIsEnglish;

  return {
    isProductPage,
    canonical,
    htmlLang,
    heading: headingText,
    items,
    localeFallback,
    redirected: !isProductPage,
  };
}

/** 构建稳定的 item_key（方案 4.3）：同名多价加 #N（第 1 条不加）。 */
function buildItemKeys(items) {
  const counts = new Map();
  for (const it of items) {
    const n = it.name;
    counts.set(n, (counts.get(n) || 0) + 1);
  }
  const seen = new Map();
  return items.map((it) => {
    const total = counts.get(it.name);
    if (total === 1) return it.name;
    const k = (seen.get(it.name) || 1);
    seen.set(it.name, k + 1);
    return k === 1 ? it.name : `${it.name}#${k}`;
  });
}

/**
 * 拉取并解析产品页内购列表（付费 / 免费都走这一步）。
 * 返回 { status, localeFallback, iapCount, items: [{item_key,name,price,currency,formatted_price}] }
 */
async function fetchStorePage(app, lookupInfo, ts) {
  const { id, country } = app;
  const isMac = lookupInfo.kind === "mac-software" || app._platforms.includes("macos");
  const mt = isMac ? "mt=12&" : "";
  const url = `${STORE_URL}/${country}/app/id${id}?${mt}l=en`;
  const r = await throttledFetch(url, { label: `store page ${country}/${id}` });

  if (!r.ok) {
    return { status: "error", error: r.error || `HTTP ${r.status}`, http_status: r.status };
  }
  if (r.status !== 200) {
    return { status: "error", error: `HTTP ${r.status}`, http_status: r.status };
  }
  const html = await r.resp.text().catch(() => "");
  if (!html) {
    return { status: "error", error: "store page 空响应", http_status: r.status };
  }

  const parsed = parseStorePage(html, id);
  if (!parsed.isProductPage) {
    // 兜底页/重定向页（如从 CN 网络访问 us 店被踢到 cn Today 页），方案第 8 节按 error 处理
    return {
      status: "error",
      error: `非产品页（canonical=${parsed.canonical || "无"}）${parsed.redirected ? "，疑似地区兜底/重定向" : ""}`,
      http_status: r.status,
      _parsed: parsed,
    };
  }

  const keys = buildItemKeys(parsed.items);
  const currency = lookupInfo.currency || "";
  const items = parsed.items.map((it, i) => {
    const price = parsePriceFromFormatted(it.price_text);
    return {
      item_key: keys[i],
      name: it.name,
      price,
      currency,
      formatted_price: it.price_text,
    };
  });

  return {
    status: "ok",
    http_status: r.status,
    localeFallback: parsed.localeFallback,
    iapCount: items.length,
    items,
    _parsed: parsed,
  };
}

// ---------------- 主流程 ----------------

async function runOnce({ alignOverride } = {}) {
  const ts = alignOverride || alignSlot();
  console.log("=== Price crawl start ===", `ts=${ts}`);

  // 1. 读配置
  let config;
  try {
    config = JSON.parse(await readFile("config/pricing.json", "utf-8"));
  } catch (err) {
    console.error("[config] 无法读取 config/pricing.json:", err.message);
    process.exit(1);
  }

  // 启动校验：非法 country / 重复 (id,country) → 退出本轮；单条字段错误 → 跳过该条
  const { errors } = validateConfig(config);
  const fatal = errors.filter(
    (e) => /country/.test(e) || /重复配置/.test(e)
  );
  const bad = errors.filter((e) => !fatal.includes(e));
  if (fatal.length > 0) {
    for (const e of fatal) console.error(`[config] FATAL: ${e}`);
    console.error(`[config] ${fatal.length} 条致命配置错误，退出本轮`);
    process.exit(1);
  }
  for (const e of bad) console.warn(`[config] 跳过坏条目: ${e}`);
  const validApps = config.apps.filter((a) => !bad.some((b) => b.includes(`id=${a.id}`) || b.includes(`(id=${a.id}`)));

  // 2. 按 country 分组
  const byCountry = new Map();
  for (const app of validApps) {
    const list = byCountry.get(app.country) || [];
    list.push(app);
    byCountry.set(app.country, list);
  }

  // 3. meta：lookup 失败时回退 name/artwork/currency（方案 4.2）
  let meta = await loadPricingMeta();
  const metaMap = new Map(Object.entries(meta?.apps || {}));
  const metaKey = (appId, country) => `${appId}|${country}`;

  // 4. 逐国 lookup
  const allCrawls = [];
  const allPoints = [];
  const lookupInfoByKey = new Map(); // `${appId}|${country}` → info
  const appResults = new Map(); // `${appId}|${country}` → { status, detail }

  for (const [country, apps] of byCountry) {
    const { infoMap, crawls } = await lookupByCountry(country, apps.map((a) => String(a.id)));
    allCrawls.push(...crawls);
    for (const app of apps) {
      const id = String(app.id);
      const key = metaKey(id, country);
      const lookupInfo = infoMap.get(id);
      if (lookupInfo) {
        lookupInfoByKey.set(key, lookupInfo);
        // 更新 meta 缓存（永不缓存 price）
        metaMap.set(key, {
          name: lookupInfo.name,
          artwork_url: lookupInfo.artwork_url,
          currency: lookupInfo.currency,
          kind: lookupInfo.kind,
        });
      }
    }
  }
  await savePricingMeta(metaMap, new Date().toISOString());

  // 5. 逐 App：lookup 判定付费/免费，再一律尝试解析内购
  for (const app of validApps) {
    const id = String(app.id);
    const key = metaKey(id, app.country);
    const lookupInfo = lookupInfoByKey.get(key);

    if (!lookupInfo) {
      // lookup 失败或该店无此 App：不拉产品页
      const crawls = allCrawls.filter((c) => c.app_id === id && c.country === app.country);
      const crawl = crawls[crawls.length - 1];
      const status = crawl?.status || "error";
      appResults.set(key, {
        status,
        pricing: null,
        name: metaMap.get(key)?.name || id,
        items: [],
        has_iap: false,
      });
      continue;
    }

    const cls = classifyPricing(lookupInfo.price, lookupInfo.formatted_price);
    // suspect：formattedPrice 含货币 → 按付费记下载价，并继续解析内购
    let effective = cls.verdict;
    let appPrice = lookupInfo.price;
    if (cls.verdict === "suspect") {
      const parsed = parsePriceFromFormatted(lookupInfo.formatted_price);
      if (parsed != null) appPrice = parsed;
      console.warn(
        `  [suspect] (${app.country}/${id}) price=${lookupInfo.price} 但 formattedPrice="${lookupInfo.formatted_price}"，按付费记下载价并解析内购`
      );
      effective = "paid";
    }

    const name = lookupInfo.name || metaMap.get(key)?.name || id;
    const platform = app._platforms[0];
    const items = [];

    if (effective === "paid") {
      const appItem = {
        item_key: "__app__",
        item_kind: "app_price",
        name,
        price: appPrice,
        currency: lookupInfo.currency,
        formatted_price: lookupInfo.formatted_price,
      };
      allPoints.push({
        ts,
        country: app.country,
        app_id: id,
        platform,
        ...appItem,
        _rule: cls.rule || "lookup price>0",
      });
      items.push(appItem);
    }

    const page = await fetchStorePage(app, lookupInfo, ts);
    allCrawls.push({
      ts,
      country: app.country,
      app_id: id,
      source: "store_page",
      lang_requested: "en_us",
      locale_fallback: page.localeFallback || false,
      status: page.status,
      http_status: page.http_status,
      iap_count: page.iapCount ?? 0,
      ...(page.status === "error" ? { error: page.error } : {}),
    });

    let iapStatus = "ok";
    if (page.status === "error") {
      iapStatus = "error";
      if (effective === "paid") {
        console.warn(`  [iap] (${app.country}/${id}) 产品页失败，仍保留下载价: ${page.error}`);
      }
    } else if (!page.items || page.items.length === 0) {
      iapStatus = "no_iap";
    } else {
      for (const it of page.items) {
        const iapItem = {
          item_key: it.item_key,
          item_kind: "iap",
          name: it.name,
          price: it.price,
          currency: it.currency,
          formatted_price: it.formatted_price,
        };
        allPoints.push({
          ts,
          country: app.country,
          app_id: id,
          platform,
          ...iapItem,
        });
        items.push(iapItem);
      }
    }

    const hasIap = iapStatus === "ok" && (page.items?.length || 0) > 0;
    let status = "ok";
    if (effective === "free" && iapStatus === "error") status = "error";
    else if (effective === "free" && iapStatus === "no_iap") status = "no_iap";

    console.log(
      `  [${effective}] (${app.country}/${id}) ${
        effective === "paid" ? lookupInfo.formatted_price : "free"
      } iap=${hasIap ? page.iapCount : iapStatus}`
    );

    appResults.set(key, {
      status,
      pricing: effective,
      name,
      platform,
      suspect: cls.verdict === "suspect",
      lookupRule: cls.rule,
      localeFallback: !!page.localeFallback,
      has_iap: hasIap,
      iap_status: iapStatus,
      items,
      ...(status === "error" ? { error: page.error } : {}),
    });
  }

  // 6. 写入 crawls + points（unavailable / error 不写点）
  const okStatuses = new Set();
  for (const [, res] of appResults) {
    if (res.status === "ok" || res.status === "no_iap") okStatuses.add(res);
  }
  await appendCrawls(allCrawls);
  if (allPoints.length > 0) {
    await appendPoints(allPoints);
  }
  console.log(
    `[store] ${allCrawls.length} crawls, ${allPoints.length} points`,
    `status: ${[...appResults.values()].map((r) => r.status).join(",")}`
  );

  // 7. rollup：重算今天（北京日），覆盖写
  const todayBj = beijingDateOf(ts);
  await rollupBeijingDay(todayBj);

  // 8. 读取上一轮 current 作为告警基线（首次运行没有）
  let prevCurrent = null;
  try {
    prevCurrent = JSON.parse(await readFile(join(PRICING_DIR, "current.json"), "utf-8"));
  } catch {
    prevCurrent = null;
  }

  // 9. 生成 current.json（含 delta）
  const current = await buildCurrent(ts, config, appResults, metaMap);

  // 10. 告警（相对上一轮，仅变化时输出）
  await runAlerts({ ts, current, prevCurrent });

  const summary = [...appResults.values()].reduce(
    (acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    },
    {}
  );
  console.log("=== Price crawl complete ===", `ts=${ts}`, JSON.stringify(summary));
  return current;
}

/**
 * 生成 current.json（方案 5.4）。
 * delta = 本轮价 − 上一轮同 item_key；新出现 null。
 */
async function buildCurrent(ts, config, appResults, metaMap) {
  // 上一轮基准：读昨天+今天的 points（排除本轮 ts；也排除 source=lookup 的无点情况）
  const prevPoints = (await loadPointsRange(toUtcDate(-1), toUtcDate(0))).filter((p) => p.ts < ts);
  const prevByKey = new Map(); // `${country}|${app_id}|${item_key}` → price
  for (const p of prevPoints) {
    prevByKey.set(`${p.country}|${p.app_id}|${p.item_key}`, p.price);
  }

  const apps = [];
  for (const app of config.apps) {
    const key = `${app.id}|${app.country}`;
    const res = appResults.get(key);
    if (!res) continue; // 被校验跳过的坏条目不进 current
    const items = (res.items || []).map((it) => {
      const prev = prevByKey.get(`${app.country}|${app.id}|${it.item_key}`);
      const delta = prev === undefined ? null : it.price === null ? null : it.price - prev;
      return { ...it, delta };
    });
    const entry = {
      app_id: String(app.id),
      name: res.name,
      pricing: res.pricing,
      platform: res.platform,
      country: app.country,
      status: res.status,
      has_iap: !!res.has_iap,
      items,
    };
    if (res.iap_status) entry.iap_status = res.iap_status;
    if (res.localeFallback !== undefined) entry.locale_fallback = res.localeFallback;
    if (res.suspect) entry.suspect = true;
    if (res.error) entry.error = res.error;
    apps.push(entry);
  }

  const current = {
    generated_at: new Date().toISOString(),
    data_ts: ts,
    display_timezone: "Asia/Shanghai",
    apps,
  };

  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(PRICING_DIR, { recursive: true });
  await writeFile(join(PRICING_DIR, "current.json"), JSON.stringify(current, null, 2) + "\n");
  console.log(`[current] current.json written, ${apps.length} apps`);
  return current;
}

function toUtcDate(offsetDays) {
  return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
}

// ---------------- CLI ----------------

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--loop")) {
    const intervalIdx = args.indexOf("--interval");
    const intervalSec = intervalIdx >= 0 ? parseInt(args[intervalIdx + 1], 10) : 14400;
    console.log(`Loop mode: every ${intervalSec}s`);
    while (true) {
      try {
        await runOnce();
      } catch (err) {
        console.error("Loop iteration error:", err);
      }
      await sleep(intervalSec * 1000);
    }
  }

  await runOnce();
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}

export { runOnce, buildCurrent, REQUEST_INTERVAL_MS };