import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";
import pg from "pg";

const { Pool } = pg;
const PORT = process.env.PORT || 3001;
const TOKEN = process.env.MCP_TOKEN || "";

// ─── Database ──────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      category TEXT NOT NULL,
      tags JSONB DEFAULT '[]',
      source TEXT DEFAULT 'claude',
      mood TEXT,
      timestamp TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ
    )
  `);
  console.log("✓ 数据库已就绪");
}

async function load() {
  const { rows } = await pool.query(
    `SELECT * FROM memories WHERE expires_at IS NULL OR expires_at > NOW() ORDER BY timestamp DESC`
  );
  return rows.map(r => ({
    ...r,
    tags: r.tags || [],
    timestamp: r.timestamp?.toISOString(),
    updated_at: r.updated_at?.toISOString(),
    expires_at: r.expires_at?.toISOString(),
  }));
}

const CATEGORIES = ["deep", "daily", "diary", "knowledge"];

// ─── MCP Server factory ────────────────────────────────────────────────────────
function createMcpServer() {
  const server = new Server(
    { name: "memory-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "write_memory",
        description: "写入一条新记忆。daily 类型会在 expires_days 天后自动过期。",
        inputSchema: {
          type: "object", required: ["content", "category"],
          properties: {
            content:      { type: "string" },
            category:     { type: "string", enum: CATEGORIES },
            tags:         { type: "array", items: { type: "string" }, default: [] },
            source:       { type: "string", default: "claude" },
            mood:         { type: "string", enum: ["happy","sad","calm","excited","anxious"] },
            expires_days: { type: "number", default: 7, description: "仅 daily 有效" },
          },
        },
      },
      {
        name: "read_memory",
        description: "读取记忆，支持按分类、标签（AND）、关键词筛选，结果按时间倒序。",
        inputSchema: {
          type: "object",
          properties: {
            category: { type: "string", enum: CATEGORIES },
            tags:     { type: "array", items: { type: "string" } },
            keyword:  { type: "string" },
            limit:    { type: "number", default: 50 },
          },
        },
      },
      {
        name: "search_memory",
        description: "全文搜索记忆内容、标签、来源字段。",
        inputSchema: {
          type: "object", required: ["query"],
          properties: {
            query:    { type: "string" },
            category: { type: "string", enum: CATEGORIES },
            limit:    { type: "number", default: 20 },
          },
        },
      },
      {
        name: "delete_memory",
        description: "按 ID 删除一条记忆。",
        inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      },
      {
        name: "update_memory",
        description: "按 ID 更新记忆（只传要改的字段）。",
        inputSchema: {
          type: "object", required: ["id"],
          properties: {
            id:      { type: "string" },
            content: { type: "string" },
            tags:    { type: "array", items: { type: "string" } },
            source:  { type: "string" },
            mood:    { type: "string" },
          },
        },
      },
      {
        name: "get_stats",
        description: "查看记忆库统计：总数、各分类、所有标签。",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const t = (s) => ({ content: [{ type: "text", text: s }] });

    try {
      switch (name) {

        case "write_memory": {
          const id = randomUUID();
          const expires_at = args.category === "daily"
            ? new Date(Date.now() + (args.expires_days ?? 7) * 86_400_000)
            : null;
          await pool.query(
            `INSERT INTO memories (id, content, category, tags, source, mood, expires_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [id, args.content, args.category, JSON.stringify(args.tags ?? []),
             args.source ?? "claude", args.mood ?? null, expires_at]
          );
          return t(`✓ 记忆已写入 (id: ${id})`);
        }

        case "read_memory": {
          let memories = await load();
          if (args.category) memories = memories.filter(m => m.category === args.category);
          if (args.tags?.length) memories = memories.filter(m => args.tags.every(tag => m.tags.includes(tag)));
          if (args.keyword) memories = memories.filter(m => m.content.includes(args.keyword));
          memories = memories.slice(0, args.limit ?? 50);
          return t(`找到 ${memories.length} 条记忆\n${JSON.stringify(memories, null, 2)}`);
        }

        case "search_memory": {
          const q = args.query.toLowerCase();
          let memories = await load();
          memories = memories.filter(m =>
            m.content.toLowerCase().includes(q) ||
            m.tags.some(tag => tag.toLowerCase().includes(q)) ||
            (m.source ?? "").toLowerCase().includes(q)
          );
          if (args.category) memories = memories.filter(m => m.category === args.category);
          memories = memories.slice(0, args.limit ?? 20);
          return t(`搜索"${args.query}"命中 ${memories.length} 条\n${JSON.stringify(memories, null, 2)}`);
        }

        case "delete_memory": {
          const { rowCount } = await pool.query(`DELETE FROM memories WHERE id = $1`, [args.id]);
          if (rowCount === 0) return t(`⚠ 未找到 ID: ${args.id}`);
          return t(`✓ 已删除 ${args.id}`);
        }

        case "update_memory": {
          const sets = [];
          const vals = [];
          let i = 1;
          if (args.content !== undefined) { sets.push(`content=$${i++}`); vals.push(args.content); }
          if (args.tags    !== undefined) { sets.push(`tags=$${i++}`);    vals.push(JSON.stringify(args.tags)); }
          if (args.source  !== undefined) { sets.push(`source=$${i++}`);  vals.push(args.source); }
          if (args.mood    !== undefined) { sets.push(`mood=$${i++}`);    vals.push(args.mood); }
          if (!sets.length) return t("⚠ 没有提供要更新的字段");
          sets.push(`updated_at=NOW()`);
          vals.push(args.id);
          const { rowCount } = await pool.query(
            `UPDATE memories SET ${sets.join(",")} WHERE id=$${i}`, vals
          );
          if (rowCount === 0) return t(`⚠ 未找到 ID: ${args.id}`);
          return t(`✓ 已更新 ${args.id}`);
        }

        case "get_stats": {
          const memories = await load();
          return t(JSON.stringify({
            总数: memories.length,
            各分类: Object.fromEntries(CATEGORIES.map(c => [c, memories.filter(m => m.category === c).length])),
            所有标签: [...new Set(memories.flatMap(m => m.tags))].sort(),
          }, null, 2));
        }

        default:
          return { content: [{ type: "text", text: `未知工具: ${name}` }], isError: true };
      }
    } catch (err) {
      return { content: [{ type: "text", text: `错误: ${err.message}` }], isError: true };
    }
  });

  return server;
}

