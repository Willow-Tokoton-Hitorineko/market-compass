/**
 * run.test.js — 主链路 / 数据缺失 / 合规边界 测试
 *
 * 运行：npm test  （node --test test/）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mean, median, sma, pctChange, percentileRank, slope, smaSeries, round } from '../server/analytics.js';
import { FUYAO_ERRORS, FuyaoError, FuyaoClient } from '../server/fuyaoClient.js';
import DataLayer from '../server/dataLayer.js';
import { runAssessment, researchIndustry, researchStage } from '../server/engine.js';

// ---------------------------------------------------------------
// 1. 分析工具（纯函数）
// ---------------------------------------------------------------
test('analytics: 基础统计量正确', () => {
  assert.equal(mean([1, 2, 3, 4]), 2.5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(sma([1, 2, 3, 4, 5], 3), 4);
  assert.equal(round(pctChange([100, 110], 1), 4), 0.1);
  assert.equal(percentileRank([1, 2, 3, 4], 4), 1);
  assert.equal(percentileRank([1, 2, 3, 4], 0.5), 0);
  assert.ok(slope([1, 2, 3, 4]) > 0);
  assert.ok(slope([4, 3, 2, 1]) < 0);
  assert.equal(smaSeries([1, 2, 3, 4, 5], 2).length, 4);
});

test('analytics: 数据不足时安全返回 null，不抛异常', () => {
  assert.equal(sma([1, 2], 5), null);
  assert.equal(pctChange([1], 5), null);
  assert.equal(mean([]), null);
  assert.equal(round(NaN, 2), null);
});

// ---------------------------------------------------------------
// 2. 扶摇客户端：错误归一化
// ---------------------------------------------------------------
test('fuyaoClient: 错误码表与异常分类', () => {
  assert.equal(FUYAO_ERRORS[0], '成功');
  assert.equal(FUYAO_ERRORS[2001], '未通过认证（X-api-key 缺失或无效）');
  assert.equal(FUYAO_ERRORS[3002], '数据未就绪');

  const err = new FuyaoError('测试', { code: 1001, kind: 'unknown', endpoint: '/x' });
  assert.equal(err.name, 'FuyaoError');
  assert.equal(err.code, 1001);
  assert.equal(err.endpoint, '/x');
});

test('fuyaoClient: 未配置 key 时 configured=false', () => {
  const c = new FuyaoClient({ apiKey: '' });
  assert.equal(c.configured, false);
  const c2 = new FuyaoClient({ apiKey: 'k', baseUrl: 'https://example.com/' });
  assert.equal(c2.configured, true);
  assert.equal(c2.baseUrl, 'https://example.com'); // 去掉尾部斜杠
});

// ---------------------------------------------------------------
// 3. 主链路：SAMPLE 模式完整研判
// ---------------------------------------------------------------
test('主链路: SAMPLE 模式产出七维完整研判', async () => {
  const dl = new DataLayer();
  const a = await runAssessment(dl);

  assert.equal(a.meta.mode.mode, 'SAMPLE');
  assert.equal(a.dimensions.length, 7);
  assert.equal(a.synthesis.stats.dimensionsTotal, 7);

  const keys = a.dimensions.map((d) => d.key).sort();
  assert.deepEqual(keys, ['breadth', 'events', 'liquidity', 'priceStructure', 'sentiment', 'styleRotation', 'valuation']);

  // 每个维度必须有 state 与结构完整字段
  for (const d of a.dimensions) {
    assert.ok(d.state && typeof d.state.label === 'string', `${d.key} 缺少 state.label`);
    assert.ok(Array.isArray(d.facts), `${d.key} facts 应为数组`);
    assert.ok(Array.isArray(d.uncertainty), `${d.key} uncertainty 应为数组`);
    assert.ok(Array.isArray(d.switchConditions), `${d.key} switchConditions 应为数组`);
  }

  // 综合结论必备四要素
  assert.ok(a.headline.summary.length > 0, '缺少综合状态描述');
  assert.ok(a.synthesis.mainContradiction.title, '缺少主要矛盾');
  assert.ok(['高', '中', '低'].includes(a.synthesis.confidence.level), '置信度等级异常');
  assert.ok(typeof a.synthesis.confidence.score === 'number');

  // 除「事件」在无事件源时应为不可用外，其余维度在 SAMPLE 下应可用
  const avail = a.dimensions.filter((d) => d.available).map((d) => d.key);
  assert.ok(avail.includes('priceStructure'));
  assert.ok(avail.includes('breadth'));
  assert.ok(avail.includes('liquidity'));
  assert.ok(avail.includes('sentiment'));
});

test('主链路: 每条事实都带口径与来源标记（可追溯性）', async () => {
  const dl = new DataLayer();
  const a = await runAssessment(dl);
  let checked = 0;
  for (const d of a.dimensions) {
    for (const f of d.facts) {
      assert.ok(f.label, '事实缺少 label');
      assert.ok(typeof f.caliber === 'string' && f.caliber.length > 0, `事实「${f.label}」缺少 caliber（统计口径）`);
      assert.ok(typeof f.computed === 'boolean', `事实「${f.label}」未标注 原始值/计算值`);
      checked++;
    }
  }
  assert.ok(checked > 20, `事实条目数偏少：${checked}`);
});

test('主链路: 时点来自交易日历且被标注', async () => {
  const dl = new DataLayer();
  const a = await runAssessment(dl);
  assert.ok(Number.isFinite(a.meta.asOf));
  assert.equal(a.meta.asOfLabel, '20261009'); // SAMPLE 构造时点
});

// ---------------------------------------------------------------
// 4. 合规边界：不得输出预测 / 买卖建议
// ---------------------------------------------------------------
test('合规: 结论文本不含涨跌预测或买卖建议词汇', async () => {
  const dl = new DataLayer();
  const a = await runAssessment(dl);
  const text = JSON.stringify({
    headline: a.headline,
    mc: a.synthesis.mainContradiction,
    dims: a.dimensions.map((d) => ({ s: d.state, u: d.uncertainty, b: d.state.basis })),
  });
  const forbidden = ['建议买入', '建议卖出', '可以买入', '目标价', '保证收益', '必涨', '必跌', '一定上涨', '一定下跌', '稳赚', '看多至', '仓位建议', '推荐买入'];
  for (const w of forbidden) {
    assert.ok(!text.includes(w), `检测到违规词汇：「${w}」`);
  }
});

test('合规: 置信度明确声明与未来方向无关', async () => {
  const dl = new DataLayer();
  const a = await runAssessment(dl);
  const basis = a.synthesis.confidence.basis.join(' ');
  assert.ok(basis.includes('不代表对未来涨跌方向'), '置信度缺少"与未来方向无关"的声明');
  assert.ok(a.meta.compliance.disclaimer.includes('不构成任何证券投资建议'));
});

// ---------------------------------------------------------------
// 5. 数据缺失 / 接口失败：不得静默生成"正常"结论
// ---------------------------------------------------------------
test('降级: 模拟接口全失败时不产生"正常"结论，置信度降为低', async () => {
  process.env.SIMULATE_FAILURE = '1';
  try {
    const dl = new DataLayer();
    const a = await runAssessment(dl);

    // 绝大多数维度应不可用
    const availCount = a.dimensions.filter((d) => d.available).length;
    assert.ok(availCount <= 2, `应几乎全部维度不可用，实际可用 ${availCount}`);

    // 置信度必须被压到"低"
    assert.equal(a.synthesis.confidence.level, '低');

    // 主要矛盾必须显式提示"证据不足"，而不是给出看似正常的判断
    assert.ok(a.synthesis.mainContradiction.title.includes('证据不足'), '证据不足时未显式提示');

    // 必须列出降级维度及原因
    assert.ok(a.synthesis.degradedDimensions.length >= 5);
    for (const d of a.synthesis.degradedDimensions) {
      assert.ok(d.reason && d.reason.length > 0, `${d.name} 缺少降级原因`);
    }

    // 不可用维度不得出现"普涨/上行趋势/放量"等正常状态标签，只允许"无结论"类标签
    const noConclusionLabels = ['不可用', '数据不足', '未接入', '构造示例'];
    for (const d of a.dimensions) {
      if (!d.available) {
        assert.ok(
          noConclusionLabels.includes(d.state.label),
          `${d.key} 不可用却给出了疑似正常的状态标签：${d.state.label}`,
        );
      }
    }
  } finally {
    delete process.env.SIMULATE_FAILURE;
  }
});

test('恢复: 关闭故障演练后主链路恢复正常', async () => {
  delete process.env.SIMULATE_FAILURE;
  const dl = new DataLayer();
  const a = await runAssessment(dl);
  assert.ok(a.dimensions.filter((d) => d.available).length >= 5);
  assert.notEqual(a.synthesis.confidence.level, '低');
});

// ---------------------------------------------------------------
// 6. 继续研究：行业下钻 / 历史阶段
// ---------------------------------------------------------------
test('继续研究: 行业轮动下钻返回排序结果', async () => {
  const dl = new DataLayer();
  const r = await researchIndustry(dl);
  assert.equal(r.mode, 'SAMPLE');
  assert.ok(r.items.length >= 10);
  assert.ok(r.caliber.includes('涨跌幅'));
  // 按 20 日收益降序
  for (let i = 1; i < r.items.length; i++) {
    assert.ok(r.items[i - 1].r20 >= r.items[i].r20, '行业未按 20 日收益降序');
  }
});

test('继续研究: 历史阶段对比返回当时可得事实', async () => {
  const dl = new DataLayer();
  const r = await researchStage(dl, { lookbackDays: 60 });
  assert.ok(r.stage, '缺少 stage');
  assert.ok(Number.isFinite(r.stage.nowClose));
  assert.ok(Number.isFinite(r.stage.changeSince));
  assert.ok(r.note.includes('后见之明') || r.note.includes('不引入事后信息'), '缺少"避免后见之明"说明');
});

// ---------------------------------------------------------------
// 7. 边界：历史数据不足时安全降级
// ---------------------------------------------------------------
test('边界: 超出历史长度的阶段对比安全返回错误而非崩溃', async () => {
  const dl = new DataLayer();
  const r = await researchStage(dl, { lookbackDays: 250 });
  // 250 个交易日回看应无足够数据，须返回结构化错误
  assert.ok(r.stage === null || r.error, '数据不足时应返回结构化错误');
});
