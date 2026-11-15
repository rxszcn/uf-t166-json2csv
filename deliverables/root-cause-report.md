# 根因诊断报告：按天分区的报表日期整体回退一天

> 环境基线：Node v24.16.0 / Windows 11 / 仓库 `@json2csv` monorepo 7.0.8。
> 仓库已执行 `npm run build`；下文行号均指**仓库工作树内的源文件**（`packages/*/src`），
> 运行期实际加载的是各包 `dist` 构建产物（行号会随编译偏移，见 §7 的包解析说明）。

## 1. 结论（TL;DR）

`Date` 在 json2csv 的「按 `typeof` 分派」的格式化器槽位表里**没有专属槽位**：`typeof new Date()`
是 `'object'`，因此 Date 被静默分派到 `object` 槽；`object` 槽用 `JSON.stringify()` 序列化，
触发 `Date.prototype.toJSON()` → `Date.prototype.toISOString()`，**一律按 UTC 渲染**。

数仓驱动把无时区的 `DATE` 列（日历日期 `2024-01-15`）按会话时区 `+08:00` 锚定成“本地午夜”
这一瞬时：`2024-01-15T00:00:00+08:00` = `2024-01-14T16:00:00.000Z` = epoch ms `1705248000000`。
序列化按 UTC 渲染后，日期部分就是 `2024-01-14`，于是**整列按天分区的报表日期回退一天**。

同一条链上：

- **为什么与时区无关**：这条链只读 Date 内部的 epoch ms，从不调用任何本地时区 API
  （`getFullYear`/`getMonth`/`getDate`/`getTimezoneOffset`/`toLocale*`/`toString`），
  也从不读 `process.env.TZ`。偏移在驱动「物化那一刻」就已固化进 epoch ms，导出机时区
  既不改变 epoch ms，也不改变“按 UTC 渲染”这条规则 → 三种时区下**逐字节一致地错**。
  把导出机搬到 UTC 也治不好。
- **为什么字符串时间戳完全不偏移**：字符串列走 `string` 槽，只做引号转义与包裹，
  逐字透传，全程不产生 instant（见 `packages/formatters/src/string.ts:21-27`）。
- **为什么槽位表里找不到时间类型的槽**：`FormatterTypes` 枚举只有
  `header/undefined/boolean/number/bigint/string/symbol/function/object`
  （`packages/plainjs/src/BaseParser.ts:35-45`），没有 `date`；而且 `typeof` 永远
  产生不了 `'date'`，所以即便用户显式传 `formatters.date`，类型层会拒绝（`TS2353`），
  运行期也会被静默忽略（探针实测：调用次数 0，见 §5）。
- **为什么只有时间对象行偏移**：`DATE` 列被物化成 Date → 走 UTC 渲染；同一管线的
  `DATETIME`/`TIMESTAMP` 列若也是 Date 同样会被 UTC 渲染（时区丢失），而字符串列
  不受影响。这正是“同一管线里字符串时间戳不偏移，只有时间对象行偏移”的直接解释。

## 2. 序列化链定位（文件:行号）

| # | 环节 | 位置 | 关键代码 | 作用 |
|---|---|---|---|---|
| ① | 按类型分派 | `packages/plainjs/src/BaseParser.ts:273-276` | `const formatter = this.opts.formatters[typeof value]` | `typeof new Date()` 为 `'object'`，Date 被分派到 object 槽 |
| ② | 槽位枚举 | `packages/plainjs/src/BaseParser.ts:35-45` | `enum FormatterTypes { …, object }` | **没有 `date` 槽**；且 `typeof` 无法产生 `'date'`，用户无配置入口 |
| ③ | 槽位类型 | `packages/plainjs/src/BaseParser.ts:47-58` | `FormattersOptions` 索引签名 | 同上，无 `date` 键 |
| ④ | 默认槽位填充 | `packages/plainjs/src/BaseParser.ts:120-133` | `const objectFormatter = objectFormatterCtor({ stringFormatter }); … object: objectFormatter` | object 槽默认指向对象格式化器 |
| ⑤ | 对象格式化器 | `packages/formatters/src/object.ts:10` | `let stringifiedValue = JSON.stringify(value)` | 对 Date 触发 `toJSON()` → `toISOString()`，**按 UTC 渲染** |
| ⑥ | 去引号后重新加引号 | `packages/formatters/src/object.ts:14-17` | `.replace(/^"(.+)"$/, '$1')` + `stringFormatter` | 输出形如 `"2024-01-14T16:00:00.000Z"` |
| ⑦ | 字符串槽（对照，零偏移） | `packages/formatters/src/string.ts:21-27` | `value.replaceAll(quote, escapedQuote)` | 只转义与包裹，**逐字透传** |
| ⑧ | transforms 不拦截 Date | `packages/transforms/src/flatten.ts:32-39`、`packages/transforms/src/unwind.ts:14-22` | `Object.prototype.toString.call(value.toJSON) !== '[object Function]'` 时豁免递归 | `Date.prototype.toJSON` 是 Function，因此 Date 原样穿过 flatten/unwind 到达格式化器 |

