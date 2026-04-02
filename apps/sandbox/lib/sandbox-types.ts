export const SANDBOX_PROVIDERS = ["mailgun", "resend", "aiinbx"] as const;

export type SandboxProviderId = (typeof SANDBOX_PROVIDERS)[number];

export interface SandboxProviderCapabilities {
  templates: boolean;
  scheduling: boolean;
  unsubscribe: boolean;
  trackOpens: boolean;
  trackClicks: boolean;
  sendIdempotency: boolean;
  tenantRouting: boolean;
}

export interface SandboxProviderInfo {
  id: SandboxProviderId;
  label: string;
  webhookPath: string;
  requiredEnv: string[];
  optionalEnv: string[];
  missingRequiredEnv: string[];
  missingOptionalEnv: string[];
  ready: boolean;
  defaultFromEmail: string;
  defaultToEmail: string;
  capabilities: SandboxProviderCapabilities;
}

export interface SandboxEvent {
  id: string;
  provider: SandboxProviderId;
  category: "hook" | "webhook" | "send" | "system";
  kind: string;
  summary: string;
  timestamp: string;
  details: unknown;
}

export interface SandboxTraceCorrelation {
  eventId?: string;
  messageId?: string;
  providerId?: string;
  recipient?: string;
  subject?: string;
  status?: string;
}

export interface SandboxTrace {
  id: string;
  provider: SandboxProviderId;
  summary: string;
  startedAt: string;
  updatedAt: string;
  correlation: SandboxTraceCorrelation;
  events: SandboxEvent[];
}

export interface SandboxSnapshot {
  providers: SandboxProviderInfo[];
  traces: SandboxTrace[];
  stats: {
    traces: number;
    events: number;
    send: number;
    webhook: number;
    hook: number;
  };
}

export interface SandboxSendPayload {
  provider: SandboxProviderId;
  fromEmail: string;
  fromName?: string;
  toEmail: string;
  ccEmail?: string;
  bccEmail?: string;
  subject: string;
  text?: string;
  html?: string;
  // Reply/threading
  replyToEmail?: string;
  inReplyToMessageId?: string;
  // Tracking
  trackOpens?: boolean;
  trackClicks?: boolean;
  // Scheduling
  sendAt?: string; // ISO string
  // Unsubscribe
  unsubscribeGlobal?: boolean;
  // Tags & metadata
  tags?: string[];
  metadata?: Record<string, string>;
  // Custom headers
  headers?: Record<string, string>;
  // Template
  templateId?: string;
  templateData?: Record<string, unknown>;
  // Idempotency
  idempotencyKey?: string;
  // Tenant
  tenantId?: string;
}
