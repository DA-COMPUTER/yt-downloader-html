const express = require("express");
const path = require("path");
const fs = require("fs");
const { promises: fsp } = require("fs");
const { randomUUID } = require("crypto");
const youtubedl = require("youtube-dl-exec");

const app = express();
const PORT = process.env.PORT || 3000;
const DOWNLOAD_DIR = path.join(__dirname, "downloads");
const DATA_DIR = path.join(__dirname, "data");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");
const MAX_HISTORY = 50;
const CACHE_TTL_DAYS = Number(process.env.CACHE_TTL_DAYS ?? 7);
// Path to the ffmpeg binary directory (override via env var if needed)
const FFMPEG_PATH = process.env.FFMPEG_PATH || path.join(process.env.HOME || "~", "ffmpeg/ffmpeg-7.x-amd64-static");

app.use(express.json());
app.use(express.static("public"));
app.use("/downloads", express.static(DOWNLOAD_DIR));

[DOWNLOAD_DIR, DATA_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, "[]");

// ── History helpers ───────────────────────────────────────────────────────────

async function readHistory() {
  try { return JSON.parse(await fsp.readFile(HISTORY_FILE, "utf8")); }
  catch { return []; }
}

async function writeHistory(entries) {
  await fsp.writeFile(HISTORY_FILE, JSON.stringify(entries.slice(0, MAX_HISTORY), null, 2));
}

async function upsertHistory(url, fields) {
  const history = await readHistory();
  const idx = history.findIndex(h => h.url === url);
  if (idx >= 0) {
    history[idx] = { ...history[idx], ...fields, url };
  } else {
    history.unshift({ url, time: Date.now(), ...fields });
  }
  await writeHistory(history);
}

// ── Cache helpers ─────────────────────────────────────────────────────────────

async function cachedFilePath(url, field) {
  const history = await readHistory();
  const entry = history.find(h => h.url === url && h[field]);
  if (!entry) return null;
  const p = path.join(DOWNLOAD_DIR, entry[field]);
  try { await fsp.access(p); return p; } catch { return null; }
}

const cachedVideoPath = (url) => cachedFilePath(url, "videoFile");
const cachedAudioPath = (url) => cachedFilePath(url, "audioFile");

// ── Startup prune ─────────────────────────────────────────────────────────────

async function pruneCache() {
  if (CACHE_TTL_DAYS <= 0) return;
  const cutoff = Date.now() - CACHE_TTL_DAYS * 86400_000;
  const history = await readHistory();
  let changed = false;

  for (const entry of history) {
    if (entry.time >= cutoff) continue;
    for (const field of ["videoFile", "audioFile", "filename"]) {
      if (!entry[field]) continue;
      try { await fsp.unlink(path.join(DOWNLOAD_DIR, entry[field])); console.log(`[prune] deleted ${entry[field]}`); }
      catch { /* already gone */ }
      entry[field] = null;
    }
    changed = true;
  }

  if (changed) {
    await writeHistory(history);
    console.log(`[prune] removed entries older than ${CACHE_TTL_DAYS}d`);
  }
}

// ── Format helpers ────────────────────────────────────────────────────────────
// Use pre-merged single-stream formats so ffmpeg is never required.
// "best[ext=mp4][height<=N]" picks a stream YouTube already provides muxed.
// Falls back to any mp4, then any stream at that height.

function videoFormat(height) {
  return `best[ext=mp4][height<=${height}]/best[ext=mp4]/best[height<=${height}]`;
}

// Audio: grab best pre-encoded stream as-is (webm or m4a, no conversion needed).
const AUDIO_FORMAT = "bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio";

// ── yt-dlp wrappers ───────────────────────────────────────────────────────────
// ffmpegLocation kept so it's used if ffmpeg IS present, but chosen formats
// never require it.

function yt(target, opts = {}) {
  return youtubedl(target, { ffmpegLocation: FFMPEG_PATH, ...opts });
}

function ytExec(target, opts = {}) {
  return youtubedl.exec(target, { ffmpegLocation: FFMPEG_PATH, ...opts });
}

