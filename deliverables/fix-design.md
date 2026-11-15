# 修复设计：Date 专属格式化槽位 + 固定时区口径

> 配套根因：`deliverables/root-cause-report.md`（行号定位在 §2）。
> 复现与修复模拟：`deliverables/repro-date-shift.mjs`
> （`--simulate-fix` / `--simulate-fix-matrix` 用参考实现演示修复后输出）。
>
> 本文件是**设计稿**，未改动仓库源码。文中“行号”均指当前工作树源文件。

---

## 0. 方案总览

| 层次 | 动作 | 影响面 |
|---|---|---|
| L1 库内（必需） | 给 `Date` 增加真正可配置的 formatter 槽位，默认行为与现状**逐字节一致** | `@json2csv/plainjs` + `@json2csv/formatters` |
| L2 管线（必需） | 显式声明业务时区口径（固定偏移），把 `DATE` 渲染回业务日历日 | 导出配置一行；需重刷受影响分区 |
| L3 管线（推荐，治本） | 纯 `DATE` 列让驱动直接返回字符串（如 mysql2 `dateStrings: true`） | 该列走既有字符串路径，天然无 instant 化 |

L1 保证“不配置就不变”；L2 是本次业务口径的订正；L3 是从根上避免“无时区日历日期被 instant 化”。
三者正交，可分别落地与回滚。

---

## 1. 时区口径三选一：选「固定时区」

| 候选 | 具体做法 | 与硬性约束的冲突 | 结论 |
|---|---|---|---|
| A. 本地时区 | 用 `getFullYear/getMonth/getDate/getHours` 渲染 | 输出随导出机 TZ 变化：`UTC` 机器得 `D-1`、`Asia/Shanghai` 机器得 `D`，**违反“三种时区下同一配置逐字节一致”**；且 CI/生产机器时区漂移会静默改写分区键 | **否决** |
| B. 保持原时区 | 依赖 Date 里保存的“原时区”还原 | JS `Date` 内部**只有 epoch ms**，不携带时区/偏移；无任何 API 可恢复“数据库会话时区”。真正的“保持原时区”只能发生在驱动层（返回字符串），那已是既有字符串路径，不需要本设计 | **否决（转为 L3 建议）** |
| C. **固定时区** | 显式配置固定 UTC 偏移 `timezoneOffsetMinutes`；渲染只读 `epoch ms + 偏移`，用 `getUTC*`/`toISOString`，全程不碰机器时区 | 无冲突：偏移来自配置（可审计、可版本化），与运行机器无关；`JSON.stringify`/`toISOString` 本就是 UTC 纯函数 | **采纳** |

**采纳理由（C）**：

1. **确定性**：输出 = `f(epoch ms, 配置常量)`，与 `process.env.TZ`、系统时区、ICU 数据无关
   → 三时区逐字节一致（实测 sha256 相同，见 §6）。
2. **可审计**：`+08:00`（无夏令时）作为业务口径写进配置，随代码评审与发布记录留痕。
3. **最小惊讶**：默认 `timezoneOffsetMinutes = 0` 时**直接复用现状的 object 槽实现**，
   现网输出零变化（见 §2.1 的默认分支）。
4. **可回滚**：口径是调用方显式配置项，回滚 = 删除配置，不需要回滚库版本。

**C 的已知限制（必须写进交付说明）**：

- 固定偏移只能精确校正**一段会话偏移恒定**的数据。若数据库会话时区在历史数据上发生过
  夏令时切换（如 `Europe/Berlin` 冬 `+01:00` / 夏 `+02:00`），单一固定偏移无法同时校正
  历史全部日期（实测：冬令 `instant=2024-01-14T23:00Z`、夏令 `2024-07-14T22:00Z`，
  `X=+01:00` 只能救冬令，`X=+02:00` 只能救夏令）。这类环境请直接走 **L3**（驱动返回字符串），
  或按“分区日 + 数据日期范围”分段重刷并分别指定偏移。
