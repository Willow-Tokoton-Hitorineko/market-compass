/**
 * fuyaoClient.js — 扶摇金融数据 REST 适配器
 *
 * 严格对齐扶摇官方文档约定（https://fuyao.aicubes.cn/docs/）：
 *  - Base URL: https://fuyao.aicubes.cn
 *  - 必需请求头: X-api-key
 *  - 统一响应信封: { code, message, request_id, data: { timestamp, item } }
 *  - HTTP 状态码恒为 200，业务错误经 code 字段表达
 *  - 时间戳为毫秒级 Unix 时间戳（Asia/Shanghai）
 *
 * 本模块只做"取数与错误归一化"，不做任何业务加工，便于测试与追溯。
 */
import config from './config.js';

/** 业务错误码 → 人类可读含义（来自扶摇文档）。 */
export const FUYAO_ERRORS = {
  0: '成功',
  1001: '缺少必填参数',
  1002: '参数格式错误',
  1003: '参数值越界',
  1004: '参数冲突',
  2001: '未通过认证（X-api-key 缺失或无效）',
  2003: '无权限访问该接口',
  3001: '标的不存在',
  3002: '数据未就绪',
  3004: '标的类型不支持该能力',
  4001: '触发限流，请降低请求频率',
  5001: '服务端内部错误',
  5002: '服务端内部错误',
  5003: '服务端内部错误',
};

/** 归一化异常：保留 HTTP/业务码与原始响应，供上层做降级判定与追溯。 */
export class FuyaoError extends Error {
  constructor(message, { code, httpStatus, endpoint, raw, kind } = {}) {
    super(message);
    this.name = 'FuyaoError';
    this.code = code ?? null;
    this.httpStatus = httpStatus ?? null;
    this.endpoint = endpoint ?? null;
    this.raw = raw ?? null;
    // kind: 'auth' | 'permission' | 'notfound' | 'notready' | 'ratelimit' | 'server' | 'network' | 'timeout' | 'parse'
    this.kind = kind ?? 'unknown';
  }
}

function classify(code) {
  if (code === 2001) return 'auth';
  if (code === 2003) return 'permission';
  if (code === 3001) return 'notfound';
  if (code === 3002) return 'notready';
  if (code === 4001) return 'ratelimit';
  if (code >= 5001 && code <= 5003) return 'server';
  return 'unknown';
}

export class FuyaoClient {
  constructor({ apiKey, baseUrl, timeoutMs = 15000 } = {}) {
    this.apiKey = apiKey || config.fuyao.apiKey || '';
    this.baseUrl = (baseUrl || config.fuyao.baseUrl).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
  }

  get configured() {
    return Boolean(this.apiKey);
  }

  /**
   * 发起一次取数请求。
   * @param {string} endpoint 形如 '/api/a-share-index/prices/snapshot'
   * @param {object} query 查询参数对象（值可为 string|number|Array）
   * @returns {Promise<{code:number,message:string,request_id:string,data:any,timestamp:number|null}>}
   */
  async request(endpoint, query = {}) {
    const url = new URL(this.baseUrl + endpoint);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { 'X-api-key': this.apiKey, accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const kind = err?.name === 'AbortError' ? 'timeout' : 'network';
      throw new FuyaoError(
        kind === 'timeout' ? `请求超时（>${this.timeoutMs}ms）：${endpoint}` : `网络请求失败：${endpoint}（${err.message}）`,
        { endpoint, kind },
      );
    }
    clearTimeout(timer);

    let body;
    const text = await res.text();
    try {
      body = JSON.parse(text);
    } catch {
      throw new FuyaoError(`响应非 JSON：${endpoint}`, {
        endpoint,
        httpStatus: res.status,
        kind: 'parse',
        raw: text.slice(0, 500),
      });
    }

    if (!res.ok && typeof body?.code !== 'number') {
      throw new FuyaoError(`HTTP ${res.status}：${endpoint}`, {
        endpoint,
        httpStatus: res.status,
        kind: 'server',
        raw: body,
      });
    }

    if (typeof body?.code === 'number' && body.code !== 0) {
      const kind = classify(body.code);
      throw new FuyaoError(
        `扶摇接口返回 code=${body.code}（${FUYAO_ERRORS[body.code] || body.message || '未知错误'}）：${endpoint}`,
        { endpoint, httpStatus: res.status, code: body.code, kind, raw: body },
      );
    }

    return {
      code: body?.code ?? 0,
      message: body?.message ?? '',
      request_id: body?.request_id ?? null,
      data: body?.data ?? null,
      timestamp: body?.data?.timestamp ?? null,
    };
  }

  // ---------- A 股指数 ----------
  indexSnapshot(thscodes) {
    return this.request('/api/a-share-index/prices/snapshot', { thscodes });
  }
  indexHistorical(thscode, startMs, endMs, interval = '1d') {
    return this.request('/api/a-share-index/prices/historical', {
      thscode,
      interval,
      start: startMs,
      end: endMs,
    });
  }
  indexCatalog(tag = 'industry') {
    return this.request('/api/a-share-index/catalog/ths-index-list', { tag });
  }
  indexConstituents(thscode) {
    return this.request('/api/a-share-index/constituents/ths-stock-list', { thscode });
  }

  // ---------- A 股个股 ----------
  stockSnapshot(thscodes) {
    return this.request('/api/a-share/prices/snapshot', { thscodes });
  }
  stockHistorical(thscode, startMs, endMs, adjust = 'forward') {
    return this.request('/api/a-share/prices/historical', { thscode, interval: '1d', start: startMs, end: endMs, adjust });
  }
  valuationSnapshot(thscodes) {
    return this.request('/api/a-share/valuations/snapshot', { thscodes });
  }

  // ---------- 交易日历 ----------
  tradingDays() {
    return this.request('/api/a-share/calendar/trading-days', {});
  }

  // ---------- 特色数据（情绪/事件）----------
  limitUpPool({ dateMs, page = 1, size = 100 } = {}) {
    return this.request('/api/a-share/special-data/limit-up-pool', { date_ms: dateMs, page, size });
  }
  limitDownPool({ dateMs, page = 1, size = 100 } = {}) {
    return this.request('/api/a-share/special-data/limit-down-pool', { date_ms: dateMs, page, size });
  }
  limitBreakPool({ dateMs, page = 1, size = 100 } = {}) {
    return this.request('/api/a-share/special-data/limit-break-pool', { date_ms: dateMs, page, size });
  }
  limitUpLadder() {
    return this.request('/api/a-share/special-data/limit-up-ladder', {});
  }
  hotStockList(period = 'day') {
    return this.request('/api/a-share/special-data/hot-stock-list', { period });
  }
  dragonTigerList(boardType = 'all', dateStr) {
    return this.request('/api/a-share/special-data/dragon-tiger-list', { board_type: boardType, date: dateStr });
  }
}

export default FuyaoClient;