// ── Filename scraping from yt-dlp stdout ──────────────────────────────────────
// yt-dlp prints different lines depending on whether it's merging or not.
// We accumulate all candidates and pick the last one (merge line wins).

function parseFilename(line) {
  // "[download] Destination: /path/to/file.ext"
  const dest = line.match(/\[download\] Destination: (.+)/);
  if (dest) return path.basename(dest[1].trim());
  // "[Merger] Merging formats into "/path/to/file.ext""
  const merge = line.match(/\[Merger\] Merging formats into "(.+)"/);
  if (merge) return path.basename(merge[1].trim());
  // "[ExtractAudio] Destination: /path/to/file.mp3"
  const extract = line.match(/\[ExtractAudio\] Destination: (.+)/);
  if (extract) return path.basename(extract[1].trim());
  return null;
}

// ── Background cache job ──────────────────────────────────────────────────────

const cacheJobs = new Set();

async function runCacheJob(url) {
  if (cacheJobs.has(url)) return;
  const [vp, ap] = await Promise.all([cachedVideoPath(url), cachedAudioPath(url)]);
  if (vp && ap) { console.log(`[cache] already cached: ${url}`); return; }

  cacheJobs.add(url);
  console.log(`[cache] starting for ${url}`);

  async function downloadPart(isAudio) {
    const field = isAudio ? "audioFile" : "videoFile";
    const label = isAudio ? "audio" : "video";

    return new Promise((resolve) => {
      const opts = {
        output: path.join(DOWNLOAD_DIR, "%(title)s.%(ext)s"),
        noPlaylist: true,
        newline: true,
        // Don't pass quiet:true — we need stdout lines for filename detection
        // but suppress verbose chatter with print-json off
      };

      if (isAudio) {
        // Pre-encoded stream, no ffmpeg conversion needed
        opts.format = AUDIO_FORMAT;
      } else {
        // Pre-merged mp4 stream, no ffmpeg merge needed
        opts.format = videoFormat(720);
      }

      let filename = null;
      let stderrBuf = "";
      const proc = ytExec(url, opts);

      proc.stdout.on("data", chunk => {
        for (const line of chunk.toString().split("\n")) {
          const f = parseFilename(line);
          if (f) filename = f; // last match wins (merger line replaces destination line)
        }
      });

      proc.stderr.on("data", chunk => { stderrBuf += chunk.toString(); });

      proc.on("close", async code => {
        if (code !== 0) {
          console.error(`[cache] yt-dlp ${label} exit ${code}: ${stderrBuf.slice(-400)}`);
        }
        // Even on non-zero exit, a file may have landed (warnings cause exit 1).
        // If we have a filename and the file exists, count it as success.
        if (filename) {
          const fullPath = path.join(DOWNLOAD_DIR, filename);
          const exists = await fsp.access(fullPath).then(() => true).catch(() => false);
          if (exists) {
            await upsertHistory(url, { [field]: filename, time: Date.now() });
            console.log(`[cache] ${label} saved: ${filename}`);
            return resolve(filename);
          }
        }
        // Fallback: scan downloads dir for any new file matching the title
        console.warn(`[cache] ${label} filename not captured; file may be missing`);
        resolve(null);
      });

      proc.on("error", err => {
        console.error(`[cache] process error (${label}):`, err.message);
        resolve(null);
      });
    });
  }

  try {
    if (!vp) await downloadPart(false);
    if (!ap) await downloadPart(true);
  } finally {
    cacheJobs.delete(url);
    console.log(`[cache] done for ${url}`);
  }
}

const jobs = new Map();

// ── Routes ────────────────────────────────────────────────────────────────────

app.get("/api/search", async (req, res) => {
  const query = req.query.q?.trim();
  if (!query) return res.json([]);
  try {
    const result = await yt(`ytsearch5:${query}`, {
      dumpSingleJson: true, noPlaylist: true, skipDownload: true, quiet: true
    });
    res.json((result.entries || []).map(v => ({
      title: v.title, url: v.webpage_url,
      thumbnail: v.thumbnail || null, duration: v.duration || null, uploader: v.uploader || null
    })));
  } catch { res.json([]); }
});

