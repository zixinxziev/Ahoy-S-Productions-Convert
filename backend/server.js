const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const archiver = require("archiver");

require("dotenv").config();

const app = express();

app.set("trust proxy", 1);

if (!ffmpegPath) {
  throw new Error("FFmpeg binary not found");
}

ffmpeg.setFfmpegPath(ffmpegPath);

// ===============================
// ENVIRONMENT VARIABLES
// ===============================

const requiredEnv = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "JWT_SECRET"
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const JWT = process.env.JWT_SECRET;

// Server-Sent Events: push membership changes to members who are online.
// Each connected client is keyed by username; reconnecting clients are cleaned up.
const memberStreams = new Map();
function broadcastMembership(username, membership) {
  const clients = memberStreams.get(username);
  if (!clients) return;
  const payload = `event: membership\ndata: ${JSON.stringify({ membership })}\n\n`;
  for (const client of [...clients]) {
    try { client.write(payload); }
    catch { clients.delete(client); }
  }
  if (!clients.size) memberStreams.delete(username);
}

// ===============================
// DIRECTORIES
// ===============================

const OUT = path.join(os.tmpdir(), "ahoys-converted");
const UPLOAD_DIR = path.join(os.tmpdir(), "ahoys-upload");
// Track which logged-in Ahoy member owns each temporary conversion output.
// This prevents another member from uploading a file by guessing its stored filename.
const outputOwners = new Map();

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ===============================
// CORS
// ===============================

const allowedOrigins = (process.env.CORS_ORIGIN || "*")
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);

app.use(helmet({
  crossOriginResourcePolicy: {
    policy: "cross-origin"
  }
}));

app.use(cors({
  origin: (origin, callback) => {
    if (
      !origin ||
      allowedOrigins.includes("*") ||
      allowedOrigins.includes(origin)
    ) {
      return callback(null, true);
    }

    return callback(new Error("Origin not allowed by CORS"));
  },
  methods: ["GET", "POST", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  exposedHeaders: ["Content-Disposition"]
}));

app.use(express.json({
  limit: "1mb"
}));

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.startsWith("/api/downloader/jobs/") || req.path === "/api/downloader/usage"
}));

const downloaderPollLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 45,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.username || req.ip)
});
const downloaderCreateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.username || req.ip)
});

// ===============================
// MULTER UPLOAD
// ===============================

const upload = multer({
  dest: UPLOAD_DIR,
  limits: {
    fileSize: 100 * 1024 * 1024,
    files: 1
  },
  fileFilter: (req, file, cb) => {
    if (!/audio\/|application\/octet-stream/.test(file.mimetype)) {
      return cb(new Error("Unsupported file type"));
    }

    cb(null, true);
  }
});

// Direct-to-Roblox uploads are isolated from converter uploads.
// Roblox audio constraints are enforced again in the route (20 MB / 7 minutes).
const directRobloxUpload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (![".mp3", ".wav", ".ogg", ".flac"].includes(ext)) {
      return cb(new Error("Format yang didukung: MP3, WAV, OGG, dan FLAC."));
    }
    cb(null, true);
  }
});

// ===============================
// AUTHENTICATION
// ===============================

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.replace(/^Bearer\s+/i, "");

  if (!token) {
    return next();
  }

  try {
    req.user = jwt.verify(token, JWT);
    return next();
  } catch {
    return res.status(401).json({
      error: "Invalid session"
    });
  }
}

function requiredAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      error: "Login required"
    });
  }

  next();
}

async function userRow(username) {
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("username", username)
    .maybeSingle();

  if (error) throw error;

  return data;
}

async function getUser(req) {
  if (!req.user?.username) return null;

  return userRow(req.user.username);
}


// ===============================
// ROBLOX OAUTH TOKEN STORAGE
// ===============================
function robloxEncryptionKey() {
  const raw = String(process.env.ROBLOX_TOKEN_ENCRYPTION_KEY || "");
  if (!/^[a-f0-9]{64}$/i.test(raw)) {
    throw new Error("ROBLOX_TOKEN_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)");
  }
  return Buffer.from(raw, "hex");
}

function encryptRobloxSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", robloxEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map(part => part.toString("base64url")).join(".");
}

function decryptRobloxSecret(value) {
  const [ivPart, tagPart, encryptedPart] = String(value || "").split(".");
  if (!ivPart || !tagPart || !encryptedPart) throw new Error("Stored Roblox token is invalid");
  const decipher = crypto.createDecipheriv("aes-256-gcm", robloxEncryptionKey(), Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedPart, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

function robloxOAuthConfig() {
  const clientId = process.env.ROBLOX_OAUTH_CLIENT_ID;
  const clientSecret = process.env.ROBLOX_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.ROBLOX_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Roblox OAuth belum dikonfigurasi. Isi ROBLOX_OAUTH_CLIENT_ID, ROBLOX_OAUTH_CLIENT_SECRET, dan ROBLOX_OAUTH_REDIRECT_URI di backend.");
  }
  return { clientId, clientSecret, redirectUri };
}

async function getRobloxConnection(username) {
  const { data, error } = await supabase
    .from("roblox_connections")
    .select("username,roblox_user_id,roblox_username,access_token_enc,refresh_token_enc,access_expires_at,scope")
    .eq("username", username)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function saveRobloxTokens(username, robloxUser, tokens) {
  const row = {
    username,
    roblox_user_id: String(robloxUser.sub),
    roblox_username: String(robloxUser.preferred_username || robloxUser.name || "Roblox User").slice(0, 100),
    access_token_enc: encryptRobloxSecret(tokens.access_token),
    refresh_token_enc: encryptRobloxSecret(tokens.refresh_token),
    access_expires_at: new Date(Date.now() + Math.max(60, Number(tokens.expires_in) || 900) * 1000).toISOString(),
    scope: String(tokens.scope || "")
  };
  const { error } = await supabase.from("roblox_connections").upsert(row, { onConflict: "username" });
  if (error) throw error;
  return row;
}

async function getValidRobloxAccessToken(username) {
  let connection = await getRobloxConnection(username);
  if (!connection) throw new Error("Hubungkan akun Roblox terlebih dahulu melalui tombol Connect Roblox Account.");
  if (new Date(connection.access_expires_at).getTime() > Date.now() + 60000) {
    return { token: decryptRobloxSecret(connection.access_token_enc), connection };
  }

  const { clientId, clientSecret } = robloxOAuthConfig();
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: decryptRobloxSecret(connection.refresh_token_enc),
    client_id: clientId,
    client_secret: clientSecret
  });
  const response = await fetch("https://apis.roblox.com/oauth/v1/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
    signal: AbortSignal.timeout(20000)
  });
  const tokens = await response.json().catch(() => ({}));
  if (!response.ok || !tokens.access_token || !tokens.refresh_token) {
    await supabase.from("roblox_connections").delete().eq("username", username);
    throw new Error("Sesi Roblox kedaluwarsa atau dicabut. Hubungkan ulang akun Roblox kamu.");
  }
  const updated = await saveRobloxTokens(username, {
    sub: connection.roblox_user_id,
    preferred_username: connection.roblox_username
  }, tokens);
  return { token: tokens.access_token, connection: updated };
}

// ===============================
// REGISTER
// ===============================

