/**
 * sampleData.js — 内置「构造样本」数据源（SAMPLE 模式）
 *
 * 目的：在未配置扶摇 API Key 时，让产品主链路可完整跑通、可演示、可测试。
 *
 * 诚实性约束（对应赛题"不得静默生成正常结论"）：
 *  1. 所有响应与扶摇真实接口保持同一信封结构，但顶层携带 sample:true 标记；
 *  2. 个股宇宙使用「样本xxxxxx」合成代码与名称，绝不冒用真实上市公司数值；
 *  3. 数据由固定随机种子生成，可复现；时点为构造时点，非实时；
 *  4. 「重要事件」为构造示例，页面上单独标注为"构造示例·非真实事件"；
 *  5. 各维度证据在构造层面保持内部自洽（指数间相对强弱、宽度、涨跌停家数互相一致），
 *     以免产品演示出一个现实中不可能出现的"拼凑"状态。
 *
 * 该模块输出的 payload 与 FuyaoClient 完全同构，故分析层代码无需区分模式。
 */

const SAMPLE_AS_OF = Date.UTC(2026, 9, 9, 7, 0, 0); // 2026-10-09 15:00 (Asia/Shanghai) 构造时点
const SAMPLE_NOTE = '构造样本数据 · 非实时 · 仅供产品功能演示与测试，不代表任何真实市场数值';

// ---------- 确定性随机（mulberry32）+ 高斯 ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeGauss(rand) {
  let spare = null;
  return function gauss() {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = rand() * 2 - 1;
      v = rand() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * mul;
    return u * mul;
  };
}

const DAY = 86400000;
function round(x, d) {
  if (!Number.isFinite(x)) return null;
  const m = 10 ** d;
  return Math.round(x * m) / m;
}
function isWeekend(ms) {
  const d = new Date(ms).getUTCDay();
  return d === 0 || d === 6;
}
function buildCalendarDays(asOfMs, n) {
  const days = [];
  let cur = asOfMs;
  while (days.length < n) {
    if (!isWeekend(cur)) days.push(cur);
    cur -= DAY;
  }
  return days.reverse();
}
const CALENDAR = buildCalendarDays(SAMPLE_AS_OF, 250);

// ---------- 指数定义（构造锚点：20日收益用于"桥接"以消除随机漂移）----------
const INDEX_DEFS = [
  { thscode: '000001.SH', ticker: '000001', name: '上证综指', close: 3286.45, ret20: 0.032, vol: 0.0082, baseTurnover: 6.0e11 },
  { thscode: '399001.SZ', ticker: '399001', name: '深证成指', close: 10412.3, ret20: 0.015, vol: 0.0106, baseTurnover: 5.1e11 },
  { thscode: '399006.SZ', ticker: '399006', name: '创业板指', close: 2135.8, ret20: -0.014, vol: 0.0158, baseTurnover: 2.3e11 },
  { thscode: '000300.SH', ticker: '000300', name: '沪深300', close: 3892.16, ret20: 0.026, vol: 0.0088, baseTurnover: 3.0e11 },
  { thscode: '000905.SH', ticker: '000905', name: '中证500', close: 5768.42, ret20: -0.006, vol: 0.0128, baseTurnover: 1.6e11 },
  { thscode: '000852.SH', ticker: '000852', name: '中证1000', close: 6210.55, ret20: -0.014, vol: 0.0148, baseTurnover: 1.4e11 },
  { thscode: '000016.SH', ticker: '000016', name: '上证50', close: 2668.9, ret20: 0.021, vol: 0.0078, baseTurnover: 1.1e11 },
  { thscode: '000688.SH', ticker: '000688', name: '科创50', close: 1042.33, ret20: -0.02, vol: 0.0168, baseTurnover: 4.4e10 },
];