- 对 `DATETIME`/`TIMESTAMP`，固定偏移输出的是**带显式偏移后缀的墙钟时间**
  （`2024-01-15T00:00:00.000+08:00`），与现状的 `…Z` 不同——这是有意的口径显式化，
  下游若要 UTC 串请改用 `timezoneOffsetMinutes: 0`（默认，现状行为）。

---

## 2. 改动清单（含文件:行号）

### 2.1 新增 `packages/formatters/src/date.ts`

```ts
import objectFormatter from './object.js';
import type Formatter from './Formatter.js';
import defaulStringFormatter from './string.js';

export interface DateFormatterOptions {
  stringFormatter?: Formatter<string>;
  /** 固定 UTC 偏移（分钟）。+08:00 => 480。取值 [-1440, 1440]。 */
  timezoneOffsetMinutes?: number;
  /** 'iso'（默认）输出完整时间；'date' 只输出 YYYY-MM-DD。 */
  format?: 'iso' | 'date';
}

export default function dateFormatter<T extends Date>(
  opts: DateFormatterOptions = {},
): Formatter<T> {
  const stringFormatter = opts.stringFormatter ?? defaulStringFormatter();
  const timezoneOffsetMinutes = opts.timezoneOffsetMinutes ?? 0;
  const format = opts.format ?? 'iso';

  if (
    !Number.isInteger(timezoneOffsetMinutes) ||
    Math.abs(timezoneOffsetMinutes) > 1440
  ) {
    throw new RangeError(
      'timezoneOffsetMinutes must be an integer within [-1440, 1440]',
    );
  }

  // 默认口径 = 现状 object 槽（JSON.stringify → toJSON → toISOString），
  // 逐字节不回退；且天然保留 Date 子类/自定义 toJSON 的既有语义。
  const legacy = objectFormatter({ stringFormatter });
  if (timezoneOffsetMinutes === 0 && format === 'iso') return legacy;

  const suffix = offsetSuffix(timezoneOffsetMinutes);

  return (value: T) => {
    // 仅处理“标准 Date”；子类/跨 realm/自定义序列化一律回退现状路径。
    if (
      value.toJSON !== Date.prototype.toJSON ||
      value.toISOString !== Date.prototype.toISOString
    ) {
      return legacy(value);
    }

    const time = Date.prototype.getTime.call(value);
    if (!Number.isFinite(time)) return legacy(value); // Invalid Date → "null"

    const MAX = 8.64e15;
    const shifted = time + timezoneOffsetMinutes * 60000;
    // 偏移把瞬时推出可表示范围（±275760 年）时，退回未偏移值，绝不抛错丢行。
    const iso = new Date(Math.abs(shifted) <= MAX ? shifted : time).toISOString();

    if (format === 'date') return stringFormatter(iso.split('T')[0]);
    return stringFormatter(`${iso.slice(0, -1)}${suffix}`);
  };
}

function offsetSuffix(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}
```

设计要点：

- **默认分支直接返回 `legacy`**：不是“数学上等价”，而是**字面上走旧实现**，
  因此对 Date 子类、跨 realm、`Invalid Date`、极值年份等边界零风险（实测见 §3.3）。
- 非默认分支只读取 `Date.prototype.getTime`（不触发子类覆盖）与 `toISOString`，
  **不出现任何 `getFullYear/getMonth/getDate/getTimezoneOffset/toLocale*`** → 与机器时区无关。
- 偏移越界时 clamp 回原瞬时，保证 `+275760-09` 这类极值边界不抛 `RangeError`。
- `format: 'date'` 用 `iso.split('T')[0]` 而非 `slice(0,10)`：极值年份是
  `+275760-09-13`（11 字符），`slice(0,10)` 会截错。

### 2.2 `packages/formatters/src/index.ts`（+1 行，导出）

在现有 `object` 导出（第 4 行）后追加：

```ts
export {
  default as date,
  type DateFormatterOptions,
} from './date.js';
```

