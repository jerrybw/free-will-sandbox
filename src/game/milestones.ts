import type { GameState, MilestoneDef } from '../types';
import { CONFIG, TEXTS, fmt, milestoneText, fmtAmounts } from './config';
import { addResource, getUpgradeLevel } from './store';

// 进度系统：里程碑判定 → 徽章 + 一次性奖励
// 纯逻辑模块（无 DOM），文案全部来自 ui-texts.json

export interface MilestoneNotification {
  id: string;
  message: string;
}

export function isMilestoneDone(state: GameState, id: string): boolean {
  return state.milestonesDone[id] === true;
}

/** 里程碑当前进度 */
export function getMilestoneProgress(def: MilestoneDef, state: GameState): { cur: number; goal: number } {
  let cur = 0;
  switch (def.type) {
    case 'total_earned':
      cur = def.resource ? state.totalEarned[def.resource] || 0 : 0;
      break;
    case 'total_clicks':
      cur = state.totalClicks;
      break;
    case 'synth_count':
      cur = state.synthCount;
      break;
    case 'upgrade_levels':
      cur = CONFIG.upgrades.reduce((sum, u) => sum + getUpgradeLevel(state, u.id), 0);
      break;
  }
  return { cur: Math.max(0, cur), goal: def.threshold };
}

function isAchieved(def: MilestoneDef, state: GameState): boolean {
  const { cur, goal } = getMilestoneProgress(def, state);
  return cur >= goal;
}

/** 检查全部里程碑，达成的自动发奖并返回通知（幂等：已完成的跳过） */
export function checkMilestones(state: GameState): MilestoneNotification[] {
  const notes: MilestoneNotification[] = [];
  for (const def of CONFIG.milestones) {
    if (isMilestoneDone(state, def.id)) continue;
    if (!isAchieved(def, state)) continue;
    state.milestonesDone[def.id] = true;
    for (const [rid, amt] of Object.entries(def.reward)) {
      if (amt > 0) addResource(state, rid, amt);
    }
    const t = milestoneText(def.id);
    notes.push({
      id: def.id,
      message: fmt(TEXTS.log.milestone, { name: t.name, reward: fmtAmounts(def.reward) })
    });
  }
  return notes;
}

/** 下一目标（按配置顺序第一个未完成的） */
export function nextMilestone(state: GameState): MilestoneDef | null {
  return CONFIG.milestones.find((m) => !isMilestoneDone(state, m.id)) ?? null;
}
