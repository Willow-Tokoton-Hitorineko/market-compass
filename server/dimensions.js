/**
 * dimensions.js — 七维市场状态研判
 *
 * 七个维度：行情结构 / 市场宽度 / 风格轮动 / 估值 / 流动性 / 情绪 / 重要事件
 *
 * 每个维度统一输出：
 *   facts[]            事实：带单位、口径、来源接口、时点
 *   state              归纳：基于规则得到的状态标签 + 依据（明确标注为"归纳"）
 *   uncertainty[]      不确定：当前证据无法支撑的判断
 *   switchConditions[] 状态切换条件：可观测阈值 + 当前值 + 是否触发
 *
 * 设计红线：本模块只描述状态、不给方向预测、不给操作建议。
 */
import { round, mean, median, sma, smaSeries, slope, pctChange, percentileRank, safeDiv } from './analytics.js';

const WINDOW_DAYS = 420; // 取历史窗口（自然日），覆盖约 250 交易日
const DAY = 86400000;

/** 用于散文（带 % 号）。 */
function fmtPct(x, d = 2) {
  return Number.isFinite(x) ? `${round(x * 100, d)}%` : null;
}
/** 用于"事实"字段的 value：只给数值，单位由 unit 字段承担，避免单位重复。 */
function pctNum(x, d = 2) {
  return Number.isFinite(x) ? String(round(x * 100, d)) : null;
}

/** 构造一条证据（事实）。 */
function fact(label, value, { unit = '', caliber = '', computed = false, src = null, extra = {} } = {}) {
  return { label, value, unit, caliber, computed, source: src, ...extra };
}

/** 从历史 bars 中取收盘价序列。 */
function closes(bars) {
  return (bars || []).map((b) => b.close_price).filter(Number.isFinite);
}

/** 构造一个"接近触发"的切换条件。 */
function condNum(x) {
  if (x == null || !Number.isFinite(x)) return x;
  return Math.abs(x) < 1 ? round(x, 4) : round(x, 2);
}
function cond(id, condition, threshold, current, satisfied, note, direction) {
  const distPct =
    Number.isFinite(threshold) && Number.isFinite(current) && threshold !== 0 ? round((current / threshold - 1) * 100, 2) : null;
  return { id, condition, threshold: condNum(threshold), current: condNum(current), satisfied, note, direction, distancePct: distPct };
}

