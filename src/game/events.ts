import type { EventDef, GameState } from '../types';
import { CONFIG, fmt, eventText } from './config';
import { addResource } from './store';

// 事件系统：概率触发 → 效果作用器（可扩展枚举映射）→ 计时/结算
// 本模块保持纯逻辑（无 DOM），渲染由 game.ts / ui 层负责

export interface EventNotification {
  eventId: string;
  kind: 'start' | 'end';
  message: string;
}

/** 应用事件触发效果，返回通知 */
export function applyEventStart(state: GameState, def: EventDef): EventNotification {
  const t = eventText(def.id);
  const name = t?.name ?? def.id;
  const fx = def.effect;

  switch (fx.type) {
    case 'multiplier_click': {
      const ticks = Math.max(1, Math.round(def.durationMs / CONFIG.meta.tickMs));
      const existing = state.events.active.find((a) => a.id === def.id);
      if (existing) {
        existing.remainingTicks = Math.max(existing.remainingTicks, ticks);
      } else {
        state.events.active.push({ id: def.id, remainingTicks: ticks });
      }
      break;
    }
    case 'grant_resource': {
      if (fx.resource && fx.amount) addResource(state, fx.resource, fx.amount);
      break;
    }
    case 'free_cost_n': {
      if (fx.resource && fx.freeCount) {
        state.events.freeSynth[fx.resource] = (state.events.freeSynth[fx.resource] || 0) + fx.freeCount;
      }
      break;
    }
  }

  const vars: Record<string, string | number> = {
    name,
    sec: Math.round(def.durationMs / 1000),
    mult: fx.multiplier ?? 1,
    amount: fx.amount ?? 0,
    n: fx.freeCount ?? 0
  };
  return {
    eventId: def.id,
    kind: 'start',
    message: fmt(t?.start ?? name, vars)
  };
}

/** tick 内按概率掷骰触发事件 */
export function maybeTriggerEvents(state: GameState, rand: () => number = Math.random): EventNotification[] {
  const notes: EventNotification[] = [];
  for (const def of CONFIG.events) {
    if (rand() < def.chancePerTick) {
      notes.push(applyEventStart(state, def));
    }
  }
  return notes;
}

/** 每 tick 结算持续型事件倒计时，返回结束通知 */
export function tickEvents(state: GameState): EventNotification[] {
  const notes: EventNotification[] = [];
  const stillActive: typeof state.events.active = [];
  for (const a of state.events.active) {
    a.remainingTicks -= 1;
    if (a.remainingTicks > 0) {
      stillActive.push(a);
    } else {
      const t = eventText(a.id);
      const name = t?.name ?? a.id;
      if (t?.end) {
        notes.push({ eventId: a.id, kind: 'end', message: fmt(t.end, { name }) });
      }
    }
  }
  state.events.active = stillActive;
  return notes;
}

/** 事件是否进行中 */
export function isEventActive(state: GameState, eventId: string): boolean {
  return state.events.active.some((a) => a.id === eventId);
}

/** 剩余秒数（用于徽标/列表展示） */
export function eventRemainingSeconds(state: GameState, eventId: string): number {
  const a = state.events.active.find((x) => x.id === eventId);
  if (!a) return 0;
  return Math.ceil((a.remainingTicks * CONFIG.meta.tickMs) / 1000);
}
