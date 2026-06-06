import express from "express";
import path from "path";
import fs from "fs";
import { google } from "googleapis";
import multer from "multer";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import { AppSettings, UploadedFile, SystemStatus } from "./src/types";

// Load environment variables
dotenv.config();

const app = express();
const PORT = 3000;
const DB_FILE = process.env.DATABASE_PATH || path.join(process.cwd(), "database.json");

// Configure Multer for in-memory file uploads
const upload = multer({ storage: multer.memoryStorage() });

// Express JSON parsing limit to handle configs
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ----------------------------------------------------
// Local Thread-Safe JSON Database Management
// ----------------------------------------------------
const defaultSettings: AppSettings = {
  telegramBotToken: "",
  googleAuthType: "oauth",
  googleServiceAccountKey: "",
  googleOAuthClientId: "",
  googleOAuthClientSecret: "",
  googleOAuthRefreshToken: "",
  targetFolderId: "",
  isBotActive: false,
  expiryHours: 24,
};

interface DatabaseSchema {
  settings: AppSettings;
  files: UploadedFile[];
}

function readDatabase(): DatabaseSchema {
  try {
    if (!fs.existsSync(DB_FILE)) {
      const initialDb: DatabaseSchema = { settings: defaultSettings, files: [] };
      fs.writeFileSync(DB_FILE, JSON.stringify(initialDb, null, 2), "utf-8");
      return initialDb;
    }
    const data = fs.readFileSync(DB_FILE, "utf-8");
    const parsed = JSON.parse(data);
    
    // Ensure all setting fields exist
    parsed.settings = { ...defaultSettings, ...parsed.settings };
    parsed.files = parsed.files || [];
    return parsed;
  } catch (error) {
    console.error("Error reading database.json, resetting to defaults:", error);
    return { settings: defaultSettings, files: [] };
  }
}

function writeDatabase(db: DatabaseSchema) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf-8");
  } catch (error) {
    console.error("Error writing database.json:", error);
  }
}

// ----------------------------------------------------
// Google Drive helper functions
// ----------------------------------------------------
function getGoogleAuth(settings: AppSettings, req?: any) {
  if (settings.googleAuthType === "serviceAccount") {
    if (!settings.googleServiceAccountKey) {
      throw new Error("Google Service Account Key is empty.");
    }
    try {
      const keyObj = JSON.parse(settings.googleServiceAccountKey);
      return new google.auth.JWT({
        email: keyObj.client_email,
        key: keyObj.private_key,
        scopes: ["https://www.googleapis.com/auth/drive.file"],
      });
    } catch (e: any) {
      throw new Error("Invalid Service Account JSON key format: " + e.message);
    }
  } else {
    // Standard OAuth2 config
    const clientId = settings.googleOAuthClientId || process.env.GOOGLE_CLIENT_ID || "";
    const clientSecret = settings.googleOAuthClientSecret || process.env.GOOGLE_CLIENT_SECRET || "";
    const redirectUri = getOAuthRedirectUri(req);

    if (!clientId || !clientSecret) {
      throw new Error("Client ID or Client Secret is missing for OAuth2.");
    }

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    if (settings.googleOAuthRefreshToken) {
      oauth2Client.setCredentials({
        refresh_token: settings.googleOAuthRefreshToken,
      });
    }
    return oauth2Client;
  }
}

function getOAuthRedirectUri(req?: any): string {
  if (process.env.APP_URL) {
    return `${process.env.APP_URL.replace(/\/$/, "")}/api/auth/google/callback`;
  }
  if (req) {
    const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
    const host = req.headers["x-forwarded-host"] || req.get("host") || "localhost:3000";
    return `${protocol}://${host}/api/auth/google/callback`;
  }
  return "http://localhost:3000/api/auth/google/callback";
}

