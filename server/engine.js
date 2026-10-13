/**
 * engine.js — 市场状态研判引擎（主链路编排）
 *
 * 流程：
 *   1. 建立时点（取自交易日历）
 *   2. 并行取数（指数历史/快照、个股快照、涨跌停、估值、日历）
 *   3. 运行七维研判
 *   4. 合成：综合状态描述 + 主要矛盾 + 置信度 + 状态切换条件 + 后续研究入口
 *
 * 合规红线：
 *   - 综合结论只做"当前状态描述 + 条件枚举"，不给方向预测、不给操作建议；
 *   - 置信度定义为"对所描述状态的可信程度"，并显式声明与未来方向无关；
 *   - 任取数失败 → 该维度 available=false 并带 degradedReason，不静默补齐。
 */
import config from './config.js';
import { CORE_INDEXES } from './dataLayer.js';
import { DIMENSION_RUNNERS, DIMENSION_META } from './dimensions.js';
import { sampleInternals, SAMPLE_INDUSTRY_ROTATION } from './sampleData.js';
import { round, pctChange, directionalScore, mean } from './analytics.js';

const DAY = 86400000;
const HIST_WINDOW_DAYS = 420;

function normErr(err, dl) {
  return dl._errInfo(err);
}

/** 将未知 promise 归一化为 {ok,res,trace}|{ok:false,error,trace}。 */
async function settle(promise, dl, endpoint) {
  try {
    return await promise;
  } catch (err) {
    return { ok: false, error: normErr(err, dl), trace: { source: dl.isSample ? 'sample' : 'fuyao', endpoint, failed: true } };
  }
}

/** 由交易日历推导"最新交易日"作为研判时点。 */
async function deriveAsOf(dl) {
  try {
    const r = await dl.tradingDays();
    const items = r.res?.data?.item || [];
    if (!items.length) return { asOf: Date.now(), label: null, degraded: true, reason: '交易日历为空，时点回退为服务器当前时间。' };
    const now = Date.now();
    const past = items.filter((i) => i.date_ms <= now);
    const last = (past.length ? past[past.length - 1] : items[items.length - 1]);
    return { asOf: last.date_ms, label: last.date, degraded: false, reason: null, trace: r.trace };
  } catch (err) {
    const e = normErr(err, dl);
    return { asOf: Date.now(), label: null, degraded: true, reason: `交易日历取数失败（${e.userMessage}），时点回退为服务器当前时间。` };
  }
}

/** 组装一次完整研判所需的上下文。 */
export async function buildContext(dl) {
  const sample = dl.isSample;
  const asOfInfo = await deriveAsOf(dl);
  const asOf = asOfInfo.asOf;
  const endMs = asOf + DAY;
  const startMs = asOf - HIST_WINDOW_DAYS * DAY;

  // 1) 指数快照
  const snap = await settle(dl.indexSnapshot(), dl, '/api/a-share-index/prices/snapshot');

  // 2) 指数历史（并行）
  const histEntries = await Promise.all(
    CORE_INDEXES.map(async (ix) => {
      const r = await settle(dl.indexHistorical(ix.thscode, startMs, endMs), dl, '/api/a-share-index/prices/historical');
      return [ix.thscode, r];
    }),
  );
  const hist = {};
  const histErrors = {};
  let histTrace = null;
  for (const [code, r] of histEntries) {
    if (r.ok) {
      hist[code] = r.res.data?.item || [];
      if (!histTrace) histTrace = r.trace;
    } else histErrors[code] = r.error;
  }

  // 3) 个股宇宙（宽度）
  const universe = await (async () => {
    try {
      return await dl.universeSnapshot();
    } catch (err) {
      return { ok: false, universe: [], aboveMa20Available: false, coverageLabel: '取数失败', error: normErr(err, dl), trace: null };
    }
  })();

  // 4) 情绪 / 特色数据（并行，允许失败）
  const [limitUp, limitDown, limitBreak, ladder, hotList, dragonTiger] = await Promise.all([
    settle(dl.limitUpPool(asOf), dl, '/api/a-share/special-data/limit-up-pool'),
    settle(dl.limitDownPool(asOf), dl, '/api/a-share/special-data/limit-down-pool'),
    settle(dl.limitBreakPool(asOf), dl, '/api/a-share/special-data/limit-break-pool'),
    settle(dl.limitUpLadder(), dl, '/api/a-share/special-data/limit-up-ladder'),
    settle(dl.hotStockList(), dl, '/api/a-share/special-data/hot-stock-list'),
    settle(dl.dragonTigerList(asOfInfo.label), dl, '/api/a-share/special-data/dragon-tiger-list'),
  ]);

  // 5) 估值（允许失败）
  const valuations = await settle(dl.valuationSnapshot(), dl, '/api/a-share/valuations/snapshot');

  return {
    dl,
    sample,
    asOf,
    asOfInfo,
    hist,
    histErrors,
    histTrace,
    snap,
    universe,
    limitUp,
    limitDown,
    limitBreak,
    ladder,
    hotList,
    dragonTiger,
    valuations,
    sampleEvents: sample ? sampleInternals.SAMPLE_EVENTS : null,
    ifindConfigured: Boolean(config.ifind.mcpUrl),
  };
}

