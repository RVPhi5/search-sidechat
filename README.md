# search_sidechat

Scrapes posts from a Sidechat group into a local SQLite database with full-text search, served through a web UI.

## Setup

```bash
npm install
```

## Configuration

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `SIDECHAT_TOKEN` | Yes | Your Sidechat bearer token (from the offsides app's MMKV storage, key: `userToken`) |
| `SIDECHAT_GROUP_ID` | Yes | The group ID to scrape |
| `SIDECHAT_SORT` | No | Sort method: `recent`, `hot`, or `top` (default: `recent`) |
| `SIDECHAT_MAX_PAGES` | No | Max pages to scrape per run (default: 50) |
| `SIDECHAT_DELAY_MS` | No | Delay between API calls in ms (default: 1000) |
| `PORT` | No | Web server port (default: 3000) |

### Finding your group ID

Run the scraper with `--list-groups` to see available groups:

```bash
SIDECHAT_TOKEN=your_token node scrape.js --list-groups
```

## Usage

### 1. Scrape posts into the database

```bash
npm run scrape
```

Run this periodically to pick up new posts. Existing posts are updated (vote counts, etc.) without duplicates.

### 2. Start the search UI

```bash
npm start
```

Open http://localhost:3000 in your browser.

### Search features

- Full-text search across post text, alias, and identity name
- Sort by relevance, date, votes, or comment count
- Paginated results
- Search term highlighting
