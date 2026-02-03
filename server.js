const express = require("express");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static("public"));
if (process.platform !== "win32") {
  const ytdlpPath = path.join(__dirname, "yt-dlp");
  if (fs.existsSync(ytdlpPath)) {
    try {
      fs.chmodSync(ytdlpPath, 0o755);
      console.log("yt-dlp permission set");
    } catch (e) {
      console.error("Failed to chmod yt-dlp:", e.message);
    }
  } else {
    console.error("yt-dlp binary not found at startup");
  }
}


// const YTDLP_PATH = "C:\\Users\\piyus\\AppData\\Local\\Microsoft\\WinGet\\Links\\yt-dlp.exe";
// const FFMPEG_PATH =
//     process.env.FFMPEG_PATH || "C:\\Users\\piyus\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe";
const isWindows = process.platform === "win32";

const YTDLP_PATH = isWindows
  ? "yt-dlp.exe"
  : "./yt-dlp";

const FFMPEG_PATH = isWindows
  ? "ffmpeg"
  : "ffmpeg";

const TEMP_DIR = path.join(os.tmpdir(), "universal-downloader");

const progressStreams = new Map();
const progressState = new Map();

function ensureTempDir() {
    if (!fs.existsSync(TEMP_DIR)) {
        fs.mkdirSync(TEMP_DIR, { recursive: true });
    }
}

function isValidUrl(value) {
    if (!value || typeof value !== "string") return false;
    try {
        new URL(value);
        return true;
    } catch {
        return false;
    }
}

function sanitizeFileName(value) {
    return String(value || "download")
        .replace(/[\\/:*?"<>|]+/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120) || "download";
}

function friendlyError(message) {
    const text = String(message || "");
    if (/Unsupported URL/i.test(text)) return "Unsupported or invalid URL.";
    if (/Private video|This video is private/i.test(text)) return "This video is private.";
    if (/Sign in to confirm your age|age-restricted/i.test(text)) {
        return "This video is age-restricted and requires sign-in.";
    }
    if (/HTTP Error 404/i.test(text)) return "Video not found (404).";
    if (/Unable to download webpage/i.test(text)) return "Unable to access this link.";
    if (/This live event will begin/i.test(text)) return "This live stream has not started yet.";
    if (/ERROR:/i.test(text)) return text.replace(/^.*ERROR:\s*/i, "").trim();
    return "Download failed. Please check the URL and try again.";
}

function sendProgress(id, payload) {
    progressState.set(id, payload);
    const streams = progressStreams.get(id);
    if (!streams || streams.size === 0) return;
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of streams) {
        res.write(data);
    }
}

function closeProgress(id) {
    const streams = progressStreams.get(id);
    if (!streams) return;
    for (const res of streams) {
        res.end();
    }
    progressStreams.delete(id);
    progressState.delete(id);
}

function attachProgressStream(id, res) {
    if (!progressStreams.has(id)) {
        progressStreams.set(id, new Set());
    }
    const streams = progressStreams.get(id);
    streams.add(res);

    const last = progressState.get(id);
    if (last) {
        res.write(`data: ${JSON.stringify(last)}\n\n`);
    }

    const ping = setInterval(() => {
        res.write(": ping\n\n");
    }, 15000);

    res.on("close", () => {
        clearInterval(ping);
        streams.delete(res);
        if (streams.size === 0 && !progressState.has(id)) {
            progressStreams.delete(id);
        }
    });
}

app.use("/api", (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
    }
    if (!req.path.startsWith("/progress") && !req.path.startsWith("/download")) {
        res.setHeader("Content-Type", "application/json");
    }
    next();
});

app.use((err, req, res, next) => {
    if (err && err.type === "entity.parse.failed") {
        res.status(400).json({ error: "Invalid JSON payload." });
        return;
    }
    next(err);
});

function parseFormats(info) {
    const formats = Array.isArray(info.formats) ? info.formats : [];
    const combined = [];
    const videoOnly = [];
    const audioOnly = [];

    for (const f of formats) {
        if (!f || !f.format_id) continue;
        if (f.format_id === "storyboard") continue;

        const hasVideo = f.vcodec && f.vcodec !== "none";
        const hasAudio = f.acodec && f.acodec !== "none";
        const height = Number.isFinite(f.height) ? f.height : null;
        const resolution = hasVideo
            ? (height ? `${height}p` : (f.resolution || "unknown"))
            : "Audio";
        const filesize = f.filesize || f.filesize_approx || null;

        const entry = {
            id: f.format_id,
            ext: f.ext || "unknown",
            resolution,
            height,
            filesize,
            vcodec: f.vcodec,
            acodec: f.acodec,
            fps: f.fps || null,
            tbr: f.tbr || null,
            abr: f.abr || null,
            formatNote: f.format_note || null,
        };

        if (hasVideo && hasAudio) combined.push(entry);
        else if (hasVideo) videoOnly.push(entry);
        else if (hasAudio) audioOnly.push(entry);
    }

    combined.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0));
    videoOnly.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0));
    audioOnly.sort((a, b) => (b.abr || 0) - (a.abr || 0));

    return { combined, videoOnly, audioOnly };
}

