const youtubedl = require("youtube-dl-exec");
const path = require("path");

function clean(name) {
  return name.replace(/[<>:"/\\|?*]+/g, "");
}

async function download(url, dir, mode) {
  try {
    console.log("Fetching video info...");
    const info = await youtubedl(url, { dumpSingleJson: true, noPlaylist: true });
    const title = clean(info.title);

    if (mode === "video" || mode === "both") {
      const videoPath = path.join(dir, `${title}.mp4`);
      console.log("Downloading video...");
      await youtubedl(url, {
        output: videoPath,
        // Pre-merged mp4 — no ffmpeg needed
        format: "best[ext=mp4][height<=720]/best[ext=mp4]/best[height<=720]",
        noPlaylist: true,
        maxFilesize: "200M"
      });
      console.log("Video saved:", videoPath);
    }

    if (mode === "audio" || mode === "both") {
      // Save pre-encoded audio stream as-is (webm or m4a, no conversion)
      const audioPath = path.join(dir, `${title}.%(ext)s`);
      console.log("Downloading audio...");
      await youtubedl(url, {
        output: audioPath,
        format: "bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio",
        noPlaylist: true
      });
      console.log("Audio saved to downloads/");
    }

    console.log("Done!");
  } catch (err) {
    console.error("Error:", err.message);
  }
}

module.exports = { download };