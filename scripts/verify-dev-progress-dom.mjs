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
    addEventListener(type, fn) { this._handlers = { ...(this._handlers || {}), [type]: fn }; },
    reset() {},
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

// ===== [S4] 通知日志 LIVE/MOCK 双链路 =====
const NOTIF_SNAPSHOT_FIXTURE = {
  schemaVersion: 1, generatedAt: "2026-09-25T08:00:00.000Z", source: "github-notifications",
  repo: "jerrybw/free-will-sandbox", counts: { total: 2 },
  items: [
    { id: "n-12-comment-2001", time: "2026-09-25T07:00:00Z", type: "受理确认", content: "Issue #12「酿造台点击负数增量越界」 🤖 已受理 · 进入评审队列", status: "unread", url: "https://github.com/jerrybw/free-will-sandbox/issues/12#issuecomment-2001" },
    { id: "n-12-label-501", time: "2026-09-25T06:00:00Z", type: "标签流转", content: "Issue #12「酿造台点击负数增量越界」 标签：pending → approved", status: "unread", url: "https://github.com/jerrybw/free-will-sandbox/issues/12" },
  ],
};
const MOCK_NOTIF_FIXTURE = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "public", "data", "mock", "notifications.json"), "utf8"));

// 场景 E：通知快照可用 → LIVE 渲染
{
  console.log("== 场景 E：通知快照可用 → LIVE 渲染 ==");
  const { getEl } = makeEnv2({
    "./data/issues-snapshot.json": SNAPSHOT_FIXTURE, "./data/mock/issues.json": MOCK_FIXTURE,
    "./data/notifications-snapshot.json": NOTIF_SNAPSHOT_FIXTURE,
  });
  new Function(pageScript)();
  await new Promise((r) => setTimeout(r, 50));
  const notif = getEl("notifList");
  ok(notif.innerHTML.includes("受理确认") && notif.innerHTML.includes("标签流转"), "通知项类型渲染（受理确认/标签流转）");
  ok(notif.innerHTML.includes("已受理 · 进入评审队列"), "bot 评论内容渲染");
  ok(notif.innerHTML.includes("标签：pending → approved"), "标签流转内容渲染");
  ok(notif.innerHTML.includes("快照生成于"), "live-meta 带快照生成时间");
  ok(notif.innerHTML.includes("来源 GitHub 通知（约每 15 分钟更新）"), "live-meta 标注来源与更新频率");
  ok(notif.innerHTML.includes("未读"), "未读状态渲染");
  ok(getEl("notifBadge").innerHTML.includes("live-dot") && getEl("notifBadge").innerHTML.includes("LIVE 快照"), "通知区绿色 LIVE 快照徽标");
  ok(getEl("notifBadge").innerHTML.includes("生成于"), "LIVE 徽标 title 带快照生成时间");
  ok(getEl("notifCount").textContent === 2, "通知计数 = 2");
}

// 场景 F：通知快照 404 → MOCK 兜底
{
  console.log("== 场景 F：通知快照 404 → MOCK 兜底渲染 ==");
  const { getEl } = makeEnv2({
    "./data/issues-snapshot.json": SNAPSHOT_FIXTURE, "./data/mock/issues.json": MOCK_FIXTURE,
    "./data/mock/notifications.json": MOCK_NOTIF_FIXTURE,
  });
  new Function(pageScript)();
  await new Promise((r) => setTimeout(r, 50));
  ok(getEl("notifList").innerHTML.includes("CI 构建 #12 通过"), "Mock 通知项渲染（同一渲染函数复用）");
  ok(getEl("notifList").innerHTML.includes("离线 Mock 兜底数据"), "live-meta 标注离线兜底");
  ok(getEl("notifBadge").innerHTML.includes("mock-dot") && getEl("notifBadge").innerHTML.includes("离线快照 · MOCK 兜底"), "琥珀色 MOCK 兜底徽标");
  ok(getEl("notifCount").textContent === MOCK_NOTIF_FIXTURE.items.length, "通知计数 = Mock 条数");
}

