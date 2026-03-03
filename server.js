import express from "express";
import { SidechatAPIClient } from "sidechat.js";
import { getDB, upsertPost, upsertComment, markCommentsScraped, saveDB, disableFTSTriggers, rebuildFTS, logUsage, DB_PATH } from "./db.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;
const SCRAPE_INTERVAL_MINS = parseInt(process.env.SCRAPE_INTERVAL_MINS || "15", 10);

let db;

let isBackfilling = false;

function getPostCount() {
  try {
    const r = db.exec("SELECT COUNT(*) FROM posts");
    return r[0]?.values[0]?.[0] || 0;
  } catch { return 0; }
}

async function autoScrape() {
  if (isBackfilling) return;

  const token = process.env.SIDECHAT_TOKEN;
  const groupId = process.env.SIDECHAT_GROUP_ID;
  if (!token || !groupId) return;

  const delayMs = parseInt(process.env.SIDECHAT_DELAY_MS || "0", 10);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const postCount = getPostCount();
  const fullScrape = postCount < 50000;

  if (fullScrape) {
    isBackfilling = true;
    console.log(`[auto-scrape] Backfill mode: only ${postCount} posts in DB, scraping all history...`);
  }

  const maxPages = fullScrape ? 10000 : 200;
  const cutoff = fullScrape ? null : new Date(Date.now() - 24 * 60 * 60 * 1000);

  try {
    const api = new SidechatAPIClient(token);
    disableFTSTriggers(db);

    let cursor = null;
    let total = 0;

    for (let page = 0; page < maxPages; page++) {
      const res = await api.getGroupPosts(groupId, "recent", cursor);
      const posts = (res.posts || []).filter((p) => p.id);
      if (!posts.length) break;

      let hitCutoff = false;
      for (const post of posts) {
        if (cutoff && new Date(post.created_at) < cutoff) { hitCutoff = true; continue; }
        upsertPost(db, post);
        if (post.comment_count > 0) {
          try {
            const comments = await api.getPostComments(post.id);
            for (const c of comments) upsertComment(db, c, post.id);
            markCommentsScraped(db, post.id);
          } catch (err) {
            console.error(`[auto-scrape] Comment fetch failed for ${post.id}:`, err.message);
          }
        }
        total++;
      }
      if (hitCutoff) break;

      if (page % 100 === 0 && page > 0) {
        saveDB(db);
        console.log(`[auto-scrape] Progress: page ${page}, ${total} posts so far...`);
      }

      cursor = res.cursor;
      if (!cursor) break;
      if (delayMs > 0) await sleep(delayMs);
    }

    rebuildFTS(db);
    saveDB(db);
    const commentCount = (() => { try { const r = db.exec("SELECT COUNT(*) FROM comments"); return r[0]?.values[0]?.[0] || 0; } catch { return 0; } })();
    console.log(`[auto-scrape] ${total} posts updated at ${new Date().toISOString()} (total in DB: ${getPostCount()} posts, ${commentCount} comments)`);
  } catch (err) {
    console.error("[auto-scrape] Error:", err.message);
  } finally {
    isBackfilling = false;
  }
}

const COMMENT_BATCH_SIZE = parseInt(process.env.COMMENT_BATCH_SIZE || "100", 10);
let isScrapingComments = false;
let commentBackfillDone = false;

function getUnscrapedCommentCount() {
  try {
    const r = db.exec("SELECT COUNT(*) FROM posts WHERE comments_scraped_at IS NULL AND comment_count > 0");
    return r[0]?.values[0]?.[0] || 0;
  } catch { return 0; }
}