app.post("/api/auth/register", async (req, res) => {
  try {
    const { username, password } = req.body || {};

    if (
      typeof username !== "string" ||
      !/^[a-zA-Z0-9_]{3,24}$/.test(username)
    ) {
      return res.status(400).json({
        error: "Username must be 3-24 characters"
      });
    }

    if (
      typeof password !== "string" ||
      password.length < 8
    ) {
      return res.status(400).json({
        error: "Password minimum 8 characters"
      });
    }

    const hash = await bcrypt.hash(password, 12);

    const { error } = await supabase
      .from("users")
      .insert({
        username,
        password_hash: hash,
        membership: "free",
        is_admin: false
      });

    if (error) {
      if (
        error.code === "23505" ||
        error.message?.toLowerCase().includes("duplicate")
      ) {
        return res.status(409).json({
          error: "Username already exists"
        });
      }

      throw error;
    }

    const token = jwt.sign(
      { username },
      JWT,
      { expiresIn: "30d" }
    );

    return res.json({
      token,
      membership: "free"
    });

  } catch (error) {
    console.error("REGISTER ERROR:", error);

    return res.status(500).json({
      error: "Registration service unavailable"
    });
  }
});

// ===============================
// LOGIN
// ===============================

app.post("/api/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};

    if (
      typeof username !== "string" ||
      typeof password !== "string"
    ) {
      return res.status(400).json({
        error: "Username and password required"
      });
    }

    const user = await userRow(username);

    if (
      !user ||
      !await bcrypt.compare(password, user.password_hash)
    ) {
      return res.status(401).json({
        error: "Invalid username or password"
      });
    }

    const token = jwt.sign(
      { username: user.username },
      JWT,
      { expiresIn: "30d" }
    );

    return res.json({
      token,
      membership: user.membership
    });

  } catch (error) {
    console.error("LOGIN ERROR:", error);

    return res.status(500).json({
      error: "Login service unavailable"
    });
  }
});

// ===============================
// MEMBER REALTIME MEMBERSHIP EVENTS
// ===============================

app.get("/api/member/events", auth, requiredAuth, async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user) return res.status(404).json({ error: "Member account not found" });

    res.status(200);
    res.set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.flushHeaders?.();
    res.write(`event: membership\ndata: ${JSON.stringify({ membership: user.membership })}\n\n`);

    if (!memberStreams.has(user.username)) memberStreams.set(user.username, new Set());
    const clients = memberStreams.get(user.username);
    clients.add(res);

    const heartbeat = setInterval(() => {
      if (!res.destroyed) res.write(": keep-alive\n\n");
    }, 25000);

    res.on("close", () => {
      clearInterval(heartbeat);
      clients.delete(res);
      if (!clients.size) memberStreams.delete(user.username);
    });
  } catch (error) {
    console.error("MEMBER EVENTS ERROR:", error);
    if (!res.headersSent) res.status(500).json({ error: "Unable to start membership updates" });
    else res.end();
  }
});

// ===============================
// USAGE QUOTA
// ===============================

async function countUsage(key) {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);

  const { count, error } = await supabase
    .from("usage")
    .select("*", {
      count: "exact",
      head: true
    })
    .eq("quota_key", key)
    .gte("created_at", since.toISOString());

  if (error) throw error;

  return count || 0;
}

// MEMBER: authenticated member's own daily usage
app.get("/api/member/my-usage", auth, requiredAuth, async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user) return res.status(404).json({ error: "Member account not found" });

    if (user.membership === "unlimited") {
      return res.json({
        username: user.username, membership: "unlimited", unlimited: true,
        daily_limit: null, used: 0, remaining: null, reset_at: null
      });
    }

    const dailyLimit = 10;
    const used = await countUsage(`user:${user.username}`);
    const resetAt = new Date();
    resetAt.setUTCHours(24, 0, 0, 0);

    return res.json({
      username: user.username, membership: "free", unlimited: false,
      daily_limit: dailyLimit, used,
      remaining: Math.max(0, dailyLimit - used),
      reset_at: resetAt.toISOString()
    });
  } catch (error) {
    console.error("MY USAGE ERROR:", error);
    return res.status(500).json({ error: "Unable to load member usage" });
  }
});

// ===============================
// FFMPEG CONVERSION
// ===============================

function ffmpegConvert(input, output, options) {
  return new Promise((resolve, reject) => {
    const sampleRate = Math.max(
      8000,
      Math.min(192000, Number(options.sampleRate) || 48000)
    );

    const cmd = ffmpeg(input).output(output)
      .audioFrequency(sampleRate);

    const filters = [];

    const originalMode = Boolean(options.robloxMode);
    const speed = originalMode
      ? 1 / Math.max(0.05, Number(options.targetSpeed) || 1)
      : Math.max(0.5, Math.min(3, Number(options.manualSpeed) || 1));

    const pitch = originalMode
      ? Math.max(-12, Math.min(12, Number(options.pitch) || 0))
      : 0;
    const pitchRatio = Math.pow(2, pitch / 12);

    // Manual mode intentionally couples tempo and pitch: Roblox later applies
    // the reciprocal PlaybackSpeed, cancelling both changes together.
    if (!originalMode) {
      filters.push(
        `asetrate=${Math.round(sampleRate * speed)}`,
        `aresample=${sampleRate}`
      );
    } else if (options.preservePitch) {
      if (pitch !== 0) {
        filters.push(
          `asetrate=${Math.round(sampleRate * pitchRatio)}`,
          `aresample=${sampleRate}`,
          `atempo=${1 / pitchRatio}`
        );
      }

      let remainingSpeed = speed;

      while (remainingSpeed > 2) {
        filters.push("atempo=2");
        remainingSpeed /= 2;
      }

      while (remainingSpeed < 0.5) {
        filters.push("atempo=0.5");
        remainingSpeed /= 0.5;
      }

      filters.push(`atempo=${remainingSpeed}`);

    } else {
      const combinedRate = speed * pitchRatio;

      filters.push(
        `asetrate=${Math.round(sampleRate * combinedRate)}`,
        `aresample=${sampleRate}`
      );
    }

    const gain = Number(options.gain) || 0;

    if (gain !== 0) {
      filters.push(`volume=${gain}dB`);
    }

    if (filters.length) {
      cmd.audioFilters(filters);
    }

    const trimStart = Math.max(0, Number(options.trimStart) || 0);
    const trimDuration = Math.max(0, Number(options.trimDuration) || 0);

    if (trimStart > 0) {
      cmd.setStartTime(trimStart);
    }

    if (trimDuration > 0) {
      cmd.duration(trimDuration);
    }

    const format = (options.format || "mp3").toLowerCase();

    const codecs = {
      mp3: "libmp3lame",
      wav: options.wavBits === "16" ? "pcm_s16le" : "pcm_s24le",
      flac: "flac",
      m4a: "aac",
      aac: "aac",
      ogg: "libvorbis",
      opus: "libopus"
    };

    cmd.audioCodec(codecs[format] || "libmp3lame");

    if (format === "mp3") {
      const bitrate = Math.max(
        64,
        Math.min(320, Number(options.bitrate) || 320)
      );

      cmd.audioBitrate(bitrate);
    }

    cmd
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
}

// ===============================
// OUTPUT FILENAMES
// ===============================

function safeAudioBase(originalName) {
  const inputName = path.basename(String(originalName || "audio").replace(/\\/g, "/"));
  const withoutExtension = inputName.replace(/\.[^.]+$/, "") || "audio";
  const cleaned = withoutExtension
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/[. ]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  return cleaned || "audio";
}

function makeStoredFilename(downloadFilename) {
  const extension = path.extname(downloadFilename).toLowerCase();
  const base = path.basename(downloadFilename, extension);
  return `${crypto.randomUUID()}__${base}${extension}`;
}

function isStoredAudioName(name) {
  return /^[a-f0-9-]{36}__[^/\\\x00-\x1F]+\.(mp3|wav|flac|m4a|aac|ogg|opus)$/iu.test(name) ||
    /^[a-f0-9-]{36}\.(mp3|wav|flac|m4a|aac|ogg|opus)$/i.test(name);
}

function safeArchiveName(name) {
  const base = path.basename(String(name || "audio").replace(/\\/g, "/"));
  return base.replace(/[\x00-\x1F]/g, "").replace(/^\.+/, "") || "audio";
}

function getQuotaKey(req, user) {
  const ip = req.ip || "unknown";
  return user
    ? `user:${user.username}`
    : `anon:${crypto.createHash("sha256")
        .update(ip + "|" + (req.headers["user-agent"] || ""))
        .digest("hex")}`;
}

function probeAudioDuration(input) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(input, (error, metadata) => {
      if (error) return reject(error);
      const audioStream = (metadata.streams || []).find(stream => stream.codec_type === "audio");
      const duration = Number(audioStream?.duration || metadata.format?.duration);
      if (!Number.isFinite(duration) || duration <= 0) {
        return reject(new Error("Unable to detect audio duration"));
      }
      resolve(duration);
    });
  });
}

