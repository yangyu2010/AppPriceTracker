# AppPriceTracker

监控 App Store **公开的**下载价和内购展示价。按 `config/pricing.json` 定期 lookup、解析产品页，生成静态看板 `public/pricing.html`。

**许可证：[MIT](LICENSE)**

## 快速开始

需要 [Node.js](https://nodejs.org/) 20 或 22。

```bash
# 编辑 config/pricing.json（每个 App 填写 id / platforms / country）
node src/price-crawl.js --once
node src/price-dashboard.js    # 生成 public/pricing.html
```

本地循环：`node src/price-crawl.js --loop --interval 14400`（每 4 小时）。GitHub Actions 用 `pricing.yml`，不要 `--loop`。

---

本仓库按 `config/pricing.json` 盯一批 App：

- **每个 App 只监控一个国家**（用户在配置里填写 `country`）。
- **配置不填付费/免费**：程序先 lookup 该店面，自己判定下载价是付费还是免费。
- **再拉产品页**：解析「In-App Purchases」，有内购则**每个 SKU 单独记走势**。付费 App 同时记下载价。
- **文案默认英语**：请求时明确要英文；价格货币仍跟店面走（日本店还是日元）。
- **看板时间默认北京时间**；落盘仍用 UTC ISO。
- **看板可切换内购 SKU**：一个 App 有多条内购时，下拉选择要看的那条；付费+内购时折线同时画下载价 + 当前选中的内购。

采集周期 **每 4 小时一次**。先本地跑通，再走 GitHub Actions + cron-job.org。

---

## 1. 本仓库范围

| | 定价监控（本文） |
|--|------------------|
| 配置 | `config/pricing.json` |
| 采集 | 每 4 小时 lookup / 产品页 |
| 看什么 | **单国**下载价 **和/或** 内购展示价 |
| 数据目录 | `data/pricing/` |
| 看板 | `public/pricing.html` |
| 国家 | **每个 App 自己填一个 `country`** |
| 展示时区 | **显示北京时间**，存储 UTC |

定价 `ts` 对齐到 4 小时整点：`00:00 / 04:00 / 08:00 / 12:00 / 16:00 / 20:00` UTC（北京时间 08:00 / 12:00 / 16:00 / 20:00 / 次日 00:00 / 04:00）。

拿不到、也不追求 Product ID（`com.xxx.annual`）。内购只记录产品页上挂出来的 **展示名 + 价格**。

---

## 2. 已拍板

### 2.1 形态由 lookup 判定，配置不再填 `pricing`

`config/pricing.json` **不要写** `pricing` / `paid` / `free`。每轮固定两步：

1. **lookup** 该店面：读 `price` / `formattedPrice` / `currency`，三态判定付费或免费。
2. **产品页**：解析 In-App Purchases。有则逐条记；没有记 `no_iap`。付费 App 即使有内购也**两样都记**。

| lookup 判定 | 产品页 | 落盘 | 看板 |
|-------------|--------|------|------|
| `paid` | 有内购 | `__app__` 下载价 + 每条 iap | 徽章「付费·内购」；可选 SKU，折线同时画下载价 + 该内购 |
| `paid` | 无内购 | 仅 `__app__` | 「付费」 |
| `paid` | 产品页失败 | 仍写下载价，`iap_status=error` | 保留下载价，标「内购采集失败」 |
| `free` | 有内购 | 每条 iap | 「免费·内购」；下拉/点行切换 SKU |
| `free` | 无内购 | 不写点 | 「免费·无内购」 |
| `free` | 产品页失败 | 不写点 | 「采集失败」 |

- **`price === 0` 不单独作为「免费」判据（三态判定）**：只有 `price === 0` **且** `formattedPrice` 是纯文字（`Get` / `获取` / `免费` / 原文如此）时才判免费；若 `price === 0` 但 `formattedPrice` 含货币符号（历史上部分店面出现过 `price: 0` 而 `formattedPrice` 是货币价的案例），记为 `suspect`：**按付费记下载价**（能从 `formattedPrice` 解析数字则用之），并继续解析内购，打 warn 日志，看板标「待核对」。
- `price` 解析不出数字时（罕见），可回退从 `formattedPrice` 解析；仍失败则沿用上一轮形态并打 warn，不硬判。
- 若配置里仍残留 `pricing` 字段：启动时 warn 并**忽略**，以 lookup 为准。

### 2.2 平台

平台：`macos` / `ios` / `ipados`。

- Mac 与 iOS 几乎总是 **不同 App ID**，必须写成两条。
- Universal iOS 同一个 ID 在 iPhone / iPad 产品页上内购通常相同；每个 ID 只拉一次该国产品页。`platforms` 用于展示，Mac 链接加 `mt=12`。

产品页 URL（店面来自该 App 的 `country`，语言见 2.4）：

```text
ios/ipados  https://apps.apple.com/{cc}/app/id{id}?l=en
macos       https://apps.apple.com/{cc}/app/id{id}?mt=12&l=en
```

### 2.3 国家：每个 App 只填一个

不再扫 15 国。用户自己决定盯哪一个店面：

```json
{ "id": "388624839", "country": "us" }
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `country` | **必填** | ISO 两字母店面码：`us` `jp` `cn` `gb` `de` … |

同一 App 若要同时看美国价和日本价：配置里写 **两条**（同一个 `id`，不同 `country`）。采集键是 `(app_id, country)`。

价格、货币只跟 **店面 `country`** 走：`country=jp` 一定是日本店日元价，不会因为要英语文案就变成美元。

### 2.4 语言：默认英语，谁在控制？

返回英文还是中文/日文，**不是 curl 自己翻译的**，是 **Apple 按请求参数选一份已经存在的本地化文案**。我们能做的只有：请求时声明「我要英语」；若该店面没有英文本地化，Apple 会退回该国默认语言，我们改不了。

两件事要拆开：

| | 由谁决定 | 我们怎么写 |
|--|----------|------------|
| **店面（价、货币、能不能买）** | URL / 参数里的 **国家** | `country=us` 或路径 `/jp/` |
| **文案语言（App 名、内购展示名、栏目标题）** | Apple 根据 **语言参数 + 该店面有没有这份本地化** | 明确要英语，见下表 |

[Apple Search API](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/Searching.html) 写明：`country` 选店面；`lang` 选返回语言，默认就是 `en_us`。

**Lookup（判定付费/免费 + 名字 + 下载价）：**

```text
https://itunes.apple.com/lookup?id=388624839&country=jp&lang=en_us
```

- `country=jp` → 日本店，`price` / `currency` / `formattedPrice` 按日元。
- `lang=en_us` → `trackName`、描述等尽量英文。官方默认已是 `en_us`，仍要写上，避免服务端按 IP 或其它规则改掉。
- 不设 `lang`、只设 `country=cn` 时，名字常常变成中文。

**产品页 HTML（内购列表，付费/免费都拉）：**

```text
https://apps.apple.com/jp/app/id388624839?l=en
```

再加请求头：

```text
Accept-Language: en-US,en;q=0.9
```

- 路径 `/jp/` = 日本店（价还是日元）。
- 查询参数 `l=en` = 向 Apple 要英文本地化。这是商店网页自己的参数，不是我们本地把 HTML 翻译成英语。
- `Accept-Language` 辅助页面框架（按钮、栏目标题）。英语成功时，栏目标题是 **In-App Purchases**，而不是「App内购买」。
- [店面与 `l=` 的关系](https://mobilemoxie.com/blog/localization-differences-itunes-app-store-google-play-store-24/)：该国若根本没有英文本地化，Apple 仍显示该国默认语言（例如德国店没有法文时不会出法文）。

解析时 **先认英文标题 `In-App Purchases`**，找不到再认 `App内购买`（以及其它语言的同类 `dt`），避免日区英文失败时整页作废。

**优先英语的实现顺序：**

1. lookup 固定带 `lang=en_us`。
2. 产品页固定带 `?l=en` + `Accept-Language: en-US`。
3. 内购 `item_key` 用这次拿到的展示名；英语成功则键是英文，走势更稳。
4. 若 Apple 退回日文/中文名：照实存储，并在 `crawls` 记 `locale_fallback: true`，看板可标「该店无英文本地化」。不要我们自己翻译。

**`locale_fallback` 的判定标准**（实现用这组启发式，任一命中即记 `true`）：

1. 产品页 `<html lang="…">` 属性不是 `en` / `en-US` / `en-*`；
2. 产品页信息栏匹配到的是「App内购买」等非英文 `dt`，而不是 `In-App Purchases`；
3. ~~lookup 的 `trackName` 含 CJK 或其它非拉丁字母字符，而本次请求明确是 `lang=en_us`~~ —— **不作为判据**：验证发现很多 App（如网易云音乐）在英语本地化可用时仍保留中文 `trackName`，页面 `html lang=en-GB` + 英文栏目 `In-App Purchases` 均正常，此时不应记 fallback。以判定标准 1、2 为准。

User-Agent 用常见 Safari 即可，**不能**靠 UA 决定语言。

### 2.5 频率与时间口径

每 **4 小时** 一轮。

**存储：** `ts` 用 UTC ISO，对齐槽 `00/04/08/12/16/20Z`。计划 04:10 跑完仍记 `04:00:00Z`。

**展示：** 一律转 **北京时间（Asia/Shanghai，UTC+8）**，与 `src/pricing-util.js` 的 `beijingStr` 一致，标签写「北京时间」，不要给用户看 `Z`。

**按日聚合：** 按 **北京时间的日历日** 切（当天 00:00–24:00 CST），这样看板上的「今天」和国内使用习惯一致。不要用 UTC 日切（会在北京时间上午 8 点前算进前一天）。

**北京日 ↔ UTC 文件的映射（实现必读）：** points 文件按 **UTC 日期**落盘（`points/2026/09/18.jsonl` 存 9-18 00:00–23:59 UTC 的点），而 daily / 「今天」按北京日切。北京 00:00 = 前一日 UTC 16:00，所以「北京 9/18 一整天」覆盖 UTC 9/17 20:00Z、9/18 00:00–16:00Z 共 6 个 4 小时槽，**横跨 `points/2026/09/17.jsonl` 与 `points/2026/09/18.jsonl` 两个文件**。统一封装一个 helper：`beijingDay → { utcFiles: [d-1, d], tsFilter: [起, 止) }`，rollup 与看板 3 天档一律走它，避免漏点或把前一天的 UTC 数据算进今天。

### 2.6 技术选型

Node 20/22、一份 JSON、`data` 分支 JSONL、静态 HTML + ECharts、cron-job.org 触发 `pricing.yml`。

---

## 3. 配置：`config/pricing.json`

| 草稿 | 本方案 | 说明 |
|------|--------|------|
| `id` | `id` | 字符串 App ID |
| `platforms`: `"macos/ios/ipados"` | `platforms`: `["macos"]` | **用数组**；可兼容 `/` 分隔字符串 |
| `类型`: `付费` / `免费` | **不写** | 由 lookup 判定，不要填 `pricing` |
| （无） | `country` | **必填**，该 App 只盯这一个店面 |

完整示例：

```json
{
  "interval_hours": 4,
  "display_timezone": "Asia/Shanghai",
  "lang": "en_us",
  "apps": [
    {
      "id": "932747118",
      "platforms": ["macos"],
      "country": "us"
    },
    {
      "id": "388624839",
      "platforms": ["ios"],
      "country": "us"
    },
    {
      "id": "388624839",
      "platforms": ["ios"],
      "country": "jp"
    }
  ]
}
```

第三条表示：同一个扫描全能王，另开一行专门盯日本店价格（文案仍优先英语，货币是日元）。

- `country` **必填**，没有全局国家列表。
- `platforms` 建议手写；**不要填 `pricing`**（lookup 判断；残留字段会被忽略并 warn）。
- `lang` 全局默认 `"en_us"`，第一期不给单个 App 覆盖。
- `display_timezone` 固定 `"Asia/Shanghai"`，只影响展示和日切，不影响请求。
- 名字、图标、货币不要写在配置里。

**启动校验（`--once` 进入采集前必须全部通过）：**

- `country` 非空、两字母、小写、属于合法店面码（白名单除 `us/jp/cn/gb/de/…` 外，可复用现有 `COUNTRY_NAMES` 键集合）；不合法直接退出本轮并报错。
- `id` 为数字字符串；`platforms` 非空且只允许 `macos/ios/ipados`。
- **同一 `(id, country)` 不允许配置两行**（示例中的扫描全能王是 `(us)` 与 `(jp)` 两行，合法）；发现重复直接退出本轮。
- 不要再校验 `pricing`；若仍写出则 warn 并忽略。
- 校验只拦坏的条目，不拦整轮：对单个坏条目写 error 行 + 终端/Job Summary 报错，其余 App 照常采集。

---

## 4. 采集路径：lookup + 产品页

每个 `(id, country)` **都走两步**（lookup 失败 / `unavailable` 则跳过产品页）。

### 4.1 lookup（国家 + 英语）：判定形态、拿下载价

```text
https://itunes.apple.com/lookup?id={id}&country={该App的country}&lang=en_us
```

同一 `country` 的多个付费 ID 可批量：`id=id1,id2,id3`，每批最多 100。

**批量 lookup 的 `crawls` 行粒度：一个请求拆成每 `app_id` 一行**（共享同一 HTTP 结果与状态码），方便看板按 App 过滤；不按 batch 记一行。

| 字段 | 用途 |
|------|------|
| `trackName` | 看板名（优先英文） |
| `artworkUrl512` | 图标 |
| `kind` | `software` / `mac-software` |
| `price` | 数字，0 = 免费 |
| `formattedPrice` | `$4.99` / `¥12.00` / `Get` |
| `currency` | `USD` / `JPY` / `CNY` |

`formattedPrice` 为 Get/获取/免费且 `price === 0` 时，不能当付费下载价。

**lookup 在该 `country` 店面返回 `resultCount: 0`**（App 未上架 / 已下架该区）：不是网络失败，记 `status: "unavailable"`，本轮不写点，看板显示「该店无此 App」，不参与告警；产品页 404 同样处理。

量级：N 个条目（按国家分组批量 lookup），每 4 小时很少几次。

### 4.2 产品页：解析内购（付费 / 免费都拉）

lookup 仍要拉（判定付费/免费、拿英文名和图标、付费则记下下载价）。内购列表来自 HTML。付费 App 的产品页失败时**不丢下载价**。

**`meta/apps.json` 的角色（与 lookup 新鲜度无关）：** 每轮 lookup 都是必须的（付费/免费判定、价格要新鲜），meta 只缓存 `name / artworkUrl / currency`，用途是 **lookup 失败时回退**——字段缺失时用上次缓存兜底，看板仍能显示名字和图标；`price`、`formatted_price` **永不写入 meta**，杜绝任何「拿缓存价」的可能。meta 键为 `app_id + country`，由本仓库独立读写 `data/pricing/meta/apps.json`。

```text
GET https://apps.apple.com/{cc}/app/id{id}?l=en
Accept-Language: en-US,en;q=0.9
```

Mac 再加 `mt=12`。`curl` 即可，不必渲染 JS。

英语成功时信息栏类似：

```html
<dt>In-App Purchases</dt>
<dd>
  <div class="text-pair"><span>CamScanner Premium</span><span>$2.99</span></div>
</dd>
```

同一数据在 `<script type="application/json">`：

```text
shelfMapping.information.items[…]  标题为 In-App Purchases
items_V3[] = { "$kind": "textPair", "leadingText": "…", "trailingText": "$2.99" }
```

**优先解析这份 JSON**：先匹配标题 `In-App Purchases`，否则再匹配 `App内购买`。不要绑 `svelte-xxxx` class。

已用中国区默认语言页验证过列表结构（[id388624839](https://apps.apple.com/cn/app/id388624839)）。第一期实现应对 **`/us/…?l=en`** 做同样解析（标题换成英文）。

请求：常见浏览器 UA；**全程串行，每两次请求之间至少间隔 `REQUEST_INTERVAL_MS`（常量，初值 `30_000`ms，集中在 `price-crawl.js` 顶部定义，方便按实际情况调整）**；失败等 2 秒再试 1 次；单 App 失败不阻断整轮。

> 实测：密集并发请求（3～5 并发、无间隔）会触发 Apple HTTP 429 限流（验证时对 `apps.apple.com` 命中过）。因此**不要恢复并发**，间隔优先保稳定；量级很小（每 4 小时每 App 1–2 次请求），串行完全够用。

量级：每个 `(id, country)` 每轮 1 次 lookup + 1 次产品页。

### 4.3 内购条目的稳定键

没有 Product ID。同名可能多价。

```text
若本轮该 App 该国该名只出现 1 次：
  item_key = 规范化展示名

若同名出现多次：
  item_key = 规范化展示名 + "#" + 页内序号（从 1）
```

规范化：trim、合并空白、保留大小写。优先英语后，键多为英文；若某次 fallback 成中文，会被当成新 `item_key`（`locale_fallback` 可辅助排查）。

- 唯一名、价格从 $2.99 改成 $3.99 → 同一条走势。
- 同名三条 → 三条走势；商店改排序时 `#1/#2` 可能对错，第一期接受。
- 列表里消失 → 本轮不写点，标「未列出」，不当 0 元。
- 同名条目从多条变一条时（如 `Premium#2` 消失、只剩 `Premium`），键会从 `Premium#2` 回退成 `Premium`，走势断成两条——**第一期接受**，出现时打 debug 日志便于排查，不当 bug 修。

展示只分 `app_price`（付费下载）和 `iap`（产品页一行）。不解析描述文案里的手写价格。付费+内购时同一个槽会同时有 `__app__` 行和若干 iap 行。

---

## 5. 数据怎么存

```text
data/pricing/
  meta/apps.json                 lookup 缓存，键 app_id + country
  crawls/2026/09/18.jsonl
  points/2026/09/18.jsonl
  rollup/daily/2026-09.jsonl     文件名按北京时间的年-月
```

### 5.1 `crawls`

| 字段 | 说明 |
|------|------|
| `ts` | 4 小时槽，UTC ISO |
| `country` | 该 App 配置的店面 |
| `app_id` | |
| `source` | `lookup` / `store_page` |
| `lang_requested` | 固定 `en_us` |
| `locale_fallback` | Apple 是否退回了非英文 |
| `status` | `ok` / `error` / `unavailable` |
| `http_status` | |
| `iap_count` | 仅产品页 |
| `error` | 仅失败 |

批量 lookup 的行粒度见 4.1：**每 `app_id` 一行**，同一 HTTP 结果会拆成多行。`unavailable` = lookup 在该店面返回 0 结果或产品页 404（该店无此 App），见 4.1。

### 5.2 `points`

| 字段 | 说明 |
|------|------|
| `ts` | UTC ISO，与 crawls 同槽 |
| `country` | |
| `app_id` | |
| `platform` | |
| `item_kind` | `app_price` / `iap` |
| `item_key` | 付费下载价固定 `__app__` |
| `name` | 优先英文展示名 |
| `price` | 数字 |
| `currency` | 跟店面 |
| `formatted_price` | 原样 |

每个 `(app_id, country)` 每槽：付费一行 `app_price`（`item_key=__app__`）；有内购则每个内购再一行 `iap`。付费+内购同一槽多行。

价格字符串解析不出数字时，`price` 为空，表里仍显示 `formatted_price`。

### 5.3 `rollup/daily`

键：`(date_beijing, country, app_id, item_key)`。`date_beijing` 为 `YYYY-MM-DD`（Asia/Shanghai）。

字段：`open_price` / `close_price` / `min_price` / `max_price` / `samples` / `appeared`。

**覆盖写语义：** 同一北京日期每 4 小时会被重算 6 次，落盘必须**先删该 `date_beijing` 的旧行再写入**（不要逐轮 append），否则 daily 行会按轮次无限堆重复。北京日对应哪些 UTC 文件见 2.5 的映射 helper。

### 5.4 `current.json`

不再套一层多国 map。每个监控条目一个国家：

```json
{
  "generated_at": "2026-09-18T04:12:00Z",
  "data_ts": "2026-09-18T04:00:00Z",
  "display_timezone": "Asia/Shanghai",
  "apps": [
    {
      "app_id": "932747118",
      "name": "Shadowrocket",
      "pricing": "paid",
      "platform": "macos",
      "country": "us",
      "status": "ok",
      "has_iap": true,
      "iap_status": "ok",
      "items": [
        {
          "item_key": "__app__",
          "item_kind": "app_price",
          "name": "Shadowrocket",
          "price": 2.99,
          "currency": "USD",
          "formatted_price": "$2.99",
          "delta": 0
        },
        {
          "item_key": "Pro Upgrade",
          "item_kind": "iap",
          "name": "Pro Upgrade",
          "price": 4.99,
          "currency": "USD",
          "formatted_price": "$4.99",
          "delta": 0
        }
      ]
    },
    {
      "app_id": "388624839",
      "name": "CamScanner",
      "pricing": "free",
      "platform": "ios",
      "country": "us",
      "status": "ok",
      "has_iap": true,
      "iap_status": "ok",
      "locale_fallback": false,
      "items": [
        {
          "item_key": "CamScanner Premium",
          "item_kind": "iap",
          "name": "CamScanner Premium",
          "price": 2.99,
          "currency": "USD",
          "formatted_price": "$2.99",
          "delta": 0
        }
      ]
    }
  ]
}
```

`status`：`ok` / `error` / `unavailable`（该店无此 App）/ `no_iap`。  
`pricing` 是 lookup 判定结果，**不是配置字段**。`has_iap` / `iap_status`（`ok` / `error` / `no_iap`）描述产品页内购。付费 App 产品页失败时 `status` 仍为 `ok`（下载价有效）。  
`delta`：本轮价 − 上轮同 `item_key`；新出现为 `null`。

---

### 5.5 数据保留与清理

**points / crawls 保留 90 天，daily rollup 永久保留**（看板的 1 月 / 3 月档依赖 daily）。

- `cleanup.js --scope pricing`（或 `--scope all`）把 `data/pricing/points`、`data/pricing/crawls` 中 90 天前的文件删掉；`data/pricing/rollup/daily` 与 `meta` 不动。
- `cleanup.yml` 第一期手动触发，第二期再挂 schedule。
- 不清理的后果：data 分支无限膨胀，`git archive` 恢复、clone、push 全部变慢，最终拖垮 Actions 构建；必须把清理纳入定价 workflow 的常规维护。

---

## 6. 每 4 小时流程

```text
1. 读 config/pricing.json
2. 按 country 分组 App
3. 每组批量 lookup（country + lang=en_us）
4. 每个 (id, country)：（形态判定统一走 2.1 的三态）
     判定为 paid → 写 app_price 点
     再 GET 产品页 ?l=en，解析 In-App Purchases，逐条写 iap 点
     产品页失败：paid 仍保留下载价；free 整 App 记 error
     unavailable（lookup 无此 App）→ 不拉产品页、不写点
5. 写 crawls + points
6. 按北京日历日重算 daily（覆盖写，见 5.3）
7. 生成 current.json + public/pricing.html（时间已转北京）
8. 本地停；CI 推 data / gh-pages
```

| 命令 | 用途 |
|------|------|
| `node src/price-crawl.js --once` | 一轮 |
| `node src/price-crawl.js --loop --interval 14400` | 本地每 4 小时 |
| `node src/price-dashboard.js` | 生成看板 |

Actions 禁止 `--loop`。

---

## 7. UI

`pricing.html`。时间全部 **北京时间**（`src/pricing-util.js` 的 `beijingStr`）。

### 7.1 首页：App 卡片

每个 `(id, country)` 一张卡：

- 图标、**英文名**、平台
- 店面徽章：美国 / 日本 / …（配置的那一个 `country`）
- **付费** / **免费** / **付费·内购** / **免费·内购**（lookup + 是否解析到 IAP）
- 当前价摘要（付费：下载价；有内购：条数 + 最低～最高；付费+内购两者都显示）
- 上轮涨红、降绿
- `locale_fallback` 时角标「非英文」
- 点进详情（无需再选国家）

### 7.2 详情：下载价 + 可切换的内购 SKU

付费、免费用同一套详情，不再分两个页面：

- 项目表：付费时第一行是「下载价」，其余为内购 SKU（可多到 10+ 条）
- **「查看项目」下拉**与表行点击同步：选中哪条就画哪条走势
- **付费 + 内购**：选中某条内购时，折线**同时**画下载价（蓝）和该内购（橙）；选「下载价」则只画 App 价
- 范围：今天 / 3 天 / 1 周 / 1 月 / 3 月；Y 轴金额越大越往上；轴标签为北京时间，例如 `09-18 12:00`
- 未列出灰点；失败灰叉，不断成 0

### 7.3 （已并入 7.2）

### 7.4 不要用饼图

### 7.5 告警

对该 App 配置的那一个店面：下载价变动、内购涨跌、内购出现/消失。**只在相对上一轮发生变化时输出**（`delta !== 0`、`appeared` 翻转、status 变化），不变不刷屏。

- 输出到终端 / Job Summary；另追加写 `data/pricing/alerts.jsonl`（字段：`ts`、`country`、`app_id`、`item_key`、`kind`、`event`、`old_price`、`new_price`），历史可检索、可去重，不需要再翻 points 找。
- 文案里的时间用北京时间。
- `unavailable` / 采集失败类告警当日只报一次，避免每 4 小时重复炸。

---

## 8. 失败与边界

- 该 App 的 lookup 失败：写 error，不写点，标「未知」，不当 0 元。产品页失败：免费整 App 失败；付费仍保留下载价。
- lookup / 产品页在该店面返回空（未上架 / 下架 / 404）：`unavailable`，不写点，看板「该店无此 App」，不告警（见 4.1）。
- `price === 0` 但 `formattedPrice` 含货币符号：`suspect`，打 warn、看板标「待核对」，按付费记下载价并继续解析内购（见 2.1）。
- 跳到同意页 / 验证页：当 error。
- 无英文本地化：收下 Apple 回退语言，`locale_fallback: true`。
- JSON 路径失败则 `dt` 回退（英文标题优先）。
- 同名多价排序变化、多条变一条时的键回退：第一期不修（见 4.3）。
- 只观察 App Store 公开标价。

---

## 9. 本地与 GitHub Actions

```bash
node -v
# 日本店 + 英文名
curl -s "https://itunes.apple.com/lookup?id=388624839&country=jp&lang=en_us"
# 日本店产品页 + 英文栏
curl -sL -A "Mozilla/5.0" -H "Accept-Language: en-US" \
  "https://apps.apple.com/jp/app/id388624839?l=en" | head
```

验收：

1. 配置 1 个付费店面 + 1 个免费店面（都只写 id/platforms/country）。
2. `--once`：lookup 名为英文；**付费和免费**都能解析产品页 `In-App Purchases`（付费同时有下载价点）。
3. 再跑一轮：jsonl 追加，`ts` 在 4 小时槽，看板时间为北京时间。
4. 只写 `data/pricing/`。
5. 删掉某天的一部分 points，重跑 rollup：确认 daily **覆盖写**而不是翻倍（见 5.3）。
6. 跑一次 `pricing.yml` 后检查 gh-pages 上有 `pricing.html`。

`.github/workflows/pricing.yml` 负责采集、rollup、生成看板并部署。cron-job.org **每 4 小时**触发。部署注意下面 9.1 / 9.2。

### 9.1 部署到 gh-pages

`pricing.yml` 用 peaceiris `keep_files: false` 发布 `./public`，会清空 gh-pages 里除本次产物外的文件。若该分支上已经有其它静态页、需要保留：

- 生成 `public/pricing.html` 后，先 `git clone --branch gh-pages` 把要保留的文件拷进 `public/`，再统一部署；
- 或者把部署步骤改成 `keep_files: true`（页面永不清理，代价是 gh-pages 会积累不再产出的旧文件）。

### 9.2 并发

- `pricing.yml` 的 `concurrency.group` 用 `pricing-crawl`。
- cron-job.org 触发分钟例如 `23 */4 * * *`。
- 极端情况下若 push data 分支冲突：接受「本轮失败、下轮自愈」，不加重试逻辑。

---

## 10. 实现阶段

### 阶段 A

- `pricing.json`（每 App 必填 `country`）+ 启动校验（见第 3 节）
- lookup：`country` + `lang=en_us`（含批量行粒度、`unavailable` 判定，见 4.1）
- 产品页：`?l=en` + `Accept-Language`
- 付费 / 免费三态判定（见 2.1）；配置不填 `pricing`
- `--once` 写入 `data/pricing/`

### 阶段 B

- `current.json`（含 `unavailable` / `suspect` 状态展示）
- `pricing.html`：北京时间、单店面卡片 / 折线 / 内购表与 SKU 切换（付费+内购可叠画）

### 阶段 C

- 按北京日历日 rollup（覆盖写 + 北京日↔UTC 映射 helper，见 5.3 / 2.5）
- 告警：仅变化时输出，落 `alerts.jsonl`（见 7.5）

### 阶段 D

- `pricing.yml` + cron-job.org 每 4 小时（`concurrency.group: pricing-crawl`）
- gh-pages 部署时不要误删已有静态页（见 9.1）
- cleanup 扩展 `data/pricing/` scope（见 5.5）

### 明确不做（第一期）

- 一个 App 自动扫多国（要多国就配置多行）
- Product ID / Connect
- 我们自己翻译文案
- 每小时采价

---

## 11. 你需要提供的 JSON

```json
{
  "id": "932747118",
  "platforms": ["macos"],
  "country": "us"
}
```

```json
{
  "id": "388624839",
  "platforms": ["ios"],
  "country": "us"
}
```

`country` 必填。不要把 iOS ID 标成 `macos`。**不要填 `pricing` / `paid` / `free`**——lookup 会判定是否付费，产品页会判定有没有内购。联调可用上面两条：Shadowrocket `us`，以及扫描全能王 `us`。

---

## 12. 参考

- 北京时间展示：`src/pricing-util.js` 中 `beijingStr`
- Lookup 语言： [iTunes Search API `country` / `lang`](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/Searching.html)（`lang` 默认 `en_us`）
- 产品页 `l=`：[店面路径与语言参数](https://mobilemoxie.com/blog/localization-differences-itunes-app-store-google-play-store-24/)
- 清理：`src/cleanup.js`（扫 `data/pricing/` 下的 points/crawls，见 5.5）

---

## 13. 验证记录（2026-09-18）

本节固化第一次真实采集验证的过程与结论，供后续开发与排障回溯。验证对象是对外公开的 App Store 数据，仅作价格监控，无越权行为。

### 13.1 验证方法与请求节奏

- 临时脚本 `AppPriceTracker/validate-pricing.mjs`（已保留，作为阶段 A `price-crawl.js` 的骨架参考）：
  1. lookup（`country` + `lang=en_us`，失败重试 1 次）；
  2. 三态判定（方案 2.1）；
  3. 免费 App 抓产品页（`?l=en` + `Accept-Language: en-US`，`mac-software` 加 `mt=12`）；
  4. 解析内购（`dt/dd` + `div.text-pair`，同名多价加 `#N` 序号）；
  5. canonical 校验判定兜底页。
- **请求节奏：串行 + `REQUEST_INTERVAL_MS = 30_000` 常量**（集中定义在脚本顶部）。本轮 23 次请求零 429。正式脚本沿用此常量（方案 4.2）。
- 验证目标共 14 条 `(id, country)`，覆盖 5 付费 + 9 免费、1 个真正 Mac App（Bear）、1 个「标注免费但实际付费」案例（CamScanner）。

### 13.2 lookup 结果（付费 / 判定）

| App ID | 区 | trackName | kind | price | formattedPrice | currency | 判定 |
|---|---|---|---|---|---|---|---|
| 932747118 | us | Shadowrocket | software | 2.99 | $2.99 | USD | paid |
| 1438243180 | us | Dark Reader for Safari | software | 4.99 | $4.99 | USD | paid |
| 1443988620 | us | Quantumult X | software | 9.99 | $9.99 | USD | paid |
| 1438243180 | cn | Dark Reader for Safari | software | 38 | ¥38.00 | CNY | paid（中国区在售，价格随店面） |
| 388624839 | cn | CamScanner + \| PDF Scanner | software | 1 | ¥1.00 | CNY | **paid（与「免费」标注冲突，见 13.4-5）** |
| 545519333 | us | Amazon Prime Video | software | 0 | Free | USD | free |
| 6473753684 | us | Claude by Anthropic | software | 0 | Free | USD | free |
| 6448311069 | us | ChatGPT | software | 0 | Free | USD | free |
| 1017492454 | us | YouTube Music | software | 0 | Free | USD | free |
| 1091189122 | cn | Bear: Markdown Notes | **mac-software** | 0 | Free | CNY | free |
| 590338362 | cn | 网易云音乐-数亿音乐畅听 | software | 0 | Free | CNY | free |
| 1605585211 | cn | 汽水音乐 - 随时听好歌 | software | 0 | Free | CNY | free |
| 414603431 | cn | QQ音乐 - 听我想听 | software | 0 | Free | CNY | free |
| 1544884479 | cn | 蛋仔派对 | software | 0 | Free | CNY | free |

备注：`kind=software` 为 iOS Universal；用户标注为 macOS 的 Shadowrocket / Dark Reader / Quantumult X / Amazon Prime Video 实际 lookup 均为 `software`（无独立 Mac 版 ID），仅 Bear 是真正的 `mac-software`（产品页需 `mt=12`）。

### 13.3 免费 App 内购解析结果（cn 区 5 个全部成功）

统一特征：`html lang="en-GB"`（`?l=en` 的返回值）、栏目标题英文 `In-App Purchases`、`locale_fallback=false`、商品展示名保持中文（App 自身无英文本地化，脚本不翻译）。

**Bear: Markdown Notes**（cn / mac-software，`mt=12`；2 条）

```text
Bear Pro = ¥22.00
Bear Pro#2 = ¥198.00
```

**网易云音乐**（cn；10 条，同名多价命中）

```text
连续包月黑胶VIP = ¥15.00
连续包月黑胶VIP#2 = ¥15.00
黑胶VIP连续包月 = ¥15.00
黑胶VIP连续包月(新客专享) = ¥15.00
连续包月音乐包 = ¥8.00
连续包月黑胶VIP促销 = ¥15.00
黑胶VIP连续包月#2 = ¥15.00
黑胶VIP首月5元 = ¥12.00
黑胶VIP连续包月#3 = ¥15.00
黑胶VIP连续包月#4 = ¥15.00
```

**汽水音乐**（cn；10 条）

```text
汽水会员连续包月 = ¥8.00
汽水VIP-连续包月优惠 = ¥8.00
汽水SVIP连续包月 = ¥15.00
汽水VIP连续包月 = ¥8.00
汽水VIP-连续包月试用 = ¥8.00
汽水SVIP连续包月#2 = ¥15.00
汽水SVIP连续包月#3 = ¥15.00
汽水VIP-连续包月优惠#2 = ¥8.00
汽水SVIP连续包月#4 = ¥15.00
汽水VIP-连续包月优惠#3 = ¥8.00
```

**QQ音乐**（cn；10 条）

```text
绿钻豪华版-自动订阅 = ¥15.00
豪华绿钻连续包月 = ¥15.00
连续包月付费音乐包 = ¥8.00
超级会员连续包月 = ¥19.00
30个乐币 = ¥3.00
1个月付费音乐包 = ¥8.00
豪华绿钻连续包月#2 = ¥15.00
超级会员连续包月#2 = ¥19.00
10个乐币 = ¥1.00
超级会员连续包月#3 = ¥30.00
```

**蛋仔派对**（cn；10 条）

```text
60蛋币 = ¥6.00
10蛋币 = ¥1.00
6元礼包 = ¥6.00
300蛋币 = ¥30.00
一元礼包 = ¥1.00
每日一元礼包 = ¥1.00
680蛋币 = ¥68.00
12元礼包 = ¥12.00
订购YO！会员 = ¥12.00
1280蛋币 = ¥128.00
```

us 区免费 App（Amazon Prime Video / Claude / ChatGPT / YouTube Music）的产品页本机未能验证，原因见 13.4-1；lookup 的免费判定本身全部正确。

### 13.4 关键发现（已实测，影响实现）

1. **us 产品页地区兜底**：本机出口 IP 在中国，`https://apps.apple.com/us/app/id…?l=en` 实际返回的是中国区 Today 首页（`canonical=https://apps.apple.com/cn/iphone/today`，title「iPhone 版 Today」，`html lang=zh-Hans-CN`），无任何 IAP 标题。**必须做 canonical 校验**（`/app/<slug>/id{id}` 匹配），不匹配即按 error（方案第 8 节）。CI 环境预期正常，见 13.6。
2. **items_V3 JSON 路径失效**：最新版 Svelte 产品页已找不到可解析的 `items_V3`（0 条）。真实生效结构为 `dt`（`<dt class="svelte-…">In-App Purchases</dt>`）+ `dd > details > ul > li > div.text-pair svelte-…`（`<span>名</span><span>价</span>`）。解析必须用 `class="[^"]*text-pair[^"]*"` 前缀匹配，不能绑死 `class="text-pair"`（后者已验证抓 0 条）。方案 4.2 的「优先 JSON」需按此修正为 **dt/dd 为主**。
3. **429 限流真实存在**：3~5 并发、无间隔的快速压测命中过一次 HTTP 429（Bear 产品页）；改为串行 30s 间隔后 23 次请求零 429。方案 4.2 已改为串行 + `REQUEST_INTERVAL_MS` 常量。
4. **`?l=en` 返回 `html lang="en-GB"`** 且栏目标题正常为英文；多个 App 的 `trackName` 是中文但英语页面正常 → 中文 `trackName` 不能作为 locale_fallback 判据，方案 2.4 判定标准已修正。
5. **CamScanner 国区为 ¥1.00 付费**（`price=1`）：标注 free 与实际冲突时按方案 2.1 以 lookup 为准 → paid。是否要抓其内购需拍板。
6. **同名多价序号生效**：网易云「连续包月黑胶VIP#2」、汽水「汽水SVIP连续包月#2/#3/#4」、QQ「超级会员连续包月#2/#3」均为同展示名多次出现 → `#N` 序号键（方案 4.3），实测正确。

### 13.5 产物与文件

- `AppPriceTracker/validate-pricing.mjs` ：验证脚本（保留，作阶段 A 骨架）。
- `AppPriceTracker/config/pricing.json` ：草案，含 9 条**可本机稳定验证**的目标（剔除 us 免费 4 条与 CamScanner，原因见 13.4-1 / 13.4-5）。`note` 字段仅为验证信息，正式实现按方案第 3 节不落配置。
- 临时探查脚本与日志已在验证后清理。

### 13.6 GitHub Actions 部署后的 us 店请求预期（待 CI 实测）

- **付费 App 一定成功**：`itunes.apple.com/lookup?country=us` 的价格由请求参数决定，与本机/CI 出口 IP 无关，本机已验证 us 付费价、货币、英文名全部正确 → CI 上无差别。
- **us 产品页预期成功、需实测确认**：本机兜底仅因出口 IP 位于中国；GitHub Actions 的 ubuntu runner 出口在北美，预期 `apps.apple.com/us/app/…` 正常返回产品页。落地验证方式：`pricing.yml` 首个 run 用 `workflow_dispatch` 手动触发，检查 Job Summary 中每个免费 App 的 `is_product_page` / `locale_fallback` / 内购条数（脚本已带 canonical 判定），`is_product_page=false` 即按 error 报出。
- **残留风险与兜底**：数据中心 IP 仍可能触发 Apple 频控或验证页；已有串行 30s 间隔 + 429/5xx 重试 1 次兜底。若 CI 上 us 页仍被拦，备选方案是降低频率（如轮内间隔调到 60s）或对 us 目标改用 `itunes.apple.com` 侧可用信息。

---

## License

[MIT](LICENSE)