function buildIndexHistory(def, seed) {
  const rand = mulberry32(seed);
  const gauss = makeGauss(rand);
  const n = CALENDAR.length;
  const r = new Array(n);
  const dailyRet20 = Math.log(1 + def.ret20) / 20;
  for (let i = 0; i < n; i++) {
    const recent = i >= n - 20;
    const mean = recent ? dailyRet20 : 0.0002 - 0.00012 * Math.sin(i / 23);
    r[i] = mean + def.vol * gauss();
  }
  // 桥接：把近 20 日累计对数收益精确对齐到 ret20，避免随机漂移破坏场景设定
  const target = Math.log(1 + def.ret20);
  let s = 0;
  for (let i = n - 20; i < n; i++) s += r[i];
  const adj = (target - s) / 20;
  for (let i = n - 20; i < n; i++) r[i] += adj;

  const p = new Array(n);
  p[0] = 100;
  for (let i = 1; i < n; i++) p[i] = p[i - 1] * Math.exp(r[i]);
  const factor = def.close / p[n - 1];
  const bars = [];
  for (let i = 0; i < n; i++) {
    const c = p[i] * factor;
    const prev = i === 0 ? c / Math.exp(r[i]) : bars[i - 1].close_price;
    const o = prev * (1 + 0.0016 * gauss());
    const hi = Math.max(o, c) * (1 + Math.abs(0.0022 * gauss()));
    const lo = Math.min(o, c) * (1 - Math.abs(0.0022 * gauss()));
    // 量能：近 30 日逐日收缩，制造"缩量"结构（斜率经标定使当日/20日均值 ≈ 0.80）
    const shrink = i >= n - 30 ? 1 - 0.0155 * (i - (n - 30)) : 1;
    const turnover = def.baseTurnover * shrink * (0.9 + 0.2 * rand()) * (1 + 2.0 * Math.abs(r[i]));
    bars.push({
      date_ms: CALENDAR[i],
      open_price: round(o, 2),
      high_price: round(hi, 2),
      low_price: round(lo, 2),
      close_price: round(c, 2),
      volume: Math.round(turnover / (c * 100)) * 100,
      turnover: Math.round(turnover),
    });
  }
  return bars;
}

const INDEX_HISTORY = {};
INDEX_DEFS.forEach((def, idx) => {
  INDEX_HISTORY[def.thscode] = buildIndexHistory(def, 90001 + idx * 137);
});

// ---------- 构造全市场个股宇宙（5400 只，近似 A 股全市场）----------
const SECTORS = ['金融', '制造', '医药', '科技', '消费', '能源', '材料', '地产', '公用', '交运'];
const UNIVERSE_SIZE = 5400;
const LIMIT_UP_TARGET = 70; // 涨停家数（构造目标）
const LIMIT_DOWN_TARGET = 9; // 跌停家数
const LIMIT_BREAK_TARGET = 22; // 炸板家数

function buildUniverse() {
  const rand = mulberry32(20261009);
  const gauss = makeGauss(rand);
  const mkt = INDEX_HISTORY['000001.SH'];
  const mktRetToday = mkt[mkt.length - 1].close_price / mkt[mkt.length - 2].close_price - 1; // 约 +0.2%
  const stocks = [];
  for (let j = 0; j < UNIVERSE_SIZE; j++) {
    const sector = SECTORS[Math.floor(rand() * SECTORS.length)];
    const size = rand(); // 0 小盘 → 1 大盘
    const beta = 0.6 + size * 0.9 + 0.25 * gauss();
    // 横截面 alpha 均值偏负，令上涨家数占比落在"分化"区间（约 40%）
    const alpha = -0.0165 + size * 0.0050 + 0.0022 * gauss();
    const eps = 0.0175 * gauss();
    const chg = alpha + beta * mktRetToday + eps;
    const lastClose = round(3 + rand() * 60 + size * 90, 2);
    const prevClose = round(lastClose / (1 + chg), 2);
    stocks.push({
      thscode: `S${String(100000 + j).slice(1)}.${j % 3 === 0 ? 'SH' : 'SZ'}`,
      ticker: String(100000 + j).slice(1),
      name: `样本${sector}${String(j + 1).padStart(4, '0')}`,
      last_price: lastClose,
      prev_price: prevClose,
      price_change_ratio_pct: round(chg * 100, 2),
      size,
      sector,
    });
  }

  // 按当日涨跌幅排序，取最极端的两端构造涨/跌停（与现实一致：涨跌停即分布尾部）
  const order = stocks.map((s, i) => i).sort((a, b) => stocks[b].price_change_ratio_pct - stocks[a].price_change_ratio_pct);
  const upSet = order.slice(0, LIMIT_UP_TARGET);
  const downSet = order.slice(-LIMIT_DOWN_TARGET);
  const breakSet = order.slice(LIMIT_UP_TARGET, LIMIT_UP_TARGET + LIMIT_BREAK_TARGET); // 冲高未封板

  const continuePlan = (i) => (i < 2 ? 6 : i < 6 ? 5 : i < 12 ? 4 : i < 24 ? 3 : i < 44 ? 2 : 1);
  const limitUp = upSet.map((idx, i) => {
    const s = stocks[idx];
    s.isLimitUp = true;
    s.price_change_ratio_pct = round(9.9 + (i % 4) * 0.02, 2);
    return {
      thscode: s.thscode,
      ticker: s.ticker,
      name: s.name,
      price_change_ratio_pct: s.price_change_ratio_pct,
      continue_day_cnt: continuePlan(i),
      seal_money: Math.round(4e7 + (9e7 * ((i * 37) % 100)) / 100),
      limit_up_reason: ['样本板块A', '样本板块B', '样本板块C', '样本板块D'][i % 4] + '（构造示例）',
      first_limit_up_time: `09:${String(30 + (i % 28)).padStart(2, '0')}`,
    };
  });
  const limitDown = downSet.map((idx) => {
    const s = stocks[idx];
    s.price_change_ratio_pct = -9.98;
    return { thscode: s.thscode, ticker: s.ticker, name: s.name, price_change_ratio_pct: -9.98 };
  });
  const limitBreak = breakSet.map((idx) => {
    const s = stocks[idx];
    return { thscode: s.thscode, ticker: s.ticker, name: s.name, price_change_ratio_pct: round(2.5 + ((idx * 7) % 60) / 10, 2) };
  });

  // 站上 MA20 的近似标记（与涨跌幅、市值相关）
  for (const s of stocks) {
    s.above_ma20 = rand() < 0.46 + s.price_change_ratio_pct / 100 * 3 + (s.size - 0.5) * 0.12;
  }

  return { stocks, limitUp, limitDown, limitBreak };
}

