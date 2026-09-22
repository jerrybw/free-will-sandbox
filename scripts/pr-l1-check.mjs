#!/usr/bin/env node
/**
 * [S3] PR L1 自动检查：构建链汇总 / 包体预算 / 安全红线扫描 / 关联 Issue 检测
 *
 * 作用：在 PR 检查工作流（.github/workflows/pr-check.yml）中运行，汇总各检查项生成
 *       Markdown 报告 pr-l1-report.md（仓库根），由工作流回写为 PR 评论；
 *       报告结尾带 <!-- pr-l1-check --> 标记，供评论幂等更新识别。
 *       任一 fail 项 → 退出码 1（工作流据此将 PR check 置为 failure）。
 *
 * 用法：node scripts/pr-l1-check.mjs（工作目录须为仓库根）
 * 环境变量：
 *   PR_NUMBER（可选）——报告标题展示；与 PR body 的 API 兜底读取
 *   BASE_REF（可选，默认 origin/main）——红线扫描的 diff 基线（三点 diff，仅看本 PR 改动）
 *   TYPECHECK_STATUS / BUILD_STATUS（可选 pass|fail）——工作流各步骤执行结果；
 *                     本脚本不执行构建，只汇总结果；缺省按 unknown 记提示项（本地调试模式）
 *   PR_BODY（可选）——PR 描述正文（工作流经 gh api 取得后传入），用于关联 Issue 检测
 *   GITHUB_TOKEN（可选）——PR_BODY 缺失时经 API 兜底读取 PR 描述；Actions 内用内置 token
 *
 * 检查项：
 *   ① 构建链汇总（typecheck / build 由工作流执行，此处仅汇总各步骤结果）
 *   ② 包体预算：游戏本体 dist/assets（.js/.css）gzip 总字节数 < 15KB；其余产物仅报告不计入判定
 *   ③ 安全红线：git diff BASE...HEAD 的新增行（+ 行）扫描词表 scripts/config/redline-words.json，
 *      排除词表文件自身与 .github/workflows/ 下 yml；fail 词命中 → 失败，warn 词 → 仅提示；
 *      输出仅含 文件:行号 与类别，不输出原句，防敏感词扩散
 *   ④ 关联检查：PR 描述是否引用 Issue 编号（提示级，不计失败）
 *
 * 测试：loadRedlineConfig / isRedlineExcluded / parseDiffAddedLines / scanAddedLines /
 *       gzipSize / evaluateBudget / collectBudgetFiles / checkBuildChain /
 *       findIssueRefs / checkPrLink / buildReport 均导出纯函数，
 *       由 scripts/test-pr-l1-check.mjs 单测覆盖，不触发 git、网络与写文件。
 */
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = "jerrybw/free-will-sandbox";
const REDLINE_CONFIG_PATH = resolve(SCRIPT_DIR, "config", "redline-words.json");
const REPORT_PATH = "pr-l1-report.md"; // 相对仓库根（工作目录）
export const BUDGET_LIMIT_BYTES = 15 * 1024; // 包体预算上限：15KB（gzip 后）
const BUDGET_EXTS = [".js", ".css", ".html", ".json"];
export const MARKER = "<!-- pr-l1-check -->"; // 报告结尾标记：bot comment 幂等识别
const REDLINE_SELF_PATH = "scripts/config/redline-words.json"; // 词表自身不参与扫描
const REDLINE_EXCLUDED_PREFIXES = [".github/workflows/"]; // 工作流 yml 不参与扫描

/**
 * 加载并校验红线词表。
 * schema：{ version, updatedAt, categories: [{ name, level: "fail"|"warn", words: string[] }] }
 * @param {string|object} rawJson 词表原始 JSON 字符串或已解析对象
 * @returns {object} 校验通过的词表对象
 */
export function loadRedlineConfig(rawJson) {
  const cfg = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
    throw new Error("词表格式不合法：顶层应为对象");
  }
  if (!Array.isArray(cfg.categories) || cfg.categories.length === 0) {
    throw new Error("词表格式不合法：categories 应为非空数组");
  }
  for (const cat of cfg.categories) {
    if (!cat || typeof cat.name !== "string" || !cat.name) {
      throw new Error("词表格式不合法：分类缺少 name");
    }
    if (cat.level !== "fail" && cat.level !== "warn") {
      throw new Error(`词表格式不合法：分类「${cat.name}」的 level 应为 fail 或 warn`);
    }
    if (!Array.isArray(cat.words) || cat.words.length === 0) {
      throw new Error(`词表格式不合法：分类「${cat.name}」的 words 应为非空数组`);
    }
    for (const w of cat.words) {
      if (typeof w !== "string" || !w.trim()) {
        throw new Error(`词表格式不合法：分类「${cat.name}」存在空词或非字符串词`);
      }
    }
  }
  return cfg;
}

/**
 * 判断 diff 文件路径是否在红线扫描排除范围（词表文件自身 / .github/workflows/ 下 yml）。
 * @param {string|null} filePath diff 中的新文件路径（不含 b/ 前缀）
 * @returns {boolean} true 表示跳过扫描
 */
export function isRedlineExcluded(filePath) {
  if (!filePath) return true;
  if (filePath === REDLINE_SELF_PATH) return true;
  if (filePath.endsWith(".yml") || filePath.endsWith(".yaml")) {
    if (REDLINE_EXCLUDED_PREFIXES.some((p) => filePath.startsWith(p))) return true;
  }
  return false;
}

/**
 * 解析 unified diff 文本，提取新增行（+ 行）及其所属文件与新文件行号。
 * 上下文行使新文件行号 +1，删除行（- 行）与 "\ No newline" 不影响行号。
 * @param {string} diffText git diff 输出
 * @returns {Array<{file: string|null, line: number, text: string}>}
 */
export function parseDiffAddedLines(diffText) {
  const results = [];
  let currentFile = null;
  let newLine = 0;
  for (const raw of String(diffText).split("\n")) {
    if (raw === "") continue; // 结尾换行产生的空串，跳过防行号漂移
    if (raw.startsWith("diff --git")) {
      currentFile = null; // 等待随后的 +++ 头确定文件
      continue;
    }
    if (raw.startsWith("--- ")) continue; // 旧文件头（--- a/x 或 --- /dev/null）
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim();
      currentFile = p === "/dev/null" ? null : p.startsWith("b/") ? p.slice(2) : p;
      continue;
    }
    if (raw.startsWith("@@")) {
      const m = raw.match(/^@@\s*-\d+(?:,\d+)?\s*\+(\d+)(?:,\d+)?\s*@@/);
      newLine = m ? parseInt(m[1], 10) : 0;
      continue;
    }
    if (raw.startsWith("+")) {
      results.push({ file: currentFile, line: newLine, text: raw.slice(1) });
      newLine += 1;
    } else if (raw.startsWith("-") || raw.startsWith("\\")) {
      // 删除行与 "\ No newline at end of file" 不影响新文件行号
    } else {
      newLine += 1; // 上下文行（含 " " 前缀）
    }
  }
  return results;
}

/**
 * 红线扫描：对 diff 新增行按词表匹配（大小写不敏感，子串匹配）。
 * 同一行同一类别只记一次命中；不同类别分别记录。
 * @param {string} diffText git diff 输出
 * @param {object} config loadRedlineConfig 校验通过的词表
 * @returns {Array<{file: string|null, line: number, category: string, level: string}>}
 */
export function scanAddedLines(diffText, config) {
  const hits = [];
  const seen = new Set();
  for (const { file, line, text } of parseDiffAddedLines(diffText)) {
    if (isRedlineExcluded(file)) continue;
    const lower = text.toLowerCase();
    for (const cat of config.categories) {
      const matched = cat.words.some((w) => lower.includes(w.toLowerCase()));
      if (!matched) continue;
      const key = `${file}:${line}:${cat.name}`;
      if (!seen.has(key)) {
        seen.add(key);
        hits.push({ file, line, category: cat.name, level: cat.level });
      }
    }
  }
  return hits;
}

/** gzip 压缩后字节数（node:zlib gzipSync，与 CI 环境一致的确定性压缩） */
export function gzipSize(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
  return gzipSync(buf).length;
}

/**
 * 预算判定：gzip 后总字节数 < 上限为 pass（恰好等于上限判 fail，严格小于）。
 * @returns {{totalBytes: number, limit: number, pass: boolean}}
 */
export function evaluateBudget(totalBytes, limit = BUDGET_LIMIT_BYTES) {
  return { totalBytes, limit, pass: totalBytes < limit };
}

/**
 * 递归收集目录下参与包体预算的文件（.js/.css/.html/.json）。
 * 目录不存在或不可读时返回空数组（由调用方按 fail/提示处理）。
 */
export function collectBudgetFiles(rootDir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(rootDir, e.name);
    if (e.isDirectory()) out.push(...collectBudgetFiles(p));
    else if (e.isFile() && BUDGET_EXTS.includes(extname(e.name).toLowerCase())) out.push(p);
  }
  return out;
}

/**
 * 计算目录内预算文件的 gzip 总量与按扩展名分项。
 * @returns {null|{files: number, total: number, byExt: Object<string, number>}} 目录缺失/无匹配文件返回 null
 */
export function measureBudget(rootDir) {
  const files = collectBudgetFiles(rootDir);
  if (!files.length) return null;
  const byExt = {};
  let total = 0;
  for (const f of files) {
    const ext = extname(f).toLowerCase();
    const size = gzipSize(readFileSync(f));
    byExt[ext] = (byExt[ext] || 0) + size;
    total += size;
  }
  return { files: files.length, total, byExt };
}

/**
 * ① 构建链汇总：typecheck / build 结果由工作流步骤写入 env，本函数仅归类。
 * @param {{typecheck?: string, build?: string}} statuses 各步骤 pass|fail|unknown(缺省)
 * @returns {Array<{id, title, status: "pass"|"fail"|"notice", detail: string[], suggestion: string}>}
 */
export function checkBuildChain(statuses) {
  const steps = [
    { key: "typecheck", label: "typecheck（类型检查）", failTip: "本地运行 npm run typecheck（tsc --noEmit）修复类型错误后再推送" },
    { key: "build", label: "build（构建）", failTip: "本地运行 npm run build 复现并修复构建错误后再推送" },
  ];
  return steps.map(({ key, label, failTip }) => {
    const v = statuses && statuses[key];
    if (v === "pass") {
      return { id: key, title: `构建链 · ${label}`, status: "pass", detail: ["步骤结果：pass"], suggestion: "" };
    }
    if (v === "fail") {
      return { id: key, title: `构建链 · ${label}`, status: "fail", detail: ["步骤结果：fail"], suggestion: failTip };
    }
    return {
      id: key,
      title: `构建链 · ${label}`,
      status: "notice",
      detail: ["步骤结果未知：未接收到该步骤状态（本地调试模式或步骤被跳过）"],
      suggestion: "",
    };
  });
}

/**
 * ④ 从 PR 描述提取 Issue 引用：#N 形式，或 issue/issues/fix(es/ed)/close(s/d)/resolve(s/d) + N。
 * @param {string} body PR 描述正文
 * @returns {string[]} 去重后的引用列表，按编号升序，如 ["#7", "#12"]
 */
export function findIssueRefs(body) {
  const text = String(body || "");
  const found = new Set();
  for (const m of text.matchAll(/#\d+/g)) found.add(m[0]);
  for (const m of text.matchAll(/\b(?:issues?|fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s*#?(\d+)\b/gi)) {
    found.add(`#${m[1]}`);
  }
  return [...found].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

/** ④ 关联检查：有关联 → pass；无关联 → 提示级（不计失败），给出建议语 */
export function checkPrLink(body) {
  const refs = findIssueRefs(body);
  if (refs.length) {
    return { id: "link", title: "关联检查 · PR 描述关联 Issue", status: "pass", detail: [`关联 ${refs.join("、")}`], suggestion: "" };
  }
  return {
    id: "link",
    title: "关联检查 · PR 描述关联 Issue",
    status: "notice",
    detail: ["未在描述中发现 Issue 编号引用"],
    suggestion: "建议在描述中关联 Issue 编号（如 #12），便于需求追溯",
  };
}

const ICON = { pass: "✅", fail: "❌", notice: "⚠️" };
const STATUS_TEXT = { pass: "通过", fail: "失败", notice: "提示" };

/**
 * 生成 Markdown 报告：通过项 ✅ / 失败项 ❌（附修复建议）/ 提示项 ⚠️；
 * 结尾带 <!-- pr-l1-check --> 标记供 bot comment 幂等识别。
 * 首行为摘要行（含结论与计数），供 PR 快照提取 summary。
 */
export function buildReport({ prNumber, items, baseRef, generatedAt }) {
  const passed = items.filter((i) => i.status === "pass");
  const failed = items.filter((i) => i.status === "fail");
  const noticed = items.filter((i) => i.status === "notice");
  const conclusion = failed.length ? "❌ 未通过" : "✅ 通过";
  const out = [];
  out.push(
    `## 🤖 PR L1 检查报告${prNumber ? `（PR #${prNumber}）` : ""}：${conclusion}（${passed.length} 通过 / ${failed.length} 失败 / ${noticed.length} 提示）`
  );
  out.push("");
  out.push(`> diff 基线：\`${baseRef}\` · 生成时间：${generatedAt}`);
  out.push("");
  for (const item of items) {
    out.push(`### ${ICON[item.status]} ${item.title}（${STATUS_TEXT[item.status]}）`);
    for (const d of item.detail) out.push(`- ${d}`);
    if (item.status === "fail" && item.suggestion) out.push(`- 💡 修复建议：${item.suggestion}`);
    if (item.status === "notice" && item.suggestion) out.push(`- 💡 ${item.suggestion}`);
    out.push("");
  }
  out.push(MARKER);
  return out.join("\n") + "\n";
}

/** PR body 的 API 兜底读取（PR_BODY 环境变量缺失时）；失败抛错由调用方降级 */
async function fetchPrBody(prNumber, token) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/pulls/${prNumber}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "free-will-sandbox-l1-check",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText}`);
  const data = await res.json();
  return (data && data.body) || "";
}

async function main() {
  const repoRoot = process.cwd(); // 约定：工作目录为仓库根
  const prNumber = process.env.PR_NUMBER || "";
  const baseRef = process.env.BASE_REF || "origin/main";
  const items = [];

  // ① 构建链汇总（步骤由工作流执行，此处仅读取结果 env）
  items.push(
    ...checkBuildChain({
      typecheck: process.env.TYPECHECK_STATUS,
      build: process.env.BUILD_STATUS,
    })
  );

  // ② 包体预算：硬预算口径=游戏本体构建产物 dist/assets（.js/.css）gzip 总量 < 15KB
  //    （延续 S1/S2 验收语境：15KB 预算约束的是游戏本体，进度页 html 与数据 json 属工具配套，仅报告不计入判定）
  const assetBudget = measureBudget(resolve(repoRoot, "dist", "assets"));
  if (assetBudget) {
    const verdict = evaluateBudget(assetBudget.total);
    const others = measureBudget(resolve(repoRoot, "dist"));
    const otherTotal = others ? others.total - assetBudget.total : 0;
    const detail = [
      `游戏本体（dist/assets .js/.css）：${assetBudget.total} 字节 / 预算上限：${verdict.limit} 字节（${verdict.pass ? "达标" : "超限"}）`,
      `其余产物（进度页 + 数据文件）：${otherTotal} 字节（参考值，不计入硬预算）`,
    ];
    items.push(
      verdict.pass
        ? { id: "budget", title: "包体预算 · 游戏本体 gzip < 15KB", status: "pass", detail, suggestion: "" }
        : {
            id: "budget",
            title: "包体预算 · 游戏本体 gzip < 15KB",
            status: "fail",
            detail,
            suggestion: "压缩游戏资源或拆分按需加载模块，将 dist/assets 的 gzip 总量降至 15KB 以内",
          }
    );
  } else {
    items.push({
      id: "budget",
      title: "包体预算 · 游戏本体 gzip < 15KB",
      status: "fail",
      detail: ["dist/assets/ 目录不存在或没有可统计的 .js/.css 文件"],
      suggestion: "确认构建步骤已成功产出 dist/assets/ 目录后再运行本检查",
    });
  }

  // ③ 安全红线扫描：git diff BASE...HEAD 的新增行（+ 行）
  let diffError = "";
  if (!/^[A-Za-z0-9._/\-]+$/.test(baseRef)) {
    diffError = `BASE_REF 含非法字符：${baseRef}`;
  } else {
    try {
      const diffText = execSync(`git diff ${baseRef}...HEAD --unified=0`, {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      const config = loadRedlineConfig(readFileSync(REDLINE_CONFIG_PATH, "utf8"));
      const hits = scanAddedLines(diffText, config);
      if (!hits.length) {
        items.push({
          id: "redline",
          title: "安全红线 · 新增行敏感词扫描",
          status: "pass",
          detail: ["新增行未命中任何红线词"],
          suggestion: "",
        });
      } else {
        const failHits = hits.filter((h) => h.level === "fail");
        const warnHits = hits.filter((h) => h.level === "warn");
        const detail = [
          // 仅输出 文件:行号 与类别，不输出原句，防敏感词扩散
          ...failHits.map((h) => `❌ 命中 fail 词：${h.file}:${h.line}（类别：${h.category}）`),
          ...warnHits.map((h) => `⚠️ 命中 warn 词：${h.file}:${h.line}（类别：${h.category}）`),
        ];
        items.push({
          id: "redline",
          title: "安全红线 · 新增行敏感词扫描",
          status: failHits.length ? "fail" : "notice", // warn 命中仅提示，不计失败
          detail,
          suggestion: failHits.length ? "移除或改写命中位置的敏感内容后重新推送（命中详情见上方 文件:行号 与类别）" : "",
        });
      }
    } catch (e) {
      diffError = String((e && e.message) || e).split("\n")[0];
    }
  }
  if (diffError) {
    items.push({
      id: "redline",
      title: "安全红线 · 新增行敏感词扫描",
      status: "notice",
      detail: [`无法读取 git diff（${diffError}），本次跳过红线扫描`],
      suggestion: "",
    });
  }

  // ④ 关联检查：PR body 优先取环境变量，缺失时走 API 兜底（失败降级为空，按无关联提示）
  let body = process.env.PR_BODY ?? "";
  if (!body && prNumber) {
    try {
      body = await fetchPrBody(prNumber, process.env.GITHUB_TOKEN);
    } catch {
      body = "";
    }
  }
  items.push(checkPrLink(body));

  // 生成并写入报告，同时打印到控制台
  const report = buildReport({ prNumber, items, baseRef, generatedAt: new Date().toISOString() });
  writeFileSync(resolve(repoRoot, REPORT_PATH), report, "utf8");
  console.log(report);
  const hasFail = items.some((i) => i.status === "fail");
  console.log(`[pr-l1-check] 报告已写入 ${REPORT_PATH}；结论：${hasFail ? "存在 fail 项，退出码 1" : "无 fail 项，退出码 0"}`);
  process.exit(hasFail ? 1 : 0);
}

// 仅在直接执行时运行主流程（被 import 时不触发 git、网络与写文件，便于单测）
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((err) => {
    console.error("[pr-l1-check] 检查失败:", (err && err.message) || err);
    process.exit(1);
  });
}