（`packages/formatters/package.json` 的 `./*` 导出已覆盖新文件，无需改 exports。）

### 2.3 `packages/plainjs/src/BaseParser.ts`（5 处）

| # | 位置 | 改动 |
|---|---|---|
| 1 | `1-8` 行 import 块 | 追加 `date as dateFormatterCtor`（来自 `@json2csv/formatters`） |
| 2 | `35-45` 行 `FormatterTypes` 枚举 | 在 `object` 前后新增 `date = 'date',` |
| 3 | `47-58` 行 `FormattersOptions` | 新增 `[FormatterTypes.date]?: Formatter<Date>;` |
| 4 | `120-133` 行默认槽位表 | 新增 `date` 槽，并把“用户自定义 object 槽”作为兼容回退 |
| 5 | `273-276` 行 `processValue` | `typeof` 分派前先拦截 `instanceof Date` |

第 4 处（兼容关键）：

```ts
const userFormatters = processedOpts.formatters ?? {};
const stringFormatter =
  userFormatters.string || stringFormatterCtor();
const objectFormatter = objectFormatterCtor({ stringFormatter });
const defaultFormatters = {
  // …原有槽位不变…
  // 兼容：用户只自定义了 object 槽、没配 date 槽时，Date 继续走其 object 槽，
  // 保证升级后输出逐字节不变（既有行为优先于“新槽位语义”）。
  date: userFormatters.object ?? dateFormatterCtor({ stringFormatter }),
  object: objectFormatter,
};
```

第 5 处：

```ts
protected processValue<T>(value: T): string {
  // typeof new Date() === 'object'，必须在 typeof 分派之前显式判定。
  if (value instanceof Date) return this.opts.formatters.date(value);
  const formatter = this.opts.formatters[typeof value] as Formatter<T>;
  return formatter(value);
}
```

说明：

- `instanceof Date` 覆盖 Date 及其子类；**跨 realm 的 Date 仍落到 object 槽**——与今天
  完全一致，属于有意的保守选择（跨 realm 需要 `Object.prototype.toString`，可被
  `Symbol.toStringTag` 伪造，且无法保证 `toISOString` 真实存在）。
- `null` 不满足 `instanceof Date`，仍走 object 槽返回 `''`（`object.ts:8` 行为不变）。
- `StreamParser` / `Parser` / `node Transform` / `node AsyncParser` / `whatwg` 全部继承
  这一个 `processValue`（`packages/plainjs/src/StreamParser.ts:177-201`、
  `packages/node/src/Transform.ts:28-38`、`packages/whatwg/src/TransformStream.ts:16-21`），
  因此**一处改动，五种入口行为一致**，无需分别改。

### 2.4 不动的部分（逐条对应硬性约束）

| 文件 | 状态 | 对应约束 |
|---|---|---|
| `packages/formatters/src/string.ts`（1-28 行） | **零改动** | 纯字符串输入逐字不回退 |
| `packages/formatters/src/object.ts`（1-19 行） | **零改动** | 非 Date 对象行为不变；默认 date 槽复用其实现 |
| `packages/transforms/src/flatten.ts:32-39`、`unwind.ts:14-22` | **零改动** | 现状已豁免 `toJSON` 为 Function 的值，Date 原样到达格式化器 |
| `packages/plainjs/src/utils.ts:126-140` | **零改动** | `fastJoin` 只拼串 |
| `packages/plainjs/src/Parser.ts`、`StreamParser.ts` | **零改动** | 都收敛到 `processValue` |

### 2.5 可选：CLI 暴露（`packages/cli/src/json2csv.ts:321-328`）

CLI 目前只组装 `string` 槽；若需 CLI 侧启用，增加
`--date-timezone-offset <minutes>`（默认不传 → 不注册 date 槽，保现状），
在 `formatters` 对象里按需追加 `date: dateFormatter({ timezoneOffsetMinutes, stringFormatter })`。
**默认不开启**，避免 CLI 输出在无感知情况下变化。

---

## 3. 兼容性论证（默认配置逐字节不变）