function ffmpegExportSegment(input, output, start, duration, options) {
  return new Promise((resolve, reject) => {
    const format = (options.format || "mp3").toLowerCase();
    const sampleRate = Math.max(8000, Math.min(192000, Number(options.sampleRate) || 48000));
    const codecs = {
      mp3: "libmp3lame",
      wav: options.wavBits === "16" ? "pcm_s16le" : "pcm_s24le",
      flac: "flac",
      m4a: "aac",
      aac: "aac",
      ogg: "libvorbis",
      opus: "libopus"
    };

    const cmd = ffmpeg(input)
      .setStartTime(start)
      .duration(duration)
      .audioFrequency(sampleRate)
      .audioCodec(codecs[format] || "libmp3lame")
      .output(output);

    // Split Only exports the original segment without speed, pitch, or gain effects.
    // Split + Convert uses the same processing chain as the main converter.
    const filters = [];
    const splitOnly = Boolean(options.splitOnly);
    const originalMode = Boolean(options.robloxMode);
    const speed = originalMode
      ? 1 / Math.max(0.05, Number(options.targetSpeed) || 1)
      : Math.max(0.5, Math.min(3, Number(options.manualSpeed) || 1));
    const pitch = originalMode ? Math.max(-12, Math.min(12, Number(options.pitch) || 0)) : 0;
    const pitchRatio = Math.pow(2, pitch / 12);

    if (!splitOnly && !originalMode) {
      // Same reciprocal-speed + pitch compensation as the regular converter.
      filters.push(
        `asetrate=${Math.round(sampleRate * speed)}`,
        `aresample=${sampleRate}`
      );
    } else if (!splitOnly && options.preservePitch) {
      if (pitch !== 0) {
        filters.push(
          `asetrate=${Math.round(sampleRate * pitchRatio)}`,
          `aresample=${sampleRate}`,
          `atempo=${1 / pitchRatio}`
        );
      }
      let remainingSpeed = speed;
      while (remainingSpeed > 2) {
        filters.push("atempo=2");
        remainingSpeed /= 2;
      }
      while (remainingSpeed < 0.5) {
        filters.push("atempo=0.5");
        remainingSpeed /= 0.5;
      }
      filters.push(`atempo=${remainingSpeed}`);
    } else if (!splitOnly) {
      const combinedRate = speed * pitchRatio;
      filters.push(
        `asetrate=${Math.round(sampleRate * combinedRate)}`,
        `aresample=${sampleRate}`
      );
    }

    const gain = splitOnly ? 0 : (Number(options.gain) || 0);
    if (gain !== 0) filters.push(`volume=${gain}dB`);

    // Fade transitions are intentionally applied in BOTH split modes.
    // The first and last part also receive fades as requested by the user.
    const requestedFade = Number(options.fadeSeconds);
    const playbackSpeed = splitOnly ? 1 : speed;
    const processedDuration = duration / Math.max(0.05, playbackSpeed);
    const fadeSeconds = Math.max(0, Math.min(15, Number.isFinite(requestedFade) ? requestedFade : 3, processedDuration / 2));
    if (fadeSeconds > 0.02) {
      filters.push(`afade=t=in:st=0:d=${fadeSeconds.toFixed(3)}`);
      filters.push(`afade=t=out:st=${Math.max(0, processedDuration - fadeSeconds).toFixed(3)}:d=${fadeSeconds.toFixed(3)}`);
    }
    if (filters.length) cmd.audioFilters(filters);

    if (format === "mp3") {
      cmd.audioBitrate(Math.max(64, Math.min(320, Number(options.bitrate) || 320)));
    }
    cmd.on("end", resolve).on("error", reject).run();
  });
}

// ===============================
// CONVERT AUDIO
// ===============================

app.post(
  "/api/convert",
  auth,
  upload.single("file"),
  async (req, res) => {
    const input = req.file?.path;

    if (!input) {
      return res.status(400).json({
        error: "Audio file missing"
      });
    }

    try {
      const user = await getUser(req);

      const ip = req.ip || "unknown";

      const quotaKey = user
        ? `user:${user.username}`
        : `anon:${crypto.createHash("sha256")
            .update(ip + "|" + (req.headers["user-agent"] || ""))
            .digest("hex")}`;

      if (!user || user.membership !== "unlimited") {
        const used = await countUsage(quotaKey);

        if (used >= 10) {
          return res.status(429).json({
            error: "Free quota reached: 10 conversions per day"
          });
        }
      }

      let options;

      try {
        options = JSON.parse(req.body.options || "{}");
      } catch {
        return res.status(400).json({
          error: "Invalid conversion options"
        });
      }

      if (!options || typeof options !== "object" || Array.isArray(options)) {
        return res.status(400).json({
          error: "Invalid conversion options"
        });
      }

      const format = (options.format || "mp3").toLowerCase();

      if (!["mp3", "wav", "flac", "m4a", "aac", "ogg", "opus"].includes(format)) {
        return res.status(400).json({
          error: "Invalid output format"
        });
      }

      options.format = format;

      const downloadFilename = `${safeAudioBase(req.file.originalname)}.${format}`;
      const filename = makeStoredFilename(downloadFilename);
      const output = path.join(OUT, filename);

      await ffmpegConvert(input, output, options);
      if (user?.username) outputOwners.set(filename, user.username);

      const { error } = await supabase
        .from("usage")
        .insert({
          quota_key: quotaKey,
          username: user?.username || null,
          filename
        });

      if (error) throw error;

      return res.json({
        filename,
        downloadFilename,
        downloadUrl: "/api/download/" + encodeURIComponent(filename)
      });

    } catch (error) {
      console.error("CONVERT ERROR:", error);

      return res.status(500).json({
        error: error.message || "Conversion failed"
      });

    } finally {
      fs.rmSync(input, { force: true });
    }
  }
);

