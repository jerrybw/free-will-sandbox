import type { GameState } from '../types';
import { CONFIG, TEXTS, fmt, resName, actionText, upgradeText, eventText, fmtAmounts } from '../game/config';
import {
  computeClickGives,
  computeConvertGives,
  computeActionCost,
  computePassivePerTick,
  getUpgradeLevel,
  getResourceCap,
  isAffordable,
  upgradeCost
} from '../game/store';
import { getMilestoneProgress, isMilestoneDone, nextMilestone } from '../game/milestones';
import { eventRemainingSeconds } from '../game/events';

// 渲染层：节点缓存式更新（不重建 DOM，避免高频 tick 造成点击丢失）

const resItems = new Map<string, HTMLDivElement>();
const actionBtns = new Map<string, HTMLButtonElement>();
const upgradeCards = new Map<string, HTMLDivElement>();
const milestoneItems = new Map<string, HTMLDivElement>();

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

// ---------- 静态文案注入（页面标题/品牌/导航/面板标题） ----------
function getTextByPath(obj: unknown, path: string): string | undefined {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return typeof cur === 'string' ? cur : undefined;
}

export function applyStaticTexts(): void {
  document.title = TEXTS.page.title;
  const desc = document.querySelector('meta[name="description"]');
  if (desc) desc.setAttribute('content', TEXTS.page.desc);
  document.querySelectorAll<HTMLElement>('[data-text-key]').forEach((elm) => {
    const v = getTextByPath(TEXTS, elm.dataset.textKey ?? '');
    if (v !== undefined) elm.textContent = v;
  });
}

// ---------- 资源 ----------
export function renderResources(state: GameState) {
  const box = document.getElementById('resources');
  if (!box) return;
  let total = 0;
  for (const r of CONFIG.resources) {
    total += state.resources[r.id] || 0;
    let item = resItems.get(r.id);
    if (!item) {
      item = el('div', 'resource-item');
      item.append(
        el('span', 'r-name', resName(r.id)),
        el('span', 'r-val', '0'),
        el('span', 'r-ps', ''),
        el('span', 'r-total', '')
      );
      resItems.set(r.id, item);
      box.appendChild(item);
    }
    const val = item.children[1] as HTMLElement;
    const ps = item.children[2] as HTMLElement;
    const tot = item.children[3] as HTMLElement;
    const res = state.resources[r.id] || 0;
    val.textContent = Math.floor(res).toLocaleString();
    const perSec = computePassivePerTick(state, r.id) * (1000 / CONFIG.meta.tickMs);
    ps.textContent = perSec > 0 ? fmt(TEXTS.ui.perSec, { n: perSec.toFixed(1) }) : '';
    const cap = getResourceCap(state, r.id);
    tot.textContent =
      fmt(TEXTS.ui.earnedTotal, { n: Math.floor(state.totalEarned[r.id] || 0).toLocaleString() }) +
      (cap > 0 ? ` · ${fmt(TEXTS.ui.capSuffix, { cap: cap.toLocaleString() })}` : '');
  }
  const totalEl = document.getElementById('totalHolding');
  if (totalEl) totalEl.textContent = fmt(TEXTS.ui.totalHolding, { n: Math.floor(total).toLocaleString() });
}

