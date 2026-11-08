// 官方模型峰谷策略单测（off|auto、UTC 周一–五峰段、边界/非法配置回退）。
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_PEAK_HOURS_UTC,
  PEAK_POLICY_VALUES,
  isPeakTime,
  parsePeakHours,
  resolveOfficialModel,
} from '../../server/model-policy.mjs';

// 2026-03-02 是周一（UTC）；2026-03-07 周六、2026-03-08 周日。
const MONDAY = '2026-03-02';
const SATURDAY = '2026-03-07';
const SUNDAY = '2026-03-08';

function utc(iso) {
  return new Date(iso);
}

function autoConfig(overrides = {}) {
  return {
    model: 'deepseek-v4-pro',
    peakModelPolicy: 'auto',
    peakModel: 'deepseek-v4-flash',
    peakHoursUtc: DEFAULT_PEAK_HOURS_UTC,
    ...overrides,
  };
}

test('默认/未知 policy → off，始终用 config.model 且 policy 返回 off', () => {
  assert.deepEqual(resolveOfficialModel({ config: { model: 'deepseek-v4-pro' }, now: utc(`${MONDAY}T02:30:00Z`) }), {
    model: 'deepseek-v4-pro',
    peak: false,
    policy: 'off',
  });
  for (const peakModelPolicy of ['off', 'AUTO', 'peak', '', 'unknown']) {
    const result = resolveOfficialModel({
      config: autoConfig({ peakModelPolicy }),
      now: utc(`${MONDAY}T02:30:00Z`),
    });
    assert.equal(result.model, 'deepseek-v4-pro', `${JSON.stringify(peakModelPolicy)} 应走基础模型`);
    assert.equal(result.peak, false);
    assert.equal(result.policy, 'off');
  }
  assert.deepEqual([...PEAK_POLICY_VALUES], ['off', 'auto']);
});

test('auto：UTC 周一–五峰段用 peakModel，谷段/周末用 model（peak 标记正确）', () => {
  const config = autoConfig();

  // 两个默认峰段内部。
  for (const time of ['01:00', '02:30', '03:59', '06:00', '09:59']) {
    const result = resolveOfficialModel({ config, now: utc(`${MONDAY}T${time}:00Z`) });
    assert.equal(result.model, 'deepseek-v4-flash', `${time} 应走峰段模型`);
    assert.equal(result.peak, true);
    assert.equal(result.policy, 'auto');
  }
  // 峰段边界：结束时刻（04:00/10:00）与峰段之间（04:30/05:30/10:00+）走基础模型。
  for (const time of ['00:30', '04:00', '04:30', '05:30', '10:00', '12:00', '23:59']) {
    const result = resolveOfficialModel({ config, now: utc(`${MONDAY}T${time}:00Z`) });
    assert.equal(result.model, 'deepseek-v4-pro', `${time} 应走基础模型`);
    assert.equal(result.peak, false);
    assert.equal(result.policy, 'auto');
  }
  // 周五 09:59 仍是峰段；周六/周日全天谷价（不含法定节假日调休，按工作日保守判定）。
  assert.equal(resolveOfficialModel({ config, now: utc(`2026-03-06T09:59:00Z`) }).peak, true);
  for (const day of [SATURDAY, SUNDAY]) {
    for (const time of ['02:30', '07:30']) {
      const result = resolveOfficialModel({ config, now: utc(`${day}T${time}:00Z`) });
      assert.equal(result.model, 'deepseek-v4-pro', `${day} ${time} 周末应走基础模型`);
      assert.equal(result.peak, false);
      assert.equal(result.policy, 'auto');
    }
  }
});

test('auto：自定义峰段（单区间）与 UTC 语义', () => {
  const config = autoConfig({ peakHoursUtc: '12:00-13:00' });
  assert.equal(resolveOfficialModel({ config, now: utc(`${MONDAY}T12:00:00Z`) }).peak, true);
  assert.equal(resolveOfficialModel({ config, now: utc(`${MONDAY}T12:59:00Z`) }).peak, true);
  assert.equal(resolveOfficialModel({ config, now: utc(`${MONDAY}T13:00:00Z`) }).peak, false);
  assert.equal(resolveOfficialModel({ config, now: utc(`${MONDAY}T11:59:00Z`) }).peak, false);
});

test('auto：非法/跨零点/空峰段配置 → 保守回退 off（不切模型）', () => {
  for (const peakHoursUtc of ['23:00-01:00', '01:00-01:00', 'garbage', '01:00-04:00,', '1:0-2:0', '25:00-26:00']) {
    const result = resolveOfficialModel({
      config: autoConfig({ peakHoursUtc }),
      now: utc(`${MONDAY}T02:30:00Z`),
    });
    assert.equal(result.model, 'deepseek-v4-pro', `非法峰段 ${JSON.stringify(peakHoursUtc)} 应回退基础模型`);
    assert.equal(result.peak, false);
    assert.equal(result.policy, 'off');
  }
});