// ===============================
// AUTO SPLIT AUDIO (USER-SELECTED 1–6 MINUTES PER PART)
// ===============================

app.post(
  "/api/split",
  auth,
  upload.single("file"),
  async (req, res) => {
    const input = req.file?.path;
    const createdFiles = [];
    const createdPaths = [];
    if (!input) return res.status(400).json({ error: "Audio file missing" });

    try {
      const user = await getUser(req);
      const quotaKey = getQuotaKey(req, user);
      if (!user || user.membership !== "unlimited") {
        const used = await countUsage(quotaKey);
        if (used >= 10) {
          return res.status(429).json({ error: "Free quota reached: 10 conversions per day" });
        }
      }

      let options;
      try { options = JSON.parse(req.body.options || "{}"); }
      catch { return res.status(400).json({ error: "Invalid split options" }); }
      if (!options || typeof options !== "object" || Array.isArray(options)) {
        return res.status(400).json({ error: "Invalid split options" });
      }

      const requestedFormat = String(options.format || "mp3").toLowerCase();
      const sourceFormat = String(options.sourceFormat || path.extname(req.file.originalname).slice(1) || "mp3").toLowerCase();
      const format = options.splitOnly ? sourceFormat : requestedFormat;
      if (!["mp3", "wav", "flac", "m4a", "aac", "ogg", "opus"].includes(requestedFormat) || !["mp3", "wav", "flac", "m4a", "aac", "ogg", "opus"].includes(format)) {
        return res.status(400).json({ error: "Invalid output format" });
      }
      const requestedMinutes = Number(options.partMinutes);
      if (![1, 2, 3, 4, 5, 6].includes(requestedMinutes)) {
        return res.status(400).json({ error: "Choose a part duration from 1 to 6 minutes." });
      }
      const partSeconds = requestedMinutes * 60;
      const duration = await probeAudioDuration(input);
      const partCount = Math.ceil(duration / partSeconds);
      if (partCount > 200) {
        return res.status(400).json({ error: "Audio is too long for this split setting. Choose a longer part duration." });
      }

      const originalBase = safeAudioBase(req.file.originalname);
      const requestedBase = String(options.baseName || originalBase).replace(/[\x00-\x1f<>:"/\\|?*]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
      const base = requestedBase || originalBase;
      const fadeSeconds = Math.max(0, Math.min(15, Number(options.fadeSeconds) || 3));
      for (let index = 0; index < partCount; index++) {
        const start = index * partSeconds;
        const segmentDuration = Math.min(partSeconds, duration - start);
        if (segmentDuration <= 0) continue;
        const partNumber = String(index + 1).padStart(2, "0");
        const downloadFilename = `${base} ${index + 1}.${format}`;
        const filename = makeStoredFilename(downloadFilename);
        const output = path.join(OUT, filename);
        createdPaths.push(output);
        await ffmpegExportSegment(input, output, start, segmentDuration, { ...options, fadeSeconds, partIndex: index, partCount });
        if (user?.username) outputOwners.set(filename, user.username);
        createdFiles.push({
          filename,
          downloadFilename,
          downloadUrl: "/api/download/" + encodeURIComponent(filename),
          previewUrl: "/api/preview/" + encodeURIComponent(filename),
          part: index + 1,
          start,
          duration: segmentDuration,
          fadeSeconds
        });
      }

      const { error } = await supabase.from("usage").insert({
        quota_key: quotaKey,
        username: user?.username || null,
        filename: createdFiles[0]?.filename || "auto-split"
      });
      if (error) throw error;

      return res.json({
        originalFilename: req.file.originalname,
        duration,
        partCount: createdFiles.length,
        maxPartSeconds: partSeconds,
        appliedEffects: {
          speed: !options.splitOnly,
          pitch: !options.splitOnly,
          preservePitch: Boolean(options.preservePitch),
          gain: !options.splitOnly,
          fadeIn: fadeSeconds,
          fadeOut: fadeSeconds
        },
        trimApplied: false,
        files: createdFiles
      });
    } catch (error) {
      for (const output of createdPaths) fs.rmSync(output, { force: true });
      console.error("AUTO SPLIT ERROR:", error);
      return res.status(500).json({ error: error.message || "Audio split failed" });
    } finally {
      fs.rmSync(input, { force: true });
    }
  }
);

// ===============================
// ROBLOX CREATOR HUB OAUTH + AUDIO UPLOAD
// ===============================
app.post("/api/roblox/oauth/start", auth, requiredAuth, async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user) return res.status(404).json({ error: "Ahoy member account not found" });
    const { clientId, redirectUri } = robloxOAuthConfig();
    const state = jwt.sign({ purpose: "roblox-oauth", username: user.username, nonce: crypto.randomBytes(18).toString("hex") }, JWT, { expiresIn: "10m" });
    const url = new URL("https://apis.roblox.com/oauth/v1/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", "openid profile asset:read asset:write");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("prompt", "select_account consent");
    url.searchParams.set("state", state);
    return res.json({ authorizeUrl: url.toString() });
  } catch (error) {
    return res.status(503).json({ error: error.message || "Roblox OAuth unavailable" });
  }
});

app.get("/api/roblox/oauth/callback", async (req, res) => {
  const frontend = process.env.FRONTEND_URL || "https://ahoy-s-productions-convert.zixinx123.workers.dev";
  const redirectWith = (params) => {
    const target = new URL(frontend);
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
    return res.redirect(302, target.toString());
  };
  try {
    if (req.query.error) return redirectWith({ roblox: "error", message: String(req.query.error_description || req.query.error).slice(0, 180) });
    const code = String(req.query.code || "");
    const state = String(req.query.state || "");
    if (!code || !state) return redirectWith({ roblox: "error", message: "Callback Roblox tidak lengkap." });
    const payload = jwt.verify(state, JWT);
    if (payload.purpose !== "roblox-oauth" || !payload.username) throw new Error("OAuth state tidak valid");

    const { clientId, clientSecret, redirectUri } = robloxOAuthConfig();
    const tokenForm = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri
    });
    const tokenResponse = await fetch("https://apis.roblox.com/oauth/v1/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenForm,
      signal: AbortSignal.timeout(20000)
    });
    const tokens = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !tokens.access_token || !tokens.refresh_token) {
      throw new Error(tokens.error_description || tokens.error || "Roblox token exchange failed");
    }

    const profileResponse = await fetch("https://apis.roblox.com/oauth/v1/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(15000)
    });
    const profile = await profileResponse.json().catch(() => ({}));
    if (!profileResponse.ok || !profile.sub) throw new Error("Tidak dapat memverifikasi akun Roblox.");
    await saveRobloxTokens(payload.username, profile, tokens);
    return redirectWith({ roblox: "connected" });
  } catch (error) {
    console.error("ROBLOX OAUTH CALLBACK ERROR:", error.message);
    return redirectWith({ roblox: "error", message: "Koneksi Roblox gagal. Coba hubungkan ulang." });
  }
});