// ============================================================
// 1. 行情结构
// ============================================================
export async function priceStructure(ctx) {
  const { dl, hist, snap, histTrace } = ctx;
  const traces = [snap?.trace, histTrace].filter(Boolean);
  const names = { '000001.SH': '上证综指', '000300.SH': '沪深300', '000852.SH': '中证1000' };
  const facts = [];
  const focus = ['000001.SH', '000300.SH', '000852.SH'];
  const rows = [];

  for (const code of focus) {
    const bars = hist[code];
    if (!bars || bars.length < 60) {
      facts.push(fact(`${names[code]} 价格结构`, '数据不足', { unit: '', caliber: '历史 K 线不足 60 根，无法计算结构指标', src: { endpoint: '/api/a-share-index/prices/historical', sample: ctx.sample } }));
      continue;
    }
    const c = closes(bars);
    const last = c[c.length - 1];
    const ma20 = sma(c, 20);
    const ma60 = sma(c, 60);
    const ma250 = sma(c, 250);
    const r20 = pctChange(c, 20);
    const r60 = pctChange(c, 60);
    const pos250 = percentileRank(c.slice(-250), last);
    const ma20Slope = slope(smaSeries(c, 20).slice(-10));
    rows.push({ code, name: names[code], last, ma20, ma60, ma250, r20, r60, pos250, ma20Slope });

    const srcSnap = snap.trace;
    facts.push(
      fact(`${names[code]} 收盘`, round(last, 2), { unit: '点', caliber: '指数点位', src: { endpoint: '/api/a-share-index/prices/historical', mcpTool: 'get_a_share_index_prices_historical', sample: ctx.sample } }),
      fact(`${names[code]} 近20日涨跌幅`, pctNum(r20), { unit: '%', caliber: '计算值 = 最新收盘 / 20 交易日前收盘 − 1', computed: true }),
      fact(`${names[code]} MA20 / MA60 / MA250`, `${round(ma20, 2)} / ${round(ma60, 2)} / ${round(ma250 ?? NaN, 2)}`, { unit: '点', caliber: '计算值 = 对应周期收盘均价', computed: true }),
      fact(`${names[code]} 近250日分位`, pctNum(pos250), { unit: '%', caliber: '计算值 = 收盘价在近 250 日收盘序列中的分位', computed: true }),
    );
  }

  // 归纳（以上证综指 + 沪深300 为锚）
  const anchor = rows.find((r) => r.code === '000001.SH') || rows[0];
  let stateLabel = '数据不足';
  const basis = [];
  if (anchor) {
    const { last, ma20, ma60, ma250, ma20Slope, pos250 } = anchor;
    const above20 = last > ma20;
    const above60 = last > ma60;
    const above250 = Number.isFinite(ma250) ? last > ma250 : null;
    const rising = Number.isFinite(ma20Slope) && ma20Slope > 0;
    if (above20 && above60 && rising) stateLabel = '上行趋势';
    else if (!above20 && !above60 && !rising) stateLabel = '下行趋势';
    else if (above60 && !above20) stateLabel = '上行中的回撤';
    else if (!above60 && above20) stateLabel = '下行中的反弹';
    else stateLabel = '区间震荡';
    basis.push(`上证综指收盘 ${round(last, 2)} ${above20 ? '高于' : '低于'} MA20(${round(ma20, 2)})、${above60 ? '高于' : '低于'} MA60(${round(ma60, 2)})`);
    if (above250 !== null) basis.push(`${above250 ? '位于' : '低于'}年线 MA250(${round(ma250, 2)})`);
    basis.push(`MA20 近 10 日斜率${rising ? '为正' : '为负'}，近 250 日分位 ${fmtPct(pos250)}`);
    basis.push('说明：以上标签为规则化「归纳」，描述当前结构，不代表未来方向。');
  }

  const uncertainty = [];
  if (anchor && anchor.pos250 != null) {
    if (anchor.pos250 > 0.8) uncertainty.push('指数处于近一年高分位区，向上方缺乏可参照的近端阻力位，突破的有效性需后续量价配合确认。');
    if (anchor.pos250 < 0.2) uncertainty.push('指数处于近一年低分位区，下方缺乏可参照的近端支撑位，破位有效性需后续量价配合确认。');
  }
  uncertainty.push('结构标签基于日线收盘与均线，未包含盘中跳空与整数关口的市场心理因素。');

  const switchConditions = [];
  if (anchor) {
    switchConditions.push(
      cond('S1-1', '上证综指收盘跌破 MA60', round(anchor.ma60, 2), round(anchor.last, 2), anchor.last < anchor.ma60, '若成立，结构由"上行/震荡"转弱为"下行"一侧', '向下'),
      cond('S1-2', '上证综指收盘站上 MA20', round(anchor.ma20, 2), round(anchor.last, 2), anchor.last > anchor.ma20, '若成立，短期结构转为多头排列一侧', '向上'),
    );
    const hi = Math.max(...(hist['000001.SH'] || []).slice(-250).map((b) => b.high_price));
    const lo = Math.min(...(hist['000001.SH'] || []).slice(-250).map((b) => b.low_price));
    if (Number.isFinite(hi)) switchConditions.push(cond('S1-3', '上证综指突破近 250 日高点', round(hi, 2), round(anchor.last, 2), anchor.last >= hi, '若成立，结构进入区间上沿突破状态', '向上'));
    if (Number.isFinite(lo)) switchConditions.push(cond('S1-4', '上证综指跌破近 250 日低点', round(lo, 2), round(anchor.last, 2), anchor.last <= lo, '若成立，结构进入区间下沿破位状态', '向下'));
  }

  return {
    key: 'priceStructure',
    name: '行情结构',
    available: rows.length > 0,
    degraded: rows.length < focus.length,
    degradedReason: rows.length < focus.length ? `部分指数历史数据不足（成功 ${rows.length}/${focus.length}）` : null,
    facts,
    state: { label: stateLabel, basis },
    uncertainty,
    switchConditions,
    traces,
  };
}

