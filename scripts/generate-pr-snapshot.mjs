#!/usr/bin/env node
/**
 * [S3] GitHub PR 静态快照生成器
 *
 * 作用：拉取 jerrybw/free-will-sandbox 仓库的全部 open PR，聚合每个 PR 的
 *       「PR L1 Check」检查结论与机器人报告摘要，生成静态快照
 *       public/data/pr-snapshot.json，供 dev-progress.html「PR 状态分区」直接读取
 *       （保持纯前端架构，前端只读静态 JSON）。
 *
 * 用法：node scripts/generate-pr-snapshot.mjs
 * 环境变量：
 *   GITHUB_TOKEN（可选）——存在时携带 Authorization 头，提升 API 速率限额；
 *                          GitHub Actions 内使用内置 github.token 注入。
 *                          注：本仓库为公开仓库，匿名即可读；带 token 仅为提升限额。
 *
 * 输出 schema（schemaVersion 1）：
 * { schemaVersion, generatedAt, source: "github-prs", repo,
 *   counts: { open, checksPassed, checksFailed, checksPending },
 *   prs: [{ number, title, author, headRef, baseRef, createdAt, url, labels,
 *           check: { conclusion: "pass"|"fail"|"pending"|"none", summary, runUrl } }] }
 *
 * 数据来源与降级：
 *   - open PR 列表：GET /repos/{repo}/pulls?state=open&per_page=100；
 *     draft PR 保留展示，以 "draft" 标签标记
 *   - 检查结论：GET /repos/{repo}/commits/{head.sha}/check-runs 过滤 name=="PR L1 Check"
 *     取最新一条；本地匿名受限（403）或无匹配时降级 conclusion="none"，不中断生成
 *   - 报告摘要：PR 评论中带 <!-- pr-l1-check --> 标记的 bot 评论首行（≤120 字符）
 *
 * 防循环：快照 commit 带 [skip ci]；pr-check 仅由 pull_request 事件触发，
 * 不会被快照 commit 触发；workflow_run 触发本身不受 push paths 限制，链路自洽。
 *
 * 测试：buildHeaders / extractSummary / mapCheckConclusion / toSnapshot / stablePart
 *       均导出纯函数，由 scripts/test-generate-pr-snapshot.mjs 单测覆盖，
 *       不触发网络与写文件。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = "jerrybw/free-will-sandbox";
const PULLS_API = `https://api.github.com/repos/${REPO}/pulls?state=open&per_page=100&page=1`;
const OUT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "public",
  "data",
  "pr-snapshot.json"
);
const SCHEMA_VERSION = 1;
const CHECK_RUN_NAME = "PR L1 Check"; // 与 pr-check.yml 的 job name 保持一致
const REPORT_MARKER = "<!-- pr-l1-check -->"; // 与 pr-l1-check.mjs 的报告标记保持一致
const SUMMARY_MAX_LEN = 120;

/** 构造 GitHub API 请求头；可选 GITHUB_TOKEN 时携带 Authorization */
export function buildHeaders(token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "free-will-sandbox-pr-snapshot",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

/**
 * 报告摘要：取评论首个非空行（去除首尾空白），截断至 120 字符（超出以 … 结尾）。
 * @param {string} body PR bot 评论正文
 * @returns {string}
 */
export function extractSummary(body) {
  const line =
    String(body || "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) || "";
  return line.length > SUMMARY_MAX_LEN ? line.slice(0, SUMMARY_MAX_LEN - 1) + "…" : line;
}

/**
 * 从 check-runs 列表中取「PR L1 Check」最新一条并映射结论：
 *   success → pass；failure/timed_out/action_required/cancelled → fail；
 *   无结论（queued/in_progress）→ pending；neutral/skipped/stale 或无匹配 → none。
 * 最新判定：按 completed_at（缺省回退 started_at）倒序，再按 id 倒序兜底。
 * @param {Array<object>} checkRuns GET /commits/{sha}/check-runs 返回的 check_runs 数组
 * @returns {{conclusion: "pass"|"fail"|"pending"|"none", runUrl: string}}
 */
export function mapCheckConclusion(checkRuns) {
  const mine = (Array.isArray(checkRuns) ? checkRuns : []).filter(
    (r) => r && r.name === CHECK_RUN_NAME
  );
  if (!mine.length) return { conclusion: "none", runUrl: "" };
  mine.sort((a, b) => {
    const ta = Date.parse(a.completed_at || a.started_at || "") || 0;
    const tb = Date.parse(b.completed_at || b.started_at || "") || 0;
    return tb - ta || (b.id || 0) - (a.id || 0);
  });
  const latest = mine[0];
  const FAIL = new Set(["failure", "timed_out", "action_required", "cancelled"]);
  let conclusion;
  if (latest.conclusion === "success") conclusion = "pass";
  else if (FAIL.has(latest.conclusion)) conclusion = "fail";
  else if (latest.conclusion == null || latest.status === "queued" || latest.status === "in_progress") {
    conclusion = "pending";
  } else {
    conclusion = "none"; // neutral / skipped / stale 等不适用场景
  }
  return { conclusion, runUrl: latest.html_url || "" };
}

/**
 * 将 API 原始 PR 条目与预取的检查详情组装为快照 schema。
 * @param {Array<object>} prItems GET /pulls 原始条目
 * @param {Object<number, {conclusion: string, summary: string, runUrl: string}>} details 按 PR number 索引的检查详情
 */
export function toSnapshot(prItems, details = {}) {
  const prs = (Array.isArray(prItems) ? prItems : []).map((pr) => {
    const labels = (Array.isArray(pr.labels) ? pr.labels : [])
      .map((l) => (typeof l === "string" ? l : l && l.name))
      .filter(Boolean);
    if (pr.draft) labels.push("draft"); // draft PR 保留展示，以 draft 标签标记
    const fallback = { conclusion: "none", summary: "", runUrl: "" };
    const d = (details && details[pr.number]) || fallback;
    return {
      number: pr.number,
      title: pr.title ?? "",
      author: (pr.user && pr.user.login) || "unknown",
      headRef: (pr.head && pr.head.ref) || "",
      baseRef: (pr.base && pr.base.ref) || "",
      createdAt: pr.created_at ?? "",
      url: pr.html_url ?? "",
      labels,
      check: {
        conclusion: d.conclusion || "none",
        summary: d.summary || "",
        runUrl: d.runUrl || "",
      },
    };
  });
  const counts = {
    open: prs.length,
    checksPassed: prs.filter((p) => p.check.conclusion === "pass").length,
    checksFailed: prs.filter((p) => p.check.conclusion === "fail").length,
    checksPending: prs.filter((p) => p.check.conclusion === "pending").length,
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    source: "github-prs",
    repo: REPO,
    counts,
    prs,
  };
}

/** 剔除 generatedAt 后的实质内容：仅时间戳变化不算快照变化，避免空提交堆积 */
export function stablePart(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return JSON.stringify(snapshot);
  const { generatedAt, ...rest } = snapshot;
  return JSON.stringify(rest);
}

/** 拉取 open PR 列表（支持可选 GITHUB_TOKEN） */
export async function fetchOpenPulls(token) {
  const res = await fetch(PULLS_API, { headers: buildHeaders(token) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `GitHub API ${res.status} ${res.statusText}${text ? " - " + text.slice(0, 200) : ""}`
    );
  }
  return res.json();
}

/** 拉取指定 commit 的 check-runs（返回 check_runs 数组；非 2xx 抛错由调用方降级） */
export async function fetchCheckRuns(headSha, token) {
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/commits/${headSha}/check-runs?per_page=100`,
    { headers: buildHeaders(token) }
  );
  if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText}`);
  const data = await res.json();
  return (data && data.check_runs) || [];
}

/** 拉取指定 PR 的评论列表（非 2xx 抛错由调用方降级） */
export async function fetchIssueComments(prNumber, token) {
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/issues/${prNumber}/comments?per_page=100`,
    { headers: buildHeaders(token) }
  );
  if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText}`);
  return res.json();
}

