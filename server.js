import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

// ─── 存储路径 ──────────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");
const DATA_FILE = join(DATA_DIR, "memories.json");
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// ─── 分类定义 ──────────────────────────────────────────────────────────────────
const CATEGORIES = ["deep", "daily", "diary", "knowledge"];
const CATEGORY_DESC = {
  deep:      "深层 — 长期不变：身份设定、规则、核心偏好",
  daily:     "日常 — 短期事件，默认7天后自动过期",
  diary:     "日记 — 每天一篇，带感情色彩的主观记录",
  knowledge: "知识 — 学到的事实、技能、常识，长期有效",
};

// ─── I/O ───────────────────────────────────────────────────────────────────────
function load() {
  if (!existsSync(DATA_FILE)) return [];
  return JSON.parse(readFileSync(DATA_FILE, "utf-8"));
}

function save(memories) {
  writeFileSync(DATA_FILE, JSON.stringify(memories, null, 2), "utf-8");
}

// 清理已过期的 daily 记忆
function purgeExpired(memories) {
  const now = Date.now();
  return memories.filter((m) => {
    if (m.expires_at) return new Date(m.expires_at).getTime() > now;
    return true;
  });
}

// ─── MCP Server ────────────────────────────────────────────────────────────────
const server = new Server(
  { name: "memory-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ── 工具列表 ────────────────────────────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "write_memory",
      description: "写入一条新记忆。daily 类型会在 expires_days 天后自动过期（默认7天）。",
      inputSchema: {
        type: "object",
        required: ["content", "category"],
        properties: {
          content:      { type: "string", description: "记忆正文" },
          category:     { type: "string", enum: CATEGORIES, description: "分类: deep | daily | diary | knowledge" },
          tags:         { type: "array", items: { type: "string" }, description: "标签列表", default: [] },
          source:       { type: "string", description: "来源（如 'user', 'conversation', 'system'）", default: "user" },
          expires_days: { type: "number", description: "过期天数，仅 daily 有效，默认 7", default: 7 },
        },
      },
    },
    {
      name: "read_memory",
      description: "读取记忆，支持按分类、标签（AND）、关键词组合筛选，结果按时间倒序。",
      inputSchema: {
        type: "object",
        properties: {
          category: { type: "string", enum: CATEGORIES, description: "按分类筛选（可选）" },
          tags:     { type: "array", items: { type: "string" }, description: "按标签筛选，多个标签取 AND（可选）" },
          keyword:  { type: "string", description: "内容关键词筛选（可选）" },
          limit:    { type: "number", description: "最多返回条数，默认 50", default: 50 },
        },
      },
    },
    {
      name: "search_memory",
      description: "全文搜索记忆内容、标签、来源字段，支持中英文。",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query:    { type: "string", description: "搜索词" },
          category: { type: "string", enum: CATEGORIES, description: "限定分类（可选）" },
          limit:    { type: "number", description: "最多返回条数，默认 20", default: 20 },
        },
      },
    },
    {
      name: "delete_memory",
      description: "按 ID 删除一条记忆。",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string", description: "记忆 ID" },
        },
      },
    },
    {
      name: "update_memory",
      description: "按 ID 更新记忆的内容、标签或来源（只传要修改的字段）。",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          id:      { type: "string", description: "记忆 ID" },
          content: { type: "string", description: "新内容（可选）" },
          tags:    { type: "array", items: { type: "string" }, description: "新标签（可选，覆盖原标签）" },
          source:  { type: "string", description: "新来源（可选）" },
        },
      },
    },
    {
      name: "get_stats",
      description: "查看记忆库统计：总数、各分类数量、所有标签、最早/最新时间戳。",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ],
}));

