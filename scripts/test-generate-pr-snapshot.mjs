#!/usr/bin/env node
/**
 * [S3] generate-pr-snapshot.mjs 纯函数单测
 *
 * 运行：node scripts/test-generate-pr-snapshot.mjs（无三方依赖，全部断言内置）
 * 通过模拟 GitHub API 响应结构验证解析逻辑，不触发网络与写文件。
 */
import {
  buildHeaders,
  extractSummary,
  mapCheckConclusion,
  toSnapshot,
  stablePart,
} from "./generate-pr-snapshot.mjs";

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name}`); }
}
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), `${name}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`); }

console.log("== buildHeaders ==");
ok(!("Authorization" in buildHeaders(undefined)), "无 token 时不携带 Authorization");
eq(buildHeaders("tk")["Authorization"], "Bearer tk", "有 token 时携带 Bearer Authorization");

console.log("== extractSummary（bot 评论首行摘要 ≤120 字符） ==");
eq(extractSummary("## 第一行摘要\n第二行"), "## 第一行摘要", "取首个非空行");
eq(extractSummary("\n \n  实际首行  \n后续"), "实际首行", "跳过前置空行并去首尾空白");
eq(extractSummary(""), "", "空正文 → 空串");
eq(extractSummary(null), "", "null 正文 → 空串");
{
  const long = "字".repeat(130);
  const cut = extractSummary(long);
  ok(cut.length === 120 && cut.endsWith("…"), `超 120 字符截断为 120 且以…结尾（实际 ${cut.length}）`);
}
eq(extractSummary("字".repeat(120)), "字".repeat(120), "恰好 120 字符不截断");

console.log("== mapCheckConclusion（check-runs 过滤与结论映射） ==");
eq(mapCheckConclusion([]), { conclusion: "none", runUrl: "" }, "空列表 → none");
eq(mapCheckConclusion([{ name: "Other Check", conclusion: "success" }]), { conclusion: "none", runUrl: "" }, "无同名 check run → none");
eq(
  mapCheckConclusion([{ name: "PR L1 Check", status: "completed", conclusion: "success", html_url: "https://run/1" }]),
  { conclusion: "pass", runUrl: "https://run/1" },
  "success → pass 且带 runUrl"
);
eq(mapCheckConclusion([{ name: "PR L1 Check", status: "completed", conclusion: "failure", html_url: "https://run/2" }]).conclusion, "fail", "failure → fail");
eq(mapCheckConclusion([{ name: "PR L1 Check", status: "completed", conclusion: "timed_out" }]).conclusion, "fail", "timed_out → fail");
eq(mapCheckConclusion([{ name: "PR L1 Check", status: "in_progress", conclusion: null }]).conclusion, "pending", "进行中（无结论）→ pending");
eq(mapCheckConclusion([{ name: "PR L1 Check", status: "completed", conclusion: "skipped" }]).conclusion, "none", "skipped → none");
eq(
  mapCheckConclusion([
    { id: 1, name: "PR L1 Check", status: "completed", conclusion: "success", completed_at: "2026-09-20T10:00:00Z" },
    { id: 2, name: "PR L1 Check", status: "completed", conclusion: "failure", completed_at: "2026-09-21T10:00:00Z" },
  ]).conclusion,
  "fail",
  "取最新一次运行（新 failure 覆盖旧 success）"
);
eq(
  mapCheckConclusion([
    { id: 1, name: "PR L1 Check", status: "completed", conclusion: "success", html_url: "https://run/old" },
    { id: 2, name: "PR L1 Check", status: "completed", conclusion: "failure", html_url: "https://run/new" },
  ]).runUrl,
  "https://run/new",
  "runUrl 取最新一次运行"
);

console.log("== toSnapshot（PR 条目转换与 counts 汇总） ==");
const prItems = [
  {
    number: 12, title: "fix: 修复负数越界", draft: false,
    user: { login: "jerrybw" },
    head: { ref: "fix/negative", sha: "abc" }, base: { ref: "main" },
    created_at: "2026-09-21T15:30:00Z", html_url: "https://github.com/jerrybw/free-will-sandbox/pull/12",
    labels: [{ name: "bug" }, "enhancement"],
  },
  {
    number: 11, title: "feat: 新玩法", draft: true,
    user: null,
    head: { ref: "feat/x", sha: "def" }, base: { ref: "main" },
    created_at: "2026-09-20T09:10:00Z", html_url: "https://github.com/jerrybw/free-will-sandbox/pull/11",
    labels: [],
  },
];
const details = {
  12: { conclusion: "pass", summary: "## 🤖 PR L1 检查报告（PR #12）：✅ 通过（4 通过 / 0 失败 / 1 提示）", runUrl: "https://run/1" },
  11: { conclusion: "fail", summary: "", runUrl: "https://run/2" },
};
const snap = toSnapshot(prItems, details);
eq(snap.schemaVersion, 1, "schemaVersion = 1");
eq(snap.source, "github-prs", "source = github-prs");
eq(snap.repo, "jerrybw/free-will-sandbox", "repo 字段");
eq(snap.counts, { open: 2, checksPassed: 1, checksFailed: 1, checksPending: 0 }, "counts 汇总正确");
eq(snap.prs[0].author, "jerrybw", "author 取 user.login");
eq(snap.prs[1].author, "unknown", "缺失 user → unknown 兜底");
eq(snap.prs[0].headRef, "fix/negative", "headRef 字段");
eq(snap.prs[0].baseRef, "main", "baseRef 字段");
eq(snap.prs[0].labels, ["bug", "enhancement"], "labels 归一化（对象/字符串混合形式）");
ok(snap.prs[1].labels.includes("draft"), "draft PR 保留并以 draft 标签标记");
eq(snap.prs[0].check, { conclusion: "pass", summary: "## 🤖 PR L1 检查报告（PR #12）：✅ 通过（4 通过 / 0 失败 / 1 提示）", runUrl: "https://run/1" }, "check 详情注入");
eq(snap.prs[1].check.conclusion, "fail", "fail 详情注入");
eq(toSnapshot(prItems).prs[0].check, { conclusion: "none", summary: "", runUrl: "" }, "缺失 details → check 降级 none 兜底");
eq(toSnapshot([], {}).counts, { open: 0, checksPassed: 0, checksFailed: 0, checksPending: 0 }, "空列表 → 全 0 计数");
ok(!Number.isNaN(Date.parse(snap.generatedAt)), "generatedAt 为合法 ISO 时间");

console.log("== stablePart（剔除 generatedAt 的实质内容对比） ==");
ok(stablePart(snap) === stablePart({ ...snap, generatedAt: "2027-01-01T00:00:00Z" }), "仅 generatedAt 变化视为无变化（防空提交堆积）");
ok(stablePart(snap) !== stablePart({ ...snap, counts: { ...snap.counts, open: 3 } }), "实质内容变化可被感知");
ok(stablePart(null) === "null", "非法输入安全序列化");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