function createLineParser(onLine) {
    let buffer = "";
    return (chunk) => {
        buffer += chunk.toString();
        const parts = buffer.split(/\r?\n/);
        buffer = parts.pop() || "";
        for (const line of parts) {
            const trimmed = line.trim();
            if (trimmed) onLine(trimmed);
        }
    };
}

function parseProgressLine(line) {
    if (/Merging formats/i.test(line) || /^\[Merger\]/i.test(line)) {
        return { status: "Merging" };
    }
    if (/ExtractAudio/i.test(line)) {
        return { status: "Merging" };
    }
    if (/^\[download\]/i.test(line)) {
        const percentMatch = line.match(/(\d{1,3}(?:\.\d+)?)%/);
        const speedMatch = line.match(/at\s+([^\s]+)\/s/i);
        const etaMatch = line.match(/ETA\s+([0-9:]+)/i);
        const progress = { status: "Downloading" };
        if (percentMatch) progress.percent = Number(percentMatch[1]);
        if (speedMatch) progress.speed = `${speedMatch[1]}/s`;
        if (etaMatch) progress.eta = etaMatch[1];
        return progress;
    }
    return null;
}

async function findDownloadedFile(downloadId) {
    const files = await fs.promises.readdir(TEMP_DIR);
    const match = files.find((file) => file.startsWith(`${downloadId}.`));
    if (!match) return null;
    return path.join(TEMP_DIR, match);
}

function downloadWithProgress({ url, formatId, kind, downloadId }) {
    return new Promise((resolve, reject) => {
        ensureTempDir();
        const outputTemplate = path.join(TEMP_DIR, `${downloadId}.%(ext)s`);

        const isAudio = kind === "audio";
        const isVideoOnly = kind === "video-only";
        const formatSpec = isVideoOnly ? `${formatId}+bestaudio/best` : formatId;

        const hasFfmpegPath = fs.existsSync(FFMPEG_PATH);
        let hasFfmpeg = hasFfmpegPath;
        if (!hasFfmpeg) {
            try {
                const probe = spawnSync("ffmpeg", ["-version"], { windowsHide: true });
                hasFfmpeg = probe && probe.status === 0;
            } catch {
                hasFfmpeg = false;
            }
        }

        if ((isVideoOnly || isAudio) && !hasFfmpeg) {
            const message = "ffmpeg is required for this download format.";
            sendProgress(downloadId, { type: "error", message });
            reject(new Error(message));
            return;
        }

        const args = ["--newline", "--no-playlist", "-f", formatSpec, "-o", outputTemplate];
        if (fs.existsSync(FFMPEG_PATH)) {
            args.push("--ffmpeg-location", FFMPEG_PATH);
        }
        if (isAudio) {
            args.push("--extract-audio", "--audio-format", "mp3");
        }
        args.push(url);

        const yt = spawn(YTDLP_PATH, args, { windowsHide: true });
        let stderrLog = "";
        let sawMerging = false;
        const handleLine = createLineParser((line) => {
            stderrLog += `${line}\n`;
            const update = parseProgressLine(line);
            if (update) {
                if (update.status === "Merging") {
                    sawMerging = true;
                }
                sendProgress(downloadId, {
                    type: "progress",
                    ...update,
                });
            }
        });

        yt.stderr.on("data", handleLine);
        yt.stdout.on("data", () => {});

        yt.on("error", (err) => {
            const message = friendlyError(err.message);
            sendProgress(downloadId, { type: "error", message });
            reject(new Error(message));
        });

        yt.on("close", async (code) => {
            if (code !== 0) {
                const message = friendlyError(stderrLog);
                sendProgress(downloadId, { type: "error", message });
                reject(new Error(message));
                return;
            }

            if (sawMerging) {
                sendProgress(downloadId, { type: "status", status: "Merging" });
            }
            try {
                const filePath = await findDownloadedFile(downloadId);
                if (!filePath) {
                    const message = "Downloaded file not found.";
                    sendProgress(downloadId, { type: "error", message });
                    reject(new Error(message));
                    return;
                }
                sendProgress(downloadId, { type: "status", status: "Completed", percent: 100 });
                resolve(filePath);
            } catch (err) {
                const message = friendlyError(err.message);
                sendProgress(downloadId, { type: "error", message });
                reject(new Error(message));
            }
        });
    });
}

