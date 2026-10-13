/**
 * analytics.js — 纯函数分析工具
 *
 * 约定：本模块只做"从原始数值计算派生指标"的确定性运算。
 * 所有派生值在证据链中都会标注为「计算值」，并附计算公式与口径，
 * 与接口返回的「原始值」严格区分，确保可追溯。
 */

export function round(x, d = 2) {
  if (!Number.isFinite(x)) return null;
  const m = 10 ** d;
  return Math.round(x * m) / m;
}

export function mean(arr) {
  const a = arr.filter(Number.isFinite);
  if (!a.length) return null;
  return a.reduce((s, x) => s + x, 0) / a.length;
}

export function stdev(arr) {
  const a = arr.filter(Number.isFinite);
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

export function median(arr) {
  const a = arr.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/** 简单移动平均（取序列末尾 n 个）。 */
export function sma(series, n) {
  if (series.length < n) return null;
  const seg = series.slice(-n);
  return mean(seg);
}

/** 序列末端相对 n 期前的涨跌幅（小数）。 */
export function pctChange(series, n) {
  if (series.length < n + 1) return null;
  const last = series[series.length - 1];
  const base = series[series.length - 1 - n];
  if (!base) return null;
  return last / base - 1;
}

/** 值在序列中的分位（0–1，含等于）。 */
export function percentileRank(series, value) {
  const a = series.filter(Number.isFinite);
  if (!a.length || !Number.isFinite(value)) return null;
  const le = a.filter((x) => x <= value).length;
  return le / a.length;
}

/** 线性回归斜率（按序归一化到"每期"），用于判断均线斜率方向。 */
export function slope(series) {
  const a = series.filter(Number.isFinite);
  const n = a.length;
  if (n < 2) return null;
  const xm = (n - 1) / 2;
  const ym = mean(a);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xm) * (a[i] - ym);
    den += (i - xm) ** 2;
  }
  return den ? num / den : null;
}

/** MA 序列（用于斜率）。 */
export function smaSeries(series, n) {
  const out = [];
  for (let i = n; i <= series.length; i++) out.push(mean(series.slice(i - n, i)));
  return out;
}

export function safeDiv(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return a / b;
}

/** 稳健的分档函数：按阈值从高到低返回第一个命中的标签。 */
export function bucket(value, rules, fallback) {
  if (!Number.isFinite(value)) return { label: fallback, hit: null };
  for (const r of rules) {
    if (value >= r.min) return { label: r.label, hit: r };
  }
  return { label: fallback, hit: null };
}

/** 把方向性状态映射为 -1/0/+1，用于一致性度量。 */
export function directionalScore(label) {
  if (!label) return 0;
  const s = String(label);
  const positive = ['上行', '普涨', '偏多', '放量', '亢奋', '偏热', '走强', '占优·大盘', '大盘占优'];
  const negative = ['下行', '普跌', '偏空', '缩量', '低迷', '偏冷', '走弱', '小盘占优'];
  for (const k of positive) if (s.includes(k)) return s.includes('小盘') ? -1 : 1;
  for (const k of negative) if (s.includes(k)) return -1;
  return 0;
}