### 3.1 逻辑论证

- 默认 `dateFormatter()` 在 `timezoneOffsetMinutes === 0 && format === 'iso'` 时
  **直接返回 `objectFormatter({ stringFormatter })` 的同一个函数** →
  与现状执行路径、字符串结果完全一致。
- `processValue` 只把“真正的 Date”导向 date 槽；该槽默认就是旧 object 槽 →
  输出逐字节相同，只是多了一次函数分派。
- 用户自定义 `object` 槽但未配置 date 槽时，date 槽默认指向其自定义 object 槽 →
  升级后输出不变（不把新语义强加给既有配置）。
- 用户显式配置 `formatters.date` → 新能力生效；这是唯一会改变输出的入口，且必须主动开启。

### 3.2 实测（50 万随机瞬时 + 边界，0 差异）

用参考实现与现状 object 槽对拍（随机 `epoch ms ∈ [-8.64e15, 8.64e15]`）：

```
默认配置对拍：{ checked: 500000, mismatch: 0 }
边界/子类/字符串配置: 13 项，差异 0
```

覆盖的边界与特例：

| 用例 | 现状 object 槽 | 默认 date 槽 | 结论 |
|---|---|---|---|
| `new Date(NaN)`（Invalid Date） | `"null"` | `"null"` | 一致 |
| epoch `0` / `-1` | `"1970-01-01T00:00:00.000Z"` / `"1969-12-31T23:59:59.999Z"` | 同 | 一致 |
| `±8.64e15`（可表示极值） | `"+275760-09-13T00:00:00.000Z"` / `"-271821-04-20T00:00:00.000Z"` | 同 | 一致 |
| `class Sub extends Date { toJSON(){…} }` | 自定义 JSON 结果 | 同（回退 legacy） | 一致 |
| `class Sub extends Date { toISOString(){…} }` | 自定义 ISO 结果 | 同（回退 legacy） | 一致 |
| 跨 realm `new Date()` | UTC 串 | 同（`instanceof` 为 false → object 槽） | 一致 |
| 自定义 `string` 槽（`quote:''`、`quote:"'"` 等） | 按该 string 槽 | 同 | 一致 |
| 现有 fixture `date.js` → `date.csv` | `"2017-01-01T00:00:00.000Z"` | 同 | 一致 |

> 实测命令：见 §6「验证记录」第 4 条；对拍脚本与 `repro-date-shift.mjs` 的
> `referenceDateFormatter` 同源。

### 3.3 非默认分支的边界行为

| 场景 | 行为 | 理由 |
|---|---|---|
| `Invalid Date` | 输出 `"null"`（与现状一致） | 保持既有口径；不把坏数据静默变成空串 |
| 子类自定义 `toJSON`/`toISOString` | 回退 legacy（object 槽） | 不篡改用户的自定义序列化语义 |
| 跨 realm Date | 回退 legacy | 无法安全断言其 `toISOString` 真实可用 |
| `time + offset` 溢出可表示范围 | 退回未偏移瞬时 | 不抛 `RangeError`、不丢行 |
| `timezoneOffsetMinutes` 非整数 / 超 ±1440 | 构造期 `RangeError` | 配置错误尽早暴露 |
| 偏移 `±05:30`、`+08:45`、`±14:00` | 正确渲染（分钟级） | 覆盖半/刻钟时区 |

---

## 4. 对存量按天分区下游的影响

### 4.1 明确前提

当前现网数据**不是“写错了”**，而是“按 UTC 渲染错了”：epoch ms 在物化时已固定，
历史分区稳定地整列偏移同一方向（§3 矩阵）。因此修复必须是**渲染口径订正 + 历史重刷**，
不能只改以后。

### 4.2 影响矩阵（以 `DATE '2024-01-15'` 为例）