// ============================================================
// 综合合成
// ============================================================

/** 主要矛盾规则表：命中优先级由高到低。 */
function detectContradictions(dims) {
  const availableCount = dims.filter((d) => d.available).length;
  if (availableCount < 2) {
    return {
      title: '证据不足，无法识别主要矛盾',
      detail: `当前仅 ${availableCount} 个维度可用，不足以识别维度间的背离或共振关系。系统按规则不生成"正常"或其他默认结论，请先恢复数据取数。`,
      dims: [],
      secondary: [],
      insufficient: true,
    };
  }
  const s = Object.fromEntries(dims.map((d) => [d.key, d.state?.label || '']));
  const get = (k) => s[k] || '';
  const rules = [
    {
      weight: 95,
      when: () => /上行|反弹/.test(get('priceStructure')) && /分化|普跌/.test(get('breadth')),
      title: '指数与个股宽度背离',
      detail:
        '价格结构偏强，但个股上涨家数占比偏低、"中位个股"表现弱于指数，说明上行主要由权重/少数个股驱动，市场参与度未同步扩散。',
      dims: ['priceStructure', 'breadth'],
    },
    {
      weight: 90,
      when: () => /上行|反弹/.test(get('priceStructure')) && /缩量/.test(get('liquidity')),
      title: '量价背离：指数上行 vs 量能收缩',
      detail: '指数维持上行结构，但成交额低于 20 日均值，量能未配合价格，上行的持续性需要后续放量确认。',
      dims: ['priceStructure', 'liquidity'],
    },
    {
      weight: 85,
      when: () => /分化|普跌/.test(get('breadth')) && /偏热|亢奋/.test(get('sentiment')),
      title: '情绪局部活跃 vs 整体宽度走弱',
      detail: '涨停家数与连板高度显示短线资金局部活跃，但市场整体宽度偏弱，赚钱效应集中在少数方向，属于结构性而非全面性活跃。',
      dims: ['breadth', 'sentiment'],
    },
    {
      weight: 80,
      when: () => /小盘/.test(get('styleRotation')) && /小盘估值显著高于大盘|小盘估值高于大盘/.test(get('valuation')),
      title: '小盘风格与高估值并存',
      detail: '风格天平偏向小盘，同时小盘相对大盘的估值倍数偏高，风格的性价比一侧需要盈利增速兑现来支撑。',
      dims: ['styleRotation', 'valuation'],
    },
    {
      weight: 78,
      when: () => /下行/.test(get('priceStructure')) && /放量/.test(get('liquidity')),
      title: '下跌伴随放量',
      detail: '价格结构偏弱且成交额高于 20 日均值，抛压释放较为充分，需观察量能能否在低位萎缩。',
      dims: ['priceStructure', 'liquidity'],
    },
    {
      weight: 70,
      when: () =>
        /上行/.test(get('priceStructure')) && /普涨|偏多/.test(get('breadth')) && /放量/.test(get('liquidity')),
      title: '多维共振（结构/宽度/量能同向）',
      detail: '价格结构、市场宽度与量能三个维度方向一致偏强，当前无显著内部矛盾。',
      dims: ['priceStructure', 'breadth', 'liquidity'],
    },
    {
      weight: 70,
      when: () => /下行/.test(get('priceStructure')) && /普跌/.test(get('breadth')) && /偏冷/.test(get('sentiment')),
      title: '多维共振（结构/宽度/情绪同向偏弱）',
      detail: '结构、宽度与情绪同向偏弱，当前主要观察情绪与量能何时出现止跌信号。',
      dims: ['priceStructure', 'breadth', 'sentiment'],
    },
  ];
  const matched = rules.filter((r) => r.when()).sort((a, b) => b.weight - a.weight);
  if (!matched.length) {
    return {
      title: '暂无显著内部矛盾',
      detail: '各可得维度状态基本一致或差异未达到产品设定的矛盾阈值；这不代表市场无风险，只代表当前证据未显示明显背离。',
      dims: [],
      secondary: [],
    };
  }
  const top = matched[0];
  return { title: top.title, detail: top.detail, dims: top.dims, secondary: matched.slice(1, 3).map((m) => ({ title: m.title, detail: m.detail })) };
}

