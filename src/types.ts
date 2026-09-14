// 游戏数据类型定义

export interface ResourceDef {
  id: string;
  name: string;
  start: number;
}

export interface ActionDef {
  id: string;
  name: string;
  desc: string;
  icon: string;
  gives: Record<string, number>;
}

export interface UpgradeEffect {
  action?: string;
  add?: number;
  passive?: string;
  addPerTick?: number;
}

export interface UpgradeDef {
  id: string;
  name: string;
  desc: string;
  cost: Record<string, number>;
  effect: UpgradeEffect;
  maxLevel: number;
}

export interface GameConfig {
  meta: {
    id: string;
    name: string;
    version: string;
    seed: number;
    autosaveIntervalMs: number;
    tickMs: number;
  };
  resources: ResourceDef[];
  actions: ActionDef[];
  upgrades: UpgradeDef[];
}

// 运行时状态
export interface GameState {
  resources: Record<string, number>;
  upgradeLevels: Record<string, number>;
  totalClicks: number;
  totalEarned: Record<string, number>;
  lastSave: number;
  log: string[];
}

export interface DerivedUnit {
  // 每个动作当前每次产出
  gives: Record<string, number>;
  // 每个资源每 tick 被动产出
  passivePerTick: number;
}