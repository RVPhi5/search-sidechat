import { SidechatAPIClient } from "sidechat.js";
import { getDB, upsertPost, saveDB, disableFTSTriggers, rebuildFTS } from "./db.js";

const TOKEN = process.env.SIDECHAT_TOKEN;
const GROUP_ID = process.env.SIDECHAT_GROUP_ID;
const SORT = process.env.SIDECHAT_SORT || "recent";
const MAX_PAGES = parseInt(process.env.SIDECHAT_MAX_PAGES || "50", 10);
const DELAY_MS = parseInt(process.env.SIDECHAT_DELAY_MS || "1000", 10);

if (!TOKEN) {
  console.error("Missing SIDECHAT_TOKEN environment variable.");
  console.error("You can find your token in the offsides app's MMKV storage (key: userToken).");
  process.exit(1);
}

if (!GROUP_ID) {
  console.error("Missing SIDECHAT_GROUP_ID environment variable.");
  console.error("Run with --list-groups to see available groups.\n");

  if (process.argv.includes("--list-groups")) {
    const api = new SidechatAPIClient(TOKEN);
    try {
      const updates = await api.getUpdates();
      console.log("Available groups:");
      for (const group of updates.groups) {
        console.log(`  ${group.id}  ${group.name}`);
      }
    } catch (err) {
      console.error("Failed to fetch groups:", err.message);
    }
  }

  process.exit(1);
}

const MAX_AGE_HOURS = parseInt(process.env.SIDECHAT_MAX_AGE_HOURS || "0", 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scrape() {
  const api = new SidechatAPIClient(TOKEN);
  const db = await getDB();
  disableFTSTriggers(db);

  let cursor = null;
  let totalInserted = 0;
  let page = 0;

  const cutoff = MAX_AGE_HOURS > 0
    ? new Date(Date.now() - MAX_AGE_HOURS * 60 * 60 * 1000)
    : null;

  console.log(`Scraping group ${GROUP_ID} sorted by "${SORT}"...`);
  console.log(`Max pages: ${MAX_PAGES}, delay: ${DELAY_MS}ms`);
  if (cutoff) console.log(`Only posts from the last ${MAX_AGE_HOURS}h (after ${cutoff.toISOString()})`);
  console.log();

  while (page < MAX_PAGES) {
    try {
      const res = await api.getGroupPosts(GROUP_ID, SORT, cursor);
      const posts = (res.posts || []).filter((p) => p.id);

      if (posts.length === 0) {
        console.log("No more posts. Done.");
        break;
      }

      let hitCutoff = false;
      let pageInserted = 0;
      for (const post of posts) {
        if (cutoff && new Date(post.created_at) < cutoff) {
          hitCutoff = true;
          continue;
        }
        upsertPost(db, post);
        pageInserted++;
      }
      totalInserted += pageInserted;

      if (hitCutoff) {
        console.log(`Page ${page + 1}: ${pageInserted} posts (reached ${MAX_AGE_HOURS}h cutoff)`);
        break;
      }
      page++;

      if (page % 5 === 0) saveDB(db);

      console.log(
        `Page ${page}: ${posts.length} posts (${totalInserted} total)`
      );

      cursor = res.cursor;
      if (!cursor) {
        console.log("Reached end of feed (no cursor). Done.");
        break;
      }

      await sleep(DELAY_MS);
    } catch (err) {
      if (err.message?.includes("429") || err.status === 429) {
        console.warn("Rate limited. Waiting 30s...");
        await sleep(30000);
        continue;
      }
      console.error(`Error on page ${page + 1}:`, err.message);
      break;
    }
  }

  console.log("Rebuilding search index...");
  rebuildFTS(db);
  saveDB(db);

  const result = db.exec("SELECT COUNT(*) as n FROM posts");
  const count = result[0]?.values[0]?.[0] || 0;
  console.log(`\nDone. ${totalInserted} posts scraped this run.`);
  console.log(`Total posts in database: ${count}`);

  db.close();
}

scrape();