app.get("/api/info", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({});
  try {
    const info = await yt(url, {
      dumpSingleJson: true, noPlaylist: true, skipDownload: true, quiet: true
    });
    res.json({ title: info.title, uploader: info.uploader || null, duration: info.duration || null });
  } catch { res.json({}); }
});

// Trigger background cache
app.post("/api/cache", (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL required" });
  // Check if already fully cached and tell the client
  Promise.all([cachedVideoPath(url), cachedAudioPath(url)]).then(([vp, ap]) => {
    res.json({ ok: true, alreadyCached: !!(vp && ap) });
    if (!(vp && ap)) runCacheJob(url).catch(err => console.error("[cache] error:", err));
  });
});

// Stream: cache-first, CDN-proxy fallback
app.get("/api/stream", async (req, res) => {
  const { url, format = "720" } = req.query;
  if (!url) return res.status(400).end();

  const cached = format === "audio" ? await cachedAudioPath(url) : await cachedVideoPath(url);
  if (cached) {
    console.log(`[stream] cache hit: ${path.basename(cached)}`);
    return res.sendFile(cached, { headers: { "Accept-Ranges": "bytes" } });
  }

  try {
    const info = await yt(url, {
      dumpSingleJson: true, noPlaylist: true, skipDownload: true, quiet: true,
      format: format === "audio"
        ? "bestaudio[ext=m4a]/bestaudio"
        : `best[height<=${format}][ext=mp4]/best[height<=${format}]`
    });

    const mediaUrl =
      info.url ||
      info.requested_formats?.find(f => f.ext === "mp4")?.url ||
      info.requested_formats?.[0]?.url;

    if (!mediaUrl) return res.status(500).json({ error: "No direct URL found" });

    const upstreamHeaders = { "User-Agent": "Mozilla/5.0 (compatible)", "Referer": "https://www.youtube.com/" };
    if (req.headers.range) upstreamHeaders["Range"] = req.headers.range;

    const upstream = await fetch(mediaUrl, { headers: upstreamHeaders });
    const outHeaders = {
      "Content-Type": upstream.headers.get("content-type") || "video/mp4",
      "Accept-Ranges": "bytes", "Cache-Control": "no-store"
    };
    const cl = upstream.headers.get("content-length");
    const cr = upstream.headers.get("content-range");
    if (cl) outHeaders["Content-Length"] = cl;
    if (cr) outHeaders["Content-Range"] = cr;

    res.writeHead(req.headers.range && upstream.status === 206 ? 206 : upstream.status, outHeaders);
    const reader = upstream.body.getReader();
    const pump = async () => {
      const { done, value } = await reader.read();
      if (done || res.destroyed) return res.end();
      res.write(value, () => pump());
    };
    pump().catch(() => res.end());
    req.on("close", () => reader.cancel());
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// Fetch to browser: serve cached file if available, else live pipe
app.get("/api/fetch", (req, res) => {
  const { url, format = "720" } = req.query;
  if (!url) return res.status(400).end();

  const isAudio = format === "audio";
  (isAudio ? cachedAudioPath(url) : cachedVideoPath(url)).then(cached => {
    if (cached) {
      res.setHeader("Content-Disposition", `attachment; filename="${path.basename(cached)}"`);
      res.setHeader("Content-Type", isAudio ? "audio/mp4" : "video/mp4");
      return res.sendFile(cached);
    }
    const safeName = `download_${Date.now()}.${isAudio ? "m4a" : "mp4"}`;
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    res.setHeader("Content-Type", isAudio ? "audio/mp4" : "video/mp4");
    const opts = {
      output: "-",
      format: isAudio ? AUDIO_FORMAT : videoFormat(format),
      noPlaylist: true, quiet: true,
    };
    const proc = ytExec(url, opts);
    proc.stdout.pipe(res);
    req.on("close", () => { try { proc.kill("SIGTERM"); } catch {} });
    proc.stderr.on("data", () => {});
    proc.on("error", () => { if (!res.headersSent) res.status(500).end(); });
  });
});

// Save to server with SSE progress
app.post("/api/download", (req, res) => {
  const { url, format } = req.body;
  if (!url) return res.status(400).json({ error: "URL required" });

  const jobId = randomUUID();
  jobs.set(jobId, { subscribers: [], lastMsg: null });
  res.json({ jobId });

  const isAudio = format === "audio";
  const field = isAudio ? "audioFile" : "videoFile";
  const opts = {
    output: path.join(DOWNLOAD_DIR, "%(title)s.%(ext)s"),
    format: isAudio ? AUDIO_FORMAT : videoFormat(format),
    noPlaylist: true, progress: true, newline: true,
  };
  const proc = ytExec(url, opts);

  let filename = null;
  let stderrBuf = "";

  function broadcast(data) {
    const job = jobs.get(jobId);
    if (!job) return;
    const str = `data: ${JSON.stringify(data)}\n\n`;
    job.lastMsg = str;
    job.subscribers.forEach(s => s.write(str));
  }

  proc.stdout.on("data", chunk => {
    for (const line of chunk.toString().split("\n")) {
      const f = parseFilename(line);
      if (f) filename = f;
      const pct = line.match(/(\d+\.?\d*)%/);
      if (pct) broadcast({ progress: Math.round(parseFloat(pct[1])), status: `Downloading... ${pct[1]}%` });
    }
  });

  proc.stderr.on("data", chunk => { stderrBuf += chunk.toString(); });

  proc.on("close", async code => {
    // Check file existence regardless of exit code — JS-runtime warning causes exit 1
    let success = false;
    if (filename) {
      const fullPath = path.join(DOWNLOAD_DIR, filename);
      success = await fsp.access(fullPath).then(() => true).catch(() => false);
    }
    if (success) {
      await upsertHistory(url, { [field]: filename, format, time: Date.now() });
      broadcast({ done: true, progress: 100, file: `/downloads/${encodeURIComponent(filename)}`, filename });
    } else {
      // Strip known non-fatal warnings before showing error to user
      const knownWarnings = /No supported JavaScript runtime|js-runtimes|EJS|deno is enabled/gi;
      const detail = stderrBuf.replace(knownWarnings, "").replace(/WARNING:[^\n]*/g, "").trim().slice(-300);
      const msg = detail || `yt-dlp exited with code ${code}`;
      broadcast({ error: msg });
    }
    setTimeout(() => jobs.delete(jobId), 60000);
  });

  proc.on("error", () => { broadcast({ error: "Failed to start process." }); jobs.delete(jobId); });
});

// Cache status — lets watch page poll whether a URL is fully cached
app.get("/api/cache-status", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({});
  const [vp, ap] = await Promise.all([cachedVideoPath(url), cachedAudioPath(url)]);
  const inProgress = cacheJobs.has(url);
  res.json({ videoFile: vp ? path.basename(vp) : null, audioFile: ap ? path.basename(ap) : null, inProgress });
});

// SSE progress
app.get("/api/progress/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.writeHead(404).end();
  res.writeHead(200, {
    "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no", Connection: "keep-alive"
  });
  res.write(": connected\n\n");
  if (job.lastMsg) res.write(job.lastMsg);
  job.subscribers.push(res);
  req.on("close", () => {
    const j = jobs.get(req.params.jobId);
    if (j) j.subscribers = j.subscribers.filter(s => s !== res);
  });
});

app.get("/api/history", async (req, res) => { res.json(await readHistory()); });

app.get("/watch", (req, res) => {
  res.sendFile(path.join(__dirname, "public/watch.html"));
});

// ── Boot ──────────────────────────────────────────────────────────────────────
pruneCache()
  .then(() => app.listen(PORT, "0.0.0.0", () => console.log(`ytdl on http://localhost:${PORT}`)))
  .catch(err => { console.error("Startup error:", err); process.exit(1); });