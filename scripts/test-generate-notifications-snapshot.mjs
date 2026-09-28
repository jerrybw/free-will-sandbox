#!/usr/bin/env node
/**
 * [S4] generate-notifications-snapshot.mjs 解析逻辑单测
 *
 * 覆盖：bot 评论分类、标签事件映射与时间线回放、time 倒序 + 30 条截断、
 *       非 bot 评论排除、PR 条目排除、schema 完整性、请求头、API 错误路径。
 * 全部使用纯内存 mock 数据：不触发网络、不写文件。
 *
 * 运行：node scripts/test-generate-notifications-snapshot.mjs（node:assert 断言）
 */
import assert from "node:assert";
import {
  buildHeaders,
  classifyComment,
  commentSummary,
  titleExcerpt,
  extractCommentItems,
  mapLabelEvent,
  replayLabelEvents,
  toSnapshot,
  needsDetail,
  fetchJson,
  stablePart,
  WORKFLOW_LABELS,
} from "./generate-notifications-snapshot.mjs";

let pass = 0, fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ❌ ${name}\n     ${e && e.message}`);
  }
}

console.log("== buildHeaders ==");
await t("无 token 时不携带 Authorization", () => {
  const h = buildHeaders(undefined);
  assert.ok(!("Authorization" in h), "不应含 Authorization");
  assert.strictEqual(h["User-Agent"], "free-will-sandbox-snapshot");
});
await t("有 token 时携带 Bearer Authorization", () => {
  assert.strictEqual(buildHeaders("test-token-placeholder")["Authorization"], "Bearer test-token-placeholder");
});

console.log("== classifyComment（bot 评论分类） ==");
await t("含「已受理」→ 受理确认", () => {
  assert.strictEqual(classifyComment("🤖 已受理 · 进入评审队列\n\n感谢反馈！"), "受理确认");
});
await t("含「评审通过」→ 状态流转", () => {
  assert.strictEqual(classifyComment("✅ 评审通过 · 进入开发排期"), "状态流转");
});
await t("含「未通过」→ 状态流转", () => {
  assert.strictEqual(classifyComment("❌ 未通过评审 · 感谢反馈\n\n原因见上方维护者说明"), "状态流转");
});
await t("含「已完成」→ 完成通知", () => {
  assert.strictEqual(classifyComment("🎉 需求已完成并发布 · 感谢贡献"), "完成通知");
});
await t("无法归类 → 系统通知", () => {
  assert.strictEqual(classifyComment("机器人例行日志输出"), "系统通知");
});
await t("空 body → 系统通知", () => {
  assert.strictEqual(classifyComment(""), "系统通知");
});
await t("null body → 系统通知", () => {
  assert.strictEqual(classifyComment(null), "系统通知");
});

console.log("== titleExcerpt / commentSummary（摘要拼装） ==");
await t("titleExcerpt 24 字内原样返回", () => {
  assert.strictEqual(titleExcerpt("酿造台点击负数增量越界"), "酿造台点击负数增量越界");
});
await t("titleExcerpt 超 24 字截断补省略号", () => {
  const out = titleExcerpt("标".repeat(30));
  assert.strictEqual(out.length, 25);
  assert.ok(out.endsWith("…"));
});
await t("commentSummary 取首个非空行并去首尾空白", () => {
  assert.strictEqual(commentSummary("\n  🤖 已受理 · 进入评审队列  \n\n正文第二行"), "🤖 已受理 · 进入评审队列");
});

console.log("== extractCommentItems（bot 评论 → 通知项） ==");
const issueA = {
  number: 12,
  title: "酿造台点击负数增量越界导致数值异常",
  html_url: "https://github.com/jerrybw/free-will-sandbox/issues/12",
};
const commentsA = [
  {
    id: 2001,
    user: { login: "github-actions[bot]" },
    body: "🤖 已受理 · 进入评审队列\n\n流转流程…",
    created_at: "2026-09-20T01:00:00Z",
    html_url: "https://github.com/jerrybw/free-will-sandbox/issues/12#issuecomment-2001",
  },
  {
    id: 2002,
    user: { login: "alice" },
    body: "含「已受理」关键词的人类评论也不应出现",
    created_at: "2026-09-20T02:00:00Z",
    html_url: "https://github.com/jerrybw/free-will-sandbox/issues/12#issuecomment-2002",
  },
  {
    id: 2003,
    user: { login: "github-actions[bot]" },
    body: "✅ 评审通过 · 进入开发排期",
    created_at: "2026-09-21T01:00:00Z",
    html_url: "https://github.com/jerrybw/free-will-sandbox/issues/12#issuecomment-2003",
  },
];
await t("仅保留 bot 评论且分类正确", () => {
  const items = extractCommentItems(issueA, commentsA);
  assert.strictEqual(items.length, 2, "人类评论应被排除");
  assert.strictEqual(items[0].type, "受理确认");
  assert.strictEqual(items[1].type, "状态流转");
});
await t("通知项 schema 字段完整且 id 规则正确", () => {
  const [it] = extractCommentItems(issueA, commentsA);
  assert.deepStrictEqual(Object.keys(it).sort(), ["content", "id", "status", "time", "type", "url"]);
  assert.strictEqual(it.id, "n-12-comment-2001");
  assert.strictEqual(it.status, "unread");
  assert.strictEqual(it.time, "2026-09-20T01:00:00Z");
  assert.strictEqual(it.url, commentsA[0].html_url);
  assert.ok(it.content.startsWith("Issue #12「酿造台点击负数增量越界导致数值异常」"), "17 字标题不截断，全量保留");
  assert.ok(it.content.includes("已受理 · 进入评审队列"), "content 含 bot 评论标题行");
});
await t("人类评论即使内容含关键词也不产生通知", () => {
  const items = extractCommentItems(issueA, [
    { id: 9, user: { login: "bob" }, body: "已受理", created_at: "2026-09-20T00:00:00Z" },
  ]);
  assert.strictEqual(items.length, 0);
});
await t("空评论列表 → 空数组", () => {
  assert.deepStrictEqual(extractCommentItems(issueA, []), []);
});

console.log("== mapLabelEvent（标签事件映射） ==");
const issueB = {
  number: 12,
  title: "酿造台点击负数增量越界",
  html_url: "https://github.com/jerrybw/free-will-sandbox/issues/12",
};
await t("labeled 工作流标签 → 标签流转通知项（X → Y 拼装）", () => {
  const ev = { event: "labeled", id: 501, label: { name: "approved" }, created_at: "2026-09-21T02:00:00Z" };
  const it = mapLabelEvent(ev, issueB, "pending");
  assert.strictEqual(it.type, "标签流转");
  assert.strictEqual(it.id, "n-12-label-501");
  assert.strictEqual(it.time, "2026-09-21T02:00:00Z");
  assert.strictEqual(it.status, "unread");
  assert.strictEqual(it.content, "Issue #12「酿造台点击负数增量越界」 标签：pending → approved");
  assert.strictEqual(it.url, issueB.html_url);
});
await t("无上一标签时展示「无」", () => {
  const ev = { event: "labeled", id: 500, label: { name: "pending" }, created_at: "2026-09-20T01:00:00Z" };
  const it = mapLabelEvent(ev, issueB, null);
  assert.ok(it.content.endsWith("标签：无 → pending"));
});
await t("unlabeled 事件 → null（仅作 X 来源，不直接产出通知）", () => {
  const ev = { event: "unlabeled", id: 502, label: { name: "pending" }, created_at: "2026-09-21T01:00:00Z" };
  assert.strictEqual(mapLabelEvent(ev, issueB, "pending"), null);
});
await t("非工作流标签 → null", () => {
  const ev = { event: "labeled", id: 503, label: { name: "enhancement" }, created_at: "2026-09-21T03:00:00Z" };
  assert.strictEqual(mapLabelEvent(ev, issueB, null), null);
});
await t("缺 label 字段的脏事件 → null（容错）", () => {
  assert.strictEqual(mapLabelEvent({ event: "labeled", id: 504 }, issueB, null), null);
});

console.log("== replayLabelEvents（时间线回放） ==");
await t("pending→approved→done 全链路产出 X→Y 序列，非工作流标签忽略", () => {
  const timeline = [
    { event: "labeled", id: 1, label: { name: "pending" }, created_at: "2026-09-20T01:00:00Z" },
    { event: "labeled", id: 2, label: { name: "issue/bug" }, created_at: "2026-09-20T01:01:00Z" },
    { event: "unlabeled", id: 3, label: { name: "pending" }, created_at: "2026-09-21T01:00:00Z" },
    { event: "labeled", id: 4, label: { name: "approved" }, created_at: "2026-09-21T02:00:00Z" },
    { event: "unlabeled", id: 5, label: { name: "approved" }, created_at: "2026-09-25T01:00:00Z" },
    { event: "labeled", id: 6, label: { name: "done" }, created_at: "2026-09-25T02:00:00Z" },
  ];
  const items = replayLabelEvents(issueB, timeline);
  assert.strictEqual(items.length, 3);
  assert.match(items[0].content, /标签：无 → pending$/);
  assert.match(items[1].content, /标签：pending → approved$/);
  assert.match(items[2].content, /标签：approved → done$/);
});
await t("时间乱序输入按时间正序回放（X 取此前最近一次 unlabeled）", () => {
  const timeline = [
    { event: "labeled", id: 2, label: { name: "approved" }, created_at: "2026-09-21T02:00:00Z" },
    { event: "unlabeled", id: 1, label: { name: "pending" }, created_at: "2026-09-21T01:00:00Z" },
  ];
  const items = replayLabelEvents(issueB, timeline);
  assert.strictEqual(items.length, 1);
  assert.match(items[0].content, /标签：pending → approved$/);
});
await t("非时间线数组容错 → 空数组", () => {
  assert.deepStrictEqual(replayLabelEvents(issueB, null), []);
});

console.log("== needsDetail（详情拉取判定） ==");
await t("有评论或带工作流标签才拉详情", () => {
  assert.strictEqual(needsDetail({ comments: 0, labels: [] }), false);
  assert.strictEqual(needsDetail({ comments: 2, labels: [] }), true);
  assert.strictEqual(needsDetail({ comments: 0, labels: [{ name: "pending" }] }), true);
  assert.strictEqual(needsDetail({ comments: 0, labels: ["approved"] }), true);
  assert.strictEqual(needsDetail({ comments: 0, labels: [{ name: "issue/bug" }] }), false);
  assert.strictEqual(needsDetail(null), false);
});
await t("工作流标签集为 pending/approved/rejected/done", () => {
  assert.deepStrictEqual([...WORKFLOW_LABELS].sort(), ["approved", "done", "pending", "rejected"]);
});

console.log("== toSnapshot（倒序 + 30 条截断 + 排除规则） ==");
// 构造 6 issue × 7 条 bot 评论 = 42 条评论通知 + 6 条标签通知 = 48 条，验证倒序与截断
function buildEntries() {
  const entries = [];
  let k = 0;
  for (let i = 0; i < 6; i++) {
    const issue = {
      number: 100 + i,
      title: `压测通知截断 Issue ${i}`,
      html_url: `https://github.com/jerrybw/free-will-sandbox/issues/${100 + i}`,
    };
    const comments = [];
    for (let j = 0; j < 7; j++) {
      comments.push({
        id: k,
        user: { login: "github-actions[bot]" },
        body: `🤖 已受理 · 进入评审队列（第 ${k} 条）`,
        created_at: new Date(Date.UTC(2026, 8, 1, 0, k, 0)).toISOString(), // k 递增 → 时间递增
      });
      k++;
    }
    // 标签事件时间晚于全部评论（09-02），是最新的 6 条
    const timeline = [
      { event: "labeled", id: 9000 + i, label: { name: "pending" }, created_at: new Date(Date.UTC(2026, 8, 2, 0, i, 0)).toISOString() },
    ];
    entries.push({ issue, comments, timeline });
  }
  return entries;
}
await t("items 倒序排列且截断为 30 条，counts.total 同步", () => {
  const snap = toSnapshot(buildEntries());
  assert.strictEqual(snap.items.length, 30);
  assert.strictEqual(snap.counts.total, 30);
  for (let i = 1; i < snap.items.length; i++) {
    assert.ok(
      Date.parse(snap.items[i - 1].time) >= Date.parse(snap.items[i].time),
      `第 ${i} 项时间不应早于第 ${i + 1} 项`
    );
  }
});
await t("截断保留最新条目：最新标签事件居首，最旧评论被裁掉", () => {
  const snap = toSnapshot(buildEntries());
  assert.strictEqual(snap.items[0].type, "标签流转");
  assert.ok(snap.items[0].content.startsWith("Issue #105"), "最新一条为 Issue #105 的 pending 标签");
  assert.ok(snap.items.some((it) => it.id === "n-105-comment-41"), "最新评论（k=41）应保留");
  assert.ok(!snap.items.some((it) => it.id === "n-102-comment-17"), "较旧评论（k=17）应被截断");
});
await t("PR 条目排除（pull_request 字段非 null 不产出任何通知）", () => {
  const snap = toSnapshot([
    {
      issue: {
        number: 77,
        title: "某个 PR",
        pull_request: { html_url: "https://github.com/jerrybw/free-will-sandbox/pull/77" },
        html_url: "https://github.com/jerrybw/free-will-sandbox/pull/77",
        comments: 3,
      },
      comments: [{ id: 1, user: { login: "github-actions[bot]" }, body: "已受理", created_at: "2026-09-20T00:00:00Z" }],
      timeline: [{ event: "labeled", id: 1, label: { name: "pending" }, created_at: "2026-09-20T00:00:00Z" }],
    },
  ]);
  assert.strictEqual(snap.items.length, 0);
  assert.strictEqual(snap.counts.total, 0);
});
await t("快照 schema 完整（schemaVersion/source/repo/counts/generatedAt）", () => {
  const snap = toSnapshot([]);
  assert.strictEqual(snap.schemaVersion, 1);
  assert.strictEqual(snap.source, "github-notifications");
  assert.strictEqual(snap.repo, "jerrybw/free-will-sandbox");
  assert.deepStrictEqual(snap.counts, { total: 0 });
  assert.ok(!Number.isNaN(Date.parse(snap.generatedAt)));
  assert.deepStrictEqual(snap.items, []);
});
await t("非数组入参容错 → 空快照", () => {
  assert.strictEqual(toSnapshot(null).counts.total, 0);
});
await t("stablePart 剔除 generatedAt 后内容一致", () => {
  const snap = toSnapshot([]);
  const snap2 = { ...snap, generatedAt: "2030-01-01T00:00:00.000Z" };
  assert.strictEqual(stablePart(snap), stablePart(snap2));
});

console.log("== fetchJson（mock globalThis.fetch 错误路径） ==");
await t("非 2xx 抛出含状态码的错误", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
    statusText: "Forbidden",
    text: async () => '{"message":"API rate limit exceeded"}',
  });
  try {
    await fetchJson("https://api.github.com/x", undefined);
    assert.fail("应抛出错误");
  } catch (e) {
    assert.match(String(e.message), /GitHub API 403/);
  } finally {
    globalThis.fetch = real;
  }
});
await t("2xx 返回解析后的 JSON，携带约定请求头", async () => {
  const real = globalThis.fetch;
  let seenOpts = null;
  globalThis.fetch = async (url, opts) => {
    seenOpts = opts;
    return { ok: true, status: 200, json: async () => ({ url }) };
  };
  try {
    const out = await fetchJson("https://api.github.com/x", "tk");
    assert.strictEqual(out.url, "https://api.github.com/x");
    assert.strictEqual(seenOpts.headers["User-Agent"], "free-will-sandbox-snapshot");
    assert.strictEqual(seenOpts.headers["Authorization"], "Bearer tk");
  } finally {
    globalThis.fetch = real;
  }
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