// ============================================================
// 2. 市场宽度
// ============================================================
export async function breadth(ctx) {
  const { dl, universe, limitUp, limitDown } = ctx;
  const facts = [];
  if (!universe || !universe.universe || !universe.universe.length) {
    return {
      key: 'breadth',
      name: '市场宽度',
      available: false,
      degraded: true,
      degradedReason: '未能获取个股快照集合，宽度无法计算。',
      facts: [],
      state: { label: '不可用', basis: ['个股快照取数失败或为空，未生成宽度结论。'] },
      uncertainty: ['宽度数据缺失，本维度结论不可用（未静默判定为"正常"）。'],
      switchConditions: [],
      traces: [universe?.trace].filter(Boolean),
    };
  }
  const list = universe.universe;
  let up = 0;
  let down = 0;
  let flat = 0;
  let aboveMa20 = 0;
  let ma20Denom = 0;
  const chgs = [];
  for (const s of list) {
    const c = s.price_change_ratio_pct;
    if (!Number.isFinite(c)) continue;
    chgs.push(c);
    if (c > 0.0001) up++;
    else if (c < -0.0001) down++;
    else flat++;
    if (s.above_ma20 === true || s.above_ma20 === false) {
      ma20Denom++;
      if (s.above_ma20) aboveMa20++;
    }
  }
  const total = up + down + flat;
  const upRatio = safeDiv(up, total);
  const med = median(chgs);
  const upCount = limitUp?.ok ? (limitUp.res.data?.item || []).length : null;
  const downCount = limitDown?.ok ? (limitDown.res.data?.item || []).length : null;

  const srcSnap = universe.trace;
  facts.push(
    fact('样本集合内 上涨/下跌/平盘 家数', `${up} / ${down} / ${flat}`, {
      unit: '家',
      caliber: `统计口径：${universe.coverageLabel}，以最新价相对前收涨跌幅正负判定`,
      src: srcSnap,
    }),
    fact('上涨家数占比', pctNum(upRatio), { unit: '%', caliber: '计算值 = 上涨家数 / 有效家数', computed: true }),
    fact('个股涨跌幅中位数', Number.isFinite(med) ? String(round(med, 2)) : null, { unit: '%', caliber: '计算值 = 集合内涨跌幅中位数（代表"中位个股"表现）', computed: true }),
  );
  if (upCount != null) facts.push(fact('涨停家数', upCount, { unit: '家', caliber: '涨停股票池（接口原始值）', src: limitUp.trace }));
  if (downCount != null) facts.push(fact('跌停家数', downCount, { unit: '家', caliber: '跌停股票池（接口原始值）', src: limitDown.trace }));
  if (ma20Denom > 0) {
    facts.push(fact('站上 MA20 个股占比', pctNum(safeDiv(aboveMa20, ma20Denom)), { unit: '%', caliber: `计算值 = 站上 20 日均线个股 / 有效家数（口径：${universe.coverageLabel}）`, computed: true }));
  } else {
    facts.push(fact('站上 MA20 个股占比', '未返回', { unit: '%', caliber: 'LIVE 模式为控制取数成本未逐股计算均线，该字段不可得', computed: false }));
  }

  let label = '数据不足';
  const basis = [];
  if (Number.isFinite(upRatio)) {
    if (upRatio >= 0.6) label = '普涨';
    else if (upRatio >= 0.45) label = '偏多';
    else if (upRatio >= 0.35) label = '分化';
    else label = '普跌';
    basis.push(`上涨家数占比 ${fmtPct(upRatio)}（阈值：≥60% 普涨 / 45–60% 偏多 / 35–45% 分化 / <35% 普跌）`);
    basis.push(`个股涨跌幅中位数 ${Number.isFinite(med) ? round(med, 2) + '%' : '—'}，反映"中位个股"而非指数权重的表现`);
    basis.push('说明：占比阈值为产品设定的经验分档，属「归纳」，非预测。');
  }

  const uncertainty = [];
  if (universe.aboveMa20Available === false) uncertainty.push('LIVE 模式未逐股计算 MA20，"站上 MA20 占比"不可得，宽度结论主要由涨跌家数与中位数支撑。');
  uncertainty.push('LIVE 模式宽度以三大宽基成分股并集近似全市场，与"全部 A 股"口径存在覆盖差异。');

  const switchConditions = [];
  if (Number.isFinite(upRatio)) {
    switchConditions.push(
      cond('S2-1', '上涨家数占比回升至 50% 以上', 0.5, upRatio, upRatio >= 0.5, '若成立，宽度由"分化/普跌"转为"偏多"一侧', '向上'),
      cond('S2-2', '上涨家数占比跌破 30%', 0.3, upRatio, upRatio < 0.3, '若成立，宽度进入"普跌"一侧，个股赚钱效应显著收缩', '向下'),
      cond('S2-3', '涨停家数重上 80 家', 80, upCount ?? NaN, Number.isFinite(upCount) && upCount >= 80, '涨停家数回升通常伴随个股活跃度修复', '向上'),
    );
  }

  return {
    key: 'breadth',
    name: '市场宽度',
    available: true,
    degraded: universe.aboveMa20Available === false,
    degradedReason: universe.aboveMa20Available === false ? '站上 MA20 占比不可得（LIVE 未逐股计算）' : null,
    facts,
    state: { label, basis },
    uncertainty,
    switchConditions,
    traces: [universe.trace].filter(Boolean),
  };
}

