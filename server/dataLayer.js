/**
 * dataLayer.js — 统一数据层
 *
 * 职责：
 *  1. 依据 config 解析实际生效模式（LIVE / SAMPLE），并暴露降级原因；
 *  2. 对上提供"取数能力"，屏蔽 SAMPLE / LIVE 差异；
 *  3. 统一记录每次取数的「来源 / 时点 / 状态」，供证据链追溯；
 *  4. 接口失败时抛出具名错误，绝不返回伪造的"正常"数据。
 */
import config, { resolveMode, isSimulateFailure } from './config.js';
import { FuyaoClient, FuyaoError } from './fuyaoClient.js';
import { sampleSource, sampleUniverseSnapshot } from './sampleData.js';

const TTL = 60_000; // 一分钟缓存，避免前端多次刷新打爆接口
const cache = new Map();

async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.val;
  const val = await fn();
  cache.set(key, { at: Date.now(), val });
  return val;
}

/** 主要宽基 / 风格指数清单（用于行情结构、风格轮动、估值）。 */
export const CORE_INDEXES = [
  { thscode: '000001.SH', name: '上证综指', role: '综合' },
  { thscode: '399001.SZ', name: '深证成指', role: '综合' },
  { thscode: '000300.SH', name: '沪深300', role: '宽基·大盘' },
  { thscode: '000905.SH', name: '中证500', role: '宽基·中盘' },
  { thscode: '000852.SH', name: '中证1000', role: '宽基·小盘' },
  { thscode: '000016.SH', name: '上证50', role: '宽基·超大盘' },
  { thscode: '399006.SZ', name: '创业板指', role: '成长' },
  { thscode: '000688.SH', name: '科创50', role: '成长' },
];

/** 市场宽度所需成分股来源（取并集近似"全市场"）。 */
const BREADTH_INDEXES = ['000300.SH', '000905.SH', '000852.SH'];

export class DataLayer {
  constructor() {
    this.modeInfo = resolveMode();
    this.fuyao = new FuyaoClient();
  }

  get isSample() {
    return this.modeInfo.mode === 'SAMPLE';
  }

  /** 面向 UI 的模式元信息。 */
  describe() {
    const { mode, requested, degraded, reason } = this.modeInfo;
    return {
      mode,
      requested,
      degraded,
      reason,
      sampleNote: this.isSample ? sampleSource.note : null,
      fuyaoConfigured: this.fuyao.configured,
      ifindConfigured: Boolean(config.ifind.mcpUrl),
      baseUrl: this.isSample ? null : this.fuyao.baseUrl,
    };
  }

  /** 统一的取数封装：附加来源追溯；模拟故障用于测试。 */
  async _call(trace, fn, { allowFailure = false } = {}) {
    if (isSimulateFailure() && trace.transient === undefined) {
      const err = new FuyaoError('已启用 SIMULATE_FAILURE=1，模拟一次接口失败（用于验证降级提示）', {
        endpoint: trace.endpoint,
        kind: 'network',
      });
      if (allowFailure) return { ok: false, error: this._errInfo(err), trace: this._trace(trace) };
      throw err;
    }
    try {
      const res = await fn();
      return { ok: true, res, trace: this._trace(trace, res) };
    } catch (err) {
      if (allowFailure) return { ok: false, error: this._errInfo(err), trace: this._trace(trace) };
      throw err;
    }
  }

  _errInfo(err) {
    return {
      kind: err.kind || 'unknown',
      code: err.code ?? null,
      message: err.message,
      userMessage:
        err.kind === 'auth'
          ? '扶摇接口鉴权失败（API Key 无效或缺失），请检查 FUYAO_API_KEY。'
          : err.kind === 'permission'
            ? '当前 API Key 无该接口权限。'
            : err.kind === 'ratelimit'
              ? '触发扶摇接口限流，请稍后重试。'
              : err.kind === 'notready'
                ? '该标的暂无可用数据（数据未就绪）。'
                : err.kind === 'notfound'
                  ? '该标的不存在。'
                  : err.kind === 'timeout' || err.kind === 'network'
                    ? '接口调用失败（网络或超时），请稍后重试。'
                    : '接口调用失败，请稍后重试。',
    };
  }

  _trace(trace, res) {
    const src = this.isSample ? 'sample' : 'fuyao';
    return {
      source: src,
      provider: this.isSample ? '内置构造样本' : '扶摇金融数据 API',
      endpoint: trace.endpoint,
      mcpTool: trace.mcpTool || null,
      request_id: res?.request_id ?? null,
      dataTimestamp: res?.timestamp ?? res?.data?.timestamp ?? null,
      fetchedAt: Date.now(),
      mode: this.modeInfo.mode,
      sample: this.isSample,
    };
  }

  // ---------- 指数 ----------
  indexSnapshot(thscodes = CORE_INDEXES.map((i) => i.thscode)) {
    return this._call(
      { endpoint: '/api/a-share-index/prices/snapshot', mcpTool: 'get_a_share_index_prices_snapshot' },
      () => (this.isSample ? sampleSource.indexSnapshot(thscodes) : this.fuyao.indexSnapshot(thscodes)),
    );
  }

  indexHistorical(thscode, startMs, endMs) {
    return this._call(
      { endpoint: '/api/a-share-index/prices/historical', mcpTool: 'get_a_share_index_prices_historical' },
      () => (this.isSample ? sampleSource.indexHistorical(thscode) : this.fuyao.indexHistorical(thscode, startMs, endMs)),
    );
  }

  indexCatalog(tag = 'industry') {
    return this._call({ endpoint: '/api/a-share-index/catalog/ths-index-list', mcpTool: 'get_a_share_index_catalog_ths_index_list' }, () =>
      this.isSample ? sampleSource.indexCatalog(tag) : this.fuyao.indexCatalog(tag),
    );
  }