test('auto：未配置 peakModel / 非法 now / 缺 config.model → 回退基础模型', () => {
  assert.deepEqual(
    resolveOfficialModel({ config: autoConfig({ peakModel: '' }), now: utc(`${MONDAY}T02:30:00Z`) }),
    { model: 'deepseek-v4-pro', peak: false, policy: 'off' },
  );
  // 缺 model：谷段返回空模型并保持 policy='auto'（峰段未触发）。
  assert.deepEqual(resolveOfficialModel({ config: autoConfig({ model: undefined }), now: utc(`${MONDAY}T05:00:00Z`) }), {
    model: '',
    peak: false,
    policy: 'auto',
  });
  for (const now of [new Date('invalid'), 'not-a-date']) {
    const result = resolveOfficialModel({ config: autoConfig(), now });
    assert.equal(result.model, 'deepseek-v4-pro');
    assert.equal(result.peak, false);
    assert.equal(result.policy, 'off');
  }
  // null → new Date(null)=epoch（周四谷段）：不崩溃，回退基础模型。
  const nullNow = resolveOfficialModel({ config: autoConfig(), now: null });
  assert.equal(nullNow.model, 'deepseek-v4-pro');
  assert.equal(nullNow.peak, false);
  // 时间戳/ISO 字符串也接受。
  assert.equal(resolveOfficialModel({ config: autoConfig(), now: Date.parse(`${MONDAY}T02:30:00Z`) }).peak, true);
  assert.equal(resolveOfficialModel({ config: autoConfig(), now: `${MONDAY}T02:30:00Z` }).peak, true);
});

test('auto：peakHoursUtc 为空 → 使用默认峰段（不是 off）', () => {
  const result = resolveOfficialModel({
    config: autoConfig({ peakHoursUtc: '' }),
    now: utc(`${MONDAY}T02:30:00Z`),
  });
  assert.deepEqual(result, { model: 'deepseek-v4-flash', peak: true, policy: 'auto' });
});

test('auto：effort 不影响峰谷选择；peakModel/model 会 trim', () => {
  const config = autoConfig({ model: ' deepseek-v4-pro ', peakModel: ' deepseek-v4-flash ' });
  for (const effort of [null, 'low', 'medium', 'high', undefined]) {
    const peak = resolveOfficialModel({ config, effort, now: utc(`${MONDAY}T02:30:00Z`) });
    assert.equal(peak.model, 'deepseek-v4-flash');
    assert.equal(peak.peak, true);
    const valley = resolveOfficialModel({ config, effort, now: utc(`${MONDAY}T05:00:00Z`) });
    assert.equal(valley.model, 'deepseek-v4-pro');
    assert.equal(valley.peak, false);
  }
});

test('parsePeakHours：合法 CSV → 分钟区间；非法输入 → null', () => {
  assert.deepEqual(parsePeakHours('01:00-04:00,06:00-10:00'), [
    { start: 60, end: 240 },
    { start: 360, end: 600 },
  ]);
  assert.deepEqual(parsePeakHours('1:00-2:30'), [{ start: 60, end: 150 }]);
  assert.deepEqual(parsePeakHours('00:00-24:00'), null, '24:00 不是合法小时');
  for (const spec of [null, undefined, 42, '', ' ', '01:00', '01:00-', '-02:00', '01:00-02:00-03:00', 'aa-bb']) {
    assert.equal(parsePeakHours(spec), null, `${JSON.stringify(spec)} 应非法`);
  }
});

test('isPeakTime：非法日期/空区间/周末 → false', () => {
  const ranges = parsePeakHours(DEFAULT_PEAK_HOURS_UTC);
  assert.equal(isPeakTime(utc(`${MONDAY}T02:30:00Z`), ranges), true);
  assert.equal(isPeakTime(utc(`${SATURDAY}T02:30:00Z`), ranges), false);
  assert.equal(isPeakTime(new Date('invalid'), ranges), false);
  assert.equal(isPeakTime(utc(`${MONDAY}T02:30:00Z`), null), false);
  assert.equal(isPeakTime(utc(`${MONDAY}T02:30:00Z`), []), false);
  assert.equal(isPeakTime(utc(`${MONDAY}T01:00:00Z`), ranges), true, '起点含');
  assert.equal(isPeakTime(utc(`${MONDAY}T04:00:00Z`), ranges), false, '终点不含');
});
