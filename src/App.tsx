import * as React from "react";
import { useState, useEffect, useRef } from "react";
import { 
  CloudUpload, 
  File, 
  Folder, 
  Settings, 
  Key, 
  Copy, 
  Check, 
  Trash, 
  User, 
  Clock, 
  ExternalLink, 
  ShieldCheck, 
  AlertCircle, 
  Eye, 
  EyeOff, 
  Send, 
  RefreshCw, 
  Play, 
  Square, 
  FileText, 
  FileImage, 
  FileVideo, 
  FileAudio,
  Lock,
  Compass
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { AppSettings, UploadedFile, SystemStatus } from "./types";

export default function App() {
  const [settings, setSettings] = useState<AppSettings>({
    telegramBotToken: "",
    googleAuthType: "oauth",
    googleServiceAccountKey: "",
    googleOAuthClientId: "",
    googleOAuthClientSecret: "",
    googleOAuthRefreshToken: "",
    targetFolderId: "",
    isBotActive: false,
    expiryHours: 24,
  });

  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [status, setStatus] = useState<SystemStatus>({
    botRunning: false,
    telegramAuthenticated: false,
    googleAuthenticated: false,
  });

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [dragActive, setDragActive] = useState(false);

  // Settings visibility states
  const [showBotToken, setShowBotToken] = useState(false);
  const [showClientSecret, setShowClientSecret] = useState(false);
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedRedirect, setCopiedRedirect] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load URL query parameters on mount to check for success messages
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("auth_success") === "true") {
      showNotice("success", "Successfully linked Google Drive OAuth!");
      // Clean up URL
      window.history.replaceState({}, document.title, window.location.pathname);
    } else if (params.get("auth_error")) {
      showNotice("error", `Google Auth failed: ${params.get("auth_error")}`);
      window.history.replaceState({}, document.title, window.location.pathname);
    }
    
    // Initial load
    fetchData();
    
    // Auto-refresh stats every 8 seconds
    const interval = setInterval(fetchData, 8000);
    return () => clearInterval(interval);
  }, []);

  const fetchData = async () => {
    try {
      const response = await fetch("/api/dashboard");
      if (!response.ok) throw new Error("Failed to load dashboard payload");
      const data = await response.json();
      
      // Keep masked text in mind, but populate current settings
      setSettings(prev => ({
        ...data.settings,
        // Preserve visual inputs for masks if they were set in DB
        googleServiceAccountKey: data.settings.googleServiceAccountKey === "PRESENTS" ? "PRESENTS" : "",
        googleOAuthClientSecret: data.settings.googleOAuthClientSecret === "•" ? "•" : "",
      }));
      setFiles(data.files || []);
      setStatus(data.status || status);
    } catch (err: any) {
      console.error("Dashboard Sync Error:", err);
    } finally {
      setLoading(false);
    }
  };

  const showNotice = (type: "success" | "error", text: string) => {
    setNotice({ type, text });
    setTimeout(() => setNotice(null), 5000);
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });

      if (!response.ok) throw new Error("Failed to update config");
      const result = await response.json();
      
      showNotice("success", "System settings successfully updated!");
      await fetchData();
    } catch (error: any) {
      showNotice("error", `Failed updating settings: ${error.message}`);
    } finally {
      setSaving(false);
    }
  };

  // Google OAuth Link flow redirect
  const handleInitiateGoogleOAuth = async () => {
    // We must validate that client ID and Secret are typed before requesting URL
    if (!settings.googleOAuthClientId || !settings.googleOAuthClientSecret) {
      showNotice("error", "Please configure your Google Client ID and Client Secret first.");
      return;
    }

    try {
      // First save current values
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });

      const response = await fetch("/api/auth/google/url");
      const data = await response.json();
      if (!response.ok || !data.url) throw new Error(data.error || "No auth URL returned");
      
      // Redirect page to OAuth consent screen
      window.location.href = data.url;
    } catch (e: any) {
      showNotice("error", `Failed to start Google OAuth: ${e.message}`);
    }
  };

  // Direct Web UI drag-drop & select upload handling
  const handleFileUpload = async (file: File) => {
    if (uploading) return;
    setUploading(true);
    setUploadProgress(10);
    
    const formData = new FormData();
    formData.append("file", file);

    try {
      setUploadProgress(40);
      const res = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });

      setUploadProgress(80);
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || "Uploader error");
      }

      setUploadProgress(100);
      showNotice("success", `Successfully uploaded "${file.name}" direct to Drive!`);
      fetchData();
    } catch (err: any) {
      showNotice("error", `Upload failed: ${err.message}`);
    } finally {
      setTimeout(() => {
        setUploading(false);
        setUploadProgress(0);
      }, 800);
    }
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileUpload(e.dataTransfer.files[0]);
    }
  };

  const handleRevokeFile = async (fileId: string, fileName: string) => {
    const doubleConfirm = window.confirm(
      `Are you sure you want to revoke public sharing access for "${fileName}"? This will securely delete the file from Google Drive.`
    );
    if (!doubleConfirm) return;

    try {
      const res = await fetch(`/api/files/${fileId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Could not revoke file");
      showNotice("success", "Public link revoked and file removed from Drive.");
      fetchData();
    } catch (err: any) {
      showNotice("error", err.message || "Failed revoking link.");
    }
  };

  const handleCopyLink = (linkUrl: string, fileId: string) => {
    navigator.clipboard.writeText(linkUrl);
    setCopiedId(fileId);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const getFileIcon = (mimeType: string) => {
    const mt = mimeType.toLowerCase();
    if (mt.includes("image")) return <FileImage className="w-5 h-5 text-emerald-600" />;
    if (mt.includes("video")) return <FileVideo className="w-5 h-5 text-indigo-600" />;
    if (mt.includes("audio") || mt.includes("ogg")) return <FileAudio className="w-5 h-5 text-amber-600" />;
    if (mt.includes("pdf") || mt.includes("text") || mt.includes("document")) return <FileText className="w-5 h-5 text-sky-600" />;
    return <File className="w-5 h-5 text-blue-600" />;
  };

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#1E293B] antialiased selection:bg-blue-600/10 selection:text-blue-800 pb-16 font-sans">
      
      {/* Dynamic Status Bar/Notice Toast */}
      <AnimatePresence>
        {notice && (
          <motion.div 
            initial={{ opacity: 0, y: -40, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.95 }}
            className={`fixed right-6 top-6 z-50 flex items-center gap-3 px-5 py-3 rounded-xl border shadow-lg ${
              notice.type === "success" 
                ? "bg-emerald-50 border-emerald-200 text-emerald-800 shadow-emerald-100/40" 
                : "bg-red-50 border-red-200 text-red-850 shadow-red-100/40"
            }`}
          >
            {notice.type === "success" ? (
              <ShieldCheck className="w-5 h-5 text-emerald-600" />
            ) : (
              <AlertCircle className="w-5 h-5 text-red-600" />
            )}
            <span className="text-sm font-medium">{notice.text}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main Container */}
      <div className="max-w-6xl mx-auto px-4 pt-8">
        
        {/* Header Branding */}
        <header className="h-16 border-b border-slate-200 bg-white px-6 md:px-8 flex items-center justify-between shrink-0 rounded-xl mb-8 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-blue-600 rounded flex items-center justify-center text-white">
              <Compass className="w-5 h-5 text-white" />
            </div>
            <span className="text-lg font-bold tracking-tight uppercase text-slate-800">TeleBridge</span>
            <div className="hidden sm:flex items-center gap-2 text-xs font-semibold text-slate-400 bg-slate-100 px-2.5 py-1 rounded">
              <span className={`w-1.5 h-1.5 rounded-full ${status.telegramAuthenticated ? 'bg-green-500' : 'bg-amber-400'}`}></span> 
              SERVER {status.telegramAuthenticated ? "ONLINE" : "STANDBY"}
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right hidden md:block">
              <p className="text-[10px] uppercase font-semibold text-slate-400 leading-none">
                {status.googleAuthenticated ? "GDrive Linked" : "GDrive Status"}
              </p>
              <p className="text-xs font-semibold text-slate-600 mt-1">
                {status.googleAuthenticated ? (settings.googleAuthType === "oauth" ? "Connected via OAuth" : "Service Account Active") : "Not Configured"}
              </p>
            </div>
            <button 
              type="button"
              onClick={fetchData}
              disabled={loading}
              className="p-2 bg-slate-50 hover:bg-slate-100 rounded-lg border border-slate-200 text-slate-600 transition"
              title="Refresh Sync States"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin text-blue-600" : ""}`} />
            </button>
          </div>
        </header>

        {loading ? (
          <div className="py-24 text-center">
            <RefreshCw className="w-8 h-8 animate-spin text-blue-600 mx-auto mb-4" />
            <p className="text-slate-500 text-sm font-mono">Synchronizing cloud status...</p>
          </div>
        ) : (
          <div className="space-y-8">
            
            {/* Split Panel Settings Panel */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
              
              {/* Configuration Form (Left) */}
              <form onSubmit={handleSaveSettings} className="lg:col-span-8 space-y-6">
                
                {/* Section header */}
                <div className="bg-white rounded-xl border border-slate-200 p-6 md:p-8 space-y-8 shadow-sm">
                  <div>
                    <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2 font-display">
                      <Settings className="w-5 h-5 text-blue-600" /> Control Parameters
                    </h2>
                    <p className="text-xs text-slate-500 mt-1">Configure Telegram Webhost and Google Cloud authentication bindings.</p>
                  </div>

                  {/* Settings grid */}
                  <div className="space-y-6">
                    
                    {/* Bot Token Configuration */}
                    <div className="space-y-2">
                      <label className="text-xs font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2">
                        <span>Telegram Bot Token</span>
                      </label>
                      <div className="relative flex items-center">
                        <span className="absolute left-3 text-slate-400 text-xs font-mono select-none">TG_BOT_TOKEN</span>
                        <input
                          type={showBotToken ? "text" : "password"}
                          className="w-full pl-36 pr-12 py-3 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-800 placeholder-slate-400 focus:bg-white focus:outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-50/50 transition font-mono"
                          placeholder="0000000000:AAxxxxxxxxx..."
                          value={settings.telegramBotToken}
                          onChange={(e) => setSettings({ ...settings, telegramBotToken: e.target.value })}
                        />
                        <button
                          type="button"
                          onClick={() => setShowBotToken(!showBotToken)}
                          className="absolute right-3 text-slate-500 hover:text-slate-800 p-1"
                        >
                          {showBotToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                      
                      {status.telegramAuthenticated && status.botInfo && (
                        <div className="p-3 bg-blue-50/50 rounded-lg border border-blue-100 flex items-center justify-between text-xs text-blue-800">
                          <span className="flex items-center gap-2">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                            Bot Loaded: <b>{status.botInfo.firstName}</b> (@{status.botInfo.username})
                          </span>
                          <span className="text-slate-400 font-mono text-[11px]">status: active</span>
                        </div>
                      )}
                    </div>

                    {/* Google Authorization Selection */}
                    <div className="space-y-3">
                      <label className="text-xs font-bold text-slate-500 uppercase tracking-widest">
                        Google Authenticity Method
                      </label>
                      <div className="grid grid-cols-2 gap-3">
                        <button
                          type="button"
                          onClick={() => setSettings({ ...settings, googleAuthType: "oauth" })}
                          className={`p-3 rounded-lg border text-sm font-semibold flex items-center justify-center gap-2 transition duration-200 ${
                            settings.googleAuthType === "oauth"
                              ? "bg-blue-50 border-blue-200 text-blue-750 font-bold"
                              : "bg-slate-50/50 border-slate-200 text-slate-500 hover:text-slate-750 hover:bg-slate-50"
                          }`}
                        >
                          <Lock className="w-4 h-4" /> Google OAuth 2.0
                        </button>
                        <button
                          type="button"
                          onClick={() => setSettings({ ...settings, googleAuthType: "serviceAccount" })}
                          className={`p-3 rounded-lg border text-sm font-semibold flex items-center justify-center gap-2 transition duration-200 ${
                            settings.googleAuthType === "serviceAccount"
                              ? "bg-blue-50 border-blue-200 text-blue-750 font-bold"
                              : "bg-slate-50/50 border-slate-200 text-slate-500 hover:text-slate-750 hover:bg-slate-50"
                          }`}
                        >
                          <Key className="w-4 h-4" /> Service Account JSON
                        </button>
                      </div>
                    </div>

                    {/* Conditional Auth Subpanels */}
                    <AnimatePresence mode="wait">
                      {settings.googleAuthType === "oauth" ? (
                        <motion.div
                          key="oauth-panel"
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -10 }}
                          transition={{ duration: 0.15 }}
                          className="space-y-4 p-4 bg-slate-50/50 rounded-xl border border-slate-200"
                        >
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="space-y-1.5">
                              <span className="text-xs font-semibold text-slate-550">Client ID</span>
                              <input
                                type="text"
                                className="w-full p-2.5 bg-white border border-slate-200 rounded-lg text-xs text-slate-800 placeholder-slate-400 font-mono focus:outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-50/20"
                                placeholder="Your Client ID..."
                                value={settings.googleOAuthClientId}
                                onChange={(e) => setSettings({ ...settings, googleOAuthClientId: e.target.value })}
                              />
                            </div>
                            <div className="space-y-1.5">
                              <span className="text-xs font-semibold text-slate-550">Client Secret</span>
                              <div className="relative flex items-center">
                                <input
                                  type={showClientSecret ? "text" : "password"}
                                  className="w-full p-2.5 bg-white border border-slate-200 rounded-lg text-xs text-slate-800 placeholder-slate-400 font-mono pr-10 focus:outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-50/20"
                                  placeholder="Your Client Secret..."
                                  value={settings.googleOAuthClientSecret}
                                  onChange={(e) => setSettings({ ...settings, googleOAuthClientSecret: e.target.value })}
                                />
                                <button
                                  type="button"
                                  onClick={() => setShowClientSecret(!showClientSecret)}
                                  className="absolute right-2 text-slate-400 hover:text-slate-600 p-1"
                                >
                                  {showClientSecret ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                                </button>
                              </div>
                            </div>
                          </div>

                          {/* OAuth Callback Redirect Helper */}
                          <div className="bg-blue-50/75 border border-blue-200/60 rounded-xl p-3.5 space-y-2 text-xs text-blue-850">
                            <span className="block font-bold text-blue-900">Google OAuth Redirect Assistant</span>
                            <p className="text-blue-700 leading-relaxed">
                              If you see <b>Error 400: redirect_uri_mismatch</b>, copy the exact URI below and paste it in your <b>Authorized redirect URIs</b> list inside your Google Developer Cloud Console.
                            </p>
                            <div className="flex gap-2 items-center mt-1">
                              <input
                                type="text"
                                readOnly
                                value={typeof window !== "undefined" ? `${window.location.origin}/api/auth/google/callback` : ""}
                                className="flex-1 p-2 bg-white border border-blue-200 rounded-lg text-xs font-mono select-all focus:outline-none"
                              />
                              <button
                                type="button"
                                onClick={() => {
                                  if (typeof window !== "undefined") {
                                    navigator.clipboard.writeText(`${window.location.origin}/api/auth/google/callback`);
                                    setCopiedRedirect(true);
                                    setTimeout(() => setCopiedRedirect(false), 2000);
                                  }
                                }}
                                className="px-3.5 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-semibold text-xs transition duration-150 shadow-sm min-w-[75px] text-center cursor-pointer"
                              >
                                {copiedRedirect ? "Copied!" : "Copy"}
                              </button>
                            </div>
                          </div>

                          <div className="pt-2 border-t border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-4">
                            <div className="text-xs text-slate-600">
                              <span className="block font-semibold">OAuth Linking Status</span>
                              {status.googleAuthenticated ? (
                                <span className="text-emerald-600 font-semibold flex items-center gap-1.5 mt-0.5 animate-pulse">
                                  ✓ Connected (Refresh token active)
                                </span>
                              ) : (
                                <span className="text-red-5400 font-semibold flex items-center gap-1.5 mt-0.5">
                                  ⚠️ Not linked or requires re-authentication
                                </span>
                              )}
                            </div>
                            <button
                              type="button"
                              onClick={handleInitiateGoogleOAuth}
                              className="px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-xs rounded-lg transition duration-150 shadow-sm flex items-center justify-center gap-2 cursor-pointer"
                            >
                              <ExternalLink className="w-3.5 h-3.5" /> Connect Google Account
                            </button>
                          </div>
                        </motion.div>
                      ) : (
                        <motion.div
                          key="sa-panel"
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -10 }}
                          transition={{ duration: 0.15 }}
                          className="space-y-2 p-4 bg-slate-50/50 rounded-xl border border-slate-200"
                        >
                          <span className="text-xs font-bold text-slate-500">Service Account Credential Key JSON</span>
                          <textarea
                            rows={4}
                            className="w-full p-3 bg-white border border-slate-200 rounded-lg text-xs text-slate-800 placeholder-slate-400 font-mono focus:outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-50/20 max-h-56 h-36"
                            placeholder='{"type": "service_account", "project_id": "...", "private_key": "..."}'
                            value={settings.googleServiceAccountKey === "PRESENTS" ? "•••••••••••• Fully Configured on Server ••••••••••••" : settings.googleServiceAccountKey}
                            onChange={(e) => setSettings({ ...settings, googleServiceAccountKey: e.target.value })}
                            onClick={() => {
                              if (settings.googleServiceAccountKey === "PRESENTS") {
                                setSettings({ ...settings, googleServiceAccountKey: "" });
                              }
                            }}
                          />
                          <p className="text-[11px] text-slate-400 select-none">
                            Provide the full JSON credentials containing your private key. The service account will upload files direct to Google Drive.
                          </p>
                        </motion.div>
                      )}
                    </AnimatePresence>

                    {/* Additional Sub configurations */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      
                      {/* Custom Link Expiration slider */}
                      <div className="space-y-2">
                        <label className="text-xs font-bold text-slate-500 uppercase tracking-widest flex items-center justify-between">
                          <span>Link Expiration Duration</span>
                          <span className="text-blue-600 font-mono font-bold">{settings.expiryHours} Hours</span>
                        </label>
                        <input
                          type="range"
                          min="1"
                          max="168"
                          className="w-full h-1.5 bg-slate-100 rounded-lg appearance-none cursor-pointer accent-blue-600"
                          value={settings.expiryHours}
                          onChange={(e) => setSettings({ ...settings, expiryHours: Number(e.target.value) })}
                        />
                        <div className="flex justify-between text-[10px] text-slate-400 font-mono">
                          <span>1 hr (Express)</span>
                          <span>24 hr (Default)</span>
                          <span>7 Days (Max)</span>
                        </div>
                      </div>

                      {/* Parent Folder ID string */}
                      <div className="space-y-2">
                        <label className="text-xs font-bold text-slate-500 uppercase tracking-wider block">
                          Target Google Drive Folder ID (Optional)
                        </label>
                        <input
                          type="text"
                          className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-800 placeholder-slate-400 focus:bg-white focus:outline-none focus:border-blue-500 font-mono focus:ring-4 focus:ring-blue-50/20"
                          placeholder="e.g. 1A_2xyz_3abcde12345 (Root Drive if blank)"
                          value={settings.targetFolderId}
                          onChange={(e) => setSettings({ ...settings, targetFolderId: e.target.value })}
                        />
                      </div>

                    </div>

                    {/* Bot active status control toggle switch */}
                    <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 flex items-center justify-between gap-4">
                      <div>
                        <span className="text-sm font-bold text-slate-800 block">Bot Engine Active</span>
                        <span className="text-xs text-slate-500">Toggle whether the bot uploader answers incoming Telegram documents.</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSettings({ ...settings, isBotActive: !settings.isBotActive })}
                        className={`w-14 h-8 flex items-center rounded-full p-1 transition-colors duration-250 focus:outline-none cursor-pointer ${
                          settings.isBotActive ? "bg-blue-600" : "bg-slate-200"
                        }`}
                      >
                        <motion.div
                          layout
                          className="bg-white w-6 h-6 rounded-full shadow-sm"
                          transition={{ type: "spring", stiffness: 500, damping: 30 }}
                          style={{ marginLeft: settings.isBotActive ? "24px" : "0px" }}
                        />
                      </button>
                    </div>

                  </div>

                  {/* Submission and Status Save elements */}
                  <div className="pt-6 border-t border-slate-150 flex justify-end gap-3">
                    <button
                      type="submit"
                      disabled={saving}
                      className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl transition duration-150 active:scale-97 shadow-sm flex items-center gap-2 cursor-pointer"
                    >
                      {saving ? (
                        <>
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Saving...
                        </>
                      ) : (
                        "Save System Configuration"
                      )}
                    </button>
                  </div>
                </div>

              </form>

              {/* Direct Drag & Drop Upload Portal (Right) */}
              <div className="lg:col-span-4 space-y-6">
                
                {/* Stats & Quick Overview Card */}
                <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm space-y-6">
                  <h3 className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Storage Overview</h3>
                  <div className="space-y-4">
                    <div className="flex justify-between items-end">
                      <span className="text-3xl font-light text-slate-800">
                        {status.googleAuthenticated ? "100" : "0"}<span className="text-lg">%</span>
                      </span>
                      <span className="text-xs text-slate-400 font-medium">
                        {status.googleAuthenticated ? "Cloud Ready" : "Unlinked"}
                      </span>
                    </div>
                    <div className="w-full bg-slate-100 h-1.5 rounded-full overflow-hidden">
                      <div className={`h-full ${status.googleAuthenticated ? 'bg-blue-600' : 'bg-slate-300'}`} style={{ width: status.googleAuthenticated ? "100%" : "0%" }}></div>
                    </div>
                    <p className="text-xs text-slate-500">
                      {status.googleAuthenticated ? "Secure direct link tunnel is active." : "Set up Google credentials to link your cloud drive."}
                    </p>
                  </div>

                  <div className="pt-4 border-t border-slate-200 space-y-4">
                    <h3 className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Quick Stats</h3>
                    <div className="space-y-3">
                      <div className="flex justify-between items-center text-sm">
                        <span className="text-slate-600 font-medium">Active Links</span>
                        <span className="font-mono font-bold text-slate-800 bg-slate-100 px-2 py-0.5 rounded text-xs">{files.length}</span>
                      </div>
                      <div className="flex justify-between items-center text-sm">
                        <span className="text-slate-600 font-medium">Google Drive API</span>
                        <span className={`font-mono text-xs font-bold ${status.googleAuthenticated ? "text-emerald-600" : "text-amber-500"}`}>
                          {status.googleAuthenticated ? "Verified" : "Offline"}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="pt-4 border-t border-slate-200">
                    <div className="p-4 bg-slate-50 rounded-lg">
                      <p className="text-[10.5px] font-bold text-slate-400 uppercase mb-2">Bot Profile Link</p>
                      <div className="flex items-center gap-3">
                        <div className={`w-2.5 h-2.5 rounded-full ${status.telegramAuthenticated ? 'bg-green-500' : 'bg-slate-300'}`}></div>
                        <span className="text-sm font-semibold text-slate-705">
                          {status.botInfo?.username ? `@${status.botInfo.username}` : "Bot Disconnected"}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Drag zone card */}
                <div 
                  onDragEnter={handleDrag}
                  onDragOver={handleDrag}
                  onDragLeave={handleDrag}
                  onDrop={handleDrop}
                  className={`bg-white rounded-xl border border-dashed p-6 md:p-8 flex flex-col items-center justify-center text-center transition-all duration-200 h-64 relative overflow-hidden ${
                    dragActive 
                      ? "border-blue-500 bg-blue-50/50" 
                      : status.googleAuthenticated 
                        ? "border-slate-300 hover:border-slate-400 bg-slate-50/30" 
                        : "border-slate-250 opacity-60 pointer-events-none"
                  }`}
                >
                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={(e) => {
                      if (e.target.files && e.target.files[0]) {
                        handleFileUpload(e.target.files[0]);
                      }
                    }}
                    className="hidden"
                  />

                  {uploading ? (
                    <div className="space-y-4 w-full">
                      <div className="p-4 bg-blue-50 border border-blue-100 rounded-full w-14 h-14 flex items-center justify-center mx-auto mb-2 animate-bounce">
                        <CloudUpload className="w-6 h-6 text-blue-600" />
                      </div>
                      <div>
                        <h3 className="text-sm font-bold text-slate-800">Transmitting file chunk...</h3>
                        <p className="text-xs text-slate-550 mt-0.5">Pushing straight into Google Drive storage API</p>
                      </div>
                      
                      {/* Loader progress */}
                      <div className="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
                        <motion.div 
                          className="bg-blue-600 h-full rounded-full"
                          initial={{ width: "0%" }}
                          animate={{ width: `${uploadProgress}%` }}
                          transition={{ duration: 0.3 }}
                        />
                      </div>
                      <span className="text-xs text-blue-600 font-mono font-bold">{uploadProgress}% Complete</span>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div className="p-4 bg-slate-100/70 border border-slate-200 rounded-full w-14 h-14 flex items-center justify-center mx-auto mb-2 text-slate-500">
                        <CloudUpload className="w-6 h-6" />
                      </div>
                      <div>
                        <h3 className="text-sm font-bold text-slate-800">Drag &amp; Drop Test Upload</h3>
                        <p className="text-xs text-slate-500 mt-1 max-w-[200px] mx-auto leading-relaxed">
                          {!status.googleAuthenticated 
                            ? "Configure your Google Drive authentication keys first to upload files." 
                            : "Drop any physical file here to generate an instant 24h cloud access key."
                          }
                        </p>
                      </div>
                      {status.googleAuthenticated && (
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="px-4 py-2 bg-white border border-slate-200 hover:bg-slate-50 text-slate-600 font-bold text-xs rounded-lg transition duration-150 cursor-pointer shadow-sm"
                        >
                          Select Local File
                        </button>
                      )}
                    </div>
                  )}
                </div>

              </div>

            </div>

            {/* Expiring Files Storage Table (Bottom) */}
            <div className="bg-white rounded-xl border border-slate-200 p-6 md:p-8 space-y-6 shadow-sm">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                    <Clock className="w-5 h-5 text-blue-600" /> Active Expiring Shares
                  </h2>
                  <p className="text-xs text-slate-500 mt-1">Files currently active and viewable by the public.</p>
                </div>
                
                <span className="px-3 py-1 bg-slate-50 border border-slate-200 text-xs text-slate-600 font-bold rounded-full self-start">
                  Total Items: {files.length}
                </span>
              </div>

              {files.length === 0 ? (
                <div className="py-16 text-center border border-dashed border-slate-200 rounded-xl bg-slate-50/30 select-none">
                  <File className="w-12 h-12 text-slate-350 mx-auto mb-3" />
                  <p className="text-sm text-slate-500 font-bold">No active files listed in the database</p>
                  <p className="text-xs text-slate-400 mt-1">Send a file to your Telegram bot or drop a file in the tester box to load sharing details!</p>
                </div>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-slate-150 bg-white">
                  <table className="w-full text-left text-xs min-w-[700px] border-collapse animate-fade-in">
                    <thead className="bg-[#f8fafc] border-b border-slate-150 text-[10px] uppercase font-bold text-slate-400 tracking-wider">
                      <tr>
                        <th className="p-4">File Specs</th>
                        <th className="p-4">Size</th>
                        <th className="p-4">Acquisition Route</th>
                        <th className="p-4">Validity Time Limits</th>
                        <th className="p-4 text-right">Settings</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 font-sans">
                      {files.map((file) => (
                        <motion.tr 
                          key={file.id} 
                          layout
                          className="hover:bg-slate-50/50 transition duration-155"
                        >
                          {/* File Details */}
                          <td className="p-4">
                            <div className="flex items-center gap-3">
                              <div className="p-2 bg-slate-100 rounded-lg border border-slate-200/65">
                                {getFileIcon(file.mimeType)}
                              </div>
                              <div className="max-w-xs md:max-w-md">
                                <span className="block font-bold text-slate-850 truncate text-sm" title={file.fileName}>
                                  {file.fileName}
                                </span>
                                <span className="block text-[10px] text-slate-400 font-mono mt-0.5">
                                  ID: {file.googleFileId.substring(0, 10)}...
                                </span>
                              </div>
                            </div>
                          </td>

                          {/* Byte size */}
                          <td className="p-4 font-mono text-slate-600 font-semibold">
                            {(file.fileSize / (1024 * 1024)).toFixed(2)} MB
                          </td>

                          {/* Sender User */}
                          <td className="p-4">
                            {file.telegramUser === "Web Dashboard" ? (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold bg-slate-100 border border-slate-200 text-blue-600">
                                🖥️ {file.telegramUser}
                              </span>
                            ) : (
                              <div className="flex flex-col">
                                <span className="font-bold text-slate-700 flex items-center gap-1">
                                  <User className="w-3.5 h-3.5 text-slate-450" />
                                  {typeof file.telegramUser === "object" && file.telegramUser ? (file.telegramUser.firstName || "Anonymous") : "Anonymous"}
                                </span>
                                {typeof file.telegramUser === "object" && file.telegramUser && file.telegramUser.username && (
                                  <span className="text-[10px] text-slate-400 font-mono mt-0.5">
                                    @{file.telegramUser.username}
                                  </span>
                                )}
                              </div>
                            )}
                          </td>

                          {/* Count-down clock and exipiresAt */}
                          <td className="p-4">
                            <CountdownField targetDate={file.expiresAt} />
                          </td>

                          {/* Copy Link & Delete Operations */}
                          <td className="p-4">
                            <div className="flex items-center justify-end gap-2">
                              <button
                                onClick={() => handleCopyLink(file.shareUrl, file.id)}
                                className={`p-2 rounded-lg border transition duration-155 flex items-center gap-1.5 cursor-pointer ${
                                  copiedId === file.id
                                    ? "bg-emerald-50 border-emerald-250 text-emerald-700 font-bold"
                                    : "bg-white border-slate-200 hover:bg-slate-50 text-slate-600 active:scale-95"
                                }`}
                                title="Copy public share key"
                              >
                                {copiedId === file.id ? (
                                  <>
                                    <Check className="w-3.5 h-3.5" /> <span className="text-[10px] font-bold">Copied</span>
                                  </>
                                ) : (
                                  <>
                                    <Copy className="w-3.5 h-3.5" /> <span className="text-[10px] font-bold">Copy Link</span>
                                  </>
                                )}
                              </button>

                              {file.googleFileId && (
                                <a
                                  href={file.googleViewUrl || `https://drive.google.com/open?id=${file.googleFileId}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="p-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-blue-600 transition duration-155 flex items-center gap-1.5 cursor-pointer"
                                  title="Open directly in Google Drive"
                                >
                                  <ExternalLink className="w-3.5 h-3.5" /> <span className="text-[10px] font-bold text-nowrap">Drive Link</span>
                                </a>
                              )}
                              
                              <button
                                onClick={() => handleRevokeFile(file.id, file.fileName)}
                                className="p-2 bg-red-50 border border-red-200/55 hover:bg-red-100 text-red-650 hover:text-red-700 rounded-lg transition duration-150 active:scale-95 cursor-pointer"
                                title="Revoke access instantly"
                              >
                                <Trash className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </motion.tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

          </div>
        )}
        
        {/* Footer info branding */}
        <footer className="mt-16 text-center text-[10.5px] uppercase tracking-wider text-slate-400 font-medium select-none">
          <p>© {new Date().getFullYear()} TeleBridge Direct Hub • Google Drive API Enabled • Telegram Bot Active</p>
        </footer>

      </div>
    </div>
  );
}

// Separate component for countdown to prevent full App re-renders every 1 second
function CountdownField({ targetDate }: { targetDate: string }) {
  const [timeLeft, setTimeLeft] = useState("");
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    const updateCountdown = () => {
      const now = new Date().getTime();
      const exp = new Date(targetDate).getTime();
      const difference = exp - now;

      if (difference <= 0) {
        setExpired(true);
        setTimeLeft("00h 00m 00s");
        return;
      }

      const hours = Math.floor(difference / (1000 * 60 * 60));
      const minutes = Math.floor((difference % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((difference % (1000 * 60)) / 1000);

      const hourStr = hours.toString().padStart(2, "0");
      const minStr = minutes.toString().padStart(2, "0");
      const secStr = seconds.toString().padStart(2, "0");

      setTimeLeft(`${hourStr}h ${minStr}m ${secStr}s`);
    };

    updateCountdown();
    const interval = setInterval(updateCountdown, 1000);
    return () => clearInterval(interval);
  }, [targetDate]);

  return (
    <div className="flex flex-col">
      <span className={`font-mono text-sm font-bold flex items-center gap-1.5 ${expired ? "text-red-600" : "text-slate-800"}`}>
        <Clock className="w-3.5 h-3.5 text-blue-600 animate-pulse" />
        {timeLeft}
      </span>
      <span className="text-[10px] text-slate-400 font-mono mt-0.5">
        expires: {new Date(targetDate).toLocaleTimeString()}
      </span>
    </div>
  );
}