const BUILT = buildUniverse();
const UNIVERSE = BUILT.stocks;
const LIMIT_UP = BUILT.limitUp;
const LIMIT_DOWN = BUILT.limitDown;
const LIMIT_BREAK = BUILT.limitBreak;

// ---------- 连板天梯（近 6 日矩阵，构造）----------
function buildLadder() {
  const days = CALENDAR.slice(-6);
  const rows = [];
  const levels = [6, 5, 4, 3, 2, 1];
  const counts = {
    6: [0, 0, 0, 0, 1, 2],
    5: [0, 1, 1, 2, 3, 4],
    4: [1, 1, 3, 4, 6, 8],
    3: [2, 4, 6, 8, 10, 12],
    2: [8, 11, 14, 17, 20, 22],
    1: [46, 50, 55, 58, 62, 24],
  };
  for (const lv of levels) {
    rows.push({ continue_day_cnt: lv, series: days.map((d, i) => ({ date_ms: d, count: counts[lv][i] })) });
  }
  return rows;
}
const LADDER = buildLadder();

// ---------- 热榜（独立构造热度，避免与涨停同质）----------
function buildHotList() {
  const rand = mulberry32(55501);
  const picked = [];
  const used = new Set();
  while (picked.length < 100) {
    const idx = Math.floor(rand() * UNIVERSE.length);
    if (used.has(idx)) continue;
    used.add(idx);
    picked.push(UNIVERSE[idx]);
  }
  return picked.map((s, i) => ({
    rank: i + 1,
    thscode: s.thscode,
    ticker: s.ticker,
    name: s.name,
    heat: Math.round(1_000_000 * Math.exp(-i / 24)),
    price_change_ratio_pct: s.price_change_ratio_pct,
  }));
}
const HOT_LIST = buildHotList();

// ---------- 龙虎榜 ----------
function buildDragonTiger() {
  const rand = mulberry32(55523);
  const rows = [];
  for (let i = 0; i < 40; i++) {
    const s = UNIVERSE[Math.floor(rand() * UNIVERSE.length)];
    const org = i % 2 === 0;
    rows.push({
      thscode: s.thscode,
      ticker: s.ticker,
      name: s.name,
      board_type: org ? '机构' : '游资',
      net_buy_amount: Math.round((org ? 1 : -1) * (2e7 + (5e7 * ((i * 13) % 100)) / 100)),
      reason: i % 3 === 0 ? '日涨幅偏离值达 7%' : '连续三个交易日涨幅偏离值累计达 20%',
    });
  }
  return rows;
}
const DRAGON_TIGER = buildDragonTiger();