补充：`flatten.ts:37-38` 与 `unwind.ts:18-19` 的 `toJSON` 豁免本意是“不展开带自定义序列化的对象”，
副作用恰好是”Date 不会被 flatten 展平成 `{}`（Date 无可枚举自有属性）”，因此它必然到达 ①。

`packages/plainjs/src/utils.ts:126-140` (`fastJoin`) 只做字符串拼接，与时间无关；
`packages/plainjs/src/Parser.ts:35-43`、`StreamParser.ts:177-201`、`node/src/Transform.ts:28-38`、
`whatwg/src/TransformStream.ts:16-21` 都最终调用同一个 `processCell → processValue`（①）,
所以 **Parser / StreamParser / node Transform / node AsyncParser / whatwg 行为完全一致**。

## 3. 为什么恰好“回退一天”

1. 数据库 `DATE` 列是**无时区的日历日期**（`2024-01-15`，不带时间、不带时区）。
2. 驱动物化时必须把它锚定到一个瞬时。按会话时区 `+08:00` 取本地午夜：
   `2024-01-15T00:00:00+08:00` → UTC `2024-01-14T16:00:00.000Z`（epoch ms `1705248000000`）。
3. 末端 `toISOString()` 按 UTC 渲染 → 日期部分是 `2024-01-14` → **按天分区整体落到前一天**。
4. 字符串列 `'2024-01-15'` 走 ⑦，只加引号，**逐字透传**，零偏移。

方向取决于会话时区符号，实测矩阵（`node deliverables/repro-date-shift.mjs --sessions`）：

```
会话时区   DATE 2024-01-15 的物化 instant          现状渲染日期  是否回退
-12:00     2024-01-15T12:00:00.000Z             2024-01-15     否（D）
-05:00     2024-01-15T05:00:00.000Z             2024-01-15     否（D）
+00:00     2024-01-15T00:00:00.000Z             2024-01-15     否（D）
+05:30     2024-01-14T18:30:00.000Z             2024-01-14     是（D-1）
+08:00     2024-01-14T16:00:00.000Z             2024-01-14     是（D-1）
+14:00     2024-01-14T10:00:00.000Z             2024-01-14     是（D-1）
```

即：**正偏移（东经）会话必然回退 D-1；负偏移（西经）会话停留 D 甚至可能跨到 D+1**
（`DATETIME` 列在 `-05:00` 会话、`23:00` 本地时刻会跨到次日，见 §6 下游影响）。

## 4. 为什么该偏移与时区无关（重点）

四个独立证据，均可由 `repro-date-shift.mjs` 复跑：

1. **链上不读机器时区**：把 `Date.prototype` 上全部本地时区 API（`getFullYear`/`getMonth`/
   `getDate`/`getDay`/`getHours`/`getMinutes`/`getSeconds`/`getMilliseconds`/
   `getTimezoneOffset`/`toLocaleString`/`toLocaleDateString`/`toLocaleTimeString`/
   `toDateString`/`toTimeString`/`toString`）全部替换为抛错函数，导出仍成功且输出逐字节不变。
   说明 `typeof` 分派（①）与 `JSON.stringify`→`toJSON`→`toISOString`（⑤）只依赖 epoch ms。
2. **偏移在物化阶段已固化**：`Date.getTime()` = `1705248000000`，由驱动锚定那一刻决定，
   与导出机时区无关；`toISOString()` 是纯函数（epoch ms → UTC 日历字段）。
