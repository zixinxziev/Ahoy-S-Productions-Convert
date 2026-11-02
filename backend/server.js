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

      const filename = crypto.randomUUID() + "." + format;
      const output = path.join(OUT, filename);

      await ffmpegConvert(input, output, options);

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
        downloadUrl: "/api/download/" + filename
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
// DOWNLOAD SINGLE FILE
// ===============================

app.get("/api/download/:name", (req, res) => {
  const name = path.basename(req.params.name);

  if (!/^[a-f0-9-]+\.(mp3|wav|flac|m4a|aac|ogg|opus)$/i.test(name)) {
    return res.status(400).json({
      error: "Invalid filename"
    });
  }

  const filePath = path.join(OUT, name);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      error: "File expired or not found"
    });
  }

  return res.download(filePath);
});

// ===============================
// DOWNLOAD ZIP
// ===============================

app.post("/api/download-zip", auth, async (req, res) => {
  try {
    const files = Array.isArray(req.body.files)
      ? req.body.files
      : [];

    const names = files
      .map(file => path.basename(String(file)))
      .filter(name =>
        /^[a-f0-9-]+\.(mp3|wav|flac|m4a|aac|ogg|opus)$/i.test(name)
      );

    if (!names.length) {
      return res.status(400).json({
        error: "No converted files"
      });
    }

    const existingFiles = names.filter(name =>
      fs.existsSync(path.join(OUT, name))
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

    for (const name of existingFiles) {
      zip.file(path.join(OUT, name), {
        name
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