app.get("/api/roblox/status", auth, requiredAuth, async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user) return res.status(404).json({ error: "Ahoy member account not found" });
    const connection = await getRobloxConnection(user.username);
    return res.json(connection ? {
      connected: true,
      robloxUserId: connection.roblox_user_id,
      robloxUsername: connection.roblox_username
    } : { connected: false });
  } catch (error) {
    console.error("ROBLOX STATUS ERROR:", error);
    return res.status(500).json({ error: "Unable to check Roblox connection. Pastikan tabel roblox_connections sudah dibuat." });
  }
});

app.post("/api/roblox/disconnect", auth, requiredAuth, async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user) return res.status(404).json({ error: "Ahoy member account not found" });
    const connection = await getRobloxConnection(user.username);
    if (connection) {
      try {
        const { clientId, clientSecret } = robloxOAuthConfig();
        const form = new URLSearchParams({
          token: decryptRobloxSecret(connection.refresh_token_enc),
          client_id: clientId,
          client_secret: clientSecret
        });
        await fetch("https://apis.roblox.com/oauth/v1/token/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form,
          signal: AbortSignal.timeout(10000)
        });
      } catch (error) { console.warn("ROBLOX TOKEN REVOKE WARNING:", error.message); }
    }
    const { error } = await supabase.from("roblox_connections").delete().eq("username", user.username);
    if (error) throw error;
    return res.json({ success: true });
  } catch (error) {
    console.error("ROBLOX DISCONNECT ERROR:", error);
    return res.status(500).json({ error: "Unable to disconnect Roblox account" });
  }
});

app.post("/api/roblox/upload", auth, requiredAuth, async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user) return res.status(404).json({ error: "Ahoy member account not found" });
    const storedName = path.basename(String(req.body?.filename || ""));
    if (!isStoredAudioName(storedName)) return res.status(400).json({ error: "Invalid converted audio file" });
    const filePath = path.join(OUT, storedName);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File expired or not found. Convert or split the audio again." });
    if (outputOwners.get(storedName) !== user.username) {
      return res.status(403).json({ error: "File ini bukan hasil Convert/Auto Split dari akun Ahoy kamu. Convert atau split ulang dengan akun yang sedang login." });
    }

    const ext = path.extname(storedName).toLowerCase();
    const mimeTypes = { ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".flac": "audio/flac" };
    if (!mimeTypes[ext]) return res.status(400).json({ error: "Roblox menerima MP3, WAV, OGG, atau FLAC. Pilih salah satu format tersebut sebelum convert/split." });
    const stats = fs.statSync(filePath);
    if (stats.size > 20 * 1024 * 1024) return res.status(413).json({ error: "Ukuran file melebihi batas Roblox 20 MB. Convert ulang dengan bitrate/format lebih kecil." });
    const duration = await probeAudioDuration(filePath);
    if (duration > 7 * 60) return res.status(400).json({ error: "Durasi audio melebihi batas Roblox 7 menit. Gunakan Auto Split." });

    const { token, connection } = await getValidRobloxAccessToken(user.username);
    const requestedName = String(req.body?.displayName || path.basename(storedName, ext))
      .replace(/[\x00-\x1f]/g, " ").trim().slice(0, 50) || "Ahoy Audio";
    const description = String(req.body?.description || "Uploaded with Ahoy's Audio Converter")
      .replace(/[\x00-\x1f]/g, " ").trim().slice(0, 1000);

    const requestData = {
      assetType: "Audio",
      displayName: requestedName,
      description,
      creationContext: { creator: { userId: String(connection.roblox_user_id) } }
    };
    const form = new FormData();
    form.append("request", JSON.stringify(requestData));
    const bytes = fs.readFileSync(filePath);
    form.append("fileContent", new Blob([bytes], { type: mimeTypes[ext] }), requestedName + ext);

    const uploadResponse = await fetch("https://apis.roblox.com/assets/v1/assets", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(60000)
    });
    const uploadData = await uploadResponse.json().catch(() => ({}));
    if (!uploadResponse.ok) {
      const message = uploadData.message || uploadData.error?.message || uploadData.error || `Roblox upload failed (HTTP ${uploadResponse.status})`;
      return res.status(uploadResponse.status === 429 ? 429 : 400).json({ error: String(message).slice(0, 350) });
    }

    let asset = uploadData.response || uploadData;
    if (!asset.assetId && uploadData.path) {
      const operationId = String(uploadData.path).split("/").pop();
      for (let attempt = 0; attempt < 25; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const poll = await fetch(`https://apis.roblox.com/assets/v1/operations/${encodeURIComponent(operationId)}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15000)
        });
        const operation = await poll.json().catch(() => ({}));
        if (!poll.ok) throw new Error(operation.message || `Roblox upload status failed (HTTP ${poll.status})`);
        if (operation.done) {
          if (operation.error) throw new Error(operation.error.message || "Roblox rejected this audio upload");
          asset = operation.response || {};
          break;
        }
      }
    }

    const assetId = String(asset.assetId || "");
    if (!/^\d+$/.test(assetId)) {
      return res.status(504).json({ error: "Roblox menerima upload tetapi belum mengembalikan Audio ID. Cek Creator Hub beberapa saat lagi." });
    }
    const rawModeration = String(asset.moderationResult?.moderationState || "MODERATION_STATE_REVIEWING");
    const moderationStatus = rawModeration.includes("APPROVED") ? "approved"
      : rawModeration.includes("REJECTED") ? "rejected" : "pending";
    const { error: historyError } = await supabase.from("roblox_upload_history").insert({
      username: user.username,
      roblox_user_id: String(connection.roblox_user_id),
      roblox_username: connection.roblox_username,
      asset_id: assetId,
      display_name: requestedName,
      status: moderationStatus,
      moderation_state: rawModeration,
      creator_url: "https://create.roblox.com/dashboard/creations"
    });
    if (historyError) console.error("ROBLOX HISTORY SAVE ERROR:", historyError);
    return res.json({
      success: true,
      assetId,
      robloxUsername: connection.roblox_username,
      moderationState: asset.moderationResult?.moderationState || null,
      creatorUrl: `https://create.roblox.com/dashboard/creations` 
    });
  } catch (error) {
    console.error("ROBLOX AUDIO UPLOAD ERROR:", error);
    const message = error.message || "Roblox audio upload failed";
    return res.status(message.includes("Hubungkan akun") || message.includes("Sesi Roblox") ? 400 : 500).json({ error: message });
  }
});



