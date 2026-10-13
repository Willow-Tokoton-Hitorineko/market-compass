/**
 * config.js — 运行配置与环境变量装载
 *
 * 设计要点：
 * 1. 零依赖：自行解析 .env，避免因 npm 网络问题阻塞启动。
 * 2. 模式判定集中在 getMode()：LIVE 需要 key 齐备，否则自动降级为 SAMPLE，
 *    并把降级原因暴露给上层，确保"数据缺失不得静默生成正常结论"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

/** 极简 .env 解析器：KEY=VALUE，# 开头为注释，值可带引号。已存在的真实环境变量优先。 */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv(path.join(ROOT, '.env'));

const raw = {
  dataMode: (process.env.DATA_MODE || 'SAMPLE').trim().toUpperCase(),
  fuyaoApiKey: (process.env.FUYAO_API_KEY || '').trim(),
  fuyaoBaseUrl: (process.env.FUYAO_BASE_URL || 'https://fuyao.aicubes.cn').trim().replace(/\/+$/, ''),
  port: Number(process.env.PORT || 8787),
  ifindMcpUrl: (process.env.IFIND_MCP_URL || '').trim(),
  simulateFailure: process.env.SIMULATE_FAILURE === '1',
};

/**
 * 解析实际生效的运行模式。
 * @returns {{mode:'LIVE'|'SAMPLE', requested:'LIVE'|'SAMPLE', degraded:boolean, reason:string|null}}
 */
export function resolveMode() {
  const requested = raw.dataMode === 'LIVE' ? 'LIVE' : 'SAMPLE';
  if (requested === 'LIVE' && !raw.fuyaoApiKey) {
    return {
      mode: 'SAMPLE',
      requested,
      degraded: true,
      reason: '已请求 LIVE 模式，但未配置 FUYAO_API_KEY，系统自动降级为 SAMPLE（构造样本）。',
    };
  }
  return { mode: requested, requested, degraded: false, reason: null };
}

/**
 * 是否开启故障演练（调用时动态读取，便于测试中开关）。
 */
export function isSimulateFailure() {
  return process.env.SIMULATE_FAILURE === '1';
}

export const config = {
  root: ROOT,
  port: raw.port,
  fuyao: { apiKey: raw.fuyaoApiKey, baseUrl: raw.fuyaoBaseUrl },
  ifind: { mcpUrl: raw.ifindMcpUrl },
  simulateFailure: raw.simulateFailure,
  // 产品层面的统一免责声明，前后端共用
  compliance: {
    version: 'v1.0',
    asOfLabel: '数据时点以各证据条目标注为准（Asia/Shanghai）',
    disclaimer:
      '本产品为市场「状态描述与证据整理」工具，不构成任何证券投资建议，不预测证券价格涨跌，不提供买卖/持仓操作建议。' +
      '所有结论均区分「事实 / 归纳 / 不确定」，并标注来源接口、时点与统计口径；当数据缺失、冲突、过期或接口失败时，' +
      '系统会显式标注降级状态而非静默给出"正常"结论。投资决策及其后果由使用者自行承担。',
  },
};

export default config;