async function commentBackfillLoop() {
  if (isScrapingComments || isBackfilling) {
    setTimeout(commentBackfillLoop, 10000);
    return;
  }

  const token = process.env.SIDECHAT_TOKEN;
  if (!token) return;

  isScrapingComments = true;
  const delayMs = parseInt(process.env.SIDECHAT_DELAY_MS || "0", 10);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    const api = new SidechatAPIClient(token);
    const postsToScrape = queryAll(
      `SELECT id FROM posts WHERE comments_scraped_at IS NULL AND comment_count > 0
       ORDER BY created_at DESC LIMIT ?`,
      [COMMENT_BATCH_SIZE]
    );

    if (!postsToScrape.length) {
      commentBackfillDone = true;
      console.log("[comment-scrape] Backfill complete. Switching to 24h refresh.");
      isScrapingComments = false;
      scheduleCommentRefresh();
      return;
    }

    let totalComments = 0;
    for (const { id } of postsToScrape) {
      try {
        const comments = await api.getPostComments(id);
        for (const c of comments) {
          upsertComment(db, c, id);
        }
        markCommentsScraped(db, id);
        totalComments += comments.length;
      } catch (err) {
        console.error(`[comment-scrape] Error on post ${id}:`, err.message);
        markCommentsScraped(db, id);
      }
      if (delayMs > 0) await sleep(delayMs);
    }

    saveDB(db);
    const remaining = getUnscrapedCommentCount();
    console.log(`[comment-scrape] Scraped ${totalComments} comments from ${postsToScrape.length} posts (${remaining} posts remaining)`);
  } catch (err) {
    console.error("[comment-scrape] Error:", err.message);
  } finally {
    isScrapingComments = false;
  }

  if (!commentBackfillDone) {
    setTimeout(commentBackfillLoop, 2000);
  }
}

async function commentRefresh() {
  if (isScrapingComments || isBackfilling) return;

  const token = process.env.SIDECHAT_TOKEN;
  if (!token) return;

  isScrapingComments = true;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    const api = new SidechatAPIClient(token);
    const postsToScrape = queryAll(
      `SELECT id FROM posts WHERE comments_scraped_at IS NULL AND comment_count > 0
       ORDER BY created_at DESC LIMIT ?`,
      [COMMENT_BATCH_SIZE]
    );

    let totalComments = 0;
    for (const { id } of postsToScrape) {
      try {
        const comments = await api.getPostComments(id);
        for (const c of comments) {
          upsertComment(db, c, id);
        }
        markCommentsScraped(db, id);
        totalComments += comments.length;
      } catch (err) {
        console.error(`[comment-scrape] Error on post ${id}:`, err.message);
        markCommentsScraped(db, id);
      }
    }

    if (totalComments > 0) {
      saveDB(db);
      console.log(`[comment-refresh] Scraped ${totalComments} comments from ${postsToScrape.length} new posts`);
    }
  } catch (err) {
    console.error("[comment-refresh] Error:", err.message);
  } finally {
    isScrapingComments = false;
  }
}

function scheduleCommentRefresh() {
  setInterval(commentRefresh, 24 * 60 * 60 * 1000);
}

async function init() {
  db = await getDB();
  console.log(`Database: ${DB_PATH}`);

  if (process.env.SIDECHAT_TOKEN && process.env.SIDECHAT_GROUP_ID) {
    console.log(`Auto-scrape enabled: every ${SCRAPE_INTERVAL_MINS} minutes`);
    autoScrape();
    setInterval(autoScrape, SCRAPE_INTERVAL_MINS * 60 * 1000);

    console.log(`Comment scrape enabled: continuous backfill (batch ${COMMENT_BATCH_SIZE}), then 24h refresh`);
    setTimeout(commentBackfillLoop, 30000);
  }
}

let usageSaveTimer = null;
function trackUsage(event, query, ip) {
  try {
    logUsage(db, event, query, ip);
    if (!usageSaveTimer) {
      usageSaveTimer = setTimeout(() => { saveDB(db); usageSaveTimer = null; }, 30000);
    }
  } catch {}
}

function getClientIP(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
}

app.use(express.static(join(__dirname, "public")));

app.get("/", (req, res, next) => {
  trackUsage("visit", null, getClientIP(req));
  next();
});

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