// Upload an audio file selected directly from the member's device.
// This route is intentionally separate from /api/roblox/upload, which handles
// files already produced by Convert / Auto Split.
app.post("/api/roblox/upload-direct", auth, requiredAuth, directRobloxUpload.single("file"), async (req, res) => {
  const tempPath = req.file?.path;
  try {
    const user = await getUser(req);
    if (!user) return res.status(404).json({ error: "Ahoy member account not found" });
    if (!req.file) return res.status(400).json({ error: "Pilih file audio terlebih dahulu." });

    const ext = path.extname(req.file.originalname || "").toLowerCase();
    const mimeTypes = { ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".flac": "audio/flac" };
    if (!mimeTypes[ext]) return res.status(400).json({ error: "Format yang didukung: MP3, WAV, OGG, dan FLAC." });
    const stats = fs.statSync(tempPath);
    if (stats.size > 20 * 1024 * 1024) return res.status(413).json({ error: "Ukuran file melebihi batas Roblox 20 MB." });
    const duration = await probeAudioDuration(tempPath);
    if (duration > 7 * 60) return res.status(400).json({ error: "Durasi audio melebihi batas Roblox 7 menit. Gunakan Auto Split." });

    const { token, connection } = await getValidRobloxAccessToken(user.username);
    const requestedName = String(req.body?.displayName || path.basename(req.file.originalname, ext))
      .replace(/[\x00-\x1f]/g, " ").trim().slice(0, 50) || "Ahoy Audio";
    const description = String(req.body?.description || "Uploaded directly with Ahoy's Audio Converter")
      .replace(/[\x00-\x1f]/g, " ").trim().slice(0, 1000);

    const requestData = {
      assetType: "Audio",
      displayName: requestedName,
      description,
      creationContext: { creator: { userId: String(connection.roblox_user_id) } }
    };
    const form = new FormData();
    form.append("request", JSON.stringify(requestData));
    form.append("fileContent", new Blob([fs.readFileSync(tempPath)], { type: mimeTypes[ext] }), requestedName + ext);

    const uploadResponse = await fetch("https://apis.roblox.com/assets/v1/assets", {
      method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form,
      signal: AbortSignal.timeout(60000)
    });
    const uploadData = await uploadResponse.json().catch(() => ({}));
    if (!uploadResponse.ok) {
      const message = uploadData.message || uploadData.error?.message || uploadData.error || `Roblox upload failed (HTTP ${uploadResponse.status})`;
      return res.status(uploadResponse.status === 429 ? 429 : 400).json({ error: String(message).slice(0, 350) });
    }

    let asset = uploadData.response || uploadData;
    if (!asset.assetId && uploadData.path) {
      const operationId = String(uploadData.path).split("/").pop();
      for (let attempt = 0; attempt < 25; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const poll = await fetch(`https://apis.roblox.com/assets/v1/operations/${encodeURIComponent(operationId)}`, {
          headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000)
        });
        const operation = await poll.json().catch(() => ({}));
        if (!poll.ok) throw new Error(operation.message || `Roblox upload status failed (HTTP ${poll.status})`);
        if (operation.done) {
          if (operation.error) throw new Error(operation.error.message || "Roblox rejected this audio upload");
          asset = operation.response || {};
          break;
        }
      }
    }

    const assetId = String(asset.assetId || "");
    if (!/^\d+$/.test(assetId)) {
      return res.status(504).json({ error: "Roblox menerima upload tetapi belum mengembalikan Audio ID. Cek Creator Hub beberapa saat lagi." });
    }
    const rawModeration = String(asset.moderationResult?.moderationState || "MODERATION_STATE_REVIEWING");
    const moderationStatus = rawModeration.includes("APPROVED") ? "approved"
      : rawModeration.includes("REJECTED") ? "rejected" : "pending";
    const { error: historyError } = await supabase.from("roblox_upload_history").insert({
      username: user.username,
      roblox_user_id: String(connection.roblox_user_id),
      roblox_username: connection.roblox_username,
      asset_id: assetId,
      display_name: requestedName,
      status: moderationStatus,
      moderation_state: rawModeration,
      creator_url: "https://create.roblox.com/dashboard/creations"
    });
    if (historyError) console.error("ROBLOX DIRECT HISTORY SAVE ERROR:", historyError);
    return res.json({
      success: true, assetId, displayName: requestedName,
      robloxUsername: connection.roblox_username,
      moderationState: asset.moderationResult?.moderationState || null,
      status: moderationStatus,
      creatorUrl: "https://create.roblox.com/dashboard/creations"
    });
  } catch (error) {
    console.error("ROBLOX DIRECT AUDIO UPLOAD ERROR:", error);
    const message = error.message || "Roblox audio upload failed";
    return res.status(message.includes("Hubungkan akun") || message.includes("Sesi Roblox") ? 400 : 500).json({ error: message });
  } finally {
    if (tempPath) fs.promises.unlink(tempPath).catch(() => {});
  }
});

// ===============================
// ROBLOX UPLOAD HISTORY + LIVE MODERATION STATUS
// ===============================
function normalizeRobloxModeration(value) {
  const state = String(value || "").toUpperCase();
  if (state.includes("APPROVED")) return "approved";
  if (state.includes("REJECTED")) return "rejected";
  return "pending";
}

app.get("/api/roblox/history", auth, requiredAuth, async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user) return res.status(404).json({ error: "Ahoy member account not found" });
    const { data, error } = await supabase.from("roblox_upload_history")
      .select("id,asset_id,display_name,status,moderation_state,roblox_username,created_at,updated_at,creator_url")
      .eq("username", user.username).order("created_at", { ascending: false }).limit(50);
    if (error) throw error;

    const pending = (data || []).filter(item => item.status === "pending").slice(0, 15);
    if (pending.length) {
      try {
        const { token } = await getValidRobloxAccessToken(user.username);
        for (const item of pending) {
          try {
            const response = await fetch(`https://apis.roblox.com/assets/v1/assets/${encodeURIComponent(item.asset_id)}`, {
              headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(12000)
            });
            if (!response.ok) continue;
            const assetData = await response.json().catch(() => ({}));
            const rawState = String(assetData.moderationResult?.moderationState || item.moderation_state || "");
            const nextStatus = normalizeRobloxModeration(rawState);
            if (nextStatus !== item.status || rawState !== item.moderation_state) {
              await supabase.from("roblox_upload_history").update({
                status: nextStatus, moderation_state: rawState || null, updated_at: new Date().toISOString()
              }).eq("id", item.id).eq("username", user.username);
              item.status = nextStatus; item.moderation_state = rawState; item.updated_at = new Date().toISOString();
            }
          } catch (refreshError) { console.warn("ROBLOX MODERATION REFRESH:", refreshError.message); }
        }
      } catch (tokenError) { console.warn("ROBLOX HISTORY TOKEN:", tokenError.message); }
    }
    return res.json({ history: data || [] });
  } catch (error) {
    console.error("ROBLOX HISTORY ERROR:", error);
    return res.status(500).json({ error: "Gagal memuat riwayat upload Roblox." });
  }
});

// ===============================
// AHOY UNIVERSAL DOWNLOADER (DEDICATED SERVICE)
// ===============================
function downloaderServiceConfig() {
  const base = String(process.env.DOWNLOADER_SERVICE_URL || "").replace(/\/+$/, "");
  const secret = String(process.env.DOWNLOADER_SERVICE_SECRET || "");
  if (!base || !secret) throw new Error("Universal Downloader belum dikonfigurasi. Isi DOWNLOADER_SERVICE_URL dan DOWNLOADER_SERVICE_SECRET.");
  return { base, secret };
}

