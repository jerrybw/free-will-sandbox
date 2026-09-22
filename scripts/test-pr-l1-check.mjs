#!/usr/bin/env node
/**
 * [S3] pr-l1-check.mjs 纯函数单测
 *
 * 运行：node scripts/test-pr-l1-check.mjs（无三方依赖，全部断言内置）
 * 说明：样例敏感词一律用字符串拼接构造（如 "赌" + "博"），避免测试源码自身
 *       出现连续敏感词，在真实 PR 的红线扫描中被误命中。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadRedlineConfig,
  isRedlineExcluded,
  parseDiffAddedLines,
  scanAddedLines,
  gzipSize,
  evaluateBudget,
  BUDGET_LIMIT_BYTES,
  collectBudgetFiles,
  checkBuildChain,
  findIssueRefs,
  checkPrLink,
  buildReport,
  MARKER,
} from "./pr-l1-check.mjs";

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name}`); }
}
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), `${name}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`); }

// 加载真实词表（与运行时同路径），供后续扫描类断言使用
const scriptDir = dirname(fileURLToPath(import.meta.url));
const realConfig = loadRedlineConfig(readFileSync(resolve(scriptDir, "config", "redline-words.json"), "utf8"));

// 拼接构造的样例词（避免测试源码自身命中红线）
const W_GAMBLE = "赌" + "博";
const W_VIOLENT = "分" + "尸";
const W_DRUG = "毒" + "品";
const W_WARN = "私聊" + "转账";

console.log("== loadRedlineConfig（词表加载与 schema 校验） ==");
ok(typeof realConfig.version === "number" && realConfig.version >= 1, "词表 version 为 ≥1 的数字");
ok(Array.isArray(realConfig.categories) && realConfig.categories.length >= 4, "categories 数量 ≥ 4（血腥暴力/色情低俗/赌博/违禁品）");
ok(realConfig.categories.every((c) => c.level === "fail" || c.level === "warn"), "每个分类 level 均为 fail|warn");
ok(realConfig.categories.every((c) => Array.isArray(c.words) && c.words.length >= 5), "每个分类 words ≥ 5 个");
ok(realConfig.categories.some((c) => c.level === "fail"), "存在 fail 级分类");
ok(realConfig.categories.some((c) => c.level === "warn"), "存在 warn 级分类");
ok(realConfig.categories.every((c) => c.words.every((w) => typeof w === "string" && w.trim())), "所有词均为非空字符串");
ok((() => { try { loadRedlineConfig({ categories: [{ name: "x", level: "bad", words: ["a"] }] }); return false; } catch { return true; } })(), "非法 level 抛出错误");
ok((() => { try { loadRedlineConfig({}); return false; } catch { return true; } })(), "缺失 categories 抛出错误");
ok((() => { try { loadRedlineConfig('{"categories":[{"name":"x","level":"fail","words":[""]}]}'); return false; } catch { return true; } })(), "空字符串词抛出错误");

console.log("== isRedlineExcluded（扫描排除范围） ==");
eq(isRedlineExcluded("scripts/config/redline-words.json"), true, "词表文件自身被排除");
eq(isRedlineExcluded(".github/workflows/ci.yml"), true, ".github/workflows 下 yml 被排除");
eq(isRedlineExcluded(".github/workflows/ci.yaml"), true, ".github/workflows 下 yaml 被排除");
eq(isRedlineExcluded("scripts/other.yml"), false, "工作流目录外的 yml 不排除");
eq(isRedlineExcluded("src/game.js"), false, "普通源码文件不排除");
eq(isRedlineExcluded(null), true, "空路径（/dev/null 等）跳过");

console.log("== parseDiffAddedLines / scanAddedLines（红线扫描） ==");
const diffSample = [
  "diff --git a/src/game.js b/src/game.js",
  "index 1111111..2222222 100644",
  "--- a/src/game.js",
  "+++ b/src/game.js",
  "@@ -10,3 +10,4 @@ function tick() {",
  "  const a = 1;",
  "-  const b = 2;",
  `+  showAd("${W_GAMBLE}平台推广");`,
  " ",
  "@@ -40,2 +41,3 @@",
  `+ 别处含${W_VIOLENT}样例`,
].join("\n");
const parsed = parseDiffAddedLines(diffSample);
eq(parsed.length, 2, "仅提取 + 新增行（2 行）");
eq(parsed.map((p) => p.line), [11, 41], "跨 hunk 新文件行号正确（11 / 41）");
const hitsSample = scanAddedLines(diffSample, realConfig);
eq(hitsSample.length, 2, "两条新增行各命中 1 类");
eq(hitsSample[0], { file: "src/game.js", line: 11, category: "赌博", level: "fail" }, "fail 词命中：文件/行号/类别/级别");
eq(hitsSample[1].category, "血腥暴力", "第二条命中类别正确");

const diffGameTerms = [
  "diff --git a/src/game.js b/src/game.js",
  "--- a/src/game.js",
  "+++ b/src/game.js",
  "@@ -1,1 +1,3 @@",
  "+const core = '源质'; const crystal = '晶核';",
  "+const craft = 合成('源质', '晶核');",
].join("\n");
eq(scanAddedLines(diffGameTerms, realConfig), [], "游戏术语（源质/晶核/合成）不命中");

const diffWarn = [
  "diff --git a/docs/post.md b/docs/post.md",
  "--- a/docs/post.md",
  "+++ b/docs/post.md",
  "@@ -1,1 +1,2 @@",
  `+客服引导${W_WARN}处理退款`,
].join("\n");
const warnHits = scanAddedLines(diffWarn, realConfig);
eq(warnHits.length, 1, "warn 词命中 1 条");
eq(warnHits[0].level, "warn", "warn 词命中记 warn 级");
eq(warnHits[0].category, "疑似违规营销", "warn 词命中类别正确");

const diffMulti = [
  "diff --git a/x.txt b/x.txt",
  "--- a/x.txt",
  "+++ b/x.txt",
  "@@ -1,1 +1,1 @@",
  `+同时含${W_GAMBLE}和${W_DRUG}内容`,
].join("\n");
eq(scanAddedLines(diffMulti, realConfig).map((h) => h.category).sort(), ["赌博", "违禁品"], "同一行多类别分别命中");

const diffSelf = [
  "diff --git a/scripts/config/redline-words.json b/scripts/config/redline-words.json",
  "--- /dev/null",
  "+++ b/scripts/config/redline-words.json",
  "@@ -0,0 +1,2 @@",
  `+{"words":["${W_GAMBLE}"]}`,
].join("\n");
eq(scanAddedLines(diffSelf, realConfig), [], "词表文件自身被排除不扫描");

const diffWorkflow = [
  "diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml",
  "--- a/.github/workflows/ci.yml",
  "+++ b/.github/workflows/ci.yml",
  "@@ -1,1 +1,2 @@",
  `+echo "${W_GAMBLE}样例"`,
].join("\n");
eq(scanAddedLines(diffWorkflow, realConfig), [], ".github/workflows 下 yml 被排除不扫描");

const diffOtherYml = [
  "diff --git a/docs/ci.yml b/docs/ci.yml",
  "--- a/docs/ci.yml",
  "+++ b/docs/ci.yml",
  "@@ -1,1 +1,2 @@",
  `+echo "${W_GAMBLE}样例"`,
].join("\n");
eq(scanAddedLines(diffOtherYml, realConfig).length, 1, "工作流目录外的 yml 仍会被扫描");

const diffEnglish = [
  "diff --git a/src/ad.js b/src/ad.js",
  "--- a/src/ad.js",
  "+++ b/src/ad.js",
  "@@ -1,1 +1,2 @@",
  "+window.open('Visit our CASINO for GAMBLING now');",
].join("\n");
eq(scanAddedLines(diffEnglish, realConfig)[0].category, "赌博", "英文词大小写不敏感命中（CASINO/GAMBLING）");

console.log("== 包体预算（gzip 计算与边界） ==");
eq(BUDGET_LIMIT_BYTES, 15 * 1024, "预算上限常量 = 15360 字节");
eq(evaluateBudget(15 * 1024 - 1).pass, true, "15359 字节 < 上限 → pass");
eq(evaluateBudget(15 * 1024).pass, false, "恰好 15360 字节 → fail（严格小于）");
eq(evaluateBudget(0).pass, true, "0 字节 → pass");
eq(evaluateBudget(10, 10).pass, false, "自定义上限 10、总量 10 → fail");
eq(evaluateBudget(9, 10).pass, true, "自定义上限 10、总量 9 → pass");
ok(gzipSize("a".repeat(1000)) < 1000, "gzip 可压缩重复内容（1000 字节原文 < 1000）");
ok(gzipSize("") > 0, "空内容 gzip 后仍有固定头部字节");
const scriptFiles = collectBudgetFiles(scriptDir);
ok(scriptFiles.some((p) => p.includes("redline-words.json")), "collectBudgetFiles 收集 .json 文件");
ok(!scriptFiles.some((p) => p.endsWith(".mjs")), "collectBudgetFiles 排除非预算扩展名（.mjs）");
eq(collectBudgetFiles(resolve(scriptDir, "不存在的目录")).length, 0, "目录不存在 → 空数组");

console.log("== checkBuildChain（构建链汇总） ==");
eq(checkBuildChain({ typecheck: "pass", build: "pass" }).every((i) => i.status === "pass"), true, "双 pass → 全部 pass");
eq(checkBuildChain({ typecheck: "pass", build: "fail" }).find((i) => i.id === "build").status, "fail", "build fail → fail 项");
ok(checkBuildChain({ typecheck: "pass", build: "fail" }).find((i) => i.id === "build").suggestion.includes("npm run build"), "fail 项附带修复建议");
eq(checkBuildChain({}).every((i) => i.status === "notice"), true, "缺省 env → 提示项（本地调试模式）");

console.log("== findIssueRefs / checkPrLink（关联检测） ==");
eq(findIssueRefs("修复 #12 的同时处理 #7"), ["#7", "#12"], "#N 引用提取并按编号升序去重");
eq(findIssueRefs("fixes #31 and closes #8"), ["#8", "#31"], "fixes/closes 关键字形式引用");
eq(findIssueRefs("关联 issue 12"), ["#12"], "issue N（无 #）形式引用");
eq(findIssueRefs("没有任何编号引用"), [], "无引用 → 空数组");
eq(checkPrLink("见 #9").status, "pass", "有关联 → pass");
const noLink = checkPrLink("没有任何编号引用");
eq(noLink.status, "notice", "无关联 → 提示级（不计失败）");
ok(noLink.suggestion.includes("建议在描述中关联 Issue 编号"), "提示项携带建议语");

console.log("== buildReport（报告生成） ==");
const items = [
  { id: "a", title: "构建链 · typecheck", status: "pass", detail: ["步骤结果：pass"], suggestion: "" },
  { id: "b", title: "包体预算", status: "fail", detail: ["gzip 总量：20000 字节"], suggestion: "压缩资源降至 15KB 以内" },
  { id: "c", title: "关联检查", status: "notice", detail: ["未发现引用"], suggestion: "建议在描述中关联 Issue 编号" },
];
const report = buildReport({ prNumber: "12", items, baseRef: "origin/main", generatedAt: "2026-09-22T10:00:00Z" });
ok(report.endsWith(MARKER + "\n"), "报告以 <!-- pr-l1-check --> 标记结尾");
eq(report.indexOf(MARKER), report.lastIndexOf(MARKER), "标记全文仅出现一次");
ok(report.includes("❌") && report.includes("修复建议：压缩资源"), "失败项含 ❌ 与修复建议");
ok(report.includes("⚠️") && report.includes("💡"), "提示项含 ⚠️ 与建议");
ok(report.split("\n")[0].includes("PR L1 检查报告（PR #12）") && report.split("\n")[0].includes("1 通过 / 1 失败 / 1 提示"), "首行摘要含结论与计数");
ok(report.includes("`origin/main`"), "报告含 diff 基线");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