| 当前会话偏移 S | 现状输出 | 配 `X = S` 后输出 | 分区键变化 | 下游动作 |
|---|---|---|---|---|
| `+08:00`（现网典型） | `2024-01-14T16:00:00.000Z` | `2024-01-15T00:00:00.000+08:00`（或 `format:'date'` → `2024-01-15`） | D-1 → **D（订正）** | 重刷全部受影响日分区；订正跨天 join/去重/累计 |
| `+05:30` / `+14:00` 等正偏移 | D-1 | D | D-1 → D | 同上 |
| `00:00` | D | D | 无变化 | 无需重刷分区；DATETIME 渲染仍会变 |
| `-05:00` / `-12:00` 等负偏移 | D（个别 DATETIME 可能 D+1） | D | 无变化 | 分区无需重刷；核查 DATETIME 列 |

### 4.3 下游影响清单

1. **分区目录/文件名**：`DATE` 列输出从 `…T16:00:00.000Z` 变为业务日历串。若分区路径
   直接取该单元格前 10 位，**目录名会整体前移一天**（订正）。这是有意的破坏性变更，
   必须按“停机窗口 + 原子切换”执行，不能新旧混写同一分区目录。
2. **`DATETIME`/`TIMESTAMP` 列**：从 `…Z` 变为 `…+08:00`（时间部分也随之改变）。
   下游若用 `slice(0,10)` 或字符串比较取日期，**跨 UTC 午夜的行会更换所属日**：
   例：`2024-01-15 23:30-05:00` 现状渲染 `2024-01-16T04:30Z`（落在 D+1），
   配 `X=-300` 后为 `2024-01-15T23:30-05:00`（回 D）。这类行需按同一口径重刷。
3. **`DATE` 与 `DATETIME` 混在同一分区键**：两列口径必须一致（同一 `X`，等于会话偏移），
   否则同一行会跨两天。建议分区键统一用 `format: 'date'`。
4. **历史重刷范围**：自该偏移引入（即管线开始以 Date 物化 DATE 列）起的所有分区；
   建议先用 `--simulate-fix-matrix` 的参考实现对**一天样本**做双跑 diff，确认
   “仅日期部分变化、行数/其余列逐字节不变”，再全量重刷。
5. **回滚**：删除 `formatters.date` 配置即回到现状（默认分支逐字节等价），无需回滚库版本；
   但已重刷的新分区**不会自动回退**，因此切换前必须保留旧分区快照或可重跑源数据。
6. **审计**：把 `timezoneOffsetMinutes` 写进导出任务的配置/发布记录，与分区重刷批次绑定，
   便于后续复盘“哪批数据用了哪个口径”。

### 4.4 存量下游未迁移时的兼容开关

对暂时不能改分区的下游，可先只上库（L1）不改配置：默认 date 槽 = 现状输出，
**零影响**；等下游就绪后再开启 `formatters.date`。这使“库升级”和“口径切换”解耦。

---

## 5. 字符串路径与确定性（硬性约束逐条落实）

| 约束 | 落实方式 | 验证 |
|---|---|---|
| 纯字符串输入既有行为逐字不回退 | `string.ts` 零改动；`processValue` 只拦截 `instanceof Date`；日期值不会被误判为字符串 | 全量 708 用例 + `repro` 的“纯字符串输入（对照）”断言 |
| 三时区同一配置输出逐字节一致 | formatter 只读 epoch ms + 配置常量，不调用任何本地时区 API | `repro-date-shift.mjs --simulate-fix-matrix`：5 时区 sha256 全为 `127be763…` |
| 全量既有测试保持通过 | 默认分支复用旧实现；唯一新增行为需显式配置 | `TZ=UTC / Asia/Shanghai / America/New_York` 三次 `vitest run` 均 708 passed |
| 不得静默改变 Date 输出 | 默认分支字面复用旧实现；用户自定义 object 槽时 date 槽跟随 | §3.2 对拍 0 差异 |

---

## 6. 测试计划（新增用例）

### 6.1 单元测试（`packages/plainjs/test/Date.test.ts`，新增）