// ─── Express ─────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.get("/health", (_, res) => res.json({ ok: true }));

// ─── Streamable HTTP transport (/mcp) ────────────────────────────────────────
const streamableSessions = new Map();

app.post("/mcp", async (req, res) => {
  console.log("POST /mcp received");
  const sessionId = req.headers["mcp-session-id"];
  let transport;

  try {
    if (sessionId && streamableSessions.has(sessionId)) {
      // Reuse existing transport
      transport = streamableSessions.get(sessionId);
      await transport.handleRequest(req, res, req.body);
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New initialization request
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      const mcpServer = createMcpServer();

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) streamableSessions.delete(sid);
        console.log(`Session closed: ${sid}`);
      };

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);

      const sid = transport.sessionId;
      if (sid) {
        streamableSessions.set(sid, transport);
        console.log(`New session: ${sid}`);
      }
    } else {
      // Invalid request
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32600, message: "Bad Request: No valid session or initialize request" },
        id: null,
      });
    }
  } catch (err) {
    console.error("Error in POST /mcp:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", async (req, res) => {
  console.log("GET /mcp received");
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && streamableSessions.has(sessionId)) {
    const transport = streamableSessions.get(sessionId);
    await transport.handleRequest(req, res);
  } else {
    res.status(405).set("Allow", "POST").send("Method Not Allowed");
  }
});

app.delete("/mcp", async (req, res) => {
  console.log("DELETE /mcp received");
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && streamableSessions.has(sessionId)) {
    const transport = streamableSessions.get(sessionId);
    await transport.close();
    streamableSessions.delete(sessionId);
    res.status(200).send("Session terminated");
  } else {
    res.status(404).send("Session not found");
  }
});

// ─── Legacy SSE transport (/sse + /messages) ─────────────────────────────────
const sseSessions = new Map();

app.get("/sse", async (req, res) => {
  console.log("GET /sse received");
  if (TOKEN && req.query.token !== TOKEN) {
    return res.status(401).send("Unauthorized");
  }
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  const transport = new SSEServerTransport("/messages", res);
  const mcpServer = createMcpServer();
  sseSessions.set(transport.sessionId, transport);
  res.on("close", () => sseSessions.delete(transport.sessionId));
  await mcpServer.connect(transport);
});

app.post("/messages", async (req, res) => {
  const transport = sseSessions.get(req.query.sessionId);
  if (!transport) return res.status(404).json({ error: "session not found" });
  await transport.handlePostMessage(req, res);
});

// ─── Start ───────────────────────────────────────────────────────────────────
await initDB();
app.listen(PORT, () => {
  console.log(`\n🔌 MCP 服务已启动 → http://localhost:${PORT}`);
  console.log(`   Streamable HTTP: /mcp`);
  console.log(`   Legacy SSE: /sse\n`);
});
