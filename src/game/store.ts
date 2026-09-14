import type { GameState, UpgradeDef } from '../types';
import { CONFIG, CONFIG_VERSION } from './config';

const SAVE_KEY = 'fws_save_v1';

export function createInitialState(): GameState {
  const resources: Record<string, number> = {};
  for (const r of CONFIG.resources) {
    resources[r.id] = r.start;
  }
  const earned: Record<string, number> = {};
  for (const r of CONFIG.resources) {
    earned[r.id] = 0;
  }
  const upgradeLevels: Record<string, number> = {};
  for (const u of CONFIG.upgrades) {
    upgradeLevels[u.id] = 0;
  }
  return {
    resources,
    upgradeLevels,
    totalClicks: 0,
    totalEarned: earned,
    lastSave: Date.now(),
    log: ['欢迎来到超高自由度游戏！']
  };
}

export function computeActionGives(actionId: string, state: GameState): Record<string, number> {
  const action = CONFIG.actions.find((a) => a.id === actionId);
  if (!action) return {};
  const base = { ...action.gives };
  // 叠加作用于该 action 的 upgrade
  for (const u of CONFIG.upgrades) {
    if (u.effect.action !== actionId || u.effect.add === undefined) continue;
    const lvl = state.upgradeLevels[u.id] || 0;
    if (lvl > 0) {
      for (const k of Object.keys(base)) {
        base[k] += u.effect.add * lvl;
      }
    }
  }
  return base;
}

export function computePassivePerTick(resourceId: string, state: GameState): number {
  let total = 0;
  for (const u of CONFIG.upgrades) {
    if (u.effect.passive !== resourceId || u.effect.addPerTick === undefined) continue;
    const lvl = state.upgradeLevels[u.id] || 0;
    total += u.effect.addPerTick * lvl;
  }
  return total;
}

function computeUpgradeCost(u: UpgradeDef, level: number): Record<string, number> {
  const cost: Record<string, number> = {};
  const scale = 1 + level * 0.6;
  for (const [rid, base] of Object.entries(u.cost)) {
    cost[rid] = Math.ceil(base * scale);
  }
  return cost;
}

export const upgradeApi = {
  getLevel(state: GameState, uid: string): number {
    return state.upgradeLevels[uid] || 0;
  },
  getCost(u: UpgradeDef, level: number): Record<string, number> {
    return computeUpgradeCost(u, level);
  },
  isAffordable(state: GameState, cost: Record<string, number>): boolean {
    for (const [rid, amount] of Object.entries(cost)) {
      if ((state.resources[rid] || 0) < amount) return false;
    }
    return true;
  }
};

export function saveGame(state: GameState) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ v: CONFIG_VERSION, ts: Date.now(), state }));
  } catch (e) {
    console.warn('存档失败', e);
  }
}

export function loadGame(): GameState | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !data.state || data.v !== CONFIG_VERSION) {
      // 版本不匹配则丢弃，避免脏数据
      localStorage.removeItem(SAVE_KEY);
      return null;
    }
    return data.state as GameState;
  } catch (e) {
    console.warn('读档失败', e);
    return null;
  }
}