import type { GameState, UpgradeDef } from '../types';
import { CONFIG, CONFIG_VERSION } from './config';

// ---------- 初始状态 ----------
export function createInitialState(): GameState {
  const resources: Record<string, number> = {};
  const earned: Record<string, number> = {};
  for (const r of CONFIG.resources) {
    resources[r.id] = r.start;
    earned[r.id] = 0;
  }
  const upgradeLevels: Record<string, number> = {};
  for (const u of CONFIG.upgrades) {
    upgradeLevels[u.id] = 0;
  }
  const freeSynth: Record<string, number> = {};
  for (const e of CONFIG.events) {
    if (e.effect.type === 'free_cost_n' && e.effect.resource) freeSynth[e.effect.resource] = 0;
  }
  return {
    resources,
    upgradeLevels,
    totalClicks: 0,
    totalEarned: earned,
    synthCount: 0,
    milestonesDone: {},
    events: { active: [], freeSynth },
    lastSave: Date.now()
  };
}

// ---------- 资源与上限 ----------
export function getResourceCap(state: GameState, rid: string): number {
  let cap = CONFIG.resources.find((r) => r.id === rid)?.capBase ?? 0;
  for (const u of CONFIG.upgrades) {
    if (u.effect.type === 'cap_add' && u.effect.add) {
      cap += u.effect.add * (state.upgradeLevels[u.id] || 0);
    }
  }
  return cap;
}

/** 增加资源（受上限约束），累计产出 totalEarned 记录理论产出量（不受上限截断） */
export function addResource(state: GameState, rid: string, amount: number): number {
  if (!(amount > 0)) return 0;
  const cap = getResourceCap(state, rid);
  const cur = state.resources[rid] || 0;
  const next = cap > 0 ? Math.min(cur + amount, cap) : cur + amount;
  state.resources[rid] = next;
  state.totalEarned[rid] = (state.totalEarned[rid] || 0) + amount;
  return next - cur;
}

// ---------- 升级 ----------
export function getUpgradeLevel(state: GameState, uid: string): number {
  return state.upgradeLevels[uid] || 0;
}

/** 升级费用：基础费用 × costGrowth^当前等级（每级取整向上） */
export function upgradeCost(u: UpgradeDef, level: number): Record<string, number> {
  const out: Record<string, number> = {};
  const scale = Math.pow(CONFIG.meta.costGrowth, level);
  for (const [rid, base] of Object.entries(u.cost)) {
    out[rid] = Math.ceil(base * scale);
  }
  return out;
}

export function isAffordable(state: GameState, cost: Record<string, number>): boolean {
  for (const [rid, amount] of Object.entries(cost)) {
    if ((state.resources[rid] || 0) < amount) return false;
  }
  return true;
}

/** 转换动作消耗折扣（0~maxDiscount） */
export function convertDiscount(state: GameState, actionId: string): number {
  let disc = 0;
  let maxDisc = 0;
  for (const u of CONFIG.upgrades) {
    if (u.effect.type !== 'convert_discount' || u.effect.action !== actionId) continue;
    disc += (u.effect.discountPerLevel ?? 0) * getUpgradeLevel(state, u.id);
    maxDisc = Math.max(maxDisc, u.effect.maxDiscount ?? 0);
  }
  return Math.min(disc, maxDisc);
}

/** 转换动作产出（含 convert_output 升级加成；不受点击倍率影响） */
export function computeConvertGives(state: GameState, actionId: string): Record<string, number> {
  const a = CONFIG.actions.find((x) => x.id === actionId);
  if (!a) return {};
  const base = { ...a.gives };
  for (const u of CONFIG.upgrades) {
    if (u.effect.type === 'convert_output' && u.effect.action === actionId && u.effect.add) {
      const lvl = getUpgradeLevel(state, u.id);
      for (const k of Object.keys(base)) base[k] += u.effect.add * lvl;
    }
  }
  return base;
}

/** 点击动作产出（含 action_add 升级与事件倍率） */
export function computeClickGives(state: GameState, actionId: string): Record<string, number> {
  const a = CONFIG.actions.find((x) => x.id === actionId);
  if (!a || a.kind !== 'click') return {};
  const base = { ...a.gives };
  for (const u of CONFIG.upgrades) {
    if (u.effect.type === 'action_add' && u.effect.action === actionId && u.effect.add) {
      const lvl = getUpgradeLevel(state, u.id);
      for (const k of Object.keys(base)) base[k] += u.effect.add * lvl;
    }
  }
  const m = getClickMultiplier(state);
  if (m !== 1) {
    for (const k of Object.keys(base)) base[k] = base[k] * m;
  }
  return base;
}