async function downloaderServiceFetch(route, options = {}) {
  const { base, secret } = downloaderServiceConfig();
  const response = await fetch(base + route, {
    ...options,
    headers: {
      "X-Ahoy-Service-Key": secret,
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(options.timeout || 30000)
  });
  return response;
}

function downloaderErrorMessage(data, fallback) {
  return String(data?.detail || data?.error || fallback).slice(0, 500);
}

app.get("/api/downloader/usage", auth, requiredAuth, downloaderPollLimiter, async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user) return res.status(404).json({ error: "Member account not found" });

    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const staleBefore = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { error: staleError } = await supabase
      .from("downloader_jobs")
      .update({ status: "failed", error_message: "Reservation expired." })
      .eq("username", user.username)
      .in("status", ["pending", "processing", "ready"])
      .lt("created_at", staleBefore);
    if (staleError) throw staleError;

    const { count: used, error: usedError } = await supabase
      .from("downloader_jobs")
      .select("id", { count: "exact", head: true })
      .eq("username", user.username)
      .eq("status", "completed")
      .gte("completed_at", start.toISOString());
    if (usedError) throw usedError;

    const { count: active, error: activeError } = await supabase
      .from("downloader_jobs")
      .select("id", { count: "exact", head: true })
      .eq("username", user.username)
      .in("status", ["pending", "processing", "ready"]);
    if (activeError) throw activeError;

    const unlimited = user.membership === "unlimited";
    const dailyLimit = unlimited ? null : 10;
    const resetAt = new Date();
    resetAt.setUTCHours(24, 0, 0, 0);
    return res.json({
      username: user.username,
      membership: user.membership,
      unlimited,
      daily_limit: dailyLimit,
      used: used || 0,
      active: active || 0,
      remaining: unlimited ? null : Math.max(0, 10 - (used || 0)),
      concurrency_limit: unlimited ? 3 : 1,
      reset_at: unlimited ? null : resetAt.toISOString()
    });
  } catch (error) {
    console.error("DOWNLOADER USAGE ERROR:", error);
    return res.status(500).json({ error: "Unable to load downloader usage. Run the downloader SQL migration first." });
  }
});

app.post("/api/downloader/jobs", auth, requiredAuth, downloaderCreateLimiter, async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user) return res.status(404).json({ error: "Member account not found" });

    const rawUrl = String(req.body?.url || "").trim();
    let parsed;
    try { parsed = new URL(rawUrl); } catch { return res.status(400).json({ error: "Masukkan URL media yang valid." }); }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      return res.status(400).json({ error: "Hanya URL HTTP/HTTPS publik yang didukung." });
    }

    const format = String(req.body?.format || "mp3").toLowerCase();
    if (!["mp3", "wav", "m4a", "opus", "original"].includes(format)) {
      return res.status(400).json({ error: "Format output tidak didukung." });
    }

    // The database function locks the account row and reserves a slot atomically.
    const { data: reservation, error: reserveError } = await supabase.rpc(
      "reserve_downloader_job",
      { p_username: user.username }
    );
    if (reserveError) throw reserveError;
    const slot = Array.isArray(reservation) ? reservation[0] : reservation;
    if (!slot?.allowed) {
      if (slot?.reason === "daily_limit") {
        return res.status(429).json({ error: "Kuota FREE habis: 10 download berhasil per hari. Upgrade ke UNLIMITED atau tunggu reset harian." });
      }
      if (slot?.reason === "concurrency_limit") {
        return res.status(429).json({ error: user.membership === "unlimited" ? "Maksimal 3 download dapat berjalan bersamaan." : "Akun FREE hanya dapat menjalankan 1 download dalam satu waktu." });
      }
      return res.status(403).json({ error: "Akun tidak dapat memulai download." });
    }

    const jobId = slot.job_id;
    try {
      const serviceResponse = await downloaderServiceFetch("/internal/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: jobId, url: parsed.toString(), format }),
        timeout: 15000
      });
      const serviceData = await serviceResponse.json().catch(() => ({}));
      if (!serviceResponse.ok) throw new Error(downloaderErrorMessage(serviceData, "Downloader service rejected the job."));
      await supabase.from("downloader_jobs").update({ status: "processing" }).eq("id", jobId);
      return res.status(202).json({ job_id: jobId, status: serviceData.status || "queued", usage: { membership: user.membership } });
    } catch (error) {
      await supabase.from("downloader_jobs").update({ status: "failed", error_message: String(error.message).slice(0, 500) }).eq("id", jobId);
      throw error;
    }
  } catch (error) {
    console.error("DOWNLOADER CREATE ERROR:", error);
    const message = error.message || "Downloader service unavailable.";
    const status = /belum dikonfigurasi|not configured/i.test(message) ? 503 : 502;
    return res.status(status).json({ error: message });
  }
});

app.get("/api/downloader/jobs/:id", auth, requiredAuth, downloaderPollLimiter, async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user) return res.status(404).json({ error: "Member account not found" });
    const { data: row, error: rowError } = await supabase
      .from("downloader_jobs")
      .select("id,username,status,output_filename,error_message,created_at,completed_at")
      .eq("id", req.params.id)
      .eq("username", user.username)
      .maybeSingle();
    if (rowError) throw rowError;
    if (!row) return res.status(404).json({ error: "Download job tidak ditemukan." });

    if (row.status === "completed" || row.status === "failed") {
      return res.json({ job_id: row.id, status: row.status, filename: row.output_filename, error: row.error_message, progress: row.status === "completed" ? 100 : 0 });
    }

    const serviceResponse = await downloaderServiceFetch("/internal/jobs/" + encodeURIComponent(row.id), { timeout: 15000 });
    const data = await serviceResponse.json().catch(() => ({}));
    if (!serviceResponse.ok) {
      if (serviceResponse.status === 404) {
        await supabase.from("downloader_jobs").update({ status: "failed", error_message: "Downloader job expired after service restart. Please retry." }).eq("id", row.id).eq("username", user.username);
        return res.json({ job_id: row.id, status: "failed", progress: 0, error: "Job expired after downloader restart. Please retry." });
      }
      throw new Error(downloaderErrorMessage(data, "Tidak dapat membaca status download."));
    }
    if (data.status === "completed") {
      const { error } = await supabase.from("downloader_jobs").update({
        status: "ready",
        output_filename: String(data.filename || "").slice(0, 240),
        error_message: null
      }).eq("id", row.id).eq("username", user.username).in("status", ["pending", "processing", "ready"]);
      if (error) throw error;
    } else if (data.status === "failed") {
      await supabase.from("downloader_jobs").update({
        status: "failed",
        error_message: String(data.error || "Download failed").slice(0, 500)
      }).eq("id", row.id).eq("username", user.username).neq("status", "completed");
    } else if (row.status !== "processing") {
      await supabase.from("downloader_jobs").update({ status: "processing" }).eq("id", row.id);
    }
    return res.json({
      job_id: row.id,
      status: data.status || row.status,
      progress: Math.max(0, Math.min(100, Number(data.progress) || 0)),
      title: data.title || "",
      extractor: data.extractor || "",
      filename: data.filename || "",
      error: data.error || ""
    });
  } catch (error) {
    console.error("DOWNLOADER STATUS ERROR:", error);
    return res.status(502).json({ error: error.message || "Unable to check download status." });
  }
});

