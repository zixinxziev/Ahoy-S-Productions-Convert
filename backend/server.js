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
  legacyHeaders: false
}));

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

    const speed = options.robloxMode
      ? 1 / Math.max(0.05, Number(options.targetSpeed) || 1)
      : Math.max(0.5, Math.min(2, Number(options.manualSpeed) || 1));

    const pitch = Math.max(
      -12,
      Math.min(12, Number(options.pitch) || 0)
    );

    const pitchRatio = Math.pow(2, pitch / 12);

    if (options.preservePitch) {
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

    // Match ffmpegConvert(): apply Roblox target speed or manual speed, pitch,
    // preserve-pitch processing, and gain independently to every extracted part.
    const filters = [];
    const speed = options.robloxMode
      ? 1 / Math.max(0.05, Number(options.targetSpeed) || 1)
      : Math.max(0.5, Math.min(2, Number(options.manualSpeed) || 1));
    const pitch = Math.max(-12, Math.min(12, Number(options.pitch) || 0));
    const pitchRatio = Math.pow(2, pitch / 12);

    if (options.preservePitch) {
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
    if (gain !== 0) filters.push(`volume=${gain}dB`);
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

      const format = String(options.format || "mp3").toLowerCase();
      if (!["mp3", "wav", "flac", "m4a", "aac", "ogg", "opus"].includes(format)) {
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

      const base = safeAudioBase(req.file.originalname);
      for (let index = 0; index < partCount; index++) {
        const start = index * partSeconds;
        const segmentDuration = Math.min(partSeconds, duration - start);
        if (segmentDuration <= 0) continue;
        const partNumber = String(index + 1).padStart(2, "0");
        const downloadFilename = `${base} Part ${partNumber}.${format}`;
        const filename = makeStoredFilename(downloadFilename);
        const output = path.join(OUT, filename);
        createdPaths.push(output);
        await ffmpegExportSegment(input, output, start, segmentDuration, options);
        if (user?.username) outputOwners.set(filename, user.username);
        createdFiles.push({
          filename,
          downloadFilename,
          downloadUrl: "/api/download/" + encodeURIComponent(filename),
          part: index + 1,
          start,
          duration: segmentDuration
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
          speed: true,
          pitch: true,
          preservePitch: Boolean(options.preservePitch),
          gain: true
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
    url.searchParams.set("prompt", "login consent");
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