// ---------- 指数估值 ----------
const VALUATIONS = {
  '000001.SH': { pe_ttm: 14.86, pb_mrq: 1.42, ps_ttm: 1.31, pcf_ttm: 11.2, name: '上证综指' },
  '000300.SH': { pe_ttm: 13.52, pb_mrq: 1.38, ps_ttm: 1.44, pcf_ttm: 10.1, name: '沪深300' },
  '000905.SH': { pe_ttm: 27.94, pb_mrq: 2.08, ps_ttm: 1.62, pcf_ttm: 18.6, name: '中证500' },
  '000852.SH': { pe_ttm: 42.83, pb_mrq: 2.61, ps_ttm: 2.12, pcf_ttm: 29.4, name: '中证1000' },
  '000016.SH': { pe_ttm: 11.24, pb_mrq: 1.19, ps_ttm: 1.28, pcf_ttm: 8.9, name: '上证50' },
  '399006.SZ': { pe_ttm: 38.62, pb_mrq: 4.12, ps_ttm: 3.05, pcf_ttm: 33.1, name: '创业板指' },
  '000688.SH': { pe_ttm: 58.14, pb_mrq: 4.86, ps_ttm: 4.22, pcf_ttm: 41.7, name: '科创50' },
  '399001.SZ': { pe_ttm: 24.37, pb_mrq: 2.14, ps_ttm: 1.71, pcf_ttm: 16.8, name: '深证成指' },
};

// ---------- 行业轮动（构造样本，供"继续研究：行业"下钻）----------
const INDUSTRY_SAMPLE = [
  { thscode: '881101.TI', name: '样本-半导体', r5: 0.028, r20: 0.0712, r60: 0.1325 },
  { thscode: '881102.TI', name: '样本-人工智能', r5: 0.019, r20: 0.0583, r60: 0.1611 },
  { thscode: '881103.TI', name: '样本-创新药', r5: 0.012, r20: 0.0341, r60: 0.0208 },
  { thscode: '881104.TI', name: '样本-军工', r5: 0.006, r20: 0.0187, r60: 0.0426 },
  { thscode: '881105.TI', name: '样本-银行', r5: 0.004, r20: 0.0122, r60: 0.0304 },
  { thscode: '881106.TI', name: '样本-白酒', r5: -0.003, r20: -0.0088, r60: 0.0117 },
  { thscode: '881107.TI', name: '样本-新能源车', r5: -0.011, r20: -0.0264, r60: -0.0412 },
  { thscode: '881108.TI', name: '样本-光伏', r5: -0.016, r20: -0.0347, r60: -0.0755 },
  { thscode: '881109.TI', name: '样本-房地产', r5: -0.021, r20: -0.0413, r60: -0.0628 },
  { thscode: '881110.TI', name: '样本-消费电子', r5: -0.008, r20: -0.0152, r60: 0.0063 },
  { thscode: '881111.TI', name: '样本-煤炭', r5: 0.009, r20: 0.0231, r60: -0.0042 },
  { thscode: '881112.TI', name: '样本-券商', r5: 0.014, r20: 0.0405, r60: 0.0588 },
];

// ---------- 构造示例事件（明确标注非真实）----------
const SAMPLE_EVENTS = [
  { id: 'EVT-S01', date_ms: CALENDAR[CALENDAR.length - 1], category: '宏观', title: '【构造示例】样本月度经济数据发布窗口临近', source: '构造示例（非真实事件，仅演示事件维度结构）', impact_scope: '全市场', direction_hint: '不确定（示例不作方向判断）' },
  { id: 'EVT-S02', date_ms: CALENDAR[CALENDAR.length - 3], category: '政策', title: '【构造示例】样本产业政策征求意见稿发布', source: '构造示例（非真实事件，仅演示事件维度结构）', impact_scope: '样本板块A / 样本板块B', direction_hint: '不确定（示例不作方向判断）' },
  { id: 'EVT-S03', date_ms: CALENDAR[CALENDAR.length - 5], category: '海外', title: '【构造示例】海外主要央行议息窗口', source: '构造示例（非真实事件，仅演示事件维度结构）', impact_scope: '跨市场 / 汇率敏感板块', direction_hint: '不确定（示例不作方向判断）' },
];

