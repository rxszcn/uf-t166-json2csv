// biome-ignore-all lint/suspicious/noConsole: 复现脚本的输出就是它的交付物，全部走 stdout/stderr
// 复现脚本：数仓 DATE 列被驱动物化成 JS Date 后，经 json2csv 序列化整体回退一天；
//          该偏移在任意时区环境的机器上逐字节复现；同一行的字符串时间戳逐字不偏移。
//
// 前置：仓库根目录已执行 `npm run build`（包入口指向 dist）。
// 用法：
//   node deliverables/repro-date-shift.mjs              # 当前时区，打印完整诊断链
//   node deliverables/repro-date-shift.mjs --matrix     # 子进程强制 5 种时区，逐字节比对
//   node deliverables/repro-date-shift.mjs --sessions   # 不同数据库会话时区下的偏移方向
//   node deliverables/repro-date-shift.mjs --simulate-fix          # 用参考实现演示修复后输出
//   node deliverables/repro-date-shift.mjs --simulate-fix-matrix   # 修复后在 5 种时区下逐字节比对
//   node deliverables/repro-date-shift.mjs --fuzz                  # 默认配置与现状 object 槽对拍
//
// 环境说明（Windows/Git Bash）：Git Bash 会丢弃含 "/" 的 TZ 值（例如
// `TZ=Asia/Tokyo node ...` 会静默回退到系统时区）。因此多时区模式用
// child_process.spawnSync 显式向子进程传 env，并在子进程内打印真实生效的时区后
// 再断言，避免把“TZ 没生效”误判成“输出与时区无关”。

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  object as objectFormatter,
  string as stringFormatter,
} from '@json2csv/formatters';
import { Parser } from '@json2csv/plainjs';
import { flatten, unwind } from '@json2csv/transforms';

// ── 1. 模拟数仓驱动的物化结果 ────────────────────────────────────────────────
// DATE '2024-01-15' 是无时区的日历日期。驱动按管线配置的会话/驱动时区（本例
// +08:00）把它锚定成“本地午夜”这一瞬时（instant）。JS Date 内部只保存 epoch ms：
//   2024-01-15T00:00:00+08:00 === 2024-01-14T16:00:00.000Z === 1705248000000
// 物化完成的那一刻，instant 就固定了。之后导出机是什么时区，既不改变 epoch ms，
// 也不改变 JSON.stringify 按 UTC 渲染的规则。
const SESSION_OFFSET_MINUTES = 480; // 管线配置的会话/驱动时区 +08:00
const CALENDAR_DATE = '2024-01-15';
const DATE_OBJECT = new Date(
  `${CALENDAR_DATE}T00:00:00${offsetLabel(SESSION_OFFSET_MINUTES)}`,
);
const DATE_STRING = CALENDAR_DATE; // 同一管线的另一类列：字符串，从未被 instant 化
const STRING_WITH_TIME = '2024-01-15 00:00:00';
const EXPECTED_STRING_ONLY_CSV = `"ts"\n"${STRING_WITH_TIME}"`;

const FIELDS = ['id', 'report_date_obj', 'report_date_str'];
const ROW = {
  id: 1,
  report_date_obj: DATE_OBJECT,
  report_date_str: DATE_STRING,
};

// ── 2. 修复设计参考实现（仅本脚本内使用；库内落地见 fix-design.md） ────────
// 固定时区口径：只读取 epoch ms + 显式配置的偏移，全程不碰机器时区。
function referenceDateFormatter({
  timezoneOffsetMinutes,
  format = 'iso',
  stringFormatter: sf = stringFormatter(),
}) {
  if (
    !Number.isInteger(timezoneOffsetMinutes) ||
    Math.abs(timezoneOffsetMinutes) > 1440
  ) {
    throw new RangeError(
      'timezoneOffsetMinutes must be an integer within [-1440, 1440]',
    );
  }
  // 默认口径 = 现状 object 槽（字面上复用旧实现）。
  const legacy = objectFormatter({ stringFormatter: sf });
  if (timezoneOffsetMinutes === 0 && format === 'iso') return legacy;
  const suffix = offsetLabel(timezoneOffsetMinutes);
  return (value) => {
    // 子类/自定义序列化一律回退既有 object 槽语义。
    if (
      value.toJSON !== Date.prototype.toJSON ||
      value.toISOString !== Date.prototype.toISOString
    ) {
      return legacy(value);
    }
    const time = Date.prototype.getTime.call(value);
    if (!Number.isFinite(time)) return legacy(value); // Invalid Date => "null"
    const shifted = time + timezoneOffsetMinutes * 60000;
    // 偏移把瞬时推出可表示范围时，退回未偏移值，保证不抛错、不丢行。
    const safeTime = Math.abs(shifted) <= 8.64e15 ? shifted : time;
    const iso = new Date(safeTime).toISOString();
    if (format === 'date') return sf(iso.split('T')[0]);
    return sf(`${iso.slice(0, -1)}${suffix}`);
  };
}

