import express from "express";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");
const DATA_FILE = join(DATA_DIR, "memories.json");
const PORT = process.env.PORT || 3000;

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

function load() {
  if (!existsSync(DATA_FILE)) return [];
  return JSON.parse(readFileSync(DATA_FILE, "utf-8"));
}
function save(memories) {
  writeFileSync(DATA_FILE, JSON.stringify(memories, null, 2), "utf-8");
}
function purgeExpired(memories) {
  const now = Date.now();
  return memories.filter((m) => !m.expires_at || new Date(m.expires_at).getTime() > now);
}

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

// GET /api/memories?category=&keyword=&tags=&limit=
app.get("/api/memories", (req, res) => {
  let list = purgeExpired(load());
  const { category, keyword, tags, limit } = req.query;
  if (category) list = list.filter((m) => m.category === category);
  if (keyword) list = list.filter((m) =>
    m.content.toLowerCase().includes(keyword.toLowerCase()) ||
    m.tags.some((t) => t.toLowerCase().includes(keyword.toLowerCase()))
  );
  if (tags) {
    const tagList = tags.split(",").filter(Boolean);
    list = list.filter((m) => tagList.every((t) => m.tags.includes(t)));
  }
  list.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  if (limit) list = list.slice(0, parseInt(limit));
  res.json(list);
});

// POST /api/memories
app.post("/api/memories", (req, res) => {
  const memories = load();
  const { content, category, tags = [], source = "web", expires_days = 7, mood } = req.body;
  if (!content || !category) return res.status(400).json({ error: "content and category required" });
  const memory = {
    id: randomUUID(),
    content,
    category,
    tags,
    source,
    timestamp: new Date().toISOString(),
    ...(mood && { mood }),
    ...(category === "daily" && {
      expires_at: new Date(Date.now() + expires_days * 86_400_000).toISOString(),
    }),
  };
  memories.push(memory);
  save(memories);
  res.status(201).json(memory);
});

// PATCH /api/memories/:id
app.patch("/api/memories/:id", (req, res) => {
  const memories = load();
  const idx = memories.findIndex((m) => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "not found" });
  const { content, tags, source, mood } = req.body;
  memories[idx] = {
    ...memories[idx],
    ...(content !== undefined && { content }),
    ...(tags !== undefined && { tags }),
    ...(source !== undefined && { source }),
    ...(mood !== undefined && { mood }),
    updated_at: new Date().toISOString(),
  };
  save(memories);
  res.json(memories[idx]);
});

// DELETE /api/memories/:id
app.delete("/api/memories/:id", (req, res) => {
  let memories = load();
  const before = memories.length;
  memories = memories.filter((m) => m.id !== req.params.id);
  if (memories.length === before) return res.status(404).json({ error: "not found" });
  save(memories);
  res.json({ ok: true });
});

// GET /api/stats
app.get("/api/stats", (req, res) => {
  const memories = purgeExpired(load());
  res.json({
    total: memories.length,
    by_category: Object.fromEntries(
      ["deep", "daily", "diary", "knowledge"].map((c) => [c, memories.filter((m) => m.category === c).length])
    ),
    all_tags: [...new Set(memories.flatMap((m) => m.tags))].sort(),
    moods: Object.fromEntries(
      ["happy", "sad", "calm", "excited", "anxious"].map((mood) => [
        mood, memories.filter((m) => m.mood === mood).length,
      ])
    ),
  });
});

app.listen(PORT, () => {
  console.log(`\n🧠 记忆库已启动 → http://localhost:${PORT}\n`);
});
