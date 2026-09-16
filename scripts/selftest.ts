// 逻辑自测：合成消耗扣除 / 事件倍率 / 里程碑判定 / 升级费用成长 / 存档迁移
// 通过 esbuild 打包后用 node 执行；直接 import 真实游戏模块（非复制逻辑）
import { CONFIG, TEXTS, fmt, resName, fmtAmounts, milestoneText } from '../src/game/config';
import {
  createInitialState,
  performClick,
  tryConvert,
  computeActionCost,
  computeClickGives,
  upgradeCost,
  addResource,
  getResourceCap,
  autoConvertPerTick,
  getClickMultiplier,
  saveGame,
  loadGame,
  migrateState
} from '../src/game/store';
import { applyEventStart, tickEvents, maybeTriggerEvents } from '../src/game/events';
import { checkMilestones, getMilestoneProgress, nextMilestone } from '../src/game/milestones';

// ---- localStorage stub（node 环境无 DOM）----
const lsMap = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => lsMap.get(k) ?? null,
  setItem: (k: string, v: string) => void lsMap.set(k, v),
  removeItem: (k: string) => void lsMap.delete(k)
};

let pass = 0;
let fail = 0;
const failures: string[] = [];

function eq(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
  } else {
    fail++;
    failures.push(`${name}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

function ok(name: string, cond: boolean): void {
  if (cond) pass++;
  else {
    fail++;
    failures.push(`${name}: 条件为假`);
  }
}

// ===== 1. 文案外置验证（主题无关：验证机制而非具体词） =====
ok('文案:页面标题外置', TEXTS.page.title.length > 0);
ok('文案:资源名外置(非 id 回退)', resName('essence') !== 'essence');
ok('文案:占位符联动', fmt(TEXTS.upgrades.charged_pick.desc).includes(resName('essence')));
ok('文案:动作名联动', fmt(TEXTS.log.synthOk, { gain: fmtAmounts({ composite: 1 }) }).includes(resName('composite')));

// ===== 2. 点击与事件倍率 =====
{
  const s = createInitialState();
  performClick(s, 'gather');
  eq('点击采集源质 +2', s.resources.essence, 2);
  eq('点击计数', s.totalClicks, 1);
  eq('累计产出', s.totalEarned.essence, 2);

  const meteor = CONFIG.events.find((e) => e.id === 'meteor_shower')!;
  applyEventStart(s, meteor);
  eq('事件激活', s.events.active.length, 1);
  eq('倍率读取', getClickMultiplierSafe2(s), 2);
  eq('事件期间点击产出 ×2', computeClickGives(s, 'gather').essence, 4);
  performClick(s, 'gather');
  eq('倍率生效后资源', s.resources.essence, 6);

  const before = s.events.active[0].remainingTicks;
  tickEvents(s);
  eq('事件倒计时递减', s.events.active[0].remainingTicks, before - 1);
}

// ===== 3. 一次性事件：能量潮汐 / 共振 =====
{
  const s = createInitialState();
  const tide = CONFIG.events.find((e) => e.id === 'energy_tide')!;
  applyEventStart(s, tide);
  eq('能量潮汐 +20 源质', s.resources.essence, 20);
  eq('一次性事件不留活动状态', s.events.active.length, 0);

  const res = CONFIG.events.find((e) => e.id === 'resonance')!;
  applyEventStart(s, res);
  eq('共振免晶核 3 次', s.events.freeSynth.core, 3);

  s.resources.essence = 100;
  s.resources.core = 10;
  const cost = computeActionCost(s, 'synthesize');
  ok('免晶核时费用不含 core', !('core' in cost));
  eq('免晶核时源质费用不变', cost.essence, 10);
  const r = tryConvert(s, 'synthesize');
  eq('免晶核合成成功', r.ok, true);
  eq('core 未被扣除', s.resources.core, 10);
  eq('essence 扣除 10', s.resources.essence, 90);
  eq('免消耗次数 3→2', s.events.freeSynth.core, 2);
  ok('usedFree 记录', (r.usedFree ?? []).includes('core'));
}

// ===== 4. 合成消耗扣除 =====
{
  const s = createInitialState();
  s.resources.essence = 50;
  s.resources.core = 10;
  const r = tryConvert(s, 'synthesize');
  eq('合成成功', r.ok, true);
  eq('源质 50→40', s.resources.essence, 40);
  eq('晶核 10→8', s.resources.core, 8);
  eq('聚合体 +1', s.resources.composite, 1);
  eq('合成计数', s.synthCount, 1);

  // 资源不足
  const s2 = createInitialState();
  s2.resources.essence = 5;
  const r2 = tryConvert(s2, 'synthesize');
  eq('资源不足失败', r2.ok, false);
  eq('失败原因', r2.reason, 'insufficient');
}

// ===== 5. 合成优化折扣 =====
{
  const s = createInitialState();
  s.upgradeLevels.synth_optimizer = 1;
  const cost1 = computeActionCost(s, 'synthesize');
  eq('优化 Lv1 源质 10→9', cost1.essence, 9);
  eq('优化 Lv1 晶核 2→2(向上取整)', cost1.core, 2);

  s.upgradeLevels.synth_optimizer = 5;
  const cost5 = computeActionCost(s, 'synthesize');
  eq('优化 Lv5(50%上限) 源质 10→5', cost5.essence, 5);
  eq('优化 Lv5 晶核 2→1', cost5.core, 1);
}

// ===== 6. 升级费用成长 ×1.6 =====
{
  const u = CONFIG.upgrades.find((x) => x.id === 'charged_pick')!;
  eq('Lv0 费用 = 基础', upgradeCost(u, 0).essence, 20);
  eq('Lv1 费用 = ×1.6', upgradeCost(u, 1).essence, 32);
  eq('Lv2 费用 = ×2.56 向上取整', upgradeCost(u, 2).essence, 52);
  eq('Lv3 费用 = ×4.096 向上取整', upgradeCost(u, 3).essence, 82);
}

// ===== 7. 里程碑判定与奖励 =====
{
  const s = createInitialState();
  s.totalEarned.essence = 99;
  let notes = checkMilestones(s);
  eq('99 未达标无里程碑', notes.length, 0);

  s.totalEarned.essence = 100;
  notes = checkMilestones(s);
  eq('100 达成 m_essence_100', s.milestonesDone.m_essence_100, true);
  eq('奖励 30 源质入账', s.resources.essence, 30);
  ok('通知文案含里程碑名', notes.length === 1 && notes[0].message.includes(milestoneText('m_essence_100').name));
  ok('通知文案含奖励', notes[0].message.includes('30'));

  // 幂等
  const again = checkMilestones(s);
  eq('重复检查不重复发奖', again.length, 0);

  // 首次合成里程碑
  const s2 = createInitialState();
  s2.resources.essence = 10;
  s2.resources.core = 2;
  tryConvert(s2, 'synthesize');
  checkMilestones(s2);
  eq('首次合成里程碑达成', s2.milestonesDone.m_first_synth, true);
  eq('首次合成奖励 50 源质', s2.resources.essence, 10 - 10 + 50);

  // 升级等级里程碑
  const s3 = createInitialState();
  s3.upgradeLevels.charged_pick = 3;
  s3.upgradeLevels.core_cutter = 2;
  checkMilestones(s3);
  eq('升级总等级 5 → m_upgrades_5', s3.milestonesDone.m_upgrades_5, true);

  // 进度查询（奖励 30 源质入账后 totalEarned = 100 + 30 = 130）
  const msDef = CONFIG.milestones.find((m) => m.id === 'm_essence_500')!;
  const prog = getMilestoneProgress(msDef, s);
  eq('进度查询 cur(含奖励入账)', prog.cur, 130);
  eq('进度查询 goal', prog.goal, 500);
  ok('下一目标定位(按配置顺序第一个未完成)', nextMilestone(s)?.id === 'm_first_synth');
}

// ===== 8. 仓储上限 =====
{
  const s = createInitialState();
  addResource(s, 'essence', 99999);
  eq('基础上限 1000', s.resources.essence, 1000);
  eq('上限读取', getResourceCap(s, 'essence'), 1000);
  eq('累计产出记理论值(不受上限截断)', s.totalEarned.essence, 99999);

  s.upgradeLevels.storage_expansion = 2;
  eq('扩容 2 级上限 2000', getResourceCap(s, 'essence'), 2000);
  addResource(s, 'core', 99999);
  eq('扩容作用于全部资源', getResourceCap(s, 'core'), 1500);
}

// ===== 9. 自动合成器 =====
{
  const s = createInitialState();
  eq('无升级不自动合成', autoConvertPerTick(s, 'synthesize'), 0);
  s.upgradeLevels.auto_synthesizer = 2;
  eq('2 级每 tick 尝试 2 次', autoConvertPerTick(s, 'synthesize'), 2);
  s.resources.essence = 25;
  s.resources.core = 5;
  let executed = 0;
  let attempts = autoConvertPerTick(s, 'synthesize');
  while (attempts-- > 0) {
    const r = tryConvert(s, 'synthesize');
    if (!r.ok) break;
    executed++;
  }
  eq('自动合成执行 2 次', executed, 2);
  eq('自动合成后资源 25-20=5', s.resources.essence, 5);
}

// ===== 10. 存档 v2 往返 =====
{
  const s = createInitialState();
  s.resources.essence = 123;
  s.upgradeLevels.charged_pick = 3;
  s.synthCount = 7;
  s.milestonesDone.m_essence_100 = true;
  s.events.freeSynth.core = 2;
  const meteor = CONFIG.events.find((e) => e.id === 'meteor_shower')!;
  applyEventStart(s, meteor);
  saveGame(s);
  const loaded = loadGame();
  ok('v2 读档成功', loaded !== null && !loaded.migratedFromLegacy);
  eq('往返:资源', loaded!.state.resources.essence, 123);
  eq('往返:升级', loaded!.state.upgradeLevels.charged_pick, 3);
  eq('往返:合成次数', loaded!.state.synthCount, 7);
  eq('往返:里程碑', loaded!.state.milestonesDone.m_essence_100, true);
  eq('往返:免晶核次数', loaded!.state.events.freeSynth.core, 2);
  eq('往返:活动事件', loaded!.state.events.active.length, 1);
}

// ===== 11. v1 旧档安全迁移 =====
{
  const legacy = {
    resources: { crystal: 55, wood: 7 },
    upgradeLevels: { pickaxe: 4, axe: 2 },
    totalClicks: 42,
    totalEarned: { crystal: 500, wood: 100 },
    lastSave: 1700000000000,
    log: ['旧日志']
  };
  const migrated = migrateState(legacy);
  eq('迁移:totalClicks 保留', migrated.totalClicks, 42);
  eq('迁移:lastSave 保留', migrated.lastSave, 1700000000000);
  eq('迁移:旧资源键不映射(crystal 丢弃)', migrated.resources.essence, 0);
  eq('迁移:新字段缺省 synthCount=0', migrated.synthCount, 0);
  ok('迁移:事件状态补齐', Array.isArray(migrated.events.active));
  ok('迁移:里程碑字段补齐', typeof migrated.milestonesDone === 'object');

  // v2 档缺字段防御（如未来再加字段）
  const partial = migrateState({ resources: { essence: 9 }, totalClicks: 'not-a-number' });
  eq('防御:非法字段回退缺省', partial.totalClicks, 0);
  eq('防御:合法字段保留', partial.resources.essence, 9);

  // 彻底垃圾输入
  const junk = migrateState('garbage');
  eq('防御:垃圾输入返回初始值', junk.resources.essence, 0);
}

// ===== 12. 事件随机触发（统计性验证） =====
{
  const s = createInitialState();
  let triggered = 0;
  for (let i = 0; i < 100000; i++) {
    const notes = maybeTriggerEvents(s, Math.random);
    triggered += notes.length;
  }
  // 期望 ~ 100000 * (0.0012+0.001+0.0008) = 300，放宽到 [100, 600]
  ok(`事件概率统计合理(触发 ${triggered} 次,期望~300)`, triggered > 100 && triggered < 600);
}

console.log('\n===== 自测结果 =====');
console.log(`通过: ${pass}  失败: ${fail}`);
if (fail > 0) {
  console.log('\n失败详情:');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
} else {
  console.log('全部通过 ✓');
}

// 辅助引用（避免 tree-shake 误判未使用）
function getClickMultiplierSafe2(s: ReturnType<typeof createInitialState>): number {
  return getClickMultiplier(s);
}