// ============================================================
// 3. 风格轮动
// ============================================================
export async function styleRotation(ctx) {
  const { hist, snap, histTrace } = ctx;
  const traces = [histTrace].filter(Boolean);
  const facts = [];
  const specs = [
    { code: '000016.SH', name: '上证50', pole: '大盘价值' },
    { code: '000852.SH', name: '中证1000', pole: '小盘' },
    { code: '399006.SZ', name: '创业板指', pole: '成长' },
  ];
  const got = {};
  for (const s of specs) {
    const bars = hist[s.code];
    if (!bars || bars.length < 61) continue;
    const c = closes(bars);
    got[s.code] = { r20: pctChange(c, 20), r60: pctChange(c, 60) };
  }
  if (!got['000016.SH'] || !got['000852.SH']) {
    return {
      key: 'styleRotation',
      name: '风格轮动',
      available: false,
      degraded: true,
      degradedReason: '大小盘代表指数历史数据不足，无法计算相对强弱。',
      facts: [],
      state: { label: '不可用', basis: ['缺少风格代表指数历史数据，未生成风格结论。'] },
      uncertainty: ['风格数据缺失，本维度结论不可用。'],
      switchConditions: [],
      traces: [],
    };
  }

  const big = got['000016.SH'];
  const small = got['000852.SH'];
  const growth = got['399006.SZ'];
  const spread20 = big.r20 - small.r20;
  const spread60 = big.r60 - small.r60;
  const gv20 = growth ? growth.r20 - big.r20 : null;

  facts.push(
    fact('上证50（大盘价值）近20/60日', `${pctNum(big.r20)} / ${pctNum(big.r60)}`, { unit: '%', caliber: '计算值 = 指数收盘 20/60 交易日涨跌幅', computed: true, src: { endpoint: '/api/a-share-index/prices/historical', sample: ctx.sample } }),
    fact('中证1000（小盘）近20/60日', `${pctNum(small.r20)} / ${pctNum(small.r60)}`, { unit: '%', caliber: '计算值 = 指数收盘 20/60 交易日涨跌幅', computed: true }),
    fact('大小盘相对强弱(20日差)', pctNum(spread20), { unit: '%', caliber: '计算值 = 上证50 20日涨跌幅 − 中证1000 20日涨跌幅，>0 表示大盘相对占优', computed: true }),
    fact('大小盘相对强弱(60日差)', pctNum(spread60), { unit: '%', caliber: '计算值 = 上证50 60日涨跌幅 − 中证1000 60日涨跌幅', computed: true }),
  );
  if (growth) facts.push(fact('成长-价值相对(20日差)', pctNum(gv20), { unit: '%', caliber: '计算值 = 创业板指 20日涨跌幅 − 上证50 20日涨跌幅', computed: true }));

  let label = '均衡';
  const basis = [];
  const TH = 0.01;
  if (spread20 > TH && spread60 > 0) label = '大盘占优';
  else if (spread20 < -TH && spread60 < 0) label = '小盘占优';
  else if (Math.abs(spread20) <= TH) label = '大小盘均衡';
  else label = '风格分歧（20日与60日不一致）';
  basis.push(`20 日大小盘差 ${fmtPct(spread20)}、60 日差 ${fmtPct(spread60)}（阈值 ±1%）`);
  if (Number.isFinite(gv20)) basis.push(`成长相对价值 20 日差 ${fmtPct(gv20)}`);
  basis.push('说明：风格标签为区间相对强弱的「归纳」，风格可能在数周内切换。');

  const uncertainty = [
    '风格判定基于指数相对收益，未纳入成分股调整、行业权重漂移等结构性因素。',
    '20 日与 60 日窗口若方向不一致，说明风格正处于切换带，结论置信度应下调。',
  ];

  const switchConditions = [
    cond('S3-1', '大小盘 20 日差由正转负（大盘优势收敛）', 0, spread20, spread20 < 0, '若成立，风格天平向小盘倾斜', '向下'),
    cond('S3-2', '大小盘 20 日差超过 +2%', 0.02, spread20, spread20 >= 0.02, '若成立，大盘风格进一步强化', '向上'),
    cond('S3-3', '大小盘 20 日差低于 −2%', -0.02, spread20, spread20 <= -0.02, '若成立，小盘风格进一步强化', '向下'),
  ];

  return {
    key: 'styleRotation',
    name: '风格轮动',
    available: true,
    degraded: !growth,
    degradedReason: !growth ? '创业板指历史数据不足，成长-价值维度不可得' : null,
    facts,
    state: { label, basis },
    uncertainty,
    switchConditions,
    traces,
  };
}