3. **多时区矩阵逐字节一致**：`--matrix` 用 `spawnSync` 显式向子进程传 `TZ`，
   子进程内先打印真实生效时区再断言（避开 Git Bash 丢弃 `TZ=Asia/Tokyo` 的坑）：

   ```
   请求时区          生效时区           本地偏移  CSV sha256(前16)    Date 列
   UTC               UTC               0        c2adbfee20883e1b   "2024-01-14T16:00:00.000Z"
   Asia/Shanghai     Asia/Shanghai     -480     c2adbfee20883e1b   "2024-01-14T16:00:00.000Z"
   America/New_York  America/New_York  300      c2adbfee20883e1b   "2024-01-14T16:00:00.000Z"
   Asia/Tokyo        Asia/Tokyo        -540     c2adbfee20883e1b   "2024-01-14T16:00:00.000Z"
   Europe/Berlin     Europe/Berlin     -60      c2adbfee20883e1b   "2024-01-14T16:00:00.000Z"
   ```

4. **运行期切换 `process.env.TZ` 不改变输出**：同一进程内依次设置
   `TZ=UTC` / `EST5EDT` / `Asia/Shanghai`（`Intl` 解析出的时区随之变为 `UTC` /
   `America/New_York` / `Asia/Shanghai`，证明设置确实生效），三次 CSV 完全相同：

   ```
   UTC:           resolved=UTC              "2024-01-14T16:00:00.000Z"
   EST5EDT:       resolved=America/New_York "2024-01-14T16:00:00.000Z"
   Asia/Shanghai: resolved=Asia/Shanghai    "2024-01-14T16:00:00.000Z"
   ```

> 关于“本地日历字段”：`repro` 会同时打印 `Date 本地日历字段`。在 `Asia/Shanghai`
> 机器上是 `2024-1-15`，在 `UTC` 机器上是 `2024-1-14` —— 只有这条**诊断线索**随机器变化。
> 生产链路从不调用它，所以是“诊断值会变、真实输出不变”。

## 5. 复现证据（脚本实测输出）

`node deliverables/repro-date-shift.mjs`（当前机器，系统时区 `Asia/Shanghai`）：

```
── 环境 ───────────────────────────────────────────────
TZ 环境变量                        = (未设置，用系统时区)
实际生效时区                       = Asia/Shanghai
机器本地偏移(分钟)                 = -480
管线会话时区                       = +08:00 (480 分钟)

── 被导出的值 ─────────────────────────────────────────
DATE 日历日期                      = 2024-01-15
Date.epoch ms                      = 1705248000000 (物化后固定不变)
Date.toISOString()                 = 2024-01-14T16:00:00.000Z
Date 本地日历字段                  = 2024-1-15 （只有本地时区 API 才随机器变化）
typeof Date                        = object → 命中 formatters['object'] 槽
直接调用 object 格式化器           = "2024-01-14T16:00:00.000Z"

── 分派链探针 ─────────────────────────────────────────
显式 formatters.date 调用次数      = 0
传入 date 槽后 CSV 不变            = true
Date.prototype.toJSON 调用次数     = 1
禁用本地时区 API 后 CSV 不变       = true

── CSV 输出 ───────────────────────────────────────────
"id","report_date_obj","report_date_str"
1,"2024-01-14T16:00:00.000Z","2024-01-15"

── 判定 ───────────────────────────────────────────────
Date 列                            = "2024-01-14T16:00:00.000Z" ← 回退一天（BUG）
字符串列                           = "2024-01-15" ← 逐字未变
CSV sha256                         = c2adbfee20883e1b16a0d5a18752eea05189b53245728919f1f434e506d2a6e4

── transforms 不拦截 Date ─────────────────────────────
flatten 后仍是原 Date 对象 = true | API 输出 = "2024-01-14T16:00:00.000Z"
unwind 后仍是原 Date 对象  = true | API 输出 = "2024-01-14T16:00:00.000Z"

── 纯字符串输入（对照） ───────────────────────────────
纯字符串 CSV                       = "\"ts\"\n\"2024-01-15 00:00:00\""
与期望逐字一致                     = true

OK: 复现成功 —— Date 列回退一天，字符串列逐字不变，formatters.date 被静默忽略。
```

