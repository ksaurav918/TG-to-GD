export interface AppSettings {
  telegramBotToken: string;
  googleAuthType: 'serviceAccount' | 'oauth';
  googleServiceAccountKey: string; // JSON string
  googleOAuthClientId: string;
  googleOAuthClientSecret: string;
  googleOAuthRefreshToken: string;
  googleOAuthAccessToken?: string;
  targetFolderId: string;
  isBotActive: boolean;
  expiryHours: number; // Defaults to 24
  appUrl?: string; // Auto-detected public domain
}

export interface UploadedFile {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  telegramUser: {
    username?: string;
    firstName?: string;
    id: number;
  } | 'Web Dashboard';
  googleFileId: string;
  shareUrl: string;
  googleViewUrl?: string; // Direct public Google Drive link
  uploadedAt: string;
  expiresAt: string;
  isExpired: boolean;
}

export interface SystemStatus {
  botRunning: boolean;
  telegramAuthenticated: boolean;
  googleAuthenticated: boolean;
  botInfo?: {
    username: string;
    firstName: string;
  };
  webhookUrl?: string;
}

export interface DashboardData {
  settings: AppSettings;
  files: UploadedFile[];
  status: SystemStatus;
}