// ---------- 组装：与 FuyaoClient 同构的接口 ----------
function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return h;
}
function envelope(item, timestamp = SAMPLE_AS_OF) {
  return {
    code: 0,
    message: 'success',
    request_id: `sample-${Math.abs(hash(JSON.stringify(item).slice(0, 512))) % 1000000}`,
    data: { timestamp, item },
    sample: true,
    sample_note: SAMPLE_NOTE,
  };
}
function snapshotFromBars(bars) {
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  return {
    open_price: last.open_price,
    high_price: last.high_price,
    low_price: last.low_price,
    last_price: last.close_price,
    prev_price: prev.close_price,
    price_change: round(last.close_price - prev.close_price, 2),
    price_change_ratio_pct: round((last.close_price / prev.close_price - 1) * 100, 4),
    volume: last.volume,
    turnover: last.turnover,
  };
}

export const sampleSource = {
  isSample: true,
  asOf: SAMPLE_AS_OF,
  note: SAMPLE_NOTE,

  async indexSnapshot(thscodes) {
    const list = String(thscodes).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    const item = list.filter((c) => INDEX_HISTORY[c]).map((c) => ({ thscode: c, ticker: c.split('.')[0], ...snapshotFromBars(INDEX_HISTORY[c]) }));
    return envelope(item);
  },
  async indexHistorical(thscode) {
    const code = String(thscode).trim().toUpperCase();
    const bars = INDEX_HISTORY[code];
    if (!bars) throw Object.assign(new Error(`样本模式无该指数：${code}`), { kind: 'notfound', code: 3001 });
    return { code: 0, message: 'success', request_id: 'sample', data: { timestamp: bars[bars.length - 1].date_ms, adjust: null, item: bars }, sample: true, sample_note: SAMPLE_NOTE };
  },
  async indexCatalog() {
    return envelope(INDEX_DEFS.map((d) => ({ thscode: d.thscode, name: d.name })));
  },
  async indexConstituents() {
    return envelope(UNIVERSE.slice(0, 300).map((s) => ({ thscode: s.thscode, ticker: s.ticker, name: s.name })));
  },
  async stockSnapshot(thscodes) {
    const list = String(thscodes).split(',').map((s) => s.trim().toUpperCase());
    const item = UNIVERSE.filter((s) => list.includes(s.thscode)).map((s) => ({
      thscode: s.thscode, ticker: s.ticker, name: s.name,
      last_price: s.last_price, price_change: s.price_change, price_change_ratio_pct: s.price_change_ratio_pct, prev_price: s.prev_price,
    }));
    return envelope(item);
  },
  async valuationSnapshot(thscodes) {
    const list = String(thscodes).split(',').map((s) => s.trim().toUpperCase());
    const item = list.filter((c) => VALUATIONS[c]).map((c) => ({ thscode: c, ...VALUATIONS[c] }));
    return envelope(item);
  },
  async tradingDays() {
    const item = CALENDAR.map((ms) => {
      const d = new Date(ms);
      return { date_ms: ms, date: `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}` };
    });
    return envelope(item);
  },
  async limitUpPool() { return envelope(LIMIT_UP); },
  async limitDownPool() { return envelope(LIMIT_DOWN); },
  async limitBreakPool() { return envelope(LIMIT_BREAK); },
  async limitUpLadder() { return envelope(LADDER); },
  async hotStockList() { return envelope(HOT_LIST); },
  async dragonTigerList() { return envelope(DRAGON_TIGER); },
  async industryRotation() { return envelope(INDUSTRY_SAMPLE); },
};

/** SAMPLE 模式行业轮动原始表（供引擎直接消费）。 */
export const SAMPLE_INDUSTRY_ROTATION = INDUSTRY_SAMPLE;

export const sampleInternals = {
  INDEX_DEFS, INDEX_HISTORY, UNIVERSE, LIMIT_UP, LIMIT_DOWN, LIMIT_BREAK, LADDER, SAMPLE_EVENTS, SAMPLE_AS_OF, SAMPLE_NOTE, CALENDAR,
};

/** 供"市场宽度"维度使用的全样本宇宙快照。 */
export function sampleUniverseSnapshot() {
  return UNIVERSE.map((s) => ({
    thscode: s.thscode, ticker: s.ticker, name: s.name,
    last_price: s.last_price, prev_price: s.prev_price,
    price_change_ratio_pct: s.price_change_ratio_pct,
    above_ma20: s.above_ma20, sector: s.sector, size: s.size,
  }));
}

export default sampleSource;