/** 置信度：对"当前状态描述"的可信程度，与未来方向无关。 */
function computeConfidence(dims) {
  const total = dims.length;
  const available = dims.filter((d) => d.available);
  const unavailableCount = total - available.length;
  const degradedCount = dims.filter((d) => d.degraded).length; // 数据可得但带口径局限
  const completeness = available.length / total;

  const scores = available.map((d) => directionalScore(d.state?.label)).filter((x) => x !== 0);
  const pos = scores.filter((x) => x > 0).length;
  const neg = scores.filter((x) => x < 0).length;
  const denom = pos + neg;
  const agreement = denom ? Math.abs(pos - neg) / denom : 0.5;

  let score = 0.55 * completeness + 0.45 * agreement;
  const caveatPenalty = Math.min(0.09, degradedCount * 0.03); // 口径局限带来的折扣
  score -= caveatPenalty;
  let capped = null;
  if (unavailableCount >= 4) {
    score = Math.min(score, 0.45);
    capped = `因 ${unavailableCount} 个维度不可用，置信度上限被限制在"低"。`;
  } else if (unavailableCount >= 2) {
    score = Math.min(score, 0.68);
    capped = `因 ${unavailableCount} 个维度不可用，置信度上限被限制在"中"。`;
  }
  const level = score >= 0.72 ? '高' : score >= 0.5 ? '中' : '低';
  return {
    level,
    score: round(score, 3),
    basis: [
      `维度可用度 ${available.length}/${total}（${round(completeness * 100, 1)}%）`,
      `方向一致性 ${round(agreement * 100, 1)}%（同向维度 ${Math.max(pos, neg)} 个 / 反向 ${Math.min(pos, neg)} 个，中性 ${available.length - denom} 个）`,
      `口径局限折扣 −${round(caveatPenalty, 3)}（降级维度 ${degradedCount} 个）`,
      capped,
      '定义说明：置信度衡量"对当前市场状态描述的可信程度"，由规则按数据完整度与维度一致性计算得出，不代表对未来涨跌方向的把握，也非收益概率。',
    ].filter(Boolean),
    formula: 'confidence = 0.55 × 维度可用度 + 0.45 × 方向一致性 − 口径局限折扣（含不可用维度上限约束）',
  };
}

function buildSwitchConditions(dims) {
  const all = [];
  for (const d of dims) {
    if (!d.available) continue;
    for (const c of d.switchConditions || []) {
      all.push({ ...c, dimension: d.name, dimensionKey: d.key });
    }
  }
  // 触发中优先，其次按距离阈值的远近
  return all.sort((a, b) => {
    if (a.satisfied !== b.satisfied) return a.satisfied ? -1 : 1;
    const da = a.distancePct == null ? Infinity : Math.abs(a.distancePct);
    const db = b.distancePct == null ? Infinity : Math.abs(b.distancePct);
    return da - db;
  });
}

function buildHeadline(dims) {
  const g = (k) => dims.find((d) => d.key === k)?.state?.label || '—';
  return {
    // 纯状态描述，不含方向预测
    summary: `行情结构：${g('priceStructure')}；市场宽度：${g('breadth')}；风格：${g('styleRotation')}；量能：${g('liquidity')}；情绪：${g('sentiment')}；估值结构：${g('valuation')}；事件：${g('events')}。`,
  };
}

/**
 * 运行一次完整研判。
 */
export async function runAssessment(dl) {
  const ctx = await buildContext(dl);
  const dims = [];
  for (const runner of DIMENSION_RUNNERS) {
    try {
      dims.push(await runner(ctx));
    } catch (err) {
      const meta = DIMENSION_META.find((m) => m.key === runner.name) || {};
      dims.push({
        key: runner.name,
        name: meta.name || runner.name,
        available: false,
        degraded: true,
        degradedReason: `维度计算异常：${err.message}`,
        facts: [],
        state: { label: '不可用', basis: ['维度内部计算异常，未生成结论。'] },
        uncertainty: ['该维度不可用，结论缺省。'],
        switchConditions: [],
        traces: [],
      });
    }
  }

  const contradiction = detectContradictions(dims);
  const confidence = computeConfidence(dims);
  const switchConditions = buildSwitchConditions(dims);
  const factsTotal = dims.reduce((s, d) => s + (d.facts?.length || 0), 0);
  const uncertainTotal = dims.reduce((s, d) => s + (d.uncertainty?.length || 0), 0);

  const availableCount = dims.filter((d) => d.available).length;
  const degraded = dims.filter((d) => d.degraded || !d.available);

  return {
    meta: {
      product: '大势罗盘',
      productEn: 'Market Compass',
      generatedAt: Date.now(),
      asOf: ctx.asOf,
      asOfLabel: ctx.asOfInfo.label,
      asOfDegraded: ctx.asOfInfo.degraded,
      asOfReason: ctx.asOfInfo.reason,
      mode: dl.describe(),
      compliance: config.compliance,
    },
    headline: buildHeadline(dims),
    synthesis: {
      mainContradiction: contradiction,
      confidence,
      switchConditions,
      stats: {
        dimensionsTotal: dims.length,
        dimensionsAvailable: availableCount,
        dimensionsDegraded: degraded.length,
        factsTotal,
        uncertainTotal,
      },
      degradedDimensions: degraded.map((d) => ({ key: d.key, name: d.name, reason: d.degradedReason || '该维度不可用' })),
    },
    dimensions: dims,
    nextResearch: [
      { id: 'industry', title: '行业轮动下钻', desc: '查看细分行业的相对强弱排序，定位资金集中的方向。' },
      { id: 'style', title: '风格切换观察', desc: '放大观察大小盘/成长价值的近端相对强弱与切换带。' },
      { id: 'risk', title: '风险变量清单', desc: '列出当前结论成立所依赖的前提，以及会推翻它的变量。' },
      { id: 'stage', title: '历史阶段对比', desc: '选取过去一段区间，回看当时的七维状态与主要矛盾。' },
    ],
  };
}

