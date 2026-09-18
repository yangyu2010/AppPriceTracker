/**
 * 定价监控公共工具。本模块自包含，不复用仓库外的 lookup / store 缓存。
 */

/** 店面码 → 中文名。也是配置校验的合法店面白名单（方案第 3 节）。 */
export const COUNTRY_NAMES = {
  us: "美国", gb: "英国", ca: "加拿大", au: "澳大利亚", de: "德国", fr: "法国",
  jp: "日本", in: "印度", br: "巴西", nz: "新西兰", nl: "荷兰", pt: "葡萄牙",
  se: "瑞典", ch: "瑞士", es: "西班牙", tw: "台湾", mx: "墨西哥", it: "意大利",
  be: "比利时", hk: "香港", sg: "新加坡", za: "南非", cn: "中国",
};

/** 合法平台枚举（方案 2.2）。 */
export const PLATFORMS = ["macos", "ios", "ipados"];

/** 定价数据的顶层目录（方案第 5 节）。 */
export const PRICING_DIR = "data/pricing";

/**
 * 对齐 ts 到采集整点槽。定价对齐 4 小时：00/04/08/12/16/20Z。
 */
export function alignSlot(date = new Date()) {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString().replace(".000Z", "Z");
}

/**
 * UTC ISO → 北京时间显示字符串。
 */
export function beijingStr(iso) {
  const d = new Date(iso);
  d.setUTCHours(d.getUTCHours() + 8);
  return d.toISOString().replace(/\.\d+Z/, "").replace("T", " ").concat(" 北京时间");
}

/** UTC ISO → 北京日历日（Asia/Shanghai）"YYYY-MM-DD"。 */
export function beijingDateOf(iso) {
  const d = new Date(iso);
  d.setUTCHours(d.getUTCHours() + 8);
  return d.toISOString().slice(0, 10);
}

/**
 * 北京日 ↔ UTC 文件的映射（方案 2.5，实现必读）。
 *
 * 北京 00:00 = 前一日 UTC 16:00，「北京日 D 一整天」= UTC [D-1 16:00, D 16:00)，
 * 覆盖 UTC 日期文件 D-1 与 D 两个文件、共 6 个 4 小时槽。
 *
 * 返回：
 *   utcFiles  — 需要读取的 UTC 日期文件（按 YYYY-MM-DD）
 *   tsFrom    — 过滤起点（含）
 *   tsTo      — 过滤终点（不含）
 */
export function beijingDayToUtcRange(beijingDate) {
  const [y, m, d] = beijingDate.split("-").map(Number);
  const prevDay = new Date(Date.UTC(y, m - 1, d - 1));
  const thisDay = new Date(Date.UTC(y, m - 1, d));
  return {
    utcFiles: [prevDay.toISOString().slice(0, 10), thisDay.toISOString().slice(0, 10)],
    tsFrom: prevDay.toISOString().slice(0, 10) + "T16:00:00Z",
    tsTo: thisDay.toISOString().slice(0, 10) + "T16:00:00Z",
  };
}

/** 生成 [from, to]（YYYY-MM-DD，含首尾）的 UTC 日期列表。 */
export function utcDateList(from, to) {
  const dates = [];
  const start = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  const cur = new Date(start);
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

/** "2026-09-10" → "2026/09/10"。 */
export function isoToPath(isoDate) {
  const [y, m, d] = isoDate.split("-");
  return `${y}/${m}/${d}`;
}

/**
 * 三态判定（方案 2.1）。返回 { verdict, rule }。
 *
 * 配置不再填写 paid/free：一律以 lookup 为准。
 * suspect（price===0 但 formattedPrice 含货币）由调用方按 paid 记下载价，
 * 并继续解析内购，看板标「待核对」。
 */
export function classifyPricing(price, formattedPrice) {
  const fp = String(formattedPrice || "");
  // 货币符号 / ISO 货币码出现 → 大概率是金额而不是 Get/免费 文案
  const hasMoney = /[¥$€£￥]|[A-Z]{3}/.test(fp) && !/^(get|免费|获取|安装)/i.test(fp.trim());

  if (typeof price === "number" && price > 0) {
    return { verdict: "paid", rule: "price>0" };
  }
  if (price === 0) {
    if (hasMoney) {
      return { verdict: "suspect", rule: "price===0 但 formattedPrice 含货币" };
    }
    return { verdict: "free", rule: "price===0 且 formattedPrice 为纯文字" };
  }
  // price 解析异常（非数字 / 负数等罕见情况）
  if (fp && hasMoney) {
    return { verdict: "suspect", rule: "price 解析异常，回退 formattedPrice" };
  }
  return { verdict: "free", rule: "price 解析异常且无货币符号，按免费继续" };
}

/**
 * 从 formattedPrice 解析数字（price 缺失时回退用，方案 2.1）。
 * "$4.99"→4.99、"¥38.00"→38、"1.000,00 €"→1000（去千分位）。
 */
export function parsePriceFromFormatted(fp) {
  const s = String(fp || "").replace(/[¥$€£￥]/g, "").replace(/,/g, "").trim();
  const m = s.match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** HTML 转义（看板内嵌用户数据用）。 */
export function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}