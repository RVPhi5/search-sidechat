import initSqlJs from "sql.js";
import { readFileSync, writeFileSync, existsSync } from "fs";

const DATA_DIR = existsSync("/data") ? "/data" : ".";
const DB_PATH = process.env.DB_PATH || `${DATA_DIR}/posts.db`;
export { DB_PATH };

let SQL;

async function getSqlJs() {
  if (!SQL) SQL = await initSqlJs();
  return SQL;
}

export async function getDB() {
  const SQL = await getSqlJs();
  let db;

  if (existsSync(DB_PATH)) {
    const buf = readFileSync(DB_PATH);
    db = new SQL.Database(buf);
    migrateSchema(db);
  } else {
    db = new SQL.Database();
    initSchema(db);
    saveDB(db);
  }

  return db;
}

function migrateSchema(db) {
  try { db.run(`ALTER TABLE posts ADD COLUMN comments_scraped_at TEXT`); } catch {}
  db.run(`
    CREATE TABLE IF NOT EXISTS comments (
      id              TEXT PRIMARY KEY,
      post_id         TEXT NOT NULL,
      text            TEXT NOT NULL DEFAULT '',
      alias           TEXT,
      identity_name   TEXT,
      identity_emoji  TEXT,
      vote_total      INTEGER NOT NULL DEFAULT 0,
      reply_post_id   TEXT,
      created_at      TEXT NOT NULL,
      assets          TEXT DEFAULT '[]'
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id)`);
  db.run(`
    CREATE TABLE IF NOT EXISTS usage_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      event      TEXT NOT NULL,
      query      TEXT,
      ip         TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_log(created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_usage_event ON usage_log(event)`);
}

export function saveDB(db) {
  const data = db.export();
  writeFileSync(DB_PATH, Buffer.from(data));
}

