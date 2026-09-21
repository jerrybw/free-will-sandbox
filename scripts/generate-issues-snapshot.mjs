#!/usr/bin/env node
/**
 * [S2] GitHub Issues 静态快照生成器
 *
 * 作用：拉取 jerrybw/free-will-sandbox 仓库的全部 open Issues（过滤 PR），
 *       生成静态快照 public/data/issues-snapshot.json，供 dev-progress.html
 *       「需求动态分区」直接读取（保持纯前端架构，前端只读静态 JSON）。
 *
 * 用法：node scripts/generate-issues-snapshot.mjs
 * 环境变量：
 *   GITHUB_TOKEN（可选）——存在时携带 Authorization 头，提升 API 速率限额；
 *                          GitHub Actions 内使用内置 github.token 注入。
 *                          注：本仓库为公开仓库，匿名即可读；带 token 仅为提升限额。
 *
 * 输出 schema（schemaVersion 1）：
 * { schemaVersion, generatedAt, source: "github-issues", repo,
 *   counts: { open, byType }, issues: [{ number, title, type, state, author,
 *   createdAt, updatedAt, url, labels, bodyExcerpt }] }
 *
 * type 推断规则：labels 中命中 issue/bug、issue/feature、issue/ux、issue/other
 * 则归对应类型，否则归 other。
 *
 * 测试：解析逻辑（buildHeaders / inferType / bodyExcerpt / toSnapshot）已导出，
 *       可被 scripts/test-generate-issues-snapshot.mjs 单测覆盖，不触发网络与写文件。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = "jerrybw/free-will-sandbox";
const ISSUES_API = `https://api.github.com/repos/${REPO}/issues?state=open&per_page=100&page=1`;
const OUT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "public",
  "data",
  "issues-snapshot.json"
);
const SCHEMA_VERSION = 1;
const TYPE_MAP = {
  "issue/bug": "bug",
  "issue/feature": "feature",
  "issue/ux": "ux",
  "issue/other": "other",
};

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

/** 从 labels 推断 issue 类型：命中 issue/* 前缀归对应类型，无匹配归 other */
export function inferType(labels) {
  for (const l of labels) {
    const name = typeof l === "string" ? l : l && l.name;
    if (name && TYPE_MAP[name]) return TYPE_MAP[name];
  }
  return "other";
}

/** body 摘要：去除换行与多余空白，截断到 500 字符以内 */
export function bodyExcerpt(body) {
  if (!body) return "";
  const flat = String(body)
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > 500 ? flat.slice(0, 499) + "…" : flat;
}

/** 拉取 open issues（支持可选 GITHUB_TOKEN） */
export async function fetchIssues(token) {
  const res = await fetch(ISSUES_API, { headers: buildHeaders(token) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `GitHub API ${res.status} ${res.statusText}${text ? " - " + text.slice(0, 200) : ""}`
    );
  }
  return res.json();
}

/** 将 API 原始条目转换为快照 schema；过滤掉 pull_request 条目 */
export function toSnapshot(items) {
  const issues = (Array.isArray(items) ? items : [])
    .filter((it) => it && !it.pull_request)
    .map((it) => {
      const labels = (Array.isArray(it.labels) ? it.labels : [])
        .map((l) => (typeof l === "string" ? l : l && l.name))
        .filter(Boolean);
      return {
        number: it.number,
        title: it.title ?? "",
        type: inferType(labels),
        state: it.state ?? "open",
        author: (it.user && it.user.login) || "unknown",
        createdAt: it.created_at ?? "",
        updatedAt: it.updated_at ?? "",
        url: it.html_url ?? "",
        labels,
        bodyExcerpt: bodyExcerpt(it.body),
      };
    });
  const byType = { bug: 0, feature: 0, ux: 0, other: 0 };
  for (const i of issues) byType[i.type] = (byType[i.type] || 0) + 1;
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    source: "github-issues",
    repo: REPO,
    counts: { open: issues.length, byType },
    issues,
  };
}

/** 剔除 generatedAt 后的实质内容：仅时间戳变化不算快照变化，避免空提交堆积 */
export function stablePart(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return JSON.stringify(snapshot);
  const { generatedAt, ...rest } = snapshot;
  return JSON.stringify(rest);
}

async function main() {
  console.log(`[issues-snapshot] 拉取 ${REPO} open issues ...`);
  const items = await fetchIssues(process.env.GITHUB_TOKEN);
  const snapshot = toSnapshot(items);
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  let existing = null;
  try {
    existing = JSON.parse(readFileSync(OUT_PATH, "utf8"));
  } catch {
    existing = null; // 首次生成或现有文件损坏，均视为有变化
  }
  if (existing && stablePart(existing) === stablePart(snapshot)) {
    console.log(
      `[issues-snapshot] 快照实质内容无变化（仅时间戳不同），保留原文件跳过写入，避免空提交堆积`
    );
  } else {
    writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
    console.log(`[issues-snapshot] 生成完成: ${OUT_PATH}`);
  }
  console.log(
    `[issues-snapshot] open=${snapshot.counts.open} byType=${JSON.stringify(snapshot.counts.byType)} generatedAt=${snapshot.generatedAt}`
  );
}

// 仅在直接执行时运行主流程（被 import 时不触发网络与写文件，便于单测）
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((err) => {
    console.error("[issues-snapshot] 生成失败:", (err && err.message) || err);
    process.exit(1);
  });
}