/** 事件点击倍率：所有进行中 multiplier_click 效果的乘积 */
export function getClickMultiplier(state: GameState): number {
  let m = 1;
  for (const a of state.events.active) {
    const def = CONFIG.events.find((e) => e.id === a.id);
    if (def?.effect.type === 'multiplier_click') m *= def.effect.multiplier ?? 1;
  }
  return m;
}

/** 被动产出：指定资源每 tick 总量 */
export function computePassivePerTick(state: GameState, resourceId: string): number {
  let total = 0;
  for (const u of CONFIG.upgrades) {
    if (u.effect.type !== 'passive' || u.effect.resource !== resourceId) continue;
    total += (u.effect.addPerTick ?? 0) * getUpgradeLevel(state, u.id);
  }
  return total;
}

/** 自动转换：每 tick 尝试次数（每级 +1 次） */
export function autoConvertPerTick(state: GameState, actionId: string): number {
  let n = 0;
  for (const u of CONFIG.upgrades) {
    if (u.effect.type !== 'auto_convert' || u.effect.action !== actionId) continue;
    n += getUpgradeLevel(state, u.id);
  }
  return n;
}

// ---------- 转换消耗（含折扣与免消耗） ----------
/** 当前转换动作的实际消耗；被免消耗的资源不出现在结果里 */
export function computeActionCost(state: GameState, actionId: string): Record<string, number> {
  const a = CONFIG.actions.find((x) => x.id === actionId);
  if (!a?.consumes) return {};
  const disc = convertDiscount(state, actionId);
  const cost: Record<string, number> = {};
  for (const [rid, amt] of Object.entries(a.consumes)) {
    if ((state.events.freeSynth[rid] || 0) > 0) continue; // 免消耗资源
    cost[rid] = Math.max(1, Math.ceil(amt * (1 - disc)));
  }
  return cost;
}

function consumeFreeSynth(state: GameState, rid: string): void {
  const left = state.events.freeSynth[rid] || 0;
  if (left > 0) state.events.freeSynth[rid] = left - 1;
}

// ---------- 动作执行 ----------
export interface ActionResult {
  ok: boolean;
  reason?: 'not_click' | 'not_convert' | 'insufficient';
  gives?: Record<string, number>;
  cost?: Record<string, number>;
  usedFree?: string[];
}

export function performClick(state: GameState, actionId: string): ActionResult {
  const a = CONFIG.actions.find((x) => x.id === actionId);
  if (!a || a.kind !== 'click') return { ok: false, reason: 'not_click' };
  const gives = computeClickGives(state, actionId);
  state.totalClicks += 1;
  const applied: Record<string, number> = {};
  for (const [rid, amt] of Object.entries(gives)) {
    if (amt <= 0) continue;
    addResource(state, rid, amt);
    applied[rid] = amt;
  }
  return { ok: true, gives: applied };
}

export function tryConvert(state: GameState, actionId: string): ActionResult {
  const a = CONFIG.actions.find((x) => x.id === actionId);
  if (!a || a.kind !== 'convert') return { ok: false, reason: 'not_convert' };
  const cost = computeActionCost(state, actionId);
  if (!isAffordable(state, cost)) {
    return { ok: false, reason: 'insufficient', cost };
  }
  // 扣除免消耗次数（被免资源不在 cost 中）
  const usedFree: string[] = [];
  for (const rid of Object.keys(a.consumes ?? {})) {
    if (!(rid in cost)) {
      consumeFreeSynth(state, rid);
      usedFree.push(rid);
    }
  }
  for (const [rid, amt] of Object.entries(cost)) {
    state.resources[rid] = (state.resources[rid] || 0) - amt;
  }
  const gives = computeConvertGives(state, actionId);
  const applied: Record<string, number> = {};
  for (const [rid, amt] of Object.entries(gives)) {
    if (amt <= 0) continue;
    addResource(state, rid, amt);
    applied[rid] = amt;
  }
  state.synthCount += 1;
  return { ok: true, gives: applied, cost, usedFree };
}