function initSchema(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS posts (
      id              TEXT PRIMARY KEY,
      group_id        TEXT NOT NULL,
      text            TEXT NOT NULL DEFAULT '',
      alias           TEXT,
      identity_name   TEXT,
      identity_emoji  TEXT,
      vote_total      INTEGER NOT NULL DEFAULT 0,
      comment_count   INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL,
      assets          TEXT DEFAULT '[]',
      attachments     TEXT DEFAULT '[]',
      tags            TEXT DEFAULT '[]',
      has_poll        INTEGER NOT NULL DEFAULT 0,
      poll_data       TEXT,
      quote_post_id   TEXT,
      scraped_at      TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_posts_group ON posts(group_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_posts_votes ON posts(vote_total)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS comments (
      id              TEXT PRIMARY KEY,
      post_id         TEXT NOT NULL,
      text            TEXT NOT NULL DEFAULT '',
      alias           TEXT,
      identity_name   TEXT,
      identity_emoji  TEXT,
      vote_total      INTEGER NOT NULL DEFAULT 0,
      reply_post_id   TEXT,
      created_at      TEXT NOT NULL,
      assets          TEXT DEFAULT '[]'
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id)`);

  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts4(
      id,
      text,
      alias,
      identity_name,
      content="posts"
    )
  `);

  db.run(`
    CREATE TRIGGER IF NOT EXISTS posts_ai AFTER INSERT ON posts BEGIN
      INSERT INTO posts_fts(docid, id, text, alias, identity_name)
      VALUES (new.rowid, new.id, new.text, new.alias, new.identity_name);
    END
  `);

  db.run(`
    CREATE TRIGGER IF NOT EXISTS posts_ad AFTER DELETE ON posts BEGIN
      INSERT INTO posts_fts(posts_fts, docid, id, text, alias, identity_name)
      VALUES ('delete', old.rowid, old.id, old.text, old.alias, old.identity_name);
    END
  `);

  db.run(`
    CREATE TRIGGER IF NOT EXISTS posts_au AFTER UPDATE ON posts BEGIN
      INSERT INTO posts_fts(posts_fts, docid, id, text, alias, identity_name)
      VALUES ('delete', old.rowid, old.id, old.text, old.alias, old.identity_name);
      INSERT INTO posts_fts(docid, id, text, alias, identity_name)
      VALUES (new.rowid, new.id, new.text, new.alias, new.identity_name);
    END
  `);
}

export function disableFTSTriggers(db) {
  db.run("DROP TRIGGER IF EXISTS posts_ai");
  db.run("DROP TRIGGER IF EXISTS posts_ad");
  db.run("DROP TRIGGER IF EXISTS posts_au");
}

export function rebuildFTS(db) {
  db.run("DROP TABLE IF EXISTS posts_fts");
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts4(
      id, text, alias, identity_name, content="posts"
    )
  `);
  db.run(`INSERT INTO posts_fts(posts_fts) VALUES('rebuild')`);
  db.run(`
    CREATE TRIGGER IF NOT EXISTS posts_ai AFTER INSERT ON posts BEGIN
      INSERT INTO posts_fts(docid, id, text, alias, identity_name)
      VALUES (new.rowid, new.id, new.text, new.alias, new.identity_name);
    END
  `);
  db.run(`
    CREATE TRIGGER IF NOT EXISTS posts_ad AFTER DELETE ON posts BEGIN
      INSERT INTO posts_fts(posts_fts, docid, id, text, alias, identity_name)
      VALUES ('delete', old.rowid, old.id, old.text, old.alias, old.identity_name);
    END
  `);
  db.run(`
    CREATE TRIGGER IF NOT EXISTS posts_au AFTER UPDATE ON posts BEGIN
      INSERT INTO posts_fts(posts_fts, docid, id, text, alias, identity_name)
      VALUES ('delete', old.rowid, old.id, old.text, old.alias, old.identity_name);
      INSERT INTO posts_fts(docid, id, text, alias, identity_name)
      VALUES (new.rowid, new.id, new.text, new.alias, new.identity_name);
    END
  `);
}

export function upsertPost(db, post) {
  const existing = db.exec(`SELECT id FROM posts WHERE id = ?`, [post.id]);

  const params = [
    post.id,
    post.group_id,
    post.text || "",
    post.alias || null,
    post.identity?.name || null,
    post.identity?.conversation_icon?.emoji || null,
    post.vote_total ?? 0,
    post.comment_count ?? 0,
    post.created_at,
    JSON.stringify(post.assets || []),
    JSON.stringify(post.attachments || []),
    JSON.stringify(post.tags || []),
    post.poll ? 1 : 0,
    post.poll ? JSON.stringify(post.poll) : null,
    post.quote_post?.post?.id || null,
  ];

  if (existing.length > 0 && existing[0].values.length > 0) {
    db.run(
      `UPDATE posts SET
        group_id = ?, text = ?, alias = ?, identity_name = ?, identity_emoji = ?,
        vote_total = ?, comment_count = ?, created_at = ?, assets = ?, attachments = ?,
        tags = ?, has_poll = ?, poll_data = ?, quote_post_id = ?
       WHERE id = ?`,
      [
        params[1], params[2], params[3], params[4], params[5],
        params[6], params[7], params[8], params[9], params[10],
        params[11], params[12], params[13], params[14],
        params[0],
      ]
    );
  } else {
    db.run(
      `INSERT INTO posts (id, group_id, text, alias, identity_name, identity_emoji,
                          vote_total, comment_count, created_at, assets, attachments,
                          tags, has_poll, poll_data, quote_post_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params
    );
  }
}

export function upsertComment(db, comment, postId) {
  const params = [
    comment.id,
    postId,
    comment.text || "",
    comment.alias || null,
    comment.identity?.name || null,
    comment.identity?.conversation_icon?.emoji || null,
    comment.vote_total ?? 0,
    comment.reply_post_id || null,
    comment.created_at,
    JSON.stringify(comment.assets || []),
  ];

  const existing = db.exec(`SELECT id FROM comments WHERE id = ?`, [comment.id]);
  if (existing.length > 0 && existing[0].values.length > 0) {
    db.run(
      `UPDATE comments SET post_id=?, text=?, alias=?, identity_name=?, identity_emoji=?,
       vote_total=?, reply_post_id=?, created_at=?, assets=? WHERE id=?`,
      [params[1], params[2], params[3], params[4], params[5],
       params[6], params[7], params[8], params[9], params[0]]
    );
  } else {
    db.run(
      `INSERT INTO comments (id, post_id, text, alias, identity_name, identity_emoji,
       vote_total, reply_post_id, created_at, assets)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params
    );
  }
}

export function markCommentsScraped(db, postId) {
  db.run(`UPDATE posts SET comments_scraped_at = datetime('now') WHERE id = ?`, [postId]);
}

export function logUsage(db, event, query, ip) {
  db.run(
    `INSERT INTO usage_log (event, query, ip) VALUES (?, ?, ?)`,
    [event, query || null, ip || null]
  );
}
