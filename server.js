import express from "express";
import { getDB } from "./db.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

let db;

async function init() {
  db = await getDB();
}

app.use(express.static(join(__dirname, "public")));

function queryAll(sql, params = []) {
  const result = db.exec(sql, params);
  if (!result.length) return [];
  const cols = result[0].columns;
  return result[0].values.map((row) =>
    Object.fromEntries(cols.map((c, i) => [c, row[i]]))
  );
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows[0] || null;
}

app.get("/api/search", (req, res) => {
  const { q, sort, order, page } = req.query;
  const limit = 50;
  const offset = ((parseInt(page, 10) || 1) - 1) * limit;

  try {
    if (!q || q.trim() === "") {
      const sortCol = ["vote_total", "created_at", "comment_count"].includes(sort)
        ? sort
        : "created_at";
      const sortDir = order === "ASC" ? "ASC" : "DESC";

      const total = queryOne("SELECT COUNT(*) as n FROM posts")?.n || 0;
      const posts = queryAll(
        `SELECT * FROM posts ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`,
        [limit, offset]
      );

      return res.json({
        posts,
        total,
        page: offset / limit + 1,
        pages: Math.ceil(total / limit),
      });
    }

    const useRelevance = !["vote_total", "created_at", "comment_count"].includes(sort);
    const sortCol = useRelevance ? "p.created_at" : `p.${sort}`;
    const sortDir = useRelevance ? "DESC" : (order === "ASC" ? "ASC" : "DESC");

    const countResult = db.exec(
      `SELECT COUNT(*) as n FROM posts_fts WHERE posts_fts MATCH ?`,
      [q]
    );
    const total = countResult.length ? countResult[0].values[0][0] : 0;

    const posts = queryAll(
      `SELECT p.*
       FROM posts_fts fts
       JOIN posts p ON p.id = fts.id
       WHERE posts_fts MATCH ?
       ORDER BY ${sortCol} ${sortDir}
       LIMIT ? OFFSET ?`,
      [q, limit, offset]
    );

    res.json({
      posts,
      total,
      page: offset / limit + 1,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    if (err.message?.includes("fts")) {
      return res.status(400).json({ error: "Invalid search query syntax." });
    }
    console.error("Search error:", err);
    res.status(500).json({ error: "Internal server error." });
  }
});

app.get("/api/asset", async (req, res) => {
  const { url } = req.query;
  if (!url || !url.startsWith("https://api.sidechat.lol/")) {
    return res.status(400).json({ error: "Invalid asset URL" });
  }
  try {
    const token = process.env.SIDECHAT_TOKEN;
    const response = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) return res.status(response.status).end();
    const contentType = response.headers.get("content-type");
    if (contentType) res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    const buffer = Buffer.from(await response.arrayBuffer());
    res.send(buffer);
  } catch {
    res.status(502).json({ error: "Failed to fetch asset" });
  }
});

app.get("/api/stats", (_req, res) => {
  try {
    const stats = queryOne(
      `SELECT
         COUNT(*) as total_posts,
         MIN(created_at) as oldest_post,
         MAX(created_at) as newest_post,
         SUM(comment_count) as total_comments,
         ROUND(AVG(vote_total), 1) as avg_votes
       FROM posts`
    );
    res.json(stats || {});
  } catch (err) {
    console.error("Stats error:", err);
    res.status(500).json({ error: "Internal server error." });
  }
});

init().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
});
