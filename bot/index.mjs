// ClipSignal — faceless lead feed. Runs on GitHub Actions cron.
// Deps: npm i @neondatabase/serverless
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const PAID_WEBHOOK = process.env.PAID_DISCORD_WEBHOOK_URL;
const FREE_WEBHOOK = process.env.FREE_DISCORD_WEBHOOK_URL;
const MIN_SCORE = 85;
const THIRTY_S = 1000 * 60 * 30; // 30 min

const QUERIES = [
  { q: "looking for a video editor", src: "shortform" },
  { q: "need a video editor", src: "shortform" },
  { q: "hiring video editor", src: "shortform" },
  { q: "video editor needed", src: "shortform" },
  { q: "looking for a YouTube editor", src: "shortform" },
  { q: "need a YouTube editor", src: "shortform" },
  { q: "looking for a shorts editor", src: "shortform" },
  { q: "need a reels editor", src: "shortform" },
  { q: "someone to edit my videos", src: "shortform" },
  { q: "podcast video editor", src: "shortform" },
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchJSON(url, opts = {}) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function sendDiscord(url, content) {
  if (!url) return;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) console.error("Discord webhook FAILED:", res.status);
}

// ---------- COLLECTORS ----------
async function collectBluesky(q) {
  const url = `https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(q)}&sort=latest&limit=25`;
  const data = await fetchJSON(url);
  return (data.posts || []).map(p => ({
    id: `bsky:${p.uri}`,
    text: (p.record?.text || "").slice(0, 500),
    url: `https://bsky.app/profile/${p.author?.did}/post/${p.uri.split("/").pop()}`,
    created: p.record?.createdAt || p.indexedAt,
    source: "Bluesky",
  }));
}

async function collectHN(q) {
  const since = Math.floor((Date.now() - THIRTY_S) / 1000);
  const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(q)}&tags=comment&numericFilters=created_at_i>${since}`;
  const data = await fetchJSON(url);
  return (data.hits || []).map(h => ({
    id: `hn:${h.objectID}`,
    text: (h.comment_text || h.story_title || "").replace(/<[^>]+>/g, "").slice(0, 500),
    url: `https://news.ycombinator.com/item?id=${h.objectID}`,
    created: h.created_at,
    source: "Hacker News",
  }));
}

async function collectReddit(q) {
  if (!process.env.REDDIT_CLIENT_ID) return [];
  const t = await fetchJSON("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=password&username=" + process.env.REDDIT_USERNAME + "&password=" + process.env.REDDIT_PASSWORD,
  });
  const sub = q.src === "shortform" ? "YouTubeEditorsForHire+HireAnEditor+forhire" : "forhire+freelance_forhire";
  const data = await fetchJSON(`https://oauth.reddit.com/r/${sub}/new?q=${encodeURIComponent(q.q)}&limit=25`, {
    headers: { Authorization: `Bearer ${t.access_token}`, "User-Agent": "clipsignal/1.0" },
  });
  return (data.data?.children || []).map(c => ({
    id: `rd:${c.data.id}`,
    text: (c.data.selftext || c.data.title || "").slice(0, 500),
    url: `https://reddit.com${c.data.permalink}`,
    created: new Date(c.data.created_utc * 1000).toISOString(),
    source: "Reddit",
  }));
}

// ---------- SCORING ----------
async function scoreBatch(posts) {
  const prompt = `You score freelance-buying-intent posts. For each post return JSON array of
{"i":<index>,"score":0-100,"reasons":["..."],"is_hiring":true|false}.
Score high ONLY if someone is actively seeking to hire a freelancer NOW:
- 90-100: explicit hire request with clear need ("looking for", "need", "budget", "paid")
- 70-89: seeking/asking for recommendations
- <70: chatter, portfolios, jokes, offers TO work, old/incomplete
Never invent budgets. Posts:
${posts.map((p, i) => `[${i}] ${p.source}: ${p.text}`).join("\n")}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, responseMimeType: "application/json" } }),
    });
    if (r.ok) {
      const data = await r.json();
      return JSON.parse(data.candidates?.[0]?.content?.parts?.[0]?.text || "[]");
    }
    console.error(`Gemini attempt ${attempt} failed: ${r.status}`);
    if (r.status !== 503 && r.status !== 429) throw new Error(`Gemini ${r.status}`);
    await sleep(6000 * attempt); // wait 6s, 12s, 18s, 24s — Google busy, try again
  }
  throw new Error("Gemini unavailable after 4 attempts — will retry next cron run");
}
Only count a lead if the person is seeking paid video-editing help (YouTube, Shorts, Reels, or podcast clips); reject email marketing, copywriting, sales, web development, and unrelated design roles.

// ---------- FORMAT ----------
function fmt(p, s) {
  const mins = Math.round((Date.now() - new Date(p.created)) / 60000);
  const age = mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)}h ago`;
  return `🔥 **SCORE ${s.score}** · ${age} · ${p.source}\n> ${p.text.slice(0, 220)}...\n→ [Open post](${p.url})\nMatched: ${s.reasons.slice(0, 3).join(" · ")}`;
}

async function freeQuotaLeft() {
  const [{ count }] = await sql`SELECT count(*)::int FROM published WHERE free = true AND ts > now() - interval '7 days'`;
  return Math.max(0, 3 - count);
}

// ---------- MAIN ----------
async function main() {
  const raw = [];
  for (const q of QUERIES) {
    try { raw.push(...(await collectBluesky(q.q))); } catch (e) { console.error("bsky", e.message); }
    try { raw.push(...(await collectHN(q.q))); } catch (e) { console.error("hn", e.message); }
    try { raw.push(...(await collectReddit(q))); } catch (e) { console.error("rd", e.message); }
    await sleep(1500);
  }
  console.log(`Collected ${raw.length} raw posts`);

  const fresh = raw.filter(p => p.text && Date.now() - new Date(p.created) < THIRTY_S
    && /look|need|hire|search|recommend|anyone know/i.test(p.text));
  if (!fresh.length) { console.log("Nothing fresh — done."); return; }

  const scores = await scoreBatch(fresh.slice(0, 40));
  let freeLeft = await freeQuotaLeft();
  let sent = 0;

  for (const s of scores.filter(s => s.is_hiring && s.score >= MIN_SCORE)) {
    const p = fresh[s.i];
    if (!p) continue;
    const inserted = await sql`INSERT INTO published (id, ts, free) VALUES (${p.id}, now(), false) ON CONFLICT (id) DO NOTHING RETURNING id`;
    if (!inserted.length) continue;
    await sendDiscord(PAID_WEBHOOK, fmt(p, s));
    if (freeLeft > 0) {
      await sendDiscord(FREE_WEBHOOK, `🆓 Free sample — ${fmt(p, s)}\n*Full feed: paid tier*`);
      await sql`UPDATE published SET free = true WHERE id = ${p.id}`;
      freeLeft--;
    }
    sent++;
    await sleep(1200);
  }
  console.log(`Published ${sent} leads`);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