附带的三个探针同时否掉了两个常见误判：

- **“给 Date 配一个 formatter 就行”**：显式 `formatters.date` 调用次数为 0
  （`typeof` 分派根本到不了它；TS 层直接报 `TS2353: 'date' does not exist in type 'FormattersOptions'`）。
- **“导出机时区设成 UTC 就好了”**：三种时区下 CSV sha256 完全相同（§4 证据 3）。

## 6. 对存量按天分区下游的影响（现状，未修复前）

| 受影响对象 | 机制 | 现网后果 |
|---|---|---|
| `DATE` 列（按天分区键） | 见 §3 | 东部正偏移会话：全部分区 D→D-1；西部负偏移会话：D 不变或个别 D→D+1 |
| `DATETIME`/`TIMESTAMP` 列 | 同样是 Date 走 ⑤ | 时间部分被强制 UTC（如 `2024-01-15 15:30 +08:00` 输出 `07:30Z`）；若下游直接截前 10 位当日期，跨 UTC 午夜的行会挪到相邻天（如 `2024-01-15 23:30-05:00` → `2024-01-16`） |
| 字符串列 | 走 ⑦ | 零偏移、零变化 |
| 按分区做 `join`/去重/累计的下游 | 依赖分区键 | 与历史分区错位一天，跨天累计会在切换日重复/缺失一天 |

**关键点**：由于偏移在物化时固化，**现网数据本身没有错**——错的是渲染。因此推断：只要
管线的会话时区在物化期间保持一致，历史分区就稳定地整列偏移同一个方向；切换修复方案时
必须整体重刷，不能“只刷以后”。注意 DST 会话（如 `Europe/Berlin`）的 `DATE` 锚定在冬夏令时
使用不同偏移，**单一固定偏移无法同时校正历史全部日期**（见修复设计 §1 的限制说明）。

## 7. 运行与构建注意事项（复现前必读）

1. 包入口解析（实测，务必注意）：
   - 在 `packages/<pkg>` 内 import **自身包名** → 解析到 `packages/<pkg>/dist`（Node 的包自引用）；
   - 在其他包或仓库根目录 import 该包 → 解析到 `node_modules/@json2csv/<pkg>/dist` **副本**；
   - `npm run build -w <pkg>` 只写 `packages/<pkg>/dist`，**不同步** `node_modules` 副本。
   因此：`deliverables/repro-date-shift.mjs`（仓库根目录运行）实际加载的是
   `node_modules/@json2csv/*/dist`；`packages/plainjs/test/*` 里 import `@json2csv/plainjs`
   用的是 `packages/plainjs/dist`，而它 import 的 `@json2csv/formatters` 用的是 `node_modules` 副本。
   改完源码后请 `npm install`（workspace 重新落盘）或手工同步两处，否则“跑起来”的仍是旧产物
   （本次排查实测：只改 `packages/plainjs/dist` 不会影响根目录脚本和跨包测试加载的副本）。
2. 在 Git Bash 里 `TZ=Asia/Tokyo node ...` 会丢变量（`process.env.TZ` 为 `undefined`），
   静默使用系统时区；`TZ=UTC`、`TZ=EST5EDT` 这类无 `/` 的值才会生效。
   `--matrix` 模式已用 `spawnSync` 规避此坑，并在子进程内校验“请求时区 = 生效时区”。
3. 既有测试基线（三次不同时区，均通过）：
   ```
   TZ=UTC              Test Files 10 passed / Tests 708 passed
   TZ=Asia/Shanghai    Test Files 10 passed / Tests 708 passed
   TZ=America/New_York Test Files 10 passed / Tests 708 passed
   ```

## 8. 结论边界（本报告没有、也不该归因于库的部分）

- 驱动的“DATE → 本地午夜 instant”锚定是**管线侧口径选择**，不是 json2csv 的缺陷；
  库侧能做的是让渲染口径可显式声明、可审计，并给 `Date` 一个真正的槽位。
- `packages/test-helpers/fixtures/json/date.js` 与 `fixtures/csv/date.csv` 存在但
  **当前没有任何测试引用**（全仓 `grep` 无引用），所以现状对 Date 的既有测试覆盖为零
  —— 这也是该缺口长期未被发现的原因之一；修复设计会补上。
