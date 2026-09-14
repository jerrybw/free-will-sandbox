import type { GameConfig } from '../types';
import configRaw from '../config/game-config.json';

// 单一信息源：数据驱动配置
export const CONFIG: GameConfig = configRaw as unknown as GameConfig;

export const CONFIG_VERSION = CONFIG.meta.version;

export function getConfig(): GameConfig {
  return CONFIG;
}