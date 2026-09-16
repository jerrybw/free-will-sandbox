import type { GameConfig, UITexts } from '../types';
import configRaw from '../config/game-config.json';
import textsRaw from '../config/ui-texts.json';

// 单一信息源：数值与文案全部数据驱动，换主题只改 JSON
export const CONFIG: GameConfig = configRaw as unknown as GameConfig;
export const TEXTS: UITexts = textsRaw as unknown as UITexts;

export const CONFIG_VERSION = CONFIG.meta.version;

// ---------- 文案访问 helper（缺失时回退到 id，保证换配置不崩溃） ----------
export function resName(id: string): string {
  return TEXTS.resources[id]?.name ?? id;
}

export function actionText(id: string): ActionTextSafe {
  const t = TEXTS.actions[id];
  return { name: t?.name ?? id, icon: t?.icon ?? '❔', desc: t?.desc ?? '' };
}

export interface ActionTextSafe { name: string; icon: string; desc: string }

export function upgradeText(id: string): UpgradeTextSafe {
  const t = TEXTS.upgrades[id];
  return { name: t?.name ?? id, desc: t?.desc ?? '' };
}

export interface UpgradeTextSafe { name: string; desc: string }

export function eventText(id: string) {
  return TEXTS.events[id];
}

export function milestoneText(id: string): MilestoneTextSafe {
  const t = TEXTS.milestones[id];
  return { name: t?.name ?? id, desc: t?.desc ?? '' };
}

export interface MilestoneTextSafe { name: string; desc: string }

/**
 * 模板格式化：
 * - {r:id} 替换为资源名、{a:id} 替换为动作名（主题联动占位符）
 * - {key} 从 vars 取值
 */
export function fmt(tpl: string, vars?: Record<string, string | number>): string {
  return tpl.replace(/\{(\w+)(?::(\w+))?\}/g, (match, key: string, refId?: string) => {
    if (refId !== undefined) {
      if (key === 'r') return resName(refId);
      if (key === 'a') return actionText(refId).name;
      return match;
    }
    if (vars && key in vars) return String(vars[key]);
    return match;
  });
}

/** 把数量记录格式化为 "数量 资源名 + 数量 资源名" 形式 */
export function fmtAmounts(record: Record<string, number>): string {
  return Object.entries(record)
    .map(([rid, amt]) => `${amt} ${resName(rid)}`)
    .join(' + ');
}