// ---------- 动作（点击 + 转换） ----------
export function renderActions(state: GameState, onAction: (id: string) => void) {
  const box = document.getElementById('actions');
  if (!box) return;
  for (const a of CONFIG.actions) {
    const at = actionText(a.id);
    let btn = actionBtns.get(a.id);
    if (!btn) {
      btn = el('button', 'action-btn');
      btn.addEventListener('click', () => onAction(a.id));
      actionBtns.set(a.id, btn);
      box.appendChild(btn);
    }
    btn.className = 'action-btn';
    if (a.kind === 'click') {
      const gives = computeClickGives(state, a.id);
      const gainText = fmtAmounts(gives);
      btn.innerHTML = '';
      btn.append(
        el('span', 'act-icon', at.icon),
        el('span', 'act-name', at.name),
        el('span', 'act-gain', fmt(TEXTS.ui.gainPrefix, { gain: gainText }))
      );
    } else {
      const cost = computeActionCost(state, a.id);
      const gives = computeConvertGives(state, a.id);
      const afford = isAffordable(state, cost) || Object.keys(cost).length === 0;
      if (!afford) btn.classList.add('insufficient');
      const consumed = Object.entries(a.consumes ?? {});
      const freeRes = consumed.filter(([rid]) => !(rid in cost)).map(([rid]) => resName(rid));
      btn.innerHTML = '';
      btn.append(
        el('span', 'act-icon', at.icon),
        el('span', 'act-name', at.name),
        el('span', 'act-cost', fmt(TEXTS.ui.convert, { cost: fmtAmounts(cost), gain: fmtAmounts(gives) }))
      );
      if (freeRes.length > 0) {
        btn.append(el('span', 'act-free', fmt(TEXTS.ui.freeTag, { res: freeRes.join('、') })));
      }
    }
  }
}

// ---------- 升级 ----------
export function renderUpgrades(state: GameState, onBuy: (id: string) => void) {
  const box = document.getElementById('upgrades');
  if (!box) return;
  for (const u of CONFIG.upgrades) {
    const ut = upgradeText(u.id);
    const lvl = getUpgradeLevel(state, u.id);
    const maxed = lvl >= u.maxLevel;
    const cost = upgradeCost(u, lvl);
    const afford = isAffordable(state, cost);
    let card = upgradeCards.get(u.id);
    if (!card) {
      card = el('div', 'upgrade-card');
      card.addEventListener('click', () => onBuy(u.id));
      upgradeCards.set(u.id, card);
      box.appendChild(card);
    }
    card.className = 'upgrade-card' + (afford && !maxed ? ' affordable' : '') + (maxed ? ' maxed' : '');
    card.innerHTML = '';
    const nameDiv = el('div', 'up-name');
    nameDiv.appendChild(document.createTextNode(`${ut.name} `));
    nameDiv.appendChild(el('span', 'up-lvl', fmt(TEXTS.ui.lv, { lv: lvl, max: u.maxLevel })));
    card.append(
      nameDiv,
      el('div', 'up-desc', fmt(ut.desc)),
      el('div', 'up-cost', maxed ? fmt(TEXTS.ui.maxed) : fmt(TEXTS.ui.costPrefix, { cost: fmtAmounts(cost) }))
    );
  }
}

// ---------- 事件徽标（顶栏） ----------
export function renderEventBadges(state: GameState) {
  const box = document.getElementById('event-badges');
  if (!box) return;
  box.innerHTML = '';
  for (const a of state.events.active) {
    const t = eventText(a.id);
    const name = t?.name ?? a.id;
    const badgeTpl = t?.badge ?? '{name}';
    const def = CONFIG.events.find((e) => e.id === a.id);
    const sec = eventRemainingSeconds(state, a.id);
    const label = fmt(badgeTpl, {
      name,
      mult: def?.effect.multiplier ?? 1,
      sec,
      amount: def?.effect.amount ?? 0,
      n: def?.effect.freeCount ?? 0
    });
    box.appendChild(el('span', 'event-badge', `${label} ${sec}s`));
  }
  for (const [rid, n] of Object.entries(state.events.freeSynth)) {
    if (n <= 0) continue;
    const evDef = CONFIG.events.find((e) => e.effect.type === 'free_cost_n' && e.effect.resource === rid);
    const evName = evDef ? eventText(evDef.id)?.name ?? evDef.id : '';
    box.appendChild(el('span', 'event-badge free', fmt(TEXTS.ui.badgeFree, { name: evName, res: resName(rid), n })));
  }
}