// Upload a stream or buffer to Google Drive
async function uploadToGoogleDrive(
  settings: AppSettings,
  fileName: string,
  mimeType: string,
  fileStreamOrBuffer: any,
  fileSize: number
): Promise<any> {
  const authClient = getGoogleAuth(settings);
  const drive = google.drive({ version: "v3", auth: authClient });

  const metadata: any = {
    name: fileName,
  };

  if (settings.targetFolderId) {
    metadata.parents = [settings.targetFolderId];
  }

  const media = {
    mimeType: mimeType,
    body: fileStreamOrBuffer,
  };

  try {
    const response = await drive.files.create({
      requestBody: metadata,
      media: media,
      fields: "id, name, mimeType, size, webViewLink",
      supportsAllDrives: true,
    } as any);

    return response.data;
  } catch (error: any) {
    if (error.message && (error.message.includes("quota") || error.message.includes("storage"))) {
      throw new Error(
        "Google Service Accounts have 0 GB storage quota. To resolve this error, you can either: " +
        "1) Use Google OAuth 2.0 (user-based login with 15 GB free quota), OR " +
        "2) Create a 'Shared Drive' inside Google Drive, add your Service Account email as 'Content Manager', and input that Shared Drive's ID in 'Target Google Drive Folder ID' below."
      );
    }
    throw error;
  }
}

// ----------------------------------------------------
// Telegram Bot Management
// ----------------------------------------------------
let botPollingInterval: NodeJS.Timeout | null = null;
let lastUpdateId = 0;

async function checkTelegramBotInfo(token: string): Promise<any> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await res.json();
    if (data.ok) {
      return data.result;
    }
    throw new Error(data.description || "Inauthentic token.");
  } catch (error: any) {
    throw new Error(`Telegram error: ${error.message}`);
  }
}

async function setTelegramWebhook(token: string) {
  const appUrl = process.env.APP_URL;
  if (!appUrl) return;

  const webhookUrl = `${appUrl.replace(/\/$/, "")}/api/telegram/webhook`;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: webhookUrl }),
    });
    const result = await res.json();
    console.log(`Telegram webhook setup attempt on: ${webhookUrl} - Result:`, result);
  } catch (error) {
    console.error("Failed to set Telegram webhook:", error);
  }
}

