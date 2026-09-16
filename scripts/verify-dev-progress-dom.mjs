#!/usr/bin/env node
/**
 * [S2] dev-progress.html 需求动态分区加载链路 DOM 实测（临时验证脚本）
 *
 * 方法：提取页面 <script> 源码，stub document / fetch / localStorage 后执行，
 *       实测三条分支：LIVE（快照可用）/ MOCK 兜底（快照 404）/ 双失败报错。
 * 运行：node scripts/verify-dev-progress-dom.mjs
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const htmlPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public", "dev-progress.html");
const html = readFileSync(htmlPath, "utf8");
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error("未找到页面 script"); process.exit(1); }
const pageScript = m[1];

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.error(`  ❌ ${name}`); } }

function makeEnv(fetchRoutes) {
  const elements = {};
  const getEl = (id) => elements[id] || (elements[id] = {
    id, innerHTML: "", textContent: "", className: "", title: "", value: "",
    addEventListener(type, fn) { this._handlers = { ...this._handlers, [type]: fn }; },
    reset() {},
  });
  globalThis.document = { getElementById: getEl };
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.fetch = async (url) => {
    const route = fetchRoutes[url.replace(locationBase, "")];
    if (route === undefined) return { ok: false, status: 404, json: async () => ({}) };
    if (route === "ERR") return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => route };
  };
  const locationBase = "http://127.0.0.1:8099/";
  return { getEl };
}

// 注意：fetch stub 中 url 形如 "./data/issues-snapshot.json"（相对路径原样传入），直接做键匹配
function makeEnv2(fetchRoutes) {
  const elements = {};
  const getEl = (id) => elements[id] || (elements[id] = {
    id, innerHTML: "", textContent: "", className: "", title: "", value: "",
    addEventListener() {}, reset() {},
  });
  globalThis.document = { getElementById: getEl };
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.fetch = async (url) => {
    const route = fetchRoutes[url];
    if (route === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => route };
  };
  return { getEl };
}

const SNAPSHOT_FIXTURE = {
  schemaVersion: 1, generatedAt: "2026-09-15T01:30:00.000Z", source: "github-issues",
  repo: "jerrybw/free-will-sandbox", counts: { open: 2, byType: { bug: 1, feature: 1, ux: 0, other: 0 } },
  issues: [
    { number: 12, title: "酿造台点击负数增量越界", type: "bug", state: "open", author: "alice", createdAt: "2026-09-15T01:00:00.000Z", updatedAt: "2026-09-15T02:00:00.000Z", url: "https://github.com/jerrybw/free-will-sandbox/issues/12", labels: ["issue/bug"], bodyExcerpt: "步骤一 步骤二 步骤三" },
    { number: 13, title: "希望增加成就系统", type: "feature", state: "open", author: "bob", createdAt: "2026-09-14T10:00:00.000Z", updatedAt: "2026-09-14T11:00:00.000Z", url: "https://github.com/jerrybw/free-will-sandbox/issues/13", labels: ["issue/feature"], bodyExcerpt: "想要里程碑徽章" },
  ],
};
const MOCK_FIXTURE = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "public", "data", "mock", "issues.json"), "utf8"));

// 场景 A：快照可用 → LIVE 渲染
{
  console.log("== 场景 A：快照可用 → LIVE 渲染 ==");
  const { getEl } = makeEnv2({ "./data/issues-snapshot.json": SNAPSHOT_FIXTURE, "./data/mock/issues.json": MOCK_FIXTURE });
  new Function(pageScript)();
  await new Promise((r) => setTimeout(r, 50));
  const queue = getEl("queue");
  ok(queue.innerHTML.includes("#12") && queue.innerHTML.includes("#13"), "快照 issue 以 #编号 渲染");
  ok(queue.innerHTML.includes("itype bug") && queue.innerHTML.includes("itype feature"), "类型小标签 bug/feature");
  ok(queue.innerHTML.includes("istate open"), "状态徽标 open");
  ok(queue.innerHTML.includes("@alice") && queue.innerHTML.includes("@bob"), "作者展示");
  ok(queue.innerHTML.includes("快照生成于 2026-09-15 09:30") || queue.innerHTML.includes("快照生成于"), "生成时间 live-meta");
  ok(queue.innerHTML.includes("步骤一 步骤二 步骤三"), "bodyExcerpt 摘要渲染");
  ok(getEl("queueCount").textContent === 2, "队列计数 = 2");
  ok(getEl("queueBadge").innerHTML.includes("LIVE 快照") && getEl("queueBadge").innerHTML.includes("live-dot"), "分区头部绿色 LIVE 快照徽标");
  ok(getEl("pageDataBadge").className === "live-badge" && getEl("pageDataBadge").textContent === "LIVE 快照", "页面级 LIVE 徽标");
  ok(getEl("dev").innerHTML.includes("源质工坊第二阶段"), "开发中分区仍读 Mock 内部排期数据");
  ok(getEl("released").innerHTML.includes("项目初始化"), "已发布分区仍读 Mock 内部排期数据");
}

// 场景 B：快照 404 → MOCK 兜底
{
  console.log("== 场景 B：快照 404 → MOCK 兜底渲染 ==");
  const { getEl } = makeEnv2({ "./data/issues-snapshot.json": undefined, "./data/mock/issues.json": MOCK_FIXTURE });
  new Function(pageScript)();
  await new Promise((r) => setTimeout(r, 50));
  ok(getEl("queue").innerHTML.includes("#3 放置系统"), "降级后按 Mock 渲染队列");
  ok(getEl("queueBadge").innerHTML.includes("离线快照 · MOCK 兜底") && getEl("queueBadge").innerHTML.includes("mock-dot"), "分区头部琥珀色 MOCK 兜底徽标");
  ok(getEl("pageDataBadge").className === "mock-badge" && getEl("pageDataBadge").textContent === "Mock 数据", "页面级沿用 Mock 徽标");
  ok(getEl("queueCount").textContent === 3, "队列计数 = 3");
}

// 场景 C：双数据源失败 → 错误提示
{
  console.log("== 场景 C：快照与 Mock 均失败 → 错误提示 ==");
  const { getEl } = makeEnv2({});
  new Function(pageScript)();
  await new Promise((r) => setTimeout(r, 50));
  ok(getEl("queue").innerHTML.includes("数据加载失败"), "queue 显示错误提示");
  ok(getEl("released").innerHTML.includes("数据加载失败"), "released 显示错误提示");
}

// 场景 D：快照空列表 → 空状态文案
{
  console.log("== 场景 D：快照空列表 → 空状态 ==");
  const { getEl } = makeEnv2({
    "./data/issues-snapshot.json": { ...SNAPSHOT_FIXTURE, issues: [], counts: { open: 0, byType: { bug: 0, feature: 0, ux: 0, other: 0 } } },
    "./data/mock/issues.json": MOCK_FIXTURE,
  });
  new Function(pageScript)();
  await new Promise((r) => setTimeout(r, 50));
  ok(getEl("queue").innerHTML.includes("暂无进行中的需求"), "空列表显示空状态文案");
  ok(getEl("queueCount").textContent === 0, "队列计数 = 0");
}

// 语法校验
new Function(pageScript);
console.log("\n页面 script 语法校验通过");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