1. **默认等价**：`new Parser({fields:['date']}).parse([{date: new Date('2017-01-01T00:00:00.000Z')}])`
   逐字节等于现有 `packages/test-helpers/fixtures/csv/date.csv`
   （顺带把长期未被引用的 fixture 接入测试）。
2. **分派正确**：显式 `formatters.date` 被调用（反向证明缺口已补）；
   `formatters.date` 只接收 Date，字符串/数值不进入。
3. **固定偏移**：`+480` 对 `2024-01-15T00:00:00+08:00` →
   `"2024-01-15T00:00:00.000+08:00"`；`format:'date'` → `"2024-01-15"`。
4. **半/负偏移**：`-300`（`-05:00`）、`+330`（`+05:30`）、`+345`（`+05:45`）、
   `+525`（`+08:45`）、`+765`（`+12:45`）、`+840`（`+14:00`）输出正确后缀与日期。
5. **Invalid Date**：输出 `"null"`（默认与偏移配置均一致）。
6. **子类与跨 realm**：自定义 `toJSON` 子类仍走旧序列化；跨 realm Date 仍走 object 槽。
7. **极值与越界**：`±8.64e15` 默认输出不变；偏移导致越界时退回未偏移值且不抛错。
8. **字符串零回归**：同一行内 Date 列 + 字符串列，字符串列输出与改动前逐字节一致。
9. **用户自定义 object 槽**：只配 `formatters.object` 时 Date 仍走该槽（兼容回退）。

### 6.2 跨时区确定性测试（`packages/plainjs/test/DateDeterminism.test.ts`，新增）

用 `child_process.spawnSync` 分别以 `TZ=UTC`、`TZ=Asia/Shanghai`、`TZ=America/New_York`
拉起一个最小转换子进程（`node --input-type=module -e …`），断言三份 CSV 的 sha256 相同；
子进程内**先打印 `Intl.DateTimeFormat().resolvedOptions().timeZone` 并校验与请求一致**，
否则测试直接失败（防止“TZ 没生效却误判为确定性通过”）。

Windows 注意：Git Bash 会丢弃含 `/` 的 `TZ`（`TZ=Asia/Tokyo` → `undefined`）；
`spawnSync` 显式传 `env` 可正常工作。CI（Linux）上无此问题。

### 6.3 全量回归

```
npm run build
TZ=UTC              npx vitest run   # 期望 10 files / 708+ 用例全过
TZ=Asia/Shanghai    npx vitest run
TZ=America/New_York npx vitest run
node deliverables/repro-date-shift.mjs --simulate-fix-matrix
```

> 构建注意（实测）：在 `packages/<pkg>` 内 import 自身包名会解析到 `packages/<pkg>/dist`
> （包自引用），在其他包/仓库根目录则解析到 `node_modules/@json2csv/<pkg>/dist` 副本；
> `npm run build -w` **只写** `packages/<pkg>/dist`，**不同步** `node_modules` 内副本。
> 因此改完源码后需 `npm install`（workspace 重新落盘）或手工同步两处，否则会测到/跑到旧产物。

### 6.4 性能

`processValue` 每个单元格增加一次 `instanceof Date`。建议在
`packages/test-performance` 跑 `parser.js` 基准，回归阈值设为 ≤3%；
如超阈值，可改为「仅当 `typeof value === 'object'` 时再 `instanceof`」
（`typeof` 已算出，避免对 string/number 做原型链检查）。

---

## 7. 发布与迁移顺序

1. **第 1 步（库）**：发布 L1（新增 `date` 槽 + 默认零变化）。下游不配置 → 输出不变，
   可先行全量升级，风险为零。
2. **第 2 步（管线预演）**：在测试环境配 `formatters.date = dateFormatter({ timezoneOffsetMinutes: <会话偏移>, format: 'date' })`，
   双跑一天，diff 断言“仅日期订正、其余逐字节不变”。
3. **第 3 步（切流 + 重刷）**：停机窗口内切换配置，重刷全部受影响分区；每批记录
   `X` 与批次号；保留旧分区快照以便回滚。