// ---------- 事件动态（右栏） ----------
export function renderEvents(state: GameState) {
  const box = document.getElementById('events');
  if (!box) return;
  box.innerHTML = '';
  let hasContent = false;
  for (const a of state.events.active) {
    const t = eventText(a.id);
    const name = t?.name ?? a.id;
    box.appendChild(
      el('div', 'event-item', fmt(TEXTS.ui.eventActive, { name, sec: eventRemainingSeconds(state, a.id) }))
    );
    hasContent = true;
  }
  for (const [rid, n] of Object.entries(state.events.freeSynth)) {
    if (n <= 0) continue;
    const evDef = CONFIG.events.find((e) => e.effect.type === 'free_cost_n' && e.effect.resource === rid);
    const evName = evDef ? eventText(evDef.id)?.name ?? evDef.id : '';
    box.appendChild(el('div', 'event-item free', fmt(TEXTS.ui.badgeFree, { name: evName, res: resName(rid), n })));
    hasContent = true;
  }
  if (!hasContent) {
    box.appendChild(el('div', 'empty-hint', TEXTS.ui.emptyEvents));
  }
}

// ---------- 里程碑（右栏） ----------
export function renderMilestones(state: GameState) {
  const box = document.getElementById('milestones');
  if (!box) return;
  const doneIds = CONFIG.milestones.filter((m) => isMilestoneDone(state, m.id));
  const next = nextMilestone(state);

  if (doneIds.length === 0 && !next) {
    box.innerHTML = '';
    box.appendChild(el('div', 'empty-hint', TEXTS.ui.emptyMilestones));
    return;
  }

  // 下一目标
  let nextEl = milestoneItems.get('__next__');
  if (!nextEl) {
    nextEl = el('div', 'milestone-next');
    nextEl.appendChild(el('div', 'ms-goal-title', TEXTS.ui.nextGoal));
    const body = el('div', 'ms-body');
    const barWrap = el('div', 'ms-bar-wrap');
    barWrap.appendChild(el('div', 'ms-bar'));
    body.append(
      el('div', 'ms-name'),
      el('div', 'ms-desc'),
      el('div', 'ms-progress'),
      barWrap
    );
    nextEl.appendChild(body);
    milestoneItems.set('__next__', nextEl);
    box.appendChild(nextEl);
  }
  const body = nextEl.querySelector('.ms-body') as HTMLElement;
  if (next) {
    nextEl.style.display = '';
    const { cur, goal } = getMilestoneProgress(next, state);
    (body.querySelector('.ms-name') as HTMLElement).textContent = fmt(TEXTS.ui.lockedTag) + ' ' + (TEXTS.milestones[next.id]?.name ?? next.id);
    (body.querySelector('.ms-desc') as HTMLElement).textContent = fmt(TEXTS.milestones[next.id]?.desc ?? '');
    (body.querySelector('.ms-progress') as HTMLElement).textContent = fmt(TEXTS.ui.progress, {
      cur: Math.floor(cur).toLocaleString(),
      goal: goal.toLocaleString()
    });
    const pct = Math.min(100, (cur / goal) * 100);
    (body.querySelector('.ms-bar') as HTMLElement).style.width = `${pct}%`;
  } else {
    nextEl.style.display = 'none';
  }

  // 已完成
  let doneBox = milestoneItems.get('__done__') as HTMLDivElement | undefined;
  if (!doneBox) {
    doneBox = el('div', 'milestone-done-list');
    milestoneItems.set('__done__', doneBox);
    box.appendChild(doneBox);
  }
  doneBox.innerHTML = '';
  for (const m of doneIds) {
    doneBox.appendChild(el('div', 'milestone-done', `${TEXTS.ui.doneTag} ${TEXTS.milestones[m.id]?.name ?? m.id}`));
  }
}

// ---------- 日志 ----------
export function appendLog(msg: string) {
  const box = document.getElementById('log');
  if (!box) return;
  const t = new Date().toLocaleTimeString();
  const div = el('div', 'log-item', `[${t}] ${msg}`);
  box.prepend(div);
  const limit = CONFIG.meta.logLimit;
  while (box.children.length > limit) box.removeChild(box.lastChild!);
}

// ---------- Toast ----------
let toastTimer: number | null = null;
export function showToast(msg: string) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('show'), 2600);
}
