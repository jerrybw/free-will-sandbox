import type { GameState } from '../types';
import { CONFIG } from './config';
import {
  computeActionGives,
  computePassivePerTick,
  createInitialState,
  loadGame,
  saveGame,
  upgradeApi
} from './store';
import { renderResources, renderActions, renderUpgrades, appendLog } from '../ui/render';

export class GameManager {
  state: GameState;
  private timer: number | null = null;
  private tickMs: number;
  private saveMs: number;

  constructor() {
    const saved = loadGame();
    this.state = saved ?? createInitialState();
    this.tickMs = CONFIG.meta.tickMs;
    this.saveMs = CONFIG.meta.autosaveIntervalMs;
  }

  handleAction(actionId: string) {
    const gives = computeActionGives(actionId, this.state);
    this.state.totalClicks += 1;
    for (const [rid, amt] of Object.entries(gives)) {
      if (amt <= 0) continue;
      this.state.resources[rid] = (this.state.resources[rid] || 0) + amt;
      this.state.totalEarned[rid] = (this.state.totalEarned[rid] || 0) + amt;
    }
    this.refresh();
  }

  /** 尝试购买升级，返回是否成功 */
  buyUpgrade(uid: string): boolean {
    const u = CONFIG.upgrades.find((x) => x.id === uid);
    if (!u) return false;
    const lvl = upgradeApi.getLevel(this.state, uid);
    if (lvl >= u.maxLevel) {
      appendLog(`🔒 ${u.name} 已满级`);
      return false;
    }
    const cost = upgradeApi.getCost(u, lvl);
    if (!upgradeApi.isAffordable(this.state, cost)) {
      appendLog(`❌ 资源不足，无法购买 ${u.name}`);
      return false;
    }
    for (const [rid, amt] of Object.entries(cost)) {
      this.state.resources[rid] -= amt;
    }
    this.state.upgradeLevels[uid] = lvl + 1;
    appendLog(`✅ 已升级 ${u.name} (Lv.${lvl + 1})`);
    this.refresh();
    return true;
  }

  private tick() {
    // 每 tick 结算被动产出
    let changed = false;
    for (const r of CONFIG.resources) {
      const perTick = computePassivePerTick(r.id, this.state);
      if (perTick > 0) {
        this.state.resources[r.id] = (this.state.resources[r.id] || 0) + perTick;
        this.state.totalEarned[r.id] = (this.state.totalEarned[r.id] || 0) + perTick;
        changed = true;
      }
    }
    if (changed) this.renderAll();
  }

  private refresh() {
    this.renderAll();
    this.state.lastSave = Date.now();
    saveGame(this.state);
  }

  private renderAll() {
    renderResources(this.state);
    renderActions(this.state, (id) => this.handleAction(id));
    renderUpgrades(this.state, (uid) => this.buyUpgrade(uid));
  }

  start() {
    this.renderAll();
    this.timer = window.setInterval(() => this.tick(), this.tickMs);
    window.setInterval(() => {
      this.state.lastSave = Date.now();
      saveGame(this.state);
    }, this.saveMs);
    window.addEventListener('beforeunload', () => {
      this.state.lastSave = Date.now();
      saveGame(this.state);
    });
  }

  stop() {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}