4. **第 4 步（治本）**：对纯 `DATE` 列启用驱动 `dateStrings: true`，该列改走字符串路径；
   确认后可从该列移除 date 槽依赖（`DATETIME`/`TIMESTAMP` 仍可按需使用固定偏移）。
5. **第 5 步（文档）**：更新 `docs/advanced-options/formatters.md:3-17`（类型列表加 `date`）、
   `docs/advanced-options/formatters.md:217`（Date 说明改为“专属槽位 + 固定偏移”）、
   `packages/formatters/README.md:176-177` 与 `docs/others/known-gotchas.md`（新增
   “Date 默认按 UTC 渲染，无时区日历日期请用字符串或显式偏移”）。

---

## 8. 风险登记

| 风险 | 等级 | 缓解 |
|---|---|---|
| 下游按字符串 `Z` 格式硬解析 | 中 | 切流前全量扫描下游解析逻辑；`format:'date'` 或保留 `iso` 但约定带偏移 |
| 历史 DST 会话无法单一偏移校正 | 中 | 走 L3（驱动字符串）或按日期分段重刷 |
| `Date` 子类/跨 realm 行为差异 | 低 | 默认走旧实现；跨 realm 显式回退 object 槽；单测覆盖 |
| 每单元格多一次 `instanceof` 的性能 | 低 | 基准阈值 3%；必要时先判 `typeof === 'object'` |
| 新旧分区混写 | 高 | 切换期冻结写入、原子替换目录、保留快照 |
| 重刷期间下游读到半新半旧 | 高 | 双写/影子分区 + 切换后一次性 rename；批次号写入元数据 |
| 用户自定义 object 槽语义被新槽覆盖 | 低 | 默认 date 槽 = 用户 object 槽（§2.3 第 4 处） |

---

## 9. 验证记录（本次设计期实测）

1. 基线：`npx vitest run` → **10 files / 708 tests passed**（`TZ=UTC`、
   `TZ=Asia/Shanghai`、`America/New_York` 三次均通过，exit 0）。
2. 现状复现：`node deliverables/repro-date-shift.mjs` →
   Date 列 `"2024-01-14T16:00:00.000Z"`（D-1），字符串列 `"2024-01-15"` 逐字未变；
   `formatters.date` 调用次数 0；`Date.prototype.toJSON` 调用 1 次；
   禁用全部本地时区 API 后 CSV 不变。
3. 时区无关：`--matrix` 5 时区 sha256 同一（`c2adbfee20883e1b…`）。
4. 默认兼容对拍：50 万随机瞬时 + 13 类边界/子类/字符串配置，`mismatch: 0`。
5. 修复后效果（参考实现）：`--simulate-fix` 输出
   `"2024-01-15T00:00:00.000+08:00"`；`--simulate-fix-matrix` 5 时区 sha256 同一
   （`127be763c3512f98…`），Date 列稳定 D、字符串列逐字不变。
6. **原型验证（临时改动后已完整回滚）**：按 §2.3 的第 2/3/4/5 处先在
   `BaseParser.ts` 打了 7 行最小补丁（新增 `date = 'date'` 枚举与类型、
   `date: userFormatters.object ?? objectFormatter` 默认槽、`processValue` 里
   `instanceof Date` 拦截），未新增 `date.ts`，验证：
   - `npx vitest run` → **10 files / 708 tests passed**（exit 0）；
   - 默认配置输出与改动前逐字节相同（`"2024-01-14T16:00:00.000Z"`）；
   - 显式 `formatters.date` 被调用（`FROM_DATE_SLOT`），缺口确认可被此改动补上；
   - 仅自定义 `formatters.object` 时，Date 仍走该槽（兼容回退成立）；
   - 字符串列输出 `"2024-01-15"` 逐字不变。
   验证后已从备份恢复 `BaseParser.ts` 原文并重建、同步 `node_modules` 产物，
   当前工作树仅新增 `deliverables/`（源码零改动）。
