#!/usr/bin/env node
/**
 * [S4] GitHub 通知静态快照生成器
 *
 * 作用：拉取 jerrybw/free-will-sandbox 仓库的全部 Issues（state=all，含 closed，过滤 PR），
 *       收集机器人通知评论与工作流标签流转事件，生成静态快照
 *       public/data/notifications-snapshot.json，供 dev-progress.html「通知日志分区」
 *       直接读取（保持纯前端架构，前端只读静态 JSON）。
 *
 * 通知项来源（与 .github/workflows/issue-notify.yml 的机器人行为对应）：
 *   a. github-actions[bot] 评论：含「已受理」→ 受理确认；含「评审通过」或「未通过」→
 *      状态流转；含「已完成」→ 完成通知；无法归类 → 系统通知
 *   b. labeled 事件（label ∈ pending/approved/rejected/done）→ 标签流转，
 *      content =「Issue #N「标题前24字」 标签：X → Y」，X 取该 labeled 事件之前
 *      最近一次 unlabeled 的工作流标签（无则「无」）
 *
 * 用法：node scripts/generate-notifications-snapshot.mjs
 * 环境变量：
 *   GITHUB_TOKEN（可选）——存在时携带 Authorization 头，提升 API 速率限额；
 *                          GitHub Actions 内使用内置 github.token 注入。
 *                          注：本仓库为公开仓库，匿名即可读；带 token 仅为提升限额。
 *
 * 输出 schema（schemaVersion 1）：
 * { schemaVersion, generatedAt, source: "github-notifications", repo,
 *   counts: { total }, items: [{ id, time, type, content, status, url }] }
 * items 按 time 倒序，最多保留 30 条；status 固定 "unread"（展示层语义字段）。
 *
 * 测试：解析逻辑（buildHeaders / classifyComment / mapLabelEvent / toSnapshot 等）已导出，
 *       可被 scripts/test-generate-notifications-snapshot.mjs 单测覆盖，不触发网络与写文件。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = "jerrybw/free-will-sandbox";
const API_BASE = `https://api.github.com/repos/${REPO}`;
const ISSUES_API = `${API_BASE}/issues?state=all&per_page=100&page=1`;
const OUT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "public",
  "data",
  "notifications-snapshot.json"
);
const SCHEMA_VERSION = 1;
const MAX_ITEMS = 30;
const BOT_LOGIN = "github-actions[bot]";
/** 工作流标签集：与 issue-notify.yml 的受理/评审/完成流转标签一致 */
export const WORKFLOW_LABELS = new Set(["pending", "approved", "rejected", "done"]);

/** 构造 GitHub API 请求头；可选 GITHUB_TOKEN 时携带 Authorization */
export function buildHeaders(token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "free-will-sandbox-snapshot",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

/** 时间解析：无效时间返回 0（排序时沉底） */
function ts(s) {
  const d = Date.parse(s ?? "");
  return Number.isNaN(d) ? 0 : d;
}

/** 标题摘要：截断到前 24 字（超出补省略号），用于通知 content 拼装 */
export function titleExcerpt(title, max = 24) {
  const t = String(title ?? "");
  if (t.length <= max) return t;
  return t.slice(0, max) + "…";
}

/** bot 评论摘要：取正文首个非空行（即「标题行」），超长截断到 120 字符 */
export function commentSummary(body, max = 120) {
  const first =
    String(body ?? "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s.length > 0) || "";
  return first.length > max ? first.slice(0, max) + "…" : first;
}

/** bot 评论分类：已受理→受理确认；评审通过/未通过→状态流转；已完成→完成通知；其余→系统通知 */
export function classifyComment(body) {
  const text = String(body ?? "");
  if (text.includes("已受理")) return "受理确认";
  if (text.includes("评审通过") || text.includes("未通过")) return "状态流转";
  if (text.includes("已完成")) return "完成通知";
  return "系统通知";
}

/** 从 issue 的评论列表提取 bot 评论通知项（非 bot 评论一律排除，即使内容含关键词） */
export function extractCommentItems(issue, comments) {
  return (Array.isArray(comments) ? comments : [])
    .filter((c) => c && c.user && c.user.login === BOT_LOGIN)
    .map((c) => ({
      id: `n-${issue.number}-comment-${c.id ?? `${c.created_at ?? ""}-${c.user.login}`}`,
      time: c.created_at ?? "",
      type: classifyComment(c.body),
      content: `Issue #${issue.number}「${titleExcerpt(issue.title)}」 ${commentSummary(c.body)}`.trim(),
      status: "unread",
      url: c.html_url ?? issue.html_url ?? "",
    }));
}

/**
 * 单个 timeline 事件映射：仅处理 labeled 且标签属于工作流标签集的事件，其余返回 null。
 * fromLabel：调用方回放 timeline 时传入的「上一个工作流标签」（最近一次 unlabeled 的标签），
 * 用于拼装「标签：X → Y」；无上一个标签时传 null，展示为「无」。
 */
export function mapLabelEvent(ev, issue, fromLabel) {
  const label = ev && ev.label && ev.label.name;
  if (!ev || ev.event !== "labeled" || !WORKFLOW_LABELS.has(label)) return null;
  return {
    id: `n-${issue.number}-label-${ev.id ?? `${ev.created_at ?? ""}-${label}`}`,
    time: ev.created_at ?? "",
    type: "标签流转",
    content: `Issue #${issue.number}「${titleExcerpt(issue.title)}」 标签：${fromLabel ?? "无"} → ${label}`,
    status: "unread",
    url: issue.html_url ?? "",
  };
}

/**
 * 回放 issue 时间线（按时间正序），收集全部工作流标签流转通知项。
 * 规则：unlabeled 工作流标签 → 记为 fromLabel；labeled 工作流标签 → 产出「X → Y」
 * 通知项并把 fromLabel 更新为 Y；非工作流标签不影响状态。
 */
export function replayLabelEvents(issue, timeline) {
  const out = [];
  let fromLabel = null;
  const events = (Array.isArray(timeline) ? timeline : [])
    .filter((ev) => ev && (ev.event === "labeled" || ev.event === "unlabeled"))
    .sort((a, b) => ts(a.created_at) - ts(b.created_at));
  for (const ev of events) {
    const name = (ev.label && ev.label.name) || null;
    if (!name || !WORKFLOW_LABELS.has(name)) continue;
    if (ev.event === "unlabeled") {
      fromLabel = name;
      continue;
    }
    const item = mapLabelEvent(ev, issue, fromLabel);
    if (item) out.push(item);
    fromLabel = name;
  }
  return out;
}

/** issue 是否需要拉取详情：有评论，或当前带有任一工作流标签（命中即可能存在通知项） */
export function needsDetail(issue) {
  if (!issue) return false;
  if ((issue.comments ?? 0) > 0) return true;
  return (Array.isArray(issue.labels) ? issue.labels : []).some((l) =>
    WORKFLOW_LABELS.has(typeof l === "string" ? l : l && l.name)
  );
}

/** 将 [{ issue, comments, timeline }] 转换为快照 schema；过滤 PR 条目，按 time 倒序，最多 30 条 */
export function toSnapshot(entries) {
  const items = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const issue = entry && entry.issue;
    if (!issue || issue.pull_request) continue;
    items.push(...extractCommentItems(issue, entry.comments));
    items.push(...replayLabelEvents(issue, entry.timeline));
  }
  // 倒序（新在前）；同刻条目依赖稳定排序保持插入序
  items.sort((a, b) => ts(b.time) - ts(a.time));
  const trimmed = items.slice(0, MAX_ITEMS);
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    source: "github-notifications",
    repo: REPO,
    counts: { total: trimmed.length },
    items: trimmed,
  };
}