// 在不动库源码的前提下模拟“processValue 增加 Date 专属槽位”后的行为。
class SimulatedDateSlotParser extends Parser {
  constructor(opts = {}) {
    super(opts);
    this.dateFormatter = opts.formatters?.date;
  }

  processValue(value) {
    // 与 fix-design.md §2.3 第 5 处一致：typeof 分派前先用 instanceof 拦截 Date。
    if (this.dateFormatter && value instanceof Date) {
      return this.dateFormatter(value);
    }
    return super.processValue(value);
  }
}

function offsetLabel(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

// 终端里中文占两列，用显示宽度对齐诊断输出（纯 ASCII 按 1 计）。
function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    width +=
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
        ? 2
        : 1;
  }
  return width;
}

function label(text, width = 34) {
  return `${text}${' '.repeat(Math.max(1, width - displayWidth(text)))}`;
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function renderPipelineCsv() {
  return new Parser({ fields: FIELDS }).parse([ROW]);
}

function renderFixedCsv() {
  return new SimulatedDateSlotParser({
    fields: FIELDS,
    formatters: {
      date: referenceDateFormatter({
        timezoneOffsetMinutes: SESSION_OFFSET_MINUTES,
        format: 'iso',
      }),
    },
  }).parse([ROW]);
}

function splitPipelineCsv(csv) {
  const [, dataLine] = csv.split('\n');
  const [, dateObjCell, dateStrCell] = dataLine.split(',');
  return { dateObjCell, dateStrCell };
}

function environmentLines() {
  return [
    ['TZ 环境变量', process.env.TZ ?? '(未设置，用系统时区)'],
    ['实际生效时区', Intl.DateTimeFormat().resolvedOptions().timeZone],
    ['机器本地偏移(分钟)', new Date().getTimezoneOffset()],
    [
      '管线会话时区',
      `${offsetLabel(SESSION_OFFSET_MINUTES)} (${SESSION_OFFSET_MINUTES} 分钟)`,
    ],
  ];
}

// ── 3. 当前时区下的完整诊断 ──────────────────────────────────────────────────
function diagnose() {
  const csv = renderPipelineCsv();
  const { dateObjCell, dateStrCell } = splitPipelineCsv(csv);
  const localCalendar = [
    DATE_OBJECT.getFullYear(),
    DATE_OBJECT.getMonth() + 1,
    DATE_OBJECT.getDate(),
  ].join('-');

  console.log('── 环境 ───────────────────────────────────────────────');
  for (const [name, value] of environmentLines()) {
    console.log(label(name), '=', value);
  }

  console.log('\n── 被导出的值 ─────────────────────────────────────────');
  console.log(label('DATE 日历日期'), '=', CALENDAR_DATE);
  console.log(
    label('Date.epoch ms'),
    '=',
    DATE_OBJECT.getTime(),
    '(物化后固定不变)',
  );
  console.log(label('Date.toISOString()'), '=', DATE_OBJECT.toISOString());
  console.log(
    label('Date 本地日历字段'),
    '=',
    localCalendar,
    '（只有本地时区 API 才随机器变化）',
  );
  console.log(
    label('typeof Date'),
    '=',
    typeof DATE_OBJECT,
    "→ 命中 formatters['object'] 槽",
  );
  console.log(
    label('直接调用 object 格式化器'),
    '=',
    objectFormatter({ stringFormatter: stringFormatter() })(DATE_OBJECT),
  );

  console.log('\n── 分派链探针 ─────────────────────────────────────────');
  // 探针 1：显式传入 formatters.date 也不会被调用（typeof 永远产生不了 'date'）。
  const dateSlotCalls = [];
  const csvWithDateSlot = new Parser({
    fields: FIELDS,
    formatters: {
      date: (value) => {
        dateSlotCalls.push(value);
        return 'FROM_DATE_SLOT';
      },
    },
  }).parse([ROW]);
  console.log(
    label('显式 formatters.date 调用次数'),
    '=',
    dateSlotCalls.length,
  );
  console.log(label('传入 date 槽后 CSV 不变'), '=', csvWithDateSlot === csv);

  // 探针 2：确认 Date 值确实经过 JSON.stringify → Date.prototype.toJSON。
  const originalToJSON = Date.prototype.toJSON;
  let toJSONCalls = 0;
  try {
    Date.prototype.toJSON = function patched(...args) {
      toJSONCalls += 1;
      return originalToJSON.apply(this, args);
    };
    new Parser({ fields: FIELDS }).parse([ROW]);
  } finally {
    Date.prototype.toJSON = originalToJSON;
  }
  console.log(label('Date.prototype.toJSON 调用次数'), '=', toJSONCalls);

  // 探针 3：禁用全部本地时区 API 后仍能正常导出（证明链上不读机器时区）。
  const localTimezoneApis = [
    'getFullYear',
    'getMonth',
    'getDate',
    'getDay',
    'getHours',
    'getMinutes',
    'getSeconds',
    'getMilliseconds',
    'getTimezoneOffset',
    'toLocaleString',
    'toLocaleDateString',
    'toLocaleTimeString',
    'toDateString',
    'toTimeString',
    'toString',
  ];
  const originals = new Map();
  let csvWithoutLocalApis;
  try {
    for (const name of localTimezoneApis) {
      originals.set(name, Date.prototype[name]);
      Date.prototype[name] = function forbidden() {
        throw new Error(`本地时区 API 被调用: ${name}`);
      };
    }
    csvWithoutLocalApis = new Parser({ fields: FIELDS }).parse([ROW]);
  } catch (error) {
    csvWithoutLocalApis = `THROW: ${error.message}`;
  } finally {
    for (const [name, fn] of originals) Date.prototype[name] = fn;
  }
  console.log(
    label('禁用本地时区 API 后 CSV 不变'),
    '=',
    csvWithoutLocalApis === csv,
  );

  console.log('\n── CSV 输出 ───────────────────────────────────────────');
  console.log(csv);

  console.log('\n── 判定 ───────────────────────────────────────────────');
  console.log(
    label('Date 列'),
    '=',
    dateObjCell,
    dateObjCell.includes('2024-01-14') ? '← 回退一天（BUG）' : '',
  );
  console.log(
    label('字符串列'),
    '=',
    dateStrCell,
    dateStrCell === `"${CALENDAR_DATE}"` ? '← 逐字未变' : '',
  );
  console.log(label('CSV sha256'), '=', sha256(csv));

  console.log('\n── transforms 不拦截 Date ─────────────────────────────');
  const nested = {
    id: 2,
    meta: { report_date: DATE_OBJECT },
    items: [{ report_date: DATE_OBJECT }],
  };
  const flattened = flatten()(nested);
  const unwound = unwind({ paths: ['items'] })(nested);
  console.log(
    'flatten 后仍是原 Date 对象 =',
    flattened['meta.report_date'] === DATE_OBJECT,
    '| API 输出 =',
    new Parser({ fields: ['meta.report_date'] })
      .parse([flattened])
      .split('\n')[1],
  );
  console.log(
    'unwind 后仍是原 Date 对象  =',
    unwound[0].items.report_date === DATE_OBJECT,
    '| API 输出 =',
    new Parser({ fields: ['items.report_date'] }).parse(unwound).split('\n')[1],
  );

  console.log('\n── 纯字符串输入（对照） ───────────────────────────────');
  const stringOnlyCsv = new Parser({ fields: ['ts'] }).parse([
    { ts: STRING_WITH_TIME },
  ]);
  console.log(label('纯字符串 CSV'), '=', JSON.stringify(stringOnlyCsv));
  console.log(
    label('与期望逐字一致'),
    '=',
    stringOnlyCsv === EXPECTED_STRING_ONLY_CSV,
  );

  const failures = [];
  if (dateObjCell !== '"2024-01-14T16:00:00.000Z"') {
    failures.push('Date 列未回退一天');
  }
  if (dateStrCell !== `"${CALENDAR_DATE}"`) failures.push('字符串列被改动');
  if (dateSlotCalls.length !== 0) failures.push('formatters.date 竟被调用');
  if (toJSONCalls === 0) failures.push('未经过 Date.prototype.toJSON');
  if (csvWithoutLocalApis !== csv) failures.push('链上读取了本地时区 API');
  if (stringOnlyCsv !== EXPECTED_STRING_ONLY_CSV) {
    failures.push('纯字符串输出回退');
  }
  if (failures.length) {
    console.error('\nFAIL:', failures.join('；'));
    process.exit(1);
  }
  console.log(
    '\nOK: 复现成功 —— Date 列回退一天，字符串列逐字不变，formatters.date 被静默忽略。',
  );
}

// ── 4. 演示修复后的输出（参考实现 + 模拟分派） ──────────────────────────────
function simulateFix() {
  const brokenCsv = renderPipelineCsv();
  const fixedCsv = renderFixedCsv();
  const broken = splitPipelineCsv(brokenCsv);
  const fixed = splitPipelineCsv(fixedCsv);

  console.log('── 环境 ───────────────────────────────────────────────');
  for (const [name, value] of environmentLines()) {
    console.log(label(name), '=', value);
  }
  console.log('\n── 现状（object 槽，UTC 渲染） ────────────────────────');
  console.log(brokenCsv);
  console.log('\n── 修复后（date 槽，固定 +08:00 口径） ────────────────');
  console.log(fixedCsv);
  console.log('\n── 对比 ───────────────────────────────────────────────');
  console.log(
    label('Date 列'),
    '=',
    broken.dateObjCell,
    '→',
    fixed.dateObjCell,
  );
  console.log(
    label('字符串列'),
    '=',
    broken.dateStrCell,
    '→',
    fixed.dateStrCell,
    broken.dateStrCell === fixed.dateStrCell
      ? '（逐字未变）'
      : '（被改动，失败）',
  );
  console.log(label('修复后 CSV sha256'), '=', sha256(fixedCsv));

  const failures = [];
  if (!fixed.dateObjCell.includes(CALENDAR_DATE)) {
    failures.push('修复后 Date 列未回到业务日历日');
  }
  if (fixed.dateStrCell !== broken.dateStrCell) {
    failures.push('修复改动了字符串列');
  }
  if (failures.length) {
    console.error('\nFAIL:', failures.join('；'));
    process.exit(1);
  }
  console.log(
    '\nOK: 固定时区 date 槽把 DATE 列恢复到 2024-01-15，字符串列逐字未变。',
  );
}

// ── 5. 多时区矩阵：同一配置，逐字节比对 ─────────────────────────────────────
function emitMatrix() {
  const brokenCsv = renderPipelineCsv();
  const fixedCsv = renderFixedCsv();
  const broken = splitPipelineCsv(brokenCsv);
  const fixed = splitPipelineCsv(fixedCsv);
  const stringOnlyCsv = new Parser({ fields: ['ts'] }).parse([
    { ts: STRING_WITH_TIME },
  ]);
  process.stdout.write(
    `${JSON.stringify({
      requestedTz: process.env.TZ ?? '(unset)',
      effectiveTz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      localOffsetMinutes: new Date().getTimezoneOffset(),
      epochMs: DATE_OBJECT.getTime(),
      brokenSha256: sha256(brokenCsv),
      fixedSha256: sha256(fixedCsv),
      stringOnlySha256: sha256(stringOnlyCsv),
      brokenDateCell: broken.dateObjCell,
      fixedDateCell: fixed.dateObjCell,
      stringCell: fixed.dateStrCell,
    })}\n`,
  );
}

function runMatrix({ fixed }) {
  const zones = [
    'UTC',
    'Asia/Shanghai',
    'America/New_York',
    'Asia/Tokyo',
    'Europe/Berlin',
  ];
  const results = zones.map((tz) => {
    const child = spawnSync(process.execPath, [process.argv[1], '--emit'], {
      env: { ...process.env, TZ: tz },
      encoding: 'utf8',
    });
    if (child.status !== 0) {
      console.error(`子进程失败 TZ=${tz}\n${child.stderr}`);
      process.exit(1);
    }
    const line = child.stdout.split('\n').find((item) => item.startsWith('{'));
    if (!line) {
      console.error(`子进程无输出 TZ=${tz}\n${child.stdout}\n${child.stderr}`);
      process.exit(1);
    }
    return JSON.parse(line);
  });

  const shas = results.map((result) =>
    fixed ? result.fixedSha256 : result.brokenSha256,
  );
  console.log(
    '请求时区'.padEnd(20),
    '生效时区'.padEnd(22),
    '本地偏移'.padEnd(10),
    'CSV sha256(前16)'.padEnd(20),
    'Date 列'.padEnd(32),
    '字符串列',
  );
  for (const [index, result] of results.entries()) {
    console.log(
      result.requestedTz.padEnd(20),
      result.effectiveTz.padEnd(22),
      String(result.localOffsetMinutes).padEnd(10),
      shas[index].slice(0, 16).padEnd(20),
      (fixed ? result.fixedDateCell : result.brokenDateCell).padEnd(32),
      result.stringCell,
    );
  }

  const failures = [];
  for (const result of results) {
    // Asia/Shanghai 与本机系统时区相同，无法区分“请求生效”与“静默回退”；
    // 其余请求值必须与生效时区一致，否则矩阵结论无效。
    if (
      result.requestedTz !== 'Asia/Shanghai' &&
      result.requestedTz !== result.effectiveTz
    ) {
      failures.push(
        `${result.requestedTz} 未生效（实际 ${result.effectiveTz}）`,
      );
    }
  }
  if (new Set(shas).size !== 1) {
    failures.push(`CSV 未逐字节一致: ${[...new Set(shas)].join(', ')}`);
  }
  if (new Set(results.map((result) => result.stringOnlySha256)).size !== 1) {
    failures.push('纯字符串 CSV 未逐字节一致');
  }
  if (new Set(results.map((result) => result.epochMs)).size !== 1) {
    failures.push('Date 的 epoch ms 随机器时区变化（说明驱动侧未固定时区）');
  }
  if (fixed) {
    if (
      results.some((result) => !result.fixedDateCell.includes(CALENDAR_DATE))
    ) {
      failures.push('修复后 Date 列在某个时区未回到业务日历日');
    }
    if (
      results.some(
        (result) =>
          result.fixedDateCell !== `"${CALENDAR_DATE}T00:00:00.000+08:00"`,
      )
    ) {
      failures.push('修复后 Date 列未按 +08:00 口径渲染');
    }
  } else if (
    results.some((result) => !result.brokenDateCell.includes('2024-01-14'))
  ) {
    failures.push('Date 列未在全部时区回退一天');
  }
  if (results.some((result) => result.stringCell !== `"${CALENDAR_DATE}"`)) {
    failures.push('字符串列在某个时区被改动');
  }

  if (failures.length) {
    console.error('\nFAIL:', failures.join('；'));
    process.exit(1);
  }
  console.log(
    fixed
      ? '\nOK: 修复后在 5 种时区下输出逐字节一致，Date 列稳定为 2024-01-15，字符串列逐字不变。'
      : '\nOK: 5 种时区下同一配置的输出逐字节一致；Date 列稳定回退一天；字符串列逐字不变。',
  );
  if (!fixed) {
    console.log(
      '    （逐字节一致恰恰证明偏移与时区无关：把导出机搬到 UTC 治不好这个 bug。）',
    );
  }
}

// ── 6. 会话时区方向矩阵：什么情况下才回退一天 ───────────────────────────────
function runSessions() {
  const sessions = [-720, -300, 0, 330, 480, 840];
  console.log(
    '会话时区   DATE 2024-01-15 的物化 instant          现状渲染日期  是否回退',
  );
  const failures = [];
  for (const session of sessions) {
    const instant = new Date(
      `${CALENDAR_DATE}T00:00:00${offsetLabel(session)}`,
    );
    const rendered = instant.toISOString().split('T')[0];
    const shifted = rendered === '2024-01-14';
    if (session > 0 && !shifted) {
      failures.push(`正偏移 ${offsetLabel(session)} 未回退`);
    }
    if (session <= 0 && shifted) {
      failures.push(`非正偏移 ${offsetLabel(session)} 却回退了`);
    }
    console.log(
      offsetLabel(session).padEnd(10),
      instant.toISOString().padEnd(36),
      rendered.padEnd(14),
      shifted ? '是（D-1）' : '否（D）',
    );
  }
  if (failures.length) {
    console.error('\nFAIL:', failures.join('；'));
    process.exit(1);
  }
  console.log(
    '\n结论：数据库会话时区为东经正偏移时，DATE 被驱动锚定成前一日 UTC，',
  );
  console.log(
    '      序列化按 UTC 渲染后日期整体变为 D-1；西经负偏移则停留 D 或跨到 D+1。',
  );
  console.log(
    '      要恢复业务日历日，date 槽的固定偏移必须等于物化时使用的会话偏移。',
  );
}

// ── 7. 默认配置兼容性对拍：修复默认值 vs 现状 object 槽 ─────────────────────
function runFuzz() {
  const sf = stringFormatter();
  const legacy = objectFormatter({ stringFormatter: sf });
  const proposedDefault = referenceDateFormatter({
    timezoneOffsetMinutes: 0,
    format: 'iso',
    stringFormatter: sf,
  });

  const samples = 500000;
  const mismatches = [];
  for (let index = 0; index < samples; index += 1) {
    const time = Math.floor((Math.random() * 2 - 1) * 8.64e15);
    const value = new Date(time);
    const before = legacy(value);
    const after = proposedDefault(value);
    if (before !== after) mismatches.push({ time, before, after });
  }

  const edgeCases = [
    ['Invalid Date', new Date(Number.NaN)],
    ['epoch 0', new Date(0)],
    ['epoch -1', new Date(-1)],
    ['max instant', new Date(8.64e15)],
    ['min instant', new Date(-8.64e15)],
    ['4-digit year 0099', new Date('0099-12-31T23:59:59.999Z')],
    ['5-digit year 10000', new Date('+010000-01-01T00:00:00.000Z')],
  ];
  for (const [label, value] of edgeCases) {
    const before = legacy(value);
    const after = proposedDefault(value);
    if (before !== after) mismatches.push({ label, before, after });
  }

  class CustomToJSON extends Date {
    toJSON() {
      return 'custom-json';
    }
  }
  class CustomToISO extends Date {
    toISOString() {
      return 'custom-iso';
    }
  }
  const specialCases = [
    ['Date 子类自定义 toJSON', new CustomToJSON('2024-01-15T00:00:00+08:00')],
    [
      'Date 子类自定义 toISOString',
      new CustomToISO('2024-01-15T00:00:00+08:00'),
    ],
    ['普通 Date', new Date('2024-01-15T00:00:00+08:00')],
  ];
  for (const [label, value] of specialCases) {
    const before = legacy(value);
    const after = proposedDefault(value);
    if (before !== after) mismatches.push({ label, before, after });
  }

  // 不同 string formatter 配置下也必须等价。
  for (const sfOptions of [{}, { quote: '' }, { quote: "'" }]) {
    const variant = stringFormatter(sfOptions);
    const variantLegacy = objectFormatter({ stringFormatter: variant });
    const variantProposed = referenceDateFormatter({
      timezoneOffsetMinutes: 0,
      stringFormatter: variant,
    });
    const value = new Date('2024-01-15T00:00:00+08:00');
    if (variantLegacy(value) !== variantProposed(value)) {
      mismatches.push({
        label: `string formatter ${JSON.stringify(sfOptions)}`,
        before: variantLegacy(value),
        after: variantProposed(value),
      });
    }
  }

  console.log(label('随机样本数'), '=', samples);
  console.log(label('边界/子类/字符串配置'), '=', 13);
  console.log(label('差异数'), '=', mismatches.length);
  if (mismatches.length) {
    console.error('FAIL: 默认配置与现状不一致');
    for (const mismatch of mismatches.slice(0, 5)) console.error(mismatch);
    process.exit(1);
  }
  console.log(
    'OK: 默认 dateFormatter 与现状 object 槽逐字节一致（含 Invalid Date、极值、子类、跨配置）。',
  );
}

const argv = process.argv.slice(2);
if (argv.includes('--matrix')) runMatrix({ fixed: false });
else if (argv.includes('--simulate-fix-matrix')) runMatrix({ fixed: true });
else if (argv.includes('--emit')) emitMatrix();
else if (argv.includes('--sessions')) runSessions();
else if (argv.includes('--simulate-fix')) simulateFix();
else if (argv.includes('--fuzz')) runFuzz();
else diagnose();