// ============================================================
// 4. 估值
// ============================================================
export async function valuation(ctx) {
  const { valuations, snap } = ctx;
  const facts = [];
  if (!valuations || !valuations.ok) {
    return {
      key: 'valuation',
      name: '估值',
      available: false,
      degraded: true,
      degradedReason: valuations?.error?.userMessage || '估值接口未返回可用数据。',
      facts: [],
      state: { label: '不可用', basis: ['估值接口取数失败，未生成估值结论。'] },
      uncertainty: ['估值数据缺失，本维度结论不可用（未静默判定为"正常"）。'],
      switchConditions: [],
      traces: [valuations?.trace].filter(Boolean),
    };
  }
  const items = valuations.res.data?.item || [];
  if (!items.length) {
    return {
      key: 'valuation',
      name: '估值',
      available: false,
      degraded: true,
      degradedReason: '估值接口返回 0 条记录（该指数估值可能未披露）。',
      facts: [],
      state: { label: '不可用', basis: ['估值接口返回空集合，未生成估值结论。'] },
      uncertainty: ['估值数据为空，本维度结论不可用。'],
      switchConditions: [],
      traces: [valuations.trace].filter(Boolean),
    };
  }
  const byCode = Object.fromEntries(items.map((i) => [String(i.thscode).toUpperCase(), i]));
  for (const it of items) {
    facts.push(fact(`${it.name || it.thscode} 估值`, `PE(TTM) ${it.pe_ttm ?? '—'} / PB ${it.pb_mrq ?? '—'}`, {
      unit: '倍',
      caliber: '接口原始值（PE-TTM 为滚动市盈率，PB 为最新市净率）',
      src: valuations.trace,
    }));
  }
  const big = byCode['000300.SH'];
  const small = byCode['000852.SH'];
  let spread = null;
  if (big?.pe_ttm && small?.pe_ttm) {
    spread = safeDiv(small.pe_ttm, big.pe_ttm);
    facts.push(fact('小盘/大盘 估值倍数', spread ? `${round(spread, 2)}x` : null, {
      unit: '倍',
      caliber: '计算值 = 中证1000 PE(TTM) / 沪深300 PE(TTM)，衡量大小盘估值相对高低',
      computed: true,
    }));
  }

  const basis = [];
  let label = '结构性分化';
  if (spread != null) {
    if (spread >= 3) label = '小盘估值显著高于大盘';
    else if (spread >= 2) label = '小盘估值高于大盘';
    else label = '大小盘估值差距较小';
    basis.push(`中证1000 PE(TTM) ${small?.pe_ttm} 对沪深300 PE(TTM) ${big?.pe_ttm}，倍数 ${round(spread, 2)}x`);
  }
  basis.push('估值"绝对高低"需要历史分位参照，而当前数据源未提供估值历史序列，故本维度只做「横向结构」归纳，不做「历史高低」判断。');

  const uncertainty = [
    '缺少估值历史分位序列（数据源未返回），无法判断当前估值处于历史什么水平，绝对高低结论不成立。',
    '指数 PE 为成分股加权口径，受成分调整与亏损股处理方式影响，跨指数直接比较需谨慎。',
  ];

  const switchConditions = [];
  if (small?.pe_ttm != null) switchConditions.push(cond('S4-1', '中证1000 PE(TTM) 突破 50 倍（参考观察阈值）', 50, small.pe_ttm, small.pe_ttm >= 50, '该阈值为产品设定的观察线，非"高估"判断；触发后应结合盈利增速与历史分位复核', '向上'));
  if (big?.pe_ttm != null) switchConditions.push(cond('S4-2', '沪深300 PE(TTM) 跌破 11 倍（参考观察阈值）', 11, big.pe_ttm, big.pe_ttm <= 11, '该阈值为产品设定的观察线，触发表明低估值一侧进一步下移', '向下'));

  return {
    key: 'valuation',
    name: '估值',
    available: true,
    degraded: false,
    degradedReason: null,
    facts,
    state: { label, basis },
    uncertainty,
    switchConditions,
    traces: [valuations.trace].filter(Boolean),
  };
}

