import type { GameState } from '../types';
import { CONFIG, TEXTS, fmt, fmtAmounts, upgradeText } from './config';
import {
  addResource,
  autoConvertPerTick,
  computePassivePerTick,
  createInitialState,
  getUpgradeLevel,
  isAffordable,
  loadGame,
  performClick,
  saveGame,
  tryConvert,
  upgradeCost
} from './store';
import { maybeTriggerEvents, tickEvents } from './events';
import { checkMilestones } from './milestones';
import {
  renderResources,
  renderActions,
  renderUpgrades,
  renderEventBadges,
  renderEvents,
  renderMilestones,
  appendLog,
  showToast
} from '../ui/render';

export class GameManager {
  state: GameState;
  private timer: number | null = null;
  private tickMs: number;
  private saveMs: number;

  constructor() {
    const loaded = loadGame();
    this.state = loaded ? loaded.state : createInitialState();
    this.tickMs = CONFIG.meta.tickMs;
    this.saveMs = CONFIG.meta.autosaveIntervalMs;
    if (loaded?.migratedFromLegacy) {
      appendLog(fmt(TEXTS.log.migrated));
    }
  }

  handleAction(actionId: string) {
    const a = CONFIG.actions.find((x) => x.id === actionId);
    if (!a) return;
    if (a.kind === 'click') {
      performClick(this.state, actionId);
    } else {
      const r = tryConvert(this.state, actionId);
      if (r.ok) {
        appendLog(fmt(TEXTS.log.synthOk, { gain: fmtAmounts(r.gives ?? {}) }));
      } else if (r.reason === 'insufficient') {
        appendLog(fmt(TEXTS.log.synthFail, { cost: fmtAmounts(r.cost ?? {}) }));
      }
    }
    this.checkProgress();
    this.renderAll();
    this.autosave();
  }

  /** 尝试购买升级，返回是否成功 */
  buyUpgrade(uid: string): boolean {
    const u = CONFIG.upgrades.find((x) => x.id === uid);
    if (!u) return false;
    const lvl = getUpgradeLevel(this.state, uid);
    const name = upgradeText(uid).name;
    if (lvl >= u.maxLevel) {
      appendLog(fmt(TEXTS.log.upgradeMax, { name }));
      return false;
    }
    const cost = upgradeCost(u, lvl);
    if (!isAffordable(this.state, cost)) {
      appendLog(fmt(TEXTS.log.upgradeFail, { name }));
      return false;
    }
    for (const [rid, amt] of Object.entries(cost)) {
      this.state.resources[rid] = (this.state.resources[rid] || 0) - amt;
    }
    this.state.upgradeLevels[uid] = lvl + 1;
    appendLog(fmt(TEXTS.log.upgradeOk, { name, lv: lvl + 1 }));
    this.checkProgress();
    this.renderAll();
    this.autosave();
    return true;
  }

  private tick() {
    // 每 tick 结算被动产出
    for (const r of CONFIG.resources) {
      const perTick = computePassivePerTick(this.state, r.id);
      if (perTick > 0) addResource(this.state, r.id, perTick);
    }
    // 事件：概率触发 + 持续结算
    const notes = [...maybeTriggerEvents(this.state), ...tickEvents(this.state)];
    for (const n of notes) {
      appendLog(n.message);
      if (n.kind === 'start') showToast(n.message);
    }
    // 自动合成（静默执行，不刷日志）
    for (const a of CONFIG.actions) {
      if (a.kind !== 'convert') continue;
      let attempts = autoConvertPerTick(this.state, a.id);
      while (attempts-- > 0) {
        const r = tryConvert(this.state, a.id);
        if (!r.ok) break;
      }
    }
    // 里程碑检查
    this.checkProgress();
    this.renderAll();
  }

  private checkProgress() {
    const done = checkMilestones(this.state);
    for (const m of done) {
      appendLog(m.message);
      showToast(m.message);
    }
  }

  private renderAll() {
    renderResources(this.state);
    renderEventBadges(this.state);
    renderActions(this.state, (id) => this.handleAction(id));
    renderUpgrades(this.state, (uid) => this.buyUpgrade(uid));
    renderEvents(this.state);
    renderMilestones(this.state);
  }

  private autosave() {
    this.state.lastSave = Date.now();
    saveGame(this.state);
  }

  start() {
    appendLog(fmt(TEXTS.log.welcome));
    this.renderAll();
    this.timer = window.setInterval(() => this.tick(), this.tickMs);
    window.setInterval(() => this.autosave(), this.saveMs);
    window.addEventListener('beforeunload', () => this.autosave());
  }

  stop() {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
