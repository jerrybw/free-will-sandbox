import type { GameState } from '../types';
import { CONFIG } from '../game/config';
import { computeActionGives, computePassivePerTick, upgradeApi } from '../game/store';

function totalResource(state: GameState): number {
  let t = 0;
  for (const r of CONFIG.resources) t += state.resources[r.id] || 0;
  return t;
}

export function renderResources(state: GameState) {
  const box = document.getElementById('resources');
  const totalEl = document.getElementById('totalCookies');
  if (!box) return;
  box.innerHTML = '';
  for (const r of CONFIG.resources) {
    const val = Math.floor(state.resources[r.id] || 0);
    const earned = Math.floor(state.totalEarned[r.id] || 0);
    const div = document.createElement('div');
    div.className = 'resource-item';
    div.innerHTML = `<span class="r-name">${r.name}</span>
      <span class="r-val">${val.toLocaleString()}</span>
      <span class="r-ps">+${computePassiveDisplay(state, r.id)}/s</span>
      <span class="r-total">共 ${earned.toLocaleString()}</span>`;
    box.appendChild(div);
  }
  if (totalEl) totalEl.textContent = `💎 总计持有：${totalResource(state).toLocaleString()}`;
}

function computePassiveDisplay(state: GameState, rid: string): string {
  // 每 tick 产出换算为每秒
  const perTick = sumPassivePerTick(state, rid);
  return (perTick * (1000 / CONFIG.meta.tickMs)).toFixed(0);
}

function sumPassivePerTick(state: GameState, rid: string): number {
  return computePassivePerTick(rid, state);
}

export function renderActions(state: GameState, onAction: (id: string) => void) {
  const box = document.getElementById('actions');
  if (!box) return;
  box.innerHTML = '';
  for (const a of CONFIG.actions) {
    const gives = computeActionGives(a.id, state);
    const btn = document.createElement('button');
    btn.className = 'action-btn';
    const gainText = Object.entries(gives)
      .map(([rid, amt]) => {
        const def = CONFIG.resources.find((r) => r.id === rid);
        return `${amt} ${def ? def.name : rid}`;
      })
      .join(' ');
    btn.innerHTML = `<span class="act-icon">${a.icon}</span>
      <span class="act-name">${a.name}</span>
      <span class="act-gain">+${gainText}</span>`;
    btn.addEventListener('click', () => onAction(a.id));
    box.appendChild(btn);
  }
}

export function renderUpgrades(state: GameState, onBuy: (id: string) => void) {
  const box = document.getElementById('upgrades');
  if (!box) return;
  box.innerHTML = '';
  for (const u of CONFIG.upgrades) {
    const lvl = upgradeApi.getLevel(state, u.id);
    const maxed = lvl >= u.maxLevel;
    const cost = upgradeApi.getCost(u, lvl);
    const afford = upgradeApi.isAffordable(state, cost);
    const card = document.createElement('div');
    card.className = 'upgrade-card' + (afford && !maxed ? ' affordable' : '');
    const costText = Object.entries(cost)
      .map(([rid, amt]) => {
        const def = CONFIG.resources.find((r) => r.id === rid);
        return `${amt} ${def ? def.name : rid}`;
      })
      .join(' ');
    card.innerHTML = `<div class="up-name">${u.name} <span class="up-lvl">Lv.${lvl}/${u.maxLevel}</span></div>
      <div class="up-desc">${u.desc}</div>
      <div class="up-cost">💰 ${maxed ? '已满级' : costText}</div>`;
    if (!maxed) {
      card.addEventListener('click', () => onBuy(u.id));
    }
    box.appendChild(card);
  }
}

export function appendLog(msg: string) {
  const box = document.getElementById('log');
  if (!box) return;
  const t = new Date().toLocaleTimeString();
  const div = document.createElement('div');
  div.className = 'log-item';
  div.textContent = `[${t}] ${msg}`;
  box.prepend(div);
  // 限制条目数
  while (box.children.length > 50) box.removeChild(box.lastChild!);
}