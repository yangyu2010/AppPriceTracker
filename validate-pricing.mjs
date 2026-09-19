// 临时验证脚本：按 README 第 4 节流程
// 1) lookup(country + lang=en_us) 判定 paid/free，取英文名/价格/货币
// 2) 免费 App 抓产品页 ?l=en + Accept-Language，解析 In-App Purchases
// 3) 检测 locale_fallback（html lang / 栏目标题语言）
// 用法: node validate-pricing.mjs

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

// 用户提供的测试目标：{ id, country, label(用户分组), expected(用户给的形态) }
const APPS = [
  { id: "932747118", country: "us", label: "macOS 美国付费", expected: "paid", note: "Shadowrocket" },
  { id: "1438243180", country: "us", label: "macOS 美国付费", expected: "paid", note: "Dark Reader for Safari" },
  { id: "1443988620", country: "us", label: "macOS 美国付费", expected: "paid", note: "Quantumult X" },
  { id: "545519333", country: "us", label: "macOS 美国免费", expected: "free", note: "Amazon Prime Video" },
  { id: "1438243180", country: "cn", label: "macOS 中国付费", expected: "paid", note: "Dark Reader(用户URL为us,标注中国)" },
  { id: "1091189122", country: "cn", label: "macOS 中国免费", expected: "free", note: "熊掌记 Markdown" },
  { id: "6473753684", country: "us", label: "iOS 美国免费", expected: "free", note: "Claude by Anthropic" },
  { id: "6448311069", country: "us", label: "iOS 美国免费", expected: "free", note: "ChatGPT" },
  { id: "1017492454", country: "us", label: "iOS 美国免费", expected: "free", note: "YouTube Music" },
  { id: "388624839", country: "cn", label: "iOS 中国免费", expected: "free", note: "CamScanner 扫描全能王" },
  { id: "590338362", country: "cn", label: "iOS 中国免费", expected: "free", note: "网易云音乐" },
  { id: "1605585211", country: "cn", label: "iOS 中国免费", expected: "free", note: "汽水音乐" },
  { id: "414603431", country: "cn", label: "iOS 中国免费", expected: "free", note: "QQ音乐" },
  { id: "1544884479", country: "cn", label: "iOS 中国免费", expected: "free", note: "蛋仔派对" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== 请求节奏常量 =====
// 苹果对 itunes.apple.com / apps.apple.com 有限流：实测密集请求会触发 HTTP 429。
// 全程串行，每两次请求之间至少间隔 REQUEST_INTERVAL_MS 毫秒。
// （正式 price-crawl.js 同样按此设计：间隔集中为一个常量，方便按实际情况调整。）
const REQUEST_INTERVAL_MS = 30_000;
let _lastReqAt = 0;
async function throttledFetch(url, headers) {
  const now = Date.now();
  const wait = Math.max(0, _lastReqAt + REQUEST_INTERVAL_MS - now);
  if (wait > 0) await sleep(wait);
  _lastReqAt = Date.now();
  return fetch(url, { headers });
}

async function lookup(id, country) {
  const url = `https://itunes.apple.com/lookup?id=${id}&country=${country}&lang=en_us`;
  const resp = await throttledFetch(url, { "User-Agent": UA });
  if (!resp.ok) return { http_status: resp.status, error: `HTTP ${resp.status}` };
  const data = await resp.json();
  if (!data.resultCount || data.resultCount === 0) return { http_status: resp.status, result_count: 0 };
  const e = data.results[0];
  return {
    http_status: resp.status,
    result_count: data.resultCount,
    track_name: e.trackName,
    kind: e.kind,
    price: e.price,
    formatted_price: e.formattedPrice,
    currency: e.currency,
    artwork: (e.artworkUrl512 || "").slice(0, 60),
  };
}

// 三态判定（方案 2.1）
function classify({ price, formatted_price, configured }) {
  const fp = String(formatted_price || "");
  const hasCurrencySymbol = /[¥$€£￥]|[A-Z]{3}\s?\d|[NTKR]\$/i.test(fp) && !/^(get|免费|获取|install|打开)$/i.test(fp.trim());
  if (Number(price) > 0) return { verdict: "paid", rule: "price>0" };
  if (Number(price) === 0 && !hasCurrencySymbol) return { verdict: "free", rule: "price===0 且 formattedPrice 为纯文字" };
  if (Number(price) === 0 && hasCurrencySymbol) return { verdict: "suspect", rule: "price===0 但 formattedPrice 含货币符号", raw: fp };
  return { verdict: configured || "unknown", rule: "无法判定,沿用配置" };
}

// 解析产品页 IAP：先找栏目标题(dt)，再抓其后 text-pair；同时探测 html lang
function parseStorePage(html) {
  const langMatch = html.match(/<html[^>]*lang="([^"]+)"/i);
  const htmlLang = langMatch ? langMatch[1] : "";

  const dtRe = /<dt[^>]*>([\s\S]*?)<\/dt>/gi;
  let heading = null;
  let headingZh = false;
  let m;
  while ((m = dtRe.exec(html))) {
    const text = m[1].replace(/<[^>]+>/g, "").trim();
    if (/^In-App Purchases$/i.test(text)) { heading = text; break; }
    if (/^App内购买$/.test(text)) { heading = text; headingZh = true; break; }
  }

  let items = [];
  if (heading) {
    // 从标题位置向后截取，避免跨到下一个 dl
    const anchor = html.slice(m.index);
    const tail = anchor.slice(0, anchor.search(/<\/dl>[\s\S]{0,500}<dl|<section|<\/section>/) >= 0 ? anchor.search(/<\/dl>[\s\S]{0,500}<dl|<section|<\/section>/) + 500 : 12000);
    // 新版 Svelte 页：<div class="text-pair svelte-xxx"><span>名字</span> <span>价</span></div>
    const pairRe = /class="[^"]*text-pair[^"]*"[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/g;
    let p;
    while ((p = pairRe.exec(tail))) {
      const name = p[1].replace(/<[^>]+>/g, "").trim();
      const price = p[2].replace(/<[^>]+>/g, "").trim();
      if (name && price) items.push({ name, price });
    }
    // 同名多价 → name#序号（方案 4.3）
    const count = new Map();
    items = items.map((it) => {
      const n = (count.get(it.name) || 0) + 1;
      count.set(it.name, n);
      return { ...it, key: n > 1 ? `${it.name}#${n}` : it.name };
    });
  }

  // JSON 优先路径（方案 4.2）：尝试 items_V3
  let jsonItems = null;
  const jsonRe = /"items_V3"\s*:\s*(\[[\s\S]*?\])/;
  const jm = html.match(jsonRe);
  if (jm) {
    try {
      const arr = JSON.parse(jm[1].replace(/\\u002F/gi, "/"));
      jsonItems = arr
        .filter((x) => x && x.$kind === "textPair")
        .map((x) => ({ name: x.leadingText, price: x.trailingText }));
    } catch {}
  }

  return { htmlLang, heading, headingZh, items, jsonItems };
}

async function fetchPage(id, country, kind) {
  const mt = kind === "mac-software" ? "mt=12&" : "";
  const url = `https://apps.apple.com/${country}/app/id${id}?${mt}l=en`;
  const resp = await throttledFetch(url, { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" });
  if (!resp.ok) return { http_status: resp.status, url };
  const html = await resp.text();
  // 产品页有效性检查：被判水印/地区兜底页时 canonical 不含 /app/id{id}
  const canonical = (html.match(/<link rel="canonical" href="([^"]+)"/i) || [])[1] || "";
  const title = (html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || "";
  const isProductPage = /\/app\/.*\/id\d+/.test(canonical) && canonical.includes(`id${id}`);
  return { http_status: resp.status, url, html, bytes: html.length, canonical, title, isProductPage };
}

async function verifyOne(app) {
  const out = { ...app };
  // 1. lookup（失败重试 1 次，间隔 2s）
  let lu = await lookup(app.id, app.country);
  if (lu.error || lu.result_count === 0) {
    await sleep(2000);
    lu = await lookup(app.id, app.country);
  }
  out.lookup = lu;

  if (lu.result_count === 0) {
    out.status = "unavailable"; // 方案：该店无此 App
    return out;
  }
  if (lu.error) {
    out.status = "error";
    return out;
  }

  // 2. 三态判定
  const cls = classify({ price: lu.price, formatted_price: lu.formatted_price, configured: app.expected });
  out.classify = cls;

  // 3. 免费 → 产品页
  if (cls.verdict === "free") {
    let pg = await fetchPage(app.id, app.country, lu.kind);
    if (pg.http_status === 429 || pg.http_status >= 500) {
      await sleep(3000);
      pg = await fetchPage(app.id, app.country, lu.kind);
    }
    out.page = { http_status: pg.http_status, url: pg.url, bytes: pg.bytes, canonical: pg.canonical, title: pg.title, is_product_page: pg.isProductPage };
    if (!pg.isProductPage) {
      out.locale_fallback = true;
      out.redirected = true; // 方案第 8 节：跳到同意/兜底页当 error
    } else if (pg.html) {
      const parsed = parseStorePage(pg.html);
      out.page.parsed = parsed;
      const htmlLangOk = /^en(-|$)/i.test(parsed.htmlLang);
      out.locale_fallback = !(htmlLangOk && !parsed.headingZh);
    }
  }
  return out;
}

async function main() {
  console.log(`=== 定价流程验证 (${APPS.length} 条) ===\n`);
  for (const app of APPS) {
    const r = await verifyOne(app);
    console.log(`--- ${r.note} [${r.label} | ${r.country}] id=${r.id} ---`);
    const lu = r.lookup;
    if (r.status === "unavailable") {
      console.log(`  lookup: resultCount=0 → 判定 unavailable（该店无此 App）`);
    } else if (r.status === "error") {
      console.log(`  lookup: 失败 ${lu.error}`);
    } else {
      console.log(`  lookup: name=${JSON.stringify(lu.track_name)} kind=${lu.kind} resultCount=${lu.result_count}`);
      console.log(`          price=${lu.price} formattedPrice=${JSON.stringify(lu.formatted_price)} currency=${lu.currency}`);
      console.log(`          形态判定: ${r.classify.verdict} (${r.classify.rule})${r.classify.raw ? " raw=" + JSON.stringify(r.classify.raw) : ""}`);
      if (r.classify.verdict === "free") {
        const pg = r.page;
        console.log(`  产品页: HTTP ${pg.http_status} bytes=${pg.bytes} 产品页=${pg.is_product_page} canonical=${pg.canonical || "?"}`);
        console.log(`          url=${pg.url}`);
        if (r.redirected) {
          console.log(`          ⚠ 兜底/非产品页（title=${JSON.stringify(pg.title)}）→ 按 error 处理（方案第 8 节）`);
        } else {
          const p = pg.parsed;
          if (p) {
            console.log(`          html lang=${JSON.stringify(p.htmlLang)} 栏目=【${p.heading || "(未匹配到标题)"}】 locale_fallback=${r.locale_fallback}`);
            console.log(`          dt/dd 解析: ${p.items.length} 条`);
            for (const it of p.items) console.log(`            ${it.key} = ${it.price}`);
            if (p.jsonItems) console.log(`          items_V3 JSON 解析: ${p.jsonItems.length} 条`);
          }
        }
      }
    }
    // 间隔由 REQUEST_INTERVAL_MS 统一控制，这里不再单独 sleep
  }
}

main().catch((e) => {
  console.error("fatal", e);
  process.exit(1);
});