// 场景 G：通知双数据源失败 → 错误提示
{
  console.log("== 场景 G：通知快照与 Mock 均失败 → 错误提示 ==");
  const { getEl } = makeEnv2({
    "./data/issues-snapshot.json": SNAPSHOT_FIXTURE, "./data/mock/issues.json": MOCK_FIXTURE,
  });
  new Function(pageScript)();
  await new Promise((r) => setTimeout(r, 50));
  ok(getEl("notifList").innerHTML.includes("通知数据加载失败"), "notifList 显示错误提示");
  ok(getEl("notifCount").textContent === 0, "通知计数 = 0");
}

// ===== [S4] 提交表单接真：GitHub Issue URL 构造 =====
// 场景 H：Bug 反馈 + 邮箱 → labels=issue/bug，body 含联系邮箱行
{
  console.log("== 场景 H：表单提交 → GitHub Issue URL（Bug 反馈 + 邮箱） ==");
  const captured = {};
  const { getEl } = makeEnv2({});
  globalThis.window = { open(url, target, features) { captured.url = url; captured.target = target; captured.features = features; } };
  new Function(pageScript)();
  await new Promise((r) => setTimeout(r, 50));
  getEl("reqTitle").value = "Bug 酿造台点击负数增量越界 ";
  getEl("reqType").value = "Bug 反馈";
  getEl("reqEmail").value = "me@example.com";
  let resetCalled = false;
  getEl("reqForm")._handlers.submit({ preventDefault() {}, target: { reset() { resetCalled = true; } } });
  const u = new URL(captured.url);
  ok(captured.target === "_blank" && captured.features === "noopener", "window.open 以 _blank + noopener 打开");
  ok(u.origin === "https://github.com" && u.pathname === "/jerrybw/free-will-sandbox/issues/new", "指向仓库 issues/new");
  const q = u.searchParams;
  ok(q.get("title") === "Bug 酿造台点击负数增量越界", "title 保留中文与空格（trim 后）");
  ok(q.get("labels") === "issue/bug", "Bug 反馈 → labels=issue/bug");
  const body = q.get("body");
  ok(body.startsWith("类型：Bug 反馈\n来源：开发进度页需求表单\n联系邮箱：me@example.com\n"), "body 模板：类型/来源/联系邮箱（选填时才含）");
  ok(body.endsWith("\n\n**需求描述：**\n（请在 GitHub Issue 页面补充细节后提交）"), "body 模板：需求描述占位");
  ok(getEl("reqHint").className === "req-hint ok" && getEl("reqHint").textContent.includes("已在 GitHub 打开 Issue 创建页"), "成功 hint 提示");
  ok(resetCalled, "提交后表单 reset");
  delete globalThis.window;
}

// 场景 I：新功能 + 邮箱留空 → labels=issue/feature，body 无联系邮箱行
{
  console.log("== 场景 I：表单提交 → GitHub Issue URL（新功能 + 无邮箱） ==");
  const captured = {};
  const { getEl } = makeEnv2({});
  globalThis.window = { open(url) { captured.url = url; } };
  new Function(pageScript)();
  await new Promise((r) => setTimeout(r, 50));
  getEl("reqTitle").value = "新功能 建议增加成就系统";
  getEl("reqType").value = "新功能";
  getEl("reqEmail").value = "";
  getEl("reqForm")._handlers.submit({ preventDefault() {}, target: { reset() {} } });
  const q = new URL(captured.url).searchParams;
  ok(q.get("labels") === "issue/feature", "新功能 → labels=issue/feature");
  ok(q.get("body").includes("联系邮箱：") === false, "邮箱留空时 body 不含联系邮箱行");
  ok(q.get("title") === "新功能 建议增加成就系统", "title 参数正确");
  delete globalThis.window;
}

// 场景 J：优化建议 → labels=issue/feature
{
  console.log("== 场景 J：表单提交 → GitHub Issue URL（优化建议） ==");
  const captured = {};
  const { getEl } = makeEnv2({});
  globalThis.window = { open(url) { captured.url = url; } };
  new Function(pageScript)();
  await new Promise((r) => setTimeout(r, 50));
  getEl("reqTitle").value = "优化建议 提升 UI 对比度";
  getEl("reqType").value = "优化建议";
  getEl("reqEmail").value = "";
  getEl("reqForm")._handlers.submit({ preventDefault() {}, target: { reset() {} } });
  ok(new URL(captured.url).searchParams.get("labels") === "issue/feature", "优化建议 → labels=issue/feature");
  delete globalThis.window;
}

// 语法校验
new Function(pageScript);
console.log("\n页面 script 语法校验通过");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