  indexConstituents(thscode) {
    return this._call({ endpoint: '/api/a-share-index/constituents/ths-stock-list', mcpTool: 'get_a_share_index_constituents_ths_stock_list' }, () =>
      this.isSample ? sampleSource.indexConstituents(thscode) : this.fuyao.indexConstituents(thscode),
    );
  }

  // ---------- 全市场（宽度）----------
  /**
   * 返回市场宽度所需的个股快照集合。
   * SAMPLE：直接给出构造的 5400 只样本宇宙（近似 A 股全市场）。
   * LIVE：取三大宽基成分股并集后按快照批量拉取（chunk=200），站上 MA20 因成本原因标为不可用。
   */
  async universeSnapshot() {
    if (this.isSample) {
      if (isSimulateFailure()) {
        throw new FuyaoError('已启用 SIMULATE_FAILURE=1，模拟个股快照接口失败', { endpoint: '/api/a-share/prices/snapshot', kind: 'network' });
      }
      const universe = sampleUniverseSnapshot();
      return {
        ok: true,
        universe,
        aboveMa20Available: true,
        coverageLabel: `样本全市场（构造 ${universe.length} 只）`,
        trace: this._trace({ endpoint: '(sample:universe)' }, { request_id: null, timestamp: null }),
      };
    }
    return cached('live:universe', async () => this._liveUniverse());
  }

  async _liveUniverse() {
    const codes = new Set();
    const traces = [];
    for (const idx of BREADTH_INDEXES) {
      const r = await this._call(
        { endpoint: '/api/a-share-index/constituents/ths-stock-list', mcpTool: 'get_a_share_index_constituents_ths_stock_list' },
        () => this.fuyao.indexConstituents(idx),
        { allowFailure: true },
      );
      traces.push(r.trace);
      if (r.ok) for (const it of r.res.data?.item || []) if (it.thscode) codes.add(it.thscode);
    }
    const list = [...codes];
    const universe = [];
    const CHUNK = 200;
    for (let i = 0; i < list.length; i += CHUNK) {
      const chunk = list.slice(i, i + CHUNK);
      const r = await this._call(
        { endpoint: '/api/a-share/prices/snapshot', mcpTool: 'get_a_share_prices_snapshot' },
        () => this.fuyao.stockSnapshot(chunk),
        { allowFailure: true },
      );
      traces.push(r.trace);
      if (r.ok) for (const it of r.res.data?.item || []) universe.push({ ...it, above_ma20: null });
    }
    return {
      ok: true,
      universe,
      aboveMa20Available: false,
      coverageLabel: `宽基成分股并集（${universe.length} 只，LIVE）`,
      trace: traces[0] || this._trace({ endpoint: '/api/a-share/prices/snapshot' }, null),
    };
  }

  // ---------- 估值 ----------
  valuationSnapshot(thscodes = CORE_INDEXES.map((i) => i.thscode)) {
    return this._call(
      { endpoint: '/api/a-share/valuations/snapshot', mcpTool: 'get_a_share_valuations_snapshot' },
      () => (this.isSample ? sampleSource.valuationSnapshot(thscodes) : this.fuyao.valuationSnapshot(thscodes)),
      { allowFailure: true },
    );
  }

  // ---------- 交易日历 ----------
  tradingDays() {
    return this._call({ endpoint: '/api/a-share/calendar/trading-days', mcpTool: 'get_a_share_calendar_trading_days' }, () =>
      this.isSample ? sampleSource.tradingDays() : this.fuyao.tradingDays(),
    );
  }

  // ---------- 情绪 / 特色数据 ----------
  limitUpPool(dateMs) {
    return this._call({ endpoint: '/api/a-share/special-data/limit-up-pool', mcpTool: 'get_a_share_special_data_limit_up_pool' }, () =>
      this.isSample ? sampleSource.limitUpPool({ dateMs }) : this.fuyao.limitUpPool({ dateMs }),
    );
  }
  limitDownPool(dateMs) {
    return this._call({ endpoint: '/api/a-share/special-data/limit-down-pool', mcpTool: 'get_a_share_special_data_limit_down_pool' }, () =>
      this.isSample ? sampleSource.limitDownPool({ dateMs }) : this.fuyao.limitDownPool({ dateMs }),
    );
  }
  limitBreakPool(dateMs) {
    return this._call({ endpoint: '/api/a-share/special-data/limit-break-pool', mcpTool: 'get_a_share_special_data_limit_break_pool' }, () =>
      this.isSample ? sampleSource.limitBreakPool({ dateMs }) : this.fuyao.limitBreakPool({ dateMs }),
    );
  }
  limitUpLadder() {
    return this._call({ endpoint: '/api/a-share/special-data/limit-up-ladder', mcpTool: 'get_a_share_special_data_limit_up_ladder' }, () =>
      this.isSample ? sampleSource.limitUpLadder() : this.fuyao.limitUpLadder(),
    );
  }
  hotStockList() {
    return this._call({ endpoint: '/api/a-share/special-data/hot-stock-list', mcpTool: 'get_a_share_special_data_hot_stock_list' }, () =>
      this.isSample ? sampleSource.hotStockList() : this.fuyao.hotStockList(),
    );
  }
  dragonTigerList(dateStr) {
    return this._call({ endpoint: '/api/a-share/special-data/dragon-tiger-list', mcpTool: 'get_a_share_special_data_dragon_tiger_list' }, () =>
      this.isSample ? sampleSource.dragonTigerList() : this.fuyao.dragonTigerList('all', dateStr),
    );
  }
}

export default DataLayer;