async function removeTelegramWebhook(token: string) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`);
  } catch (error) {
    console.error("Failed to remove Telegram Webhook:", error);
  }
}

// Process a single update from Telegram
async function handleTelegramUpdate(update: any) {
  if (!update.message) return;

  const msg = update.message;
  const chatId = msg.chat.id;
  const dbData = readDatabase();
  const settings = dbData.settings;

  // Setup response function
  const sendTelegramText = async (text: string, replyToMsgId?: number) => {
    try {
      await fetch(`https://api.telegram.org/bot${settings.telegramBotToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: text,
          parse_mode: "HTML",
          reply_to_message_id: replyToMsgId,
        }),
      });
    } catch (e) {
      console.error("Failed to send message to Telegram user chat:", chatId, e);
    }
  };

  // Check if Bot is configured and active
  if (!settings.telegramBotToken) {
    return;
  }

  // Handle /start commands or simple instructions
  const text = msg.text || "";
  if (text.startsWith("/start")) {
    await sendTelegramText(
      "<b>Hi! Welcome to TG-to-GD Uploader!</b>\n\n" +
      "Send or forward me any file (document, photo, audio, video) and I will:\n" +
      "1. Upload it securely to your linked Google Drive folder\n" +
      "2. Return a secure public shareable link that expires in <b>24 hours</b> (or your custom expiry)!"
    );
    return;
  }

  // Pull out any attachment/files
  let fileId = "";
  let fileName = "";
  let mimeType = "application/octet-stream";
  let fileSize = 0;

  if (msg.document) {
    fileId = msg.document.file_id;
    fileName = msg.document.file_name || "document";
    mimeType = msg.document.mime_type || mimeType;
    fileSize = msg.document.file_size || 0;
  } else if (msg.photo && msg.photo.length > 0) {
    // Pick the largest photo resolution
    const p = msg.photo[msg.photo.length - 1];
    fileId = p.file_id;
    fileName = `photo_${Date.now()}.jpg`;
    mimeType = "image/jpeg";
    fileSize = p.file_size || 0;
  } else if (msg.video) {
    fileId = msg.video.file_id;
    fileName = msg.video.file_name || `video_${Date.now()}.mp4`;
    mimeType = msg.video.mime_type || "video/mp4";
    fileSize = msg.video.file_size || 0;
  } else if (msg.audio) {
    fileId = msg.audio.file_id;
    fileName = msg.audio.file_name || `audio_${Date.now()}.mp3`;
    mimeType = msg.audio.mime_type || "audio/mpeg";
    fileSize = msg.audio.file_size || 0;
  } else if (msg.voice) {
    fileId = msg.voice.file_id;
    fileName = `voice_${Date.now()}.ogg`;
    mimeType = msg.voice.mime_type || "audio/ogg";
    fileSize = msg.voice.file_size || 0;
  }

  if (!fileId) {
    if (text) {
      await sendTelegramText("Please forward or send a physical file rather than plain text. I'll translate it directly into a public Google Drive down-link!");
    }
    return;
  }

  // Acknowledge uploader
  const processingMsg = await fetch(`https://api.telegram.org/bot${settings.telegramBotToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: "⚡ <b>Processing file and linking Google Drive...</b> Please wait.",
      parse_mode: "HTML",
      reply_to_message_id: msg.message_id,
    }),
  }).then(r => r.json());

  const tempMessageId = processingMsg?.ok ? processingMsg.result.message_id : undefined;

  try {
    // 1. Get file path from Telegram
    const pathRes = await fetch(`https://api.telegram.org/bot${settings.telegramBotToken}/getFile?file_id=${fileId}`);
    const pathData = await pathRes.json();
    if (!pathData.ok) {
      throw new Error(`Telegram getFile fetch failed: ${pathData.description}`);
    }

    const filePath = pathData.result.file_path;
    const downloadUrl = `https://api.telegram.org/file/bot${settings.telegramBotToken}/${filePath}`;

    // Stream download from Telegram
    const dlResponse = await fetch(downloadUrl);
    if (!dlResponse.ok || !dlResponse.body) {
      throw new Error("Could not construct file download stream from Telegram CDN.");
    }

    // Convert the stream body into a format Google Drive API accepts (Node readable or Buffer)
    const arrayBuffer = await dlResponse.arrayBuffer();
    const cleanBuffer = Buffer.from(arrayBuffer);

    // Write stream in memory
    const stream = require("stream");
    const bufferStream = new stream.PassThrough();
    bufferStream.end(cleanBuffer);

    // 2. Upload to Google Drive
    const driveFile = await uploadToGoogleDrive(
      settings,
      fileName,
      mimeType,
      bufferStream,
      fileSize
    );

    // 3. Register inside db.json with expiry tracking
    const fileIdInDb = Math.random().toString(36).substring(2, 11) + "_" + Date.now();
    const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;
    const publicUrl = `${appUrl.replace(/\/$/, "")}/download/${fileIdInDb}`;

    const uploadedHours = settings.expiryHours || 24;
    const uploadedAt = new Date();
    const expiresAt = new Date(uploadedAt.getTime() + uploadedHours * 60 * 60 * 1000);

    const newUploadedFile: UploadedFile = {
      id: fileIdInDb,
      fileName: fileName,
      fileSize: fileSize || cleanBuffer.length,
      mimeType: mimeType,
      telegramUser: {
        id: msg.from.id,
        username: msg.from.username,
        firstName: msg.from.first_name,
      },
      googleFileId: driveFile.id,
      shareUrl: publicUrl,
      uploadedAt: uploadedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      isExpired: false,
    };

    // Store inside database atomically
    const latestDb = readDatabase();
    latestDb.files.push(newUploadedFile);
    writeDatabase(latestDb);

    // Respond back elegantly with download details to Telegram user
    const sizeMb = (newUploadedFile.fileSize / (1024 * 1024)).toFixed(2);
    
    // Delete status warning and reply with the file's information
    if (tempMessageId) {
      await fetch(`https://api.telegram.org/bot${settings.telegramBotToken}/deleteMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, message_id: tempMessageId }),
      });
    }

    await sendTelegramText(
      `✅ <b>File Uploaded Successfully!</b>\n\n` +
      `📦 <b>Name:</b> <code>${fileName}</code>\n` +
      `⚖️ <b>Size:</b> ${sizeMb} MB\n` +
      `⏳ <b>Expiration:</b> ${uploadedHours} Hours\n\n` +
      `🔗 <b>Public Download URL:</b>\n${publicUrl}\n\n` +
      `<i>This download link will automatically self-destruct on ${expiresAt.toLocaleDateString()} at ${expiresAt.toLocaleTimeString()}.</i>`,
      msg.message_id
    );

  } catch (error: any) {
    console.error("Error processing Telegram file uploader stream:", error);

    // Delete static uploader state if possible
    if (tempMessageId) {
      try {
        await fetch(`https://api.telegram.org/bot${settings.telegramBotToken}/deleteMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, message_id: tempMessageId }),
        });
      } catch {}
    }

    await sendTelegramText(
      `❌ <b>Upload failed:</b>\n<code>${error.message || "An unexpected error occurred during Google Drive transmission"}.</code>\n\nPlease check your Google credentials/authentication status in the Web Dashboard.`,
      msg.message_id
    );
  }
}