// ============================================================
// 5. 流动性
// ============================================================
export async function liquidity(ctx) {
  const { hist, histTrace } = ctx;
  const bars = hist['000001.SH'];
  if (!bars || bars.length < 25) {
    return {
      key: 'liquidity',
      name: '流动性',
      available: false,
      degraded: true,
      degradedReason: '缺少上证综指历史成交额，无法计算量能水平。',
      facts: [],
      state: { label: '不可用', basis: ['成交额历史数据不足，未生成流动性结论。'] },
      uncertainty: ['流动性数据缺失，本维度结论不可用。'],
      switchConditions: [],
      traces: [],
    };
  }
  const turns = bars.map((b) => b.turnover).filter(Number.isFinite);
  const last = turns[turns.length - 1];
  const ma20 = mean(turns.slice(-20));
  const ma60 = mean(turns.slice(-60));
  const ratio20 = safeDiv(last, ma20);
  const ratio60 = safeDiv(last, ma60);

  const facts = [
    fact('上证综指当日成交额', `${round(last / 1e8, 1)} 亿元`, { unit: '亿元', caliber: '接口原始值（沪市全口径代理，单位由元换算为亿元）', src: { endpoint: '/api/a-share-index/prices/historical', sample: ctx.sample } }),
    fact('近20日均成交额', `${round(ma20 / 1e8, 1)} 亿元`, { unit: '亿元', caliber: '计算值 = 近 20 个交易日成交额均值', computed: true }),
    fact('当日/20日均量 倍数', ratio20 ? `${round(ratio20, 2)}x` : null, { unit: '倍', caliber: '计算值 = 当日成交额 / 近20日均成交额', computed: true }),
    fact('当日/60日均量 倍数', ratio60 ? `${round(ratio60, 2)}x` : null, { unit: '倍', caliber: '计算值 = 当日成交额 / 近60日均成交额', computed: true }),
  ];

  let label = '平量';
  if (ratio20 >= 1.2) label = '放量';
  else if (ratio20 < 0.85) label = '缩量';
  const basis = [`当日成交额为 20 日均值的 ${round(ratio20, 2)}x（分档：≥1.2 放量 / 0.85–1.2 平量 / <0.85 缩量）`];

  const uncertainty = [
    '资金净流入/流出（北向、主力资金）接口未对外开放，本维度仅以成交额作为活跃度代理，不等于资金净流向。',
    '成交额受新股上市、指数成分调整与节假日效应影响，单日值需结合多日趋势观察。',
  ];

  const switchConditions = [
    cond('S5-1', '成交额回升至 20 日均值以上', 1.0, ratio20, ratio20 >= 1.0, '若成立，量能由"缩量"向"平量/放量"修复', '向上'),
    cond('S5-2', '成交额低于 20 日均值 80%', 0.8, ratio20, ratio20 < 0.8, '若成立，量能进入显著收缩区', '向下'),
  ];

  return {
    key: 'liquidity',
    name: '流动性',
    available: true,
    degraded: true,
    degradedReason: '资金流向接口未对外开放，仅以成交额代理（口径已在证据中标注）',
    facts,
    state: { label, basis },
    uncertainty,
    switchConditions,
    traces: [histTrace].filter(Boolean),
  };
}

// ============================================================
// 6. 情绪
// ============================================================
export async function sentiment(ctx) {
  const { limitUp, limitDown, limitBreak, ladder, hotList, dragonTiger } = ctx;
  const facts = [];
  const okUp = limitUp?.ok;
  const upItems = okUp ? limitUp.res.data?.item || [] : [];
  const downItems = limitDown?.ok ? limitDown.res.data?.item || [] : [];
  const breakItems = limitBreak?.ok ? limitBreak.res.data?.item || [] : [];
  if (!okUp && !downItems.length && !breakItems.length) {
    return {
      key: 'sentiment',
      name: '情绪',
      available: false,
      degraded: true,
      degradedReason: '涨跌停/炸板等特色数据接口均未返回，情绪维度不可用。',
      facts: [],
      state: { label: '不可用', basis: ['情绪类特色数据取数失败，未生成情绪结论。'] },
      uncertainty: ['情绪数据缺失，本维度结论不可用。'],
      switchConditions: [],
      traces: [],
    };
  }
  const upN = upItems.length;
  const downN = downItems.length;
  const breakN = breakItems.length;
  const breakRate = safeDiv(breakN, upN + breakN); // 炸板率 = 炸板 / (涨停 + 炸板)
  const heights = upItems.map((i) => i.continue_day_cnt).filter(Number.isFinite);
  const maxHeight = heights.length ? Math.max(...heights) : null;
  const multiBoard = heights.filter((h) => h >= 2).length;

  if (okUp) facts.push(fact('涨停家数', upN, { unit: '家', caliber: '涨停股票池（接口原始值，含首板与连板）', src: limitUp.trace }));
  if (limitDown?.ok) facts.push(fact('跌停家数', downN, { unit: '家', caliber: '跌停股票池（接口原始值）', src: limitDown.trace }));
  if (limitBreak?.ok) facts.push(fact('炸板家数', breakN, { unit: '家', caliber: '炸板股票池（接口原始值）', src: limitBreak.trace }));
  if (breakRate != null) facts.push(fact('炸板率', pctNum(breakRate), { unit: '%', caliber: '计算值 = 炸板家数 / (涨停家数 + 炸板家数)，衡量封板成功率', computed: true }));
  if (maxHeight != null) facts.push(fact('最高连板高度', `${maxHeight} 连板`, { unit: '板', caliber: '涨停池内 continue_day_cnt 最大值', src: limitUp.trace }));
  if (heights.length) facts.push(fact('连板（≥2板）家数', multiBoard, { unit: '家', caliber: '计算值 = 涨停池中 continue_day_cnt ≥ 2 的家数', computed: true }));

  if (dragonTiger?.ok) {
    const items = dragonTiger.res.data?.item || [];
    const orgNet = items.filter((i) => /机构/.test(i.board_type || '')).reduce((s, i) => s + (i.net_buy_amount || 0), 0);
    facts.push(fact('龙虎榜机构合计净买卖', `${round(orgNet / 1e8, 2)} 亿元`, { unit: '亿元', caliber: '计算值 = 龙虎榜（机构榜）net_buy_amount 求和，单位换算为亿元', computed: true, src: dragonTiger.trace }));
  }
  if (hotList?.ok) {
    const items = hotList.res.data?.item || [];
    const top = items.slice(0, 3).map((i) => i.name).join('、');
    facts.push(fact('热度榜前三位', top || '未返回', { unit: '', caliber: '同花顺热榜按热度排序前 3（接口原始值）', src: hotList.trace }));
  }

  // 归纳
  let label = '中性';
  const basis = [];
  const hot = upN >= 70 || (breakRate != null && breakRate < 0.2 && upN >= 50);
  const cold = upN < 25 || (breakRate != null && breakRate > 0.45);
  if (upN >= 90 && (maxHeight ?? 0) >= 5) label = '亢奋';
  else if (hot) label = '偏热';
  else if (cold) label = '偏冷';
  else label = '中性';
  basis.push(`涨停 ${upN} 家 / 跌停 ${downN} 家，炸板率 ${breakRate != null ? fmtPct(breakRate) : '—'}，最高高度 ${maxHeight ?? '—'} 板`);
  basis.push('说明：情绪标签基于涨停家数、炸板率与连板高度的规则分档，属「归纳」，反映活跃度而非方向。');

  const uncertainty = [
    '情绪指标波动大、日内切换快，收盘口径的涨停/炸板数据不能刻画盘中情绪反复。',
    '涨停口径包含 ST 与新股，可能放大或扰动家数，需结合封板资金与原因列复核。',
  ];

  const switchConditions = [];
  if (breakRate != null) switchConditions.push(cond('S6-1', '炸板率超过 40%', 0.4, breakRate, breakRate > 0.4, '若成立，封板成功率显著下降，赚钱效应转弱', '向下'));
  if (Number.isFinite(upN)) switchConditions.push(cond('S6-2', '涨停家数跌破 25 家', 25, upN, upN < 25, '若成立，短线情绪进入低迷一侧', '向下'));
  if (maxHeight != null) switchConditions.push(cond('S6-3', '最高连板高度达到 6 板及以上', 6, maxHeight, maxHeight >= 6, '若成立，龙头高度打开，情绪进入亢奋观察区', '向上'));

  return {
    key: 'sentiment',
    name: '情绪',
    available: true,
    degraded: !okUp,
    degradedReason: !okUp ? '涨停池未返回，情绪结论不完整' : null,
    facts,
    state: { label, basis },
    uncertainty,
    switchConditions,
    traces: [limitUp?.trace, limitDown?.trace, limitBreak?.trace].filter(Boolean),
  };
}

// ============================================================
// 7. 重要事件
// ============================================================
export async function events(ctx) {
  const { sampleEvents, ifindConfigured, sample } = ctx;
  if (ifindConfigured && !sample) {
    return {
      key: 'events',
      name: '重要事件',
      available: false,
      degraded: true,
      degradedReason: '已配置 iFinD MCP，但事件/新闻工具在当前部署中未接入调用链，事件维度暂不可用。',
      facts: [],
      state: { label: '未接入', basis: ['事件源声明已配置但实际调用链未接入，为避免伪造，不生成事件结论。'] },
      uncertainty: ['事件数据不可得，本维度结论不可用（未静默判定为"无重大事件"）。'],
      switchConditions: [],
      traces: [],
    };
  }
  if (!sample || !sampleEvents || !sampleEvents.length) {
    return {
      key: 'events',
      name: '重要事件',
      available: false,
      degraded: true,
      degradedReason: '未接入新闻/政策事件源（iFinD MCP 未配置），事件维度不可用。',
      facts: [],
      state: { label: '未接入', basis: ['事件源未接入，为避免"静默生成正常结论"，本维度留空并显式标注。'] },
      uncertainty: ['事件数据不可得；"无重大事件"与"未接入事件源"是两回事，本产品不做前者式表述。'],
      switchConditions: [],
      traces: [],
    };
  }
  const facts = sampleEvents.map((e) =>
    fact(e.title, `${new Date(e.date_ms).toISOString().slice(0, 10)} · ${e.category}`, {
      unit: '',
      caliber: `影响范围：${e.impact_scope}；方向：${e.direction_hint}`,
      src: { endpoint: '(sample:events)', sample: true, note: e.source },
      sampleEvent: true,
    }),
  );
  return {
    key: 'events',
    name: '重要事件',
    available: true,
    degraded: true,
    degradedReason: '当前为构造示例事件（非真实事件），仅用于演示事件维度结构与合规表述',
    facts,
    state: { label: '构造示例', basis: ['SAMPLE 模式返回构造示例事件，已逐条标注"构造示例·非真实事件"。'] },
    uncertainty: ['真实事件维度需接入 iFinD MCP 新闻/政策工具后启用；示例事件不含任何真实信息。'],
    switchConditions: [],
    traces: [],
  };
}

export const DIMENSION_RUNNERS = [priceStructure, breadth, styleRotation, valuation, liquidity, sentiment, events];
export const DIMENSION_META = [
  { key: 'priceStructure', name: '行情结构', question: '指数当前处于什么价格结构？' },
  { key: 'breadth', name: '市场宽度', question: '个股整体参与度如何？' },
  { key: 'styleRotation', name: '风格轮动', question: '大盘/小盘、成长/价值的相对强弱在哪一侧？' },
  { key: 'valuation', name: '估值', question: '估值结构呈现什么样的相对格局？' },
  { key: 'liquidity', name: '流动性', question: '量能处于放量还是缩量？' },
  { key: 'sentiment', name: '情绪', question: '短线情绪处于什么温度？' },
  { key: 'events', name: '重要事件', question: '是否有可确认的重要事件在影响市场？' },
];