// ============================================================
// 继续研究：行业轮动
// ============================================================
export async function researchIndustry(dl) {
  if (dl.isSample) {
    const items = SAMPLE_INDUSTRY_ROTATION.slice().sort((a, b) => b.r20 - a.r20);
    return {
      mode: 'SAMPLE',
      note: '构造样本行业数据（非实时），仅演示行业轮动下钻结构。',
      items: items.map((i, idx) => ({ rank: idx + 1, thscode: i.thscode, name: i.name, r5: i.r5, r20: i.r20, r60: i.r60 })),
      caliber: 'r5/r20/r60 = 该行业指数近 5/20/60 交易日涨跌幅（计算值）',
    };
  }
  // LIVE：先取行业指数目录，再取前 N 个的历史并计算相对强弱
  const cat = await settle(dl.indexCatalog('industry'), dl, '/api/a-share-index/catalog/ths-index-list');
  if (!cat.ok) {
    return { mode: 'LIVE', error: cat.error, items: [], note: '行业指数目录取数失败，行业轮动暂不可用。' };
  }
  const catalog = (cat.res.data?.item || []).slice(0, 24);
  const asOf = Date.now();
  const startMs = asOf - 200 * DAY;
  const rows = [];
  for (const c of catalog) {
    const r = await settle(dl.indexHistorical(c.thscode, startMs, asOf), dl, '/api/a-share-index/prices/historical');
    if (!r.ok) continue;
    const bars = r.res.data?.item || [];
    const closes = bars.map((b) => b.close_price).filter(Number.isFinite);
    if (closes.length < 21) continue;
    rows.push({ thscode: c.thscode, name: c.name, r5: pctChange(closes, 5), r20: pctChange(closes, 20), r60: pctChange(closes, 60) });
  }
  rows.sort((a, b) => (b.r20 ?? -9) - (a.r20 ?? -9));
  return {
    mode: 'LIVE',
    note: `扶摇行业指数前 ${catalog.length} 个（按目录顺序抽样，非全行业完整排名）。`,
    items: rows.map((i, idx) => ({ rank: idx + 1, ...i })),
    caliber: 'r5/r20/r60 = 该行业指数近 5/20/60 交易日涨跌幅（计算值）',
  };
}

// ============================================================
// 继续研究：历史阶段对比
// ============================================================
export async function researchStage(dl, { lookbackDays = 60 } = {}) {
  const ctx = await buildContext(dl);
  const bars = ctx.hist['000001.SH'] || [];
  if (bars.length < lookbackDays + 1) {
    return { mode: ctx.sample ? 'SAMPLE' : 'LIVE', error: { userMessage: '历史区间数据不足，无法对比。' }, stage: null };
  }
  const idx = bars.length - 1 - lookbackDays;
  const past = bars.slice(0, idx + 1);
  const pastCloses = past.map((b) => b.close_price);
  const pastTurns = past.map((b) => b.turnover).filter(Number.isFinite);
  return {
    mode: ctx.sample ? 'SAMPLE' : 'LIVE',
    stage: {
      label: `近 ${lookbackDays} 个交易日前`,
      dateMs: bars[idx].date_ms,
      close: bars[idx].close_price,
      r20Then: pctChange(pastCloses, 20),
      turnoverThen: pastTurns.length ? pastTurns[pastTurns.length - 1] : null,
      turnoverMa20Then: pastTurns.length >= 20 ? mean(pastTurns.slice(-20)) : null,
      nowClose: bars[bars.length - 1].close_price,
      changeSince: round((bars[bars.length - 1].close_price / bars[idx].close_price - 1) * 100, 2),
    },
    note: '历史阶段对比仅回顾当时可得的行情事实（价格/量能），不引入事后信息，避免后见之明。',
  };
}

export default { runAssessment, buildContext, researchIndustry, researchStage };
