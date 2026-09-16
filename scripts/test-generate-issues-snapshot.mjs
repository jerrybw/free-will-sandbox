#!/usr/bin/env node
/**
 * [S2] generate-issues-snapshot.mjs 解析逻辑单测（临时验证脚本）
 *
 * 背景：本地出口 IP 触发 GitHub API 匿名限流（403 rate limit exceeded），
 *       无法在本地生成真实快照。本单测通过模拟 GitHub API 响应结构，
 *       验证快照生成脚本的解析逻辑正确；真实数据生成由 GitHub Actions
 *       内置 GITHUB_TOKEN（或主人 PAT 补 Issues read 权限）执行。
 *
 * 运行：node scripts/test-generate-issues-snapshot.mjs（无三方依赖，全部断言内置）
 */
import { buildHeaders, inferType, bodyExcerpt, toSnapshot, fetchIssues } from "./generate-issues-snapshot.mjs";

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name}`); }
}
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), `${name}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`); }

console.log("== buildHeaders ==");
const h0 = buildHeaders(undefined);
ok(!("Authorization" in h0), "无 token 时不携带 Authorization");
eq(h0["User-Agent"], "free-will-sandbox-snapshot", "匿名请求携带 User-Agent");
const h1 = buildHeaders("test-token-placeholder");
eq(h1["Authorization"], "Bearer test-token-placeholder", "有 token 时携带 Bearer Authorization");

console.log("== inferType ==");
eq(inferType(["issue/bug"]), "bug", "issue/bug → bug");
eq(inferType(["issue/feature"]), "feature", "issue/feature → feature");
eq(inferType(["issue/ux"]), "ux", "issue/ux → ux");
eq(inferType(["issue/other"]), "other", "issue/other → other");
eq(inferType(["enhancement", "issue/bug", "gameplay"]), "bug", "混合 labels 中命中前缀优先");
eq(inferType([]), "other", "空 labels → other");
eq(inferType(["enhancement"]), "other", "未知 label → other");
eq(inferType([{ name: "issue/ux" }]), "ux", "对象形式 label（API 原始结构）→ ux");

console.log("== bodyExcerpt ==");
eq(bodyExcerpt(null), "", "null body → 空串");
eq(bodyExcerpt(""), "", "空串 body → 空串");
eq(bodyExcerpt("第一行\n第二行\r\n第三行"), "第一行 第二行 第三行", "去除换行合并为单行");
eq(bodyExcerpt("  多  余   空格  "), "多 余 空格", "压缩多余空白");
const long = "字".repeat(600);
const cut = bodyExcerpt(long);
ok(cut.length === 500 && cut.endsWith("…"), `超 500 字符截断为 500 且以…结尾（实际 ${cut.length}）`);

console.log("== toSnapshot（模拟 GitHub API 响应结构） ==");
// 模拟 GitHub /issues 响应：含 1 条 PR（应过滤）、4 类 issue、1 条无 label、1 条空 body
const apiItems = [
  { number: 101, title: "PR 不应出现", pull_request: { html_url: "https://github.com/jerrybw/free-will-sandbox/pull/101" }, user: { login: "alice" }, labels: [{ name: "issue/bug" }], state: "open", created_at: "2026-09-15T01:00:00Z", updated_at: "2026-09-15T02:00:00Z", html_url: "https://github.com/jerrybw/free-will-sandbox/pull/101", body: "x" },
  { number: 12, title: "酿造台点击负数增量越界", user: { login: "alice" }, labels: [{ name: "issue/bug" }, { name: "p1" }], state: "open", created_at: "2026-09-15T01:00:00Z", updated_at: "2026-09-15T02:00:00Z", html_url: "https://github.com/jerrybw/free-will-sandbox/issues/12", body: "步骤一\n步骤二\r\n步骤三" },
  { number: 13, title: "希望增加成就系统", user: { login: "bob" }, labels: ["issue/feature"], state: "open", created_at: "2026-09-14T10:00:00Z", updated_at: "2026-09-14T11:00:00Z", html_url: "https://github.com/jerrybw/free-will-sandbox/issues/13", body: "想要里程碑徽章" },
  { number: 14, title: "UI 配色偏暗", user: { login: "carol" }, labels: [{ name: "issue/ux" }], state: "open", created_at: "2026-09-14T09:00:00Z", updated_at: "2026-09-14T09:30:00Z", html_url: "https://github.com/jerrybw/free-will-sandbox/issues/14", body: "希望更明亮的主题" },
  { number: 15, title: "咨询合作事宜", user: { login: "dave" }, labels: [{ name: "issue/other" }], state: "open", created_at: "2026-09-13T09:00:00Z", updated_at: "2026-09-13T09:30:00Z", html_url: "https://github.com/jerrybw/free-will-sandbox/issues/15", body: "" },
  { number: 16, title: "无 label 与无 user 兜底", user: null, labels: [], state: "open", created_at: "2026-09-13T08:00:00Z", updated_at: "2026-09-13T08:30:00Z", html_url: "https://github.com/jerrybw/free-will-sandbox/issues/16", body: null },
];
const snap = toSnapshot(apiItems);
eq(snap.schemaVersion, 1, "schemaVersion = 1");
eq(snap.source, "github-issues", "source = github-issues");
eq(snap.repo, "jerrybw/free-will-sandbox", "repo 字段");
eq(snap.counts.open, 5, "PR 被过滤后 open 计数 = 5");
eq(snap.counts.byType, { bug: 1, feature: 1, ux: 1, other: 2 }, "byType 统计正确");
ok(snap.issues.every((i) => i.number !== 101), "pull_request 条目已过滤");
eq(snap.issues.map((i) => i.type), ["bug", "feature", "ux", "other", "other"], "type 推断序列");
eq(snap.issues[0].bodyExcerpt, "步骤一 步骤二 步骤三", "bodyExcerpt 去换行");
eq(snap.issues[4].bodyExcerpt, "", "空 body → 空摘要");
eq(snap.issues[4].author, "unknown", "缺失 user → unknown 兜底");
eq(snap.issues[4].state, "open", "state 字段");
const fields = ["number", "title", "type", "state", "author", "createdAt", "updatedAt", "url", "labels", "bodyExcerpt"];
ok(snap.issues.every((i) => fields.every((f) => f in i)), "每条 issue 均含完整 schema 字段");
ok(!Number.isNaN(Date.parse(snap.generatedAt)), "generatedAt 为合法 ISO 时间");
eq(snap.issues[0].labels, ["issue/bug", "p1"], "labels 保留原始 label 名");
eq(toSnapshot([]).counts, { open: 0, byType: { bug: 0, feature: 0, ux: 0, other: 0 } }, "空列表 → 全 0 计数");

console.log("== fetchIssues（mock globalThis.fetch 错误路径） ==");
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
    statusText: "Forbidden",
    text: async () => '{"message":"API rate limit exceeded"}',
  });
  try {
    await fetchIssues();
    ok(false, "403 响应应抛出错误");
  } catch (e) {
    ok(String(e.message).includes("GitHub API 403"), "403 响应抛出含状态码的错误信息");
  }
  globalThis.fetch = realFetch;
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