app.get("/api/progress/:id", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    attachProgressStream(req.params.id, res);
});

const handleAnalyze = (req, res) => {
    const { url } = req.body;
    if (!isValidUrl(url)) {
        res.status(400).json({ error: "Please enter a valid URL." });
        return;
    }

    const args = ["-J", "--no-playlist", url];
    const yt = spawn(YTDLP_PATH, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";

    yt.stdout.on("data", (d) => (stdout += d.toString()));
    yt.stderr.on("data", (d) => (stderr += d.toString()));

    yt.on("error", (err) => {
        res.status(500).json({ error: friendlyError(err.message) });
    });

    yt.on("close", (code) => {
        if (res.headersSent) return;
        if (code !== 0) {
            res.status(400).json({ error: friendlyError(stderr) });
            return;
        }
        try {
            const info = JSON.parse(stdout);
            const formats = parseFormats(info);
            res.json({
                title: info.title || "download",
                duration: info.duration || null,
                thumbnail: info.thumbnail || null,
                formats,
            });
        } catch (err) {
            res.status(500).json({ error: "Failed to parse video info." });
        }
    });
};

app.post("/api/analyze", handleAnalyze);
app.post("/analyze", handleAnalyze);

app.post("/api/download", async (req, res) => {
    const { url, formatId, kind, title, downloadId } = req.body;
    const id = downloadId || crypto.randomUUID();
    if (!isValidUrl(url)) {
        sendProgress(id, { type: "error", message: "Please enter a valid URL." });
        res.status(400).json({ error: "Please enter a valid URL." });
        return;
    }
    if (!formatId || typeof formatId !== "string") {
        sendProgress(id, { type: "error", message: "Please select a valid format." });
        res.status(400).json({ error: "Please select a valid format." });
        return;
    }

    sendProgress(id, { type: "status", status: "Downloading", percent: 0 });

    try {
        const filePath = await downloadWithProgress({
            url,
            formatId,
            kind,
            downloadId: id,
        });

        const ext = path.extname(filePath) || ".bin";
        const safeTitle = sanitizeFileName(title);
        const downloadName = `${safeTitle}${ext}`;

        const contentTypes = {
            ".mp4": "video/mp4",
            ".webm": "video/webm",
            ".mkv": "video/x-matroska",
            ".mp3": "audio/mpeg",
            ".m4a": "audio/mp4",
            ".wav": "audio/wav",
        };

        const stat = await fs.promises.stat(filePath);
        res.setHeader("Content-Type", contentTypes[ext.toLowerCase()] || "application/octet-stream");
        res.setHeader("Content-Disposition", `attachment; filename="${downloadName}"`);
        res.setHeader("Content-Length", stat.size);

        const stream = fs.createReadStream(filePath);
        sendProgress(id, { type: "status", status: "Streaming" });
        stream.pipe(res);

        let cleaned = false;
        const cleanup = (completed = false) => {
            if (cleaned) return;
            cleaned = true;
            if (completed) {
                sendProgress(id, { type: "status", status: "Completed", percent: 100 });
            }
            fs.promises.unlink(filePath).catch(() => {});
            setTimeout(() => closeProgress(id), 2000);
        };

        stream.on("close", () => {
            cleanup(true);
        });
        stream.on("error", () => {
            cleanup(false);
        });
        res.on("close", () => {
            stream.destroy();
            cleanup(false);
        });
    } catch (err) {
        sendProgress(id, { type: "error", message: err.message || "Download failed." });
        res.status(500).json({ error: err.message || "Download failed." });
        setTimeout(() => closeProgress(id), 2000);
    }
});

app.use((err, req, res, next) => {
    if (req.path && req.path.startsWith("/api")) {
        res.status(500).json({ error: "Server error. Please try again." });
        return;
    }
    next(err);
});

app.use("/api", (req, res) => {
    res.status(404).json({ error: "API route not found." });
});

// app.listen(3000, () => {
//     console.log("Server running at http://localhost:3000");
// });

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