// Periodic Long-polling fallback in case of no public app link
function startTelegramPolling(token: string) {
  if (botPollingInterval) clearInterval(botPollingInterval);

  console.log("Starting Telegram Bot long polling engine...");
  botPollingInterval = setInterval(async () => {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=${lastUpdateId + 1}&timeout=2`);
      const data = await res.json();
      if (data.ok && data.result.length > 0) {
        for (const update of data.result) {
          lastUpdateId = Math.max(lastUpdateId, update.update_id);
          try {
            await handleTelegramUpdate(update);
          } catch (itemErr) {
            console.error("Individual update failure inside polling interval:", itemErr);
          }
        }
      }
    } catch (e) {
      // Quiet fail to avoid polluting terminal logs
    }
  }, 3500);
}

function stopTelegramPolling() {
  if (botPollingInterval) {
    clearInterval(botPollingInterval);
    botPollingInterval = null;
    console.log("Stopped Telegram Bot long polling engine.");
  }
}

// Start bot based on current settings
async function startupTelegramBot() {
  const dbData = readDatabase();
  const token = dbData.settings.telegramBotToken;
  const isBotActive = dbData.settings.isBotActive;

  stopTelegramPolling();

  if (!token || !isBotActive) {
    return;
  }

  const appUrl = process.env.APP_URL;
  if (appUrl) {
    await setTelegramWebhook(token);
  } else {
    // If local without public HTTPS URL, use polling fallback
    startTelegramPolling(token);
  }
}

// Try running bot at initial start
startupTelegramBot().catch(err => console.error("Initial Bot Startup Failed:", err));

// ----------------------------------------------------
// REST APIs for configuration and authentication
// ----------------------------------------------------

// Get Dashboard Data (Settings, Files, Status)
app.get("/api/dashboard", async (req, res) => {
  const dbData = readDatabase();
  const settings = dbData.settings;

  const status: SystemStatus = {
    botRunning: false,
    telegramAuthenticated: false,
    googleAuthenticated: false,
  };

  // Check Telegram Bot state
  if (settings.telegramBotToken) {
    try {
      const botInfo = await checkTelegramBotInfo(settings.telegramBotToken);
      status.telegramAuthenticated = true;
      status.botRunning = settings.isBotActive;
      status.botInfo = botInfo;
      if (process.env.APP_URL) {
        status.webhookUrl = `${process.env.APP_URL.replace(/\/$/, "")}/api/telegram/webhook`;
      }
    } catch {
      status.telegramAuthenticated = false;
    }
  }

  // Check Google connection state
  if (
    (settings.googleAuthType === "serviceAccount" && settings.googleServiceAccountKey) ||
    (settings.googleAuthType === "oauth" && settings.googleOAuthRefreshToken)
  ) {
    try {
      const authClient = getGoogleAuth(settings, req);
      const drive = google.drive({ version: "v3", auth: authClient });
      // Quick request to verify API connection is healthy
      await drive.files.list({ 
        pageSize: 1, 
        supportsAllDrives: true, 
        includeItemsFromAllDrives: true 
      } as any);
      status.googleAuthenticated = true;
    } catch (e: any) {
      status.googleAuthenticated = false;
      console.log("Verify Google Drive Failed:", e.message);
    }
  }

  res.json({
    settings: {
      ...settings,
      // Mask keys so they aren't fully exposed in client responses
      googleServiceAccountKey: settings.googleServiceAccountKey ? "PRESENTS" : "",
      googleOAuthClientSecret: settings.googleOAuthClientSecret ? "•" : "",
    },
    files: dbData.files,
    status: status,
  });
});

// Update Settings
app.post("/api/settings", async (req, res) => {
  const newSettings = req.body;
  const dbData = readDatabase();
  const currentSettings = dbData.settings;

  // Preserve masked keys if not overwritten
  let serviceKey = newSettings.googleServiceAccountKey;
  if (serviceKey === "PRESENTS") {
    serviceKey = currentSettings.googleServiceAccountKey;
  }
  let oAuthSecret = newSettings.googleOAuthClientSecret;
  if (oAuthSecret === "•") {
    oAuthSecret = currentSettings.googleOAuthClientSecret;
  }

  const updatedSettings: AppSettings = {
    telegramBotToken: newSettings.telegramBotToken || "",
    googleAuthType: newSettings.googleAuthType || "oauth",
    googleServiceAccountKey: serviceKey || "",
    googleOAuthClientId: newSettings.googleOAuthClientId || "",
    googleOAuthClientSecret: oAuthSecret || "",
    googleOAuthRefreshToken: newSettings.googleOAuthRefreshToken || currentSettings.googleOAuthRefreshToken || "",
    targetFolderId: newSettings.targetFolderId || "",
    isBotActive: typeof newSettings.isBotActive === "boolean" ? newSettings.isBotActive : false,
    expiryHours: Number(newSettings.expiryHours) || 24,
  };

  dbData.settings = updatedSettings;
  writeDatabase(dbData);

  // Restart bot on settings change
  try {
    if (updatedSettings.telegramBotToken) {
      await removeTelegramWebhook(currentSettings.telegramBotToken);
      await startupTelegramBot();
    } else {
      stopTelegramPolling();
    }
  } catch (err) {
    console.warn("Failed resetting Telegram updates on configure update:", err);
  }

  res.json({ status: "success", settings: { ...updatedSettings, googleServiceAccountKey: updatedSettings.googleServiceAccountKey ? "PRESENTS" : "" } });
});

// Verify credentials instantly
app.post("/api/verify-telegram", async (req, res) => {
  const { token } = req.body;
  try {
    const info = await checkTelegramBotInfo(token);
    res.json({ success: true, info });
  } catch (error: any) {
    res.json({ success: false, error: error.message });
  }
});

// Direct Web Dashboard upload
app.post("/api/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file was selected for upload." });
  }

  try {
    const dbData = readDatabase();
    const settings = dbData.settings;

    // Stream download from buffer to Google Drive
    const stream = require("stream");
    const bufferStream = new stream.PassThrough();
    bufferStream.end(req.file.buffer);

    const driveFile = await uploadToGoogleDrive(
      settings,
      req.file.originalname,
      req.file.mimetype,
      bufferStream,
      req.file.size
    );

    const fileIdInDb = Math.random().toString(36).substring(2, 11) + "_" + Date.now();
    const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;
    const publicUrl = `${appUrl.replace(/\/$/, "")}/download/${fileIdInDb}`;

    const uploadedHours = settings.expiryHours || 24;
    const uploadedAt = new Date();
    const expiresAt = new Date(uploadedAt.getTime() + uploadedHours * 60 * 60 * 1000);

    const newUploadedFile: UploadedFile = {
      id: fileIdInDb,
      fileName: req.file.originalname,
      fileSize: req.file.size,
      mimeType: req.file.mimetype,
      telegramUser: "Web Dashboard",
      googleFileId: driveFile.id,
      shareUrl: publicUrl,
      uploadedAt: uploadedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      isExpired: false,
    };

    dbData.files.push(newUploadedFile);
    writeDatabase(dbData);

    res.json({ success: true, file: newUploadedFile });
  } catch (error: any) {
    console.error("Direct web uploader failed on server:", error);
    res.status(500).json({ error: error.message || "Failed uploading file to Google Drive." });
  }
});

// Delete individual registered upload
app.delete("/api/files/:id", async (req, res) => {
  const fileId = req.params.id;
  const dbData = readDatabase();
  const fileIndex = dbData.files.findIndex(f => f.id === fileId);

  if (fileIndex === -1) {
    return res.status(404).json({ error: "Share item not found in records." });
  }

  const targetFile = dbData.files[fileIndex];

  try {
    // Optionally delete from Google Drive to keep things tidy
    const authClient = getGoogleAuth(dbData.settings);
    const drive = google.drive({ version: "v3", auth: authClient });
    await drive.files.delete({ fileId: targetFile.googleFileId });
  } catch (e) {
    console.warn(`File deleted in record, but unable to delete file from Drive directly: ${targetFile.googleFileId}`);
  }

  dbData.files.splice(fileIndex, 1);
  writeDatabase(dbData);
  res.json({ success: true, message: "Share item revoked, and file deleted from Google Drive." });
});

// ----------------------------------------------------
// Google Drive OAuth2 Redirect Flow Methods
// ----------------------------------------------------
app.get("/api/auth/google/url", (req, res) => {
  const dbData = readDatabase();
  const settings = dbData.settings;
  const clientId = settings.googleOAuthClientId || process.env.GOOGLE_CLIENT_ID || "";
  const clientSecret = settings.googleOAuthClientSecret || process.env.GOOGLE_CLIENT_SECRET || "";

  if (!clientId || !clientSecret) {
    return res.status(400).json({ error: "Google OAuth credentials are not fully configured in your settings." });
  }

  const redirectUri = getOAuthRedirectUri(req);
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/drive.file"],
  });

  res.json({ url: authUrl });
});

app.get("/api/auth/google/callback", async (req, res) => {
  const code = req.query.code as string;
  if (!code) {
    return res.redirect("/?error=auth_code_missing");
  }

  try {
    const dbData = readDatabase();
    const settings = dbData.settings;
    const clientId = settings.googleOAuthClientId || process.env.GOOGLE_CLIENT_ID || "";
    const clientSecret = settings.googleOAuthClientSecret || process.env.GOOGLE_CLIENT_SECRET || "";

    const redirectUri = getOAuthRedirectUri(req);
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

    const { tokens } = await oauth2Client.getToken(code);
    
    if (tokens.refresh_token) {
      settings.googleOAuthRefreshToken = tokens.refresh_token;
    }
    
    // Save tokens and update DB
    dbData.settings = settings;
    writeDatabase(dbData);

    res.redirect("/?auth_success=true");
  } catch (error: any) {
    console.error("OAuth Exchange Callback Error:", error);
    res.redirect(`/?auth_error=${encodeURIComponent(error.message)}`);
  }
});

// ----------------------------------------------------
// Telegram Webhook receiver endpoint
// ----------------------------------------------------
app.post("/api/telegram/webhook", async (req, res) => {
  try {
    await handleTelegramUpdate(req.body);
    res.status(200).send("OK");
  } catch (error) {
    console.error("Webhook processing encountered error:", error);
    res.status(200).send("OK"); // Avoid retries from TG server on operational error
  }
});

// ----------------------------------------------------
// File download proxy and viewer page
// ----------------------------------------------------
app.get("/download/:id", async (req, res) => {
  const fileId = req.params.id;
  const dbData = readDatabase();
  const fileRecord = dbData.files.find(f => f.id === fileId);

  if (!fileRecord) {
    return res.status(404).send("File Link Code is invalid or not registered.");
  }

  const expiresDate = new Date(fileRecord.expiresAt);
  const now = new Date();
  const isExpired = now.getTime() > expiresDate.getTime();

  // If expired, render uploader details with elegant notice
  if (isExpired) {
    res.setHeader("Content-Type", "text/html");
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Link Expired - TG to Drive</title>
          <script src="https://cdn.tailwindcss.com"></script>
        </head>
        <body class="bg-[#0b0f19] text-gray-200 min-h-screen flex items-center justify-center font-sans">
          <div class="max-w-md w-full mx-4 p-8 bg-[#151d30] rounded-2xl shadow-xl text-center border border-gray-800">
            <div class="w-16 h-16 bg-red-950/40 border border-red-500/30 text-red-400 rounded-full flex items-center justify-center mx-auto mb-6">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-8 h-8">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
              </svg>
            </div>
            <h1 class="text-2xl font-bold font-sans tracking-tight text-white mb-2">This link has expired</h1>
            <p class="text-gray-400 text-sm mb-6">In order to save storage, the secure public sharing link for this file expired after 24 hours.</p>
            <div class="bg-black/20 p-4 rounded-xl text-left font-mono text-xs text-gray-400 border border-gray-800 space-y-2 mb-6">
              <div><span class="text-gray-500">File:</span> ${fileRecord.fileName}</div>
              <div><span class="text-gray-500">Created:</span> ${new Date(fileRecord.uploadedAt).toLocaleString()}</div>
              <div><span class="text-gray-500">Expired:</span> ${expiresDate.toLocaleString()}</div>
            </div>
            <a href="/" class="inline-flex w-full justify-center px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-500 transition shadow">
              Open Dashboard Settings
            </a>
          </div>
        </body>
      </html>
    `);
  }

  // File is healthy - Stream downloader directly from Google Drive anonymously
  try {
    const authClient = getGoogleAuth(dbData.settings);
    const drive = google.drive({ version: "v3", auth: authClient });

    // Download Google file content stream
    const driveRes = await drive.files.get(
      { fileId: fileRecord.googleFileId, alt: "media" },
      { responseType: "stream" }
    );

    // Set appropriate streaming headers
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(fileRecord.fileName)}"`);
    res.setHeader("Content-Type", fileRecord.mimeType || "application/octet-stream");
    if (fileRecord.fileSize) {
      res.setHeader("Content-Length", fileRecord.fileSize);
    }

    driveRes.data
      .on("error", (streamErr: any) => {
        console.error("Streaming error during file pipeline transfer:", streamErr);
        if (!res.headersSent) {
          res.status(500).send("A pipeline error occurred while serving Google Drive chunks.");
        }
      })
      .pipe(res);

  } catch (error: any) {
    console.error("Proxy streaming failed from Google Drive client keys:", error);
    res.status(500).send(`Failed to read file from Google Drive: ${error.message || "Invalid Connection credentials."}`);
  }
});

// ----------------------------------------------------
// Front-end build delivery and routers fallback
// ----------------------------------------------------
async function startServer() {
  // Vite dev server implementation if not in production
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Serve production static build
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n============== RUNNING SERVER ==============\nhttp://localhost:${PORT}\n============================================\n`);
  });
}

startServer();
