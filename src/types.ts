// 游戏数据类型定义（v2 配置化架构：文案见 ui-texts.json，数值见 game-config.json）

// ---------- 配置：资源 ----------
export interface ResourceDef {
  id: string;
  start: number;
  /** 基础存储上限；省略或 0 表示无上限 */
  capBase?: number;
}

// ---------- 配置：动作 ----------
export type ActionKind = 'click' | 'convert';

export interface ActionDef {
  id: string;
  kind: ActionKind;
  /** 产出（click 型受事件倍率影响） */
  gives: Record<string, number>;
  /** 消耗（convert 型专用） */
  consumes?: Record<string, number>;
}

// ---------- 配置：升级效果（可扩展枚举） ----------
export type UpgradeEffectType =
  | 'action_add'        // 指定动作每次产出 +add/级
  | 'passive'           // 指定资源每 tick +addPerTick/级
  | 'convert_discount'  // 指定转换动作消耗 -discountPerLevel/级，累计不超过 maxDiscount
  | 'auto_convert'      // 每 tick 自动尝试指定转换动作（每级 +1 次）
  | 'convert_output'    // 指定转换动作产出 +add/级
  | 'cap_add';          // 全部资源上限 +add/级

export interface UpgradeEffect {
  type: UpgradeEffectType;
  action?: string;
  resource?: string;
  add?: number;
  addPerTick?: number;
  discountPerLevel?: number;
  maxDiscount?: number;
}

export interface UpgradeDef {
  id: string;
  cost: Record<string, number>;
  effect: UpgradeEffect;
  maxLevel: number;
}

// ---------- 配置：事件效果（可扩展枚举） ----------
export type EventEffectType =
  | 'multiplier_click'  // 持续期间点击产出 ×multiplier
  | 'grant_resource'    // 触发瞬间一次性 +amount 资源
  | 'free_cost_n';      // 下 freeCount 次转换动作免消耗指定资源

export interface EventEffect {
  type: EventEffectType;
  multiplier?: number;
  resource?: string;
  amount?: number;
  freeCount?: number;
}

export interface EventDef {
  id: string;
  /** 每 tick 触发概率 0~1 */
  chancePerTick: number;
  /** 持续毫秒数；0 表示一次性事件（触发即结束，效果可能持续） */
  durationMs: number;
  effect: EventEffect;
}

// ---------- 配置：里程碑 ----------
export type MilestoneType =
  | 'total_earned'    // 累计产出指定资源达到阈值
  | 'total_clicks'    // 累计点击达到阈值
  | 'synth_count'     // 累计合成次数达到阈值
  | 'upgrade_levels'; // 升级总等级达到阈值

export interface MilestoneDef {
  id: string;
  type: MilestoneType;
  resource?: string;
  threshold: number;
  reward: Record<string, number>;
}

// ---------- 配置根 ----------
export interface GameConfig {
  meta: {
    id: string;
    version: string;
    seed: number;
    autosaveIntervalMs: number;
    tickMs: number;
    saveKey: string;
    legacySaveKey: string;
    costGrowth: number;
    logLimit: number;
  };
  resources: ResourceDef[];
  actions: ActionDef[];
  upgrades: UpgradeDef[];
  events: EventDef[];
  milestones: MilestoneDef[];
}

// ---------- UI 文案结构 ----------
export interface NamedText { name: string }
export interface ActionText { name: string; icon: string; desc: string }
export interface UpgradeText { name: string; desc: string }
export interface EventText { name: string; start: string; end?: string; badge?: string }
export interface MilestoneText { name: string; desc: string }

export interface UITexts {
  page: { title: string; brand: string; desc: string };
  nav: { game: string; dev: string };
  panels: Record<string, string>;
  resources: Record<string, NamedText>;
  actions: Record<string, ActionText>;
  upgrades: Record<string, UpgradeText>;
  events: Record<string, EventText>;
  milestones: Record<string, MilestoneText>;
  log: Record<string, string>;
  ui: Record<string, string>;
}

// ---------- 运行时状态 ----------
export interface ActiveEventState {
  id: string;
  remainingTicks: number;
}

export interface EventRuntime {
  active: ActiveEventState[];
  /** 免消耗剩余次数：资源 id -> 次数（free_cost_n 效果） */
  freeSynth: Record<string, number>;
}

export interface GameState {
  resources: Record<string, number>;
  upgradeLevels: Record<string, number>;
  totalClicks: number;
  totalEarned: Record<string, number>;
  synthCount: number;
  milestonesDone: Record<string, boolean>;
  events: EventRuntime;
  lastSave: number;
}