async function main() {
  console.log(`[pr-snapshot] 拉取 ${REPO} open pulls ...`);
  const pulls = await fetchOpenPulls(process.env.GITHUB_TOKEN);
  const details = {};
  for (const pr of pulls) {
    const d = { conclusion: "none", summary: "", runUrl: "" };
    // 检查结论：本地匿名受限（403）等导致读取失败时降级 none，不中断快照生成
    try {
      const runs = await fetchCheckRuns(pr.head && pr.head.sha, process.env.GITHUB_TOKEN);
      const mapped = mapCheckConclusion(runs);
      d.conclusion = mapped.conclusion;
      d.runUrl = mapped.runUrl;
    } catch (e) {
      console.warn(`[pr-snapshot] PR #${pr.number} check-runs 读取失败，降级为 none：${(e && e.message) || e}`);
    }
    // 报告摘要：从带 <!-- pr-l1-check --> 标记的 bot 评论首行提取；失败静默降级为空
    try {
      const comments = await fetchIssueComments(pr.number, process.env.GITHUB_TOKEN);
      const bot = (Array.isArray(comments) ? comments : []).find(
        (c) => typeof c.body === "string" && c.body.includes(REPORT_MARKER)
      );
      if (bot) d.summary = extractSummary(bot.body);
    } catch (e) {
      console.warn(`[pr-snapshot] PR #${pr.number} 评论读取失败，摘要留空：${(e && e.message) || e}`);
    }
    details[pr.number] = d;
  }
  const snapshot = toSnapshot(pulls, details);
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  let existing = null;
  try {
    existing = JSON.parse(readFileSync(OUT_PATH, "utf8"));
  } catch {
    existing = null; // 首次生成或现有文件损坏，均视为有变化
  }
  if (existing && stablePart(existing) === stablePart(snapshot)) {
    console.log(
      `[pr-snapshot] 快照实质内容无变化（仅时间戳不同），保留原文件跳过写入，避免空提交堆积`
    );
  } else {
    writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
    console.log(`[pr-snapshot] 生成完成: ${OUT_PATH}`);
  }
  console.log(
    `[pr-snapshot] open=${snapshot.counts.open} pass=${snapshot.counts.checksPassed} fail=${snapshot.counts.checksFailed} pending=${snapshot.counts.checksPending} generatedAt=${snapshot.generatedAt}`
  );
}

// 仅在直接执行时运行主流程（被 import 时不触发网络与写文件，便于单测）
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((err) => {
    console.error("[pr-snapshot] 生成失败:", (err && err.message) || err);
    process.exit(1);
  });
}