/** 剔除 generatedAt 后的实质内容：仅时间戳变化不算快照变化，避免空提交堆积 */
export function stablePart(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return JSON.stringify(snapshot);
  const { generatedAt, ...rest } = snapshot;
  return JSON.stringify(rest);
}

/** 通用 GET：返回解析后的 JSON；非 2xx 抛错（含状态码，便于定位限流/权限问题） */
export async function fetchJson(url, token) {
  const res = await fetch(url, { headers: buildHeaders(token) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `GitHub API ${res.status} ${res.statusText}${text ? " - " + text.slice(0, 200) : ""}`
    );
  }
  return res.json();
}

/** 拉取全部 issues（state=all，含 closed；调用方过滤 PR 条目） */
export async function fetchIssues(token) {
  return fetchJson(ISSUES_API, token);
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  console.log(`[notifications-snapshot] 拉取 ${REPO} 全部 issues（state=all）...`);
  const raw = await fetchIssues(token);
  const issues = (Array.isArray(raw) ? raw : []).filter((it) => it && !it.pull_request);
  const targets = issues.filter(needsDetail);
  console.log(
    `[notifications-snapshot] issues=${issues.length}（过滤 PR 后），需拉取评论/时间线=${targets.length}`
  );
  const entries = [];
  for (const issue of targets) {
    const [comments, timeline] = await Promise.all([
      fetchJson(`${API_BASE}/issues/${issue.number}/comments?per_page=100&page=1`, token),
      fetchJson(`${API_BASE}/issues/${issue.number}/timeline?per_page=100&page=1`, token),
    ]);
    entries.push({ issue, comments, timeline });
  }
  const snapshot = toSnapshot(entries);
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  let existing = null;
  try {
    existing = JSON.parse(readFileSync(OUT_PATH, "utf8"));
  } catch {
    existing = null; // 首次生成或现有文件损坏，均视为有变化
  }
  if (existing && stablePart(existing) === stablePart(snapshot)) {
    console.log(
      "[notifications-snapshot] 快照实质内容无变化（仅时间戳不同），保留原文件跳过写入，避免空提交堆积"
    );
  } else {
    writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
    console.log(`[notifications-snapshot] 生成完成: ${OUT_PATH}`);
  }
  console.log(
    `[notifications-snapshot] 通知项 total=${snapshot.counts.total} generatedAt=${snapshot.generatedAt}`
  );
}

// 仅在直接执行时运行主流程（被 import 时不触发网络与写文件，便于单测）
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((err) => {
    console.error("[notifications-snapshot] 生成失败:", (err && err.message) || err);
    process.exit(1);
  });
}