// ---------- 存档（v2 + v1 安全迁移） ----------
export interface LoadResult {
  state: GameState;
  migratedFromLegacy: boolean;
}

export function saveGame(state: GameState): void {
  try {
    localStorage.setItem(
      CONFIG.meta.saveKey,
      JSON.stringify({ v: CONFIG_VERSION, ts: Date.now(), state })
    );
  } catch (e) {
    console.warn('存档失败', e);
  }
}

/** 任意来源的旧状态安全合并到当前配置的初始值上（缺省补齐、脏数据丢弃） */
export function migrateState(raw: unknown): GameState {
  const out = createInitialState();
  if (!raw || typeof raw !== 'object') return out;
  const src = raw as Record<string, unknown>;

  if (src.resources && typeof src.resources === 'object') {
    const rs = src.resources as Record<string, unknown>;
    for (const r of CONFIG.resources) {
      const v = Number(rs[r.id]);
      if (Number.isFinite(v) && v >= 0) out.resources[r.id] = v;
    }
  }
  if (src.upgradeLevels && typeof src.upgradeLevels === 'object') {
    const us = src.upgradeLevels as Record<string, unknown>;
    for (const u of CONFIG.upgrades) {
      const v = Number(us[u.id]);
      if (Number.isFinite(v)) out.upgradeLevels[u.id] = Math.max(0, Math.min(u.maxLevel, Math.floor(v)));
    }
  }
  const clicks = Number(src.totalClicks);
  if (Number.isFinite(clicks) && clicks >= 0) out.totalClicks = Math.floor(clicks);
  const synth = Number(src.synthCount);
  if (Number.isFinite(synth) && synth >= 0) out.synthCount = Math.floor(synth);

  if (src.totalEarned && typeof src.totalEarned === 'object') {
    const te = src.totalEarned as Record<string, unknown>;
    for (const r of CONFIG.resources) {
      const v = Number(te[r.id]);
      if (Number.isFinite(v) && v >= 0) out.totalEarned[r.id] = v;
    }
  }
  if (src.milestonesDone && typeof src.milestonesDone === 'object') {
    const md = src.milestonesDone as Record<string, unknown>;
    for (const m of CONFIG.milestones) {
      if (md[m.id] === true) out.milestonesDone[m.id] = true;
    }
  }
  if (src.events && typeof src.events === 'object') {
    const ev = src.events as Record<string, unknown>;
    if (Array.isArray(ev.active)) {
      out.events.active = ev.active
        .map((a) => a as Record<string, unknown>)
        .filter((a) => typeof a.id === 'string' && Number.isFinite(Number(a.remainingTicks)))
        .map((a) => ({ id: a.id as string, remainingTicks: Math.max(0, Math.floor(Number(a.remainingTicks))) }))
        .filter((a) => a.remainingTicks > 0 && CONFIG.events.some((e) => e.id === a.id));
    }
    if (ev.freeSynth && typeof ev.freeSynth === 'object') {
      const fs = ev.freeSynth as Record<string, unknown>;
      for (const e of CONFIG.events) {
        if (e.effect.type === 'free_cost_n' && e.effect.resource) {
          const v = Number(fs[e.effect.resource]);
          if (Number.isFinite(v) && v > 0) out.events.freeSynth[e.effect.resource] = Math.floor(v);
        }
      }
    }
  }
  const lastSave = Number(src.lastSave);
  if (Number.isFinite(lastSave) && lastSave > 0) out.lastSave = lastSave;
  return out;
}

export function loadGame(): LoadResult | null {
  try {
    const raw = localStorage.getItem(CONFIG.meta.saveKey);
    if (raw) {
      const data = JSON.parse(raw);
      if (data && data.state) {
        return { state: migrateState(data.state), migratedFromLegacy: false };
      }
      localStorage.removeItem(CONFIG.meta.saveKey);
    }
    // 旧版 v1 存档迁移
    const legacyRaw = localStorage.getItem(CONFIG.meta.legacySaveKey);
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw);
      if (legacy && legacy.state) {
        return { state: migrateState(legacy.state), migratedFromLegacy: true };
      }
    }
    return null;
  } catch (e) {
    console.warn('读档失败', e);
    return null;
  }
}