// ── 工具执行 ────────────────────────────────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  let memories = purgeExpired(load());

  try {
    switch (name) {

      // ── write_memory ──────────────────────────────────────────────────────────
      case "write_memory": {
        const now = new Date();
        const expiresAt =
          args.category === "daily"
            ? new Date(now.getTime() + (args.expires_days ?? 7) * 86_400_000).toISOString()
            : undefined;

        const memory = {
          id:         randomUUID(),
          content:    args.content,
          category:   args.category,
          tags:       args.tags ?? [],
          source:     args.source ?? "user",
          timestamp:  now.toISOString(),
          ...(expiresAt && { expires_at: expiresAt }),
        };

        memories.push(memory);
        save(memories);
        return text(`✓ 记忆已写入（${CATEGORY_DESC[memory.category]}）\n\n${fmt(memory)}`);
      }

      // ── read_memory ───────────────────────────────────────────────────────────
      case "read_memory": {
        let result = [...memories];

        if (args.category) result = result.filter((m) => m.category === args.category);
        if (args.tags?.length)
          result = result.filter((m) => args.tags.every((t) => m.tags.includes(t)));
        if (args.keyword)
          result = result.filter((m) => m.content.includes(args.keyword));

        result.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        result = result.slice(0, args.limit ?? 50);

        return text(`共找到 ${result.length} 条记忆\n\n${fmt(result)}`);
      }

      // ── search_memory ─────────────────────────────────────────────────────────
      case "search_memory": {
        const q = args.query.toLowerCase();
        let result = memories.filter(
          (m) =>
            m.content.toLowerCase().includes(q) ||
            m.tags.some((t) => t.toLowerCase().includes(q)) ||
            (m.source ?? "").toLowerCase().includes(q)
        );
        if (args.category) result = result.filter((m) => m.category === args.category);
        result.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        result = result.slice(0, args.limit ?? 20);

        return text(`搜索"${args.query}"，命中 ${result.length} 条\n\n${fmt(result)}`);
      }

      // ── delete_memory ─────────────────────────────────────────────────────────
      case "delete_memory": {
        const before = memories.length;
        memories = memories.filter((m) => m.id !== args.id);
        if (memories.length === before)
          return text(`⚠ 未找到 ID: ${args.id}`);
        save(memories);
        return text(`✓ 已删除记忆 ${args.id}`);
      }

      // ── update_memory ─────────────────────────────────────────────────────────
      case "update_memory": {
        const idx = memories.findIndex((m) => m.id === args.id);
        if (idx === -1) return text(`⚠ 未找到 ID: ${args.id}`);

        const updated = {
          ...memories[idx],
          ...(args.content !== undefined && { content: args.content }),
          ...(args.tags    !== undefined && { tags:    args.tags }),
          ...(args.source  !== undefined && { source:  args.source }),
          updated_at: new Date().toISOString(),
        };
        memories[idx] = updated;
        save(memories);
        return text(`✓ 记忆已更新\n\n${fmt(updated)}`);
      }

      // ── get_stats ─────────────────────────────────────────────────────────────
      case "get_stats": {
        const sorted = [...memories].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        const stats = {
          总数: memories.length,
          各分类: Object.fromEntries(
            CATEGORIES.map((c) => [`${c}（${CATEGORY_DESC[c].split("—")[0].trim()}）`,
              memories.filter((m) => m.category === c).length])
          ),
          所有标签: [...new Set(memories.flatMap((m) => m.tags))].sort(),
          最早记忆: sorted[0]?.timestamp ?? "无",
          最新记忆: sorted[sorted.length - 1]?.timestamp ?? "无",
          数据文件: DATA_FILE,
        };
        return text(fmt(stats));
      }

      default:
        return { content: [{ type: "text", text: `未知工具: ${name}` }], isError: true };
    }
  } catch (err) {
    return { content: [{ type: "text", text: `错误: ${err.message}\n${err.stack}` }], isError: true };
  }
});

// ─── 工具函数 ──────────────────────────────────────────────────────────────────
function text(str) {
  return { content: [{ type: "text", text: str }] };
}
function fmt(obj) {
  return JSON.stringify(obj, null, 2);
}

// ─── 启动 ──────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