function attachQuotedPosts(posts) {
  const quoteIds = posts.filter(p => p.quote_post_id).map(p => p.quote_post_id);
  if (!quoteIds.length) return posts;
  const placeholders = quoteIds.map(() => "?").join(",");
  const quoted = queryAll(
    `SELECT id, text, alias, identity_name, identity_emoji, vote_total, created_at FROM posts WHERE id IN (${placeholders})`,
    quoteIds
  );
  const map = Object.fromEntries(quoted.map(q => [q.id, q]));
  return posts.map(p => p.quote_post_id ? { ...p, quoted_post: map[p.quote_post_id] || null } : p);
}

app.get("/api/search", (req, res) => {
  const { q, sort, order, page, after, before } = req.query;
  if (q && q.trim()) trackUsage("search", q.trim(), getClientIP(req));
  const limit = 50;
  const offset = ((parseInt(page, 10) || 1) - 1) * limit;

  const dateFilters = [];
  const dateParams = [];
  if (after) { dateFilters.push("created_at >= ?"); dateParams.push(after); }
  if (before) { dateFilters.push("created_at < ?"); dateParams.push(before); }
  const dateWhere = dateFilters.length ? dateFilters.join(" AND ") : "";

  try {
    if (!q || q.trim() === "") {
      const sortCol = ["vote_total", "created_at", "comment_count"].includes(sort)
        ? sort
        : "created_at";
      const sortDir = order === "ASC" ? "ASC" : "DESC";
      const where = dateWhere ? `WHERE ${dateWhere}` : "";

      const total = queryOne(`SELECT COUNT(*) as n FROM posts ${where}`, dateParams)?.n || 0;
      const posts = attachQuotedPosts(queryAll(
        `SELECT * FROM posts ${where} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`,
        [...dateParams, limit, offset]
      ));

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
    const extraWhere = dateWhere ? `AND ${dateWhere.replace(/created_at/g, "p.created_at")}` : "";

    const countResult = db.exec(
      `SELECT COUNT(*) as n FROM posts_fts fts JOIN posts p ON p.id = fts.id WHERE posts_fts MATCH ? ${extraWhere}`,
      [q, ...dateParams]
    );
    const total = countResult.length ? countResult[0].values[0][0] : 0;

    const posts = attachQuotedPosts(queryAll(
      `SELECT p.*
       FROM posts_fts fts
       JOIN posts p ON p.id = fts.id
       WHERE posts_fts MATCH ? ${extraWhere}
       ORDER BY ${sortCol} ${sortDir}
       LIMIT ? OFFSET ?`,
      [q, ...dateParams, limit, offset]
    ));

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

app.get("/api/post/:id", (req, res) => {
  try {
    const post = queryOne("SELECT * FROM posts WHERE id = ?", [req.params.id]);
    if (!post) return res.status(404).json({ error: "Post not found" });

    if (post.quote_post_id) {
      post.quoted_post = queryOne(
        "SELECT id, text, alias, identity_name, identity_emoji, vote_total, created_at FROM posts WHERE id = ?",
        [post.quote_post_id]
      );
    }

    const comments = queryAll(
      "SELECT * FROM comments WHERE post_id = ? ORDER BY created_at ASC",
      [req.params.id]
    );

    res.json({ post, comments });
  } catch (err) {
    console.error("Post detail error:", err);
    res.status(500).json({ error: "Internal server error." });
  }
});

app.post("/api/upload-db", async (req, res) => {
  const secret = process.env.UPLOAD_SECRET;
  if (!secret || req.headers["x-upload-secret"] !== secret) {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    const { writeFileSync } = await import("fs");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const buf = Buffer.concat(chunks);
    writeFileSync(DB_PATH, buf);
    db = await getDB();
    res.json({ ok: true, size: buf.length });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/usage", (_req, res) => {
  try {
    const today = queryOne(
      `SELECT COUNT(*) as visits FROM usage_log WHERE event='visit' AND created_at >= date('now')`
    );
    const todaySearches = queryOne(
      `SELECT COUNT(*) as searches FROM usage_log WHERE event='search' AND created_at >= date('now')`
    );
    const total = queryOne(
      `SELECT
        (SELECT COUNT(*) FROM usage_log WHERE event='visit') as total_visits,
        (SELECT COUNT(*) FROM usage_log WHERE event='search') as total_searches,
        (SELECT COUNT(DISTINCT ip) FROM usage_log WHERE event='visit') as unique_visitors,
        (SELECT COUNT(DISTINCT ip) FROM usage_log WHERE event='visit' AND created_at >= date('now')) as unique_today`
    );
    const topSearches = queryAll(
      `SELECT query, COUNT(*) as count FROM usage_log WHERE event='search' AND query IS NOT NULL
       GROUP BY query ORDER BY count DESC LIMIT 20`
    );
    const dailyVisits = queryAll(
      `SELECT date(created_at) as day, COUNT(*) as visits,
       COUNT(DISTINCT ip) as unique_visitors
       FROM usage_log WHERE event='visit'
       GROUP BY date(created_at) ORDER BY day DESC LIMIT 30`
    );
    const dailySearches = queryAll(
      `SELECT date(created_at) as day, COUNT(*) as searches
       FROM usage_log WHERE event='search'
       GROUP BY date(created_at) ORDER BY day DESC LIMIT 30`
    );

    res.json({
      today: { visits: today?.visits || 0, searches: todaySearches?.searches || 0, unique_visitors: total?.unique_today || 0 },
      all_time: { visits: total?.total_visits || 0, searches: total?.total_searches || 0, unique_visitors: total?.unique_visitors || 0 },
      top_searches: topSearches,
      daily_visits: dailyVisits,
      daily_searches: dailySearches,
    });
  } catch (err) {
    console.error("Usage error:", err);
    res.status(500).json({ error: "Internal server error." });
  }
});

app.get("/api/charts", (_req, res) => {
  try {
    const postsPerDay = queryAll(
      `SELECT date(created_at) as day, COUNT(*) as count
       FROM posts GROUP BY date(created_at) ORDER BY day ASC`
    );
    const postsPerMonth = queryAll(
      `SELECT strftime('%Y-%m', created_at) as month, COUNT(*) as count
       FROM posts GROUP BY strftime('%Y-%m', created_at) ORDER BY month ASC`
    );
    const postsByHour = queryAll(
      `SELECT CAST(strftime('%H', created_at) AS INTEGER) as hour, COUNT(*) as count
       FROM posts GROUP BY strftime('%H', created_at) ORDER BY hour ASC`
    );
    const postsByDayOfWeek = queryAll(
      `SELECT CAST(strftime('%w', created_at) AS INTEGER) as dow, COUNT(*) as count
       FROM posts GROUP BY strftime('%w', created_at) ORDER BY dow ASC`
    );
    const topPosters = queryAll(
      `SELECT COALESCE(identity_name, alias, 'Anonymous') as name, COUNT(*) as count
       FROM posts GROUP BY name ORDER BY count DESC LIMIT 15`
    );
    const voteDistribution = queryAll(
      `SELECT
        CASE
          WHEN vote_total < 0 THEN 'negative'
          WHEN vote_total = 0 THEN '0'
          WHEN vote_total BETWEEN 1 AND 10 THEN '1-10'
          WHEN vote_total BETWEEN 11 AND 50 THEN '11-50'
          WHEN vote_total BETWEEN 51 AND 100 THEN '51-100'
          WHEN vote_total BETWEEN 101 AND 500 THEN '101-500'
          ELSE '500+'
        END as bucket,
        COUNT(*) as count
       FROM posts GROUP BY bucket`
    );
    const bucketOrder = ['negative','0','1-10','11-50','51-100','101-500','500+'];
    voteDistribution.sort((a,b) => bucketOrder.indexOf(a.bucket) - bucketOrder.indexOf(b.bucket));

    res.json({ postsPerDay, postsPerMonth, postsByHour, postsByDayOfWeek, topPosters, voteDistribution });
  } catch (err) {
    console.error("Charts error:", err);
    res.status(500).json({ error: "Internal server error." });
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
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
});