app.get("/api/downloader/jobs/:id/file", auth, requiredAuth, downloaderPollLimiter, async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user) return res.status(404).json({ error: "Member account not found" });
    const { data: row, error } = await supabase
      .from("downloader_jobs")
      .select("id,username,status,output_filename")
      .eq("id", req.params.id)
      .eq("username", user.username)
      .maybeSingle();
    if (error) throw error;
    if (!row || !["ready", "completed"].includes(row.status)) return res.status(404).json({ error: "File belum siap atau tidak ditemukan." });

    const upstream = await downloaderServiceFetch("/internal/jobs/" + encodeURIComponent(row.id) + "/file", { timeout: 60000 });
    if (!upstream.ok) {
      const data = await upstream.json().catch(() => ({}));
      return res.status(upstream.status).json({ error: downloaderErrorMessage(data, "File download tidak tersedia.") });
    }
    const bytes = Buffer.from(await upstream.arrayBuffer());
    const filename = String(upstream.headers.get("content-disposition") || "").match(/filename="?([^";]+)"?/i)?.[1] || row.output_filename || "ahoy-download";
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
    res.setHeader("Content-Length", String(bytes.length));
    res.setHeader("Content-Disposition", `attachment; filename="${String(filename).replace(/["\\r\\n]/g, "_")}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(bytes);
    res.once("finish", () => {
      if (row.status !== "completed") {
        supabase.from("downloader_jobs").update({
          status: "completed",
          completed_at: new Date().toISOString(),
          error_message: null
        }).eq("id", row.id).eq("username", user.username).eq("status", "ready")
          .then(({ error: updateError }) => { if (updateError) console.error("DOWNLOADER COMPLETE USAGE UPDATE:", updateError); });
      }
    });
    return;
  } catch (error) {
    console.error("DOWNLOADER FILE ERROR:", error);
    return res.status(502).json({ error: error.message || "Unable to retrieve downloaded file." });
  }
});

// ===============================
// DOWNLOAD SINGLE FILE
// ===============================

app.get("/api/download/:name", (req, res) => {
  const name = path.basename(req.params.name);

  if (!isStoredAudioName(name)) {
    return res.status(400).json({ error: "Invalid filename" });
  }

  const filePath = path.join(OUT, name);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      error: "File expired or not found"
    });
  }

  const storedBase = name.includes("__") ? name.split("__").slice(1).join("__") : name;
  return res.download(filePath, safeArchiveName(storedBase));
});

// ===============================
// INLINE AUDIO PREVIEW (supports browser byte-range playback/seeking)
// ===============================

app.get("/api/preview/:name", (req, res) => {
  const name = path.basename(req.params.name);
  if (!isStoredAudioName(name)) {
    return res.status(400).json({ error: "Invalid filename" });
  }

  const filePath = path.join(OUT, name);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Preview expired or not found" });
  }

  const mimeTypes = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg"
  };
  const contentType = mimeTypes[path.extname(name).toLowerCase()];
  if (!contentType) return res.status(415).json({ error: "Unsupported preview format" });

  const displayName = safeArchiveName(name.includes("__") ? name.split("__").slice(1).join("__") : name);
  const encodedDisplayName = encodeURIComponent(displayName).replace(/[!'()*]/g, char =>
    "%" + char.charCodeAt(0).toString(16).toUpperCase()
  );
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodedDisplayName}`);
  res.setHeader("Cache-Control", "private, max-age=300");
  return res.sendFile(filePath, { acceptRanges: true }, error => {
    if (error && !res.headersSent) res.status(error.statusCode || 500).end();
  });
});

// ===============================
// DOWNLOAD ZIP
// ===============================

app.post("/api/download-zip", auth, async (req, res) => {
  try {
    const files = Array.isArray(req.body.files)
      ? req.body.files
      : [];

    const entries = files.map(file => {
      if (typeof file === "string") {
        const name = path.basename(file);
        return { name, archiveName: name };
      }
      const name = path.basename(String(file?.name || ""));
      const archiveName = safeArchiveName(file?.downloadName || name);
      return { name, archiveName };
    }).filter(entry => isStoredAudioName(entry.name));

    if (!entries.length) {
      return res.status(400).json({
        error: "No converted files"
      });
    }

    const existingFiles = entries.filter(entry =>
      fs.existsSync(path.join(OUT, entry.name))
    );

    if (!existingFiles.length) {
      return res.status(404).json({
        error: "Files expired or not found"
      });
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="ahoys-audio.zip"'
    );

    const zip = archiver("zip", {
      zlib: { level: 5 }
    });

    zip.on("error", error => {
      console.error("ZIP ERROR:", error);

      if (!res.headersSent) {
        res.status(500).json({
          error: "ZIP creation failed"
        });
      } else {
        res.end();
      }
    });

    zip.pipe(res);

    for (const entry of existingFiles) {
      zip.file(path.join(OUT, entry.name), {
        name: entry.archiveName
      });
    }

    await zip.finalize();

  } catch (error) {
    console.error("ZIP ERROR:", error);

    if (!res.headersSent) {
      return res.status(500).json({
        error: "ZIP creation failed"
      });
    }

    res.end();
  }
});

// ===============================
// ADMIN AUTHORIZATION
// ===============================

async function admin(req, res, next) {
  try {
    const user = await getUser(req);

    if (!user?.is_admin) {
      return res.status(403).json({
        error: "Admin only"
      });
    }

    req.admin = user;
    next();

  } catch (error) {
    console.error("ADMIN CHECK ERROR:", error);

    return res.status(500).json({
      error: "Admin check failed"
    });
  }
}

// ===============================
// ADMIN: GET USERS
// ===============================

app.get(
  "/api/admin/users",
  auth,
  requiredAuth,
  admin,
  async (req, res) => {
    try {
      const { data, error } = await supabase
        .from("users")
        .select("id,username,membership,is_admin,created_at,activated_at")
        .order("created_at", {
          ascending: false
        });

      if (error) throw error;

      return res.json(data);

    } catch (error) {
      console.error("ADMIN USERS ERROR:", error);

      return res.status(500).json({
        error: "Unable to load users"
      });
    }
  }
);

// ===============================
// ADMIN: UPDATE MEMBERSHIP
// ===============================

app.patch(
  "/api/admin/users/:id/membership",
  auth,
  requiredAuth,
  admin,
  async (req, res) => {
    try {
      const membership = req.body?.membership;

      if (!["free", "unlimited"].includes(membership)) {
        return res.status(400).json({
          error: "Invalid membership"
        });
      }

      const { data: updatedUser, error } = await supabase
        .from("users")
        .update({
          membership,
          activated_at: membership === "unlimited"
            ? new Date().toISOString()
            : null
        })
        .eq("id", req.params.id)
        .select("id,username,membership")
        .maybeSingle();

      if (error) throw error;
      if (!updatedUser) {
        return res.status(404).json({ error: "User not found" });
      }

      // Push immediately to every active session belonging to this username.
      broadcastMembership(updatedUser.username, updatedUser.membership);

      return res.json({
        ok: true,
        user: updatedUser
      });

    } catch (error) {
      console.error("MEMBERSHIP UPDATE ERROR:", error);

      return res.status(500).json({
        error: "Membership update failed"
      });
    }
  }
);

// ===============================
// HEALTH CHECK
// ===============================

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "AHOY'S Audio Converter"
  });
});

// ===============================
// ERROR HANDLER
// ===============================

app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err);

  if (res.headersSent) {
    return next(err);
  }

  const status = err instanceof multer.MulterError ? 400 : 400;

  return res.status(status).json({
    error: err.message || "Bad request"
  });
});

// ===============================
// START SERVER
// ===============================

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`AHOY'S backend listening on ${port}`);
});
