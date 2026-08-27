require('dotenv').config();

// Parses an optional positive-integer env var, falling back to defaultValue
// when unset/empty. Fails fast and clearly (rather than silently coercing to
// NaN, which the pre-existing parseInt(... || 'default', 10) calls below
// this function would do) if the value is set but not a valid positive
// integer.
function parsePositiveInt(name, rawValue, defaultValue) {
  if (rawValue === undefined || rawValue === '') return defaultValue;
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: must be a positive integer, got "${rawValue}"`);
  }
  return parsed;
}

module.exports = {
  port: process.env.PORT || 3000,
  supabase: {
    url: process.env.GLOBAL_SUPABASE_URL,
    serviceKey: process.env.GLOBAL_SUPABASE_SERVICE_ROLE_KEY || process.env.GLOBAL_SUPABASE_SERVICE_KEY,
    anonKey: process.env.GLOBAL_SUPABASE_ANON_KEY,
  },
  // Slack OAuth v2 (Architecture Review Phase 4, Milestone 3). appId/appSecret
  // (the old SLACK_APP_ID/SLACK_APP_SECRET vars) are gone along with the
  // retired /auth/slack/{start,callback} flow — see routes/auth.js.
  // signingSecret is read here for discoverability/future use (the Slack
  // Events endpoint, not built in this milestone); the OAuth connect/
  // callback flow itself does not use it.
  slack: {
    clientId: process.env.SLACK_CLIENT_ID,
    clientSecret: process.env.SLACK_CLIENT_SECRET,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    redirectUri: process.env.SLACK_REDIRECT_URI,
    // Architecture Review Phase 4, Milestone 4 — max normalized question
    // length forwarded to AIKB from an app_mention (services/slackQuestionService.js).
    questionMaxLength: parseInt(process.env.SLACK_QUESTION_MAX_LENGTH || '2000', 10),
  },
  // Architecture Review Phase 4, Milestone 4 (§4.10) — a small, additive
  // HMAC-signed envelope scoped ONLY to POST /api/knowledge/ask (Relativity
  // -> AIKB) and POST /api/integrations/slack/deliver (AIKB -> Relativity,
  // reversed). Distinct from AIKB_API_KEY (unchanged, still gates every
  // other AIKB route) and from SLACK_SIGNING_SECRET (Slack<->Relativity
  // only). This is NOT the full future signed ServiceRequest envelope
  // (Phase 2 §10) — see services/serviceRequestAuth.js.
  serviceRequest: {
    signingSecret: process.env.SERVICE_REQUEST_SIGNING_SECRET,
  },
  // Provider-neutral OAuth credential encryption (starts with Slack, applies
  // to every future provider on oauth_connections/oauth_credentials).
  // Exposed here for discoverability/status checks only — the encryption
  // service (services/integrationCredentialEncryption.js) reads
  // process.env directly rather than this cached value, so a key rotation
  // or misconfiguration is caught at the moment of use, not only at
  // server-start time — see that file for details, including its
  // temporary deprecated fallback to SLACK_TOKEN_ENCRYPTION_KEY.
  integrationCredentials: {
    encryptionKey: process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY,
  },
  // Google Drive Picker only (browser-side, one-shot copy import — see
  // routes/api.js's /google-drive/picker-config and /google-drive/import).
  // Backlog M15 removed the separate persistent-OAuth-connection flow that
  // used to also live here (clientSecret/redirectUri for a server-side
  // token exchange) — the Picker needs neither.
  googleDrive: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    pickerApiKey: process.env.GOOGLE_PICKER_API_KEY,
  },
  // Gmail OAuth per member (EM2 — Architecture/architecture/EMAIL_INGESTION.md).
  // Distinct from googleDrive above: this is a real server-side
  // authorization-code exchange (needs a client secret), not the Picker's
  // browser-only flow. Reuses the existing generic
  // INTEGRATION_CREDENTIAL_ENCRYPTION_KEY — no separate encryption key.
  gmail: {
    clientId: process.env.GMAIL_CLIENT_ID,
    clientSecret: process.env.GMAIL_CLIENT_SECRET,
    redirectUri: process.env.GMAIL_REDIRECT_URI,
  },
  appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:3000',
  // Backlog M6 — explicit CORS allowlist (middleware/corsPolicy.js).
  // Comma-separated list of additional origins allowed to make
  // browser-based cross-origin requests to this API (e.g. a staging
  // domain). appBaseUrl is always allowed and does not need to be repeated
  // here.
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  email: {
    resendApiKey: process.env.RESEND_API_KEY,
    smtpHost: process.env.SMTP_HOST,
    smtpPort: parseInt(process.env.SMTP_PORT || '587', 10),
    smtpUser: process.env.SMTP_USER,
    smtpPass: process.env.SMTP_PASS,
    leadNotificationEmail: process.env.LEAD_NOTIFICATION_EMAIL,
    fromAddress: process.env.EMAIL_FROM || 'noreply@relativitysystems.ai',
    // EM6/EM7 (services/emailSyncService.js) — one page of historical import,
    // or one page of history-diff processing, per POST /sync call (bounded
    // per request — Vercel timeout, §17 item 3).
    historicalSyncPageSize: parsePositiveInt('EMAIL_HISTORICAL_SYNC_PAGE_SIZE', process.env.EMAIL_HISTORICAL_SYNC_PAGE_SIZE, 25),
    // EM5 (services/emailPreviewService.js) — one Gmail messages.get round
    // trip per candidate in the label-query dry-run preview.
    previewPageSize: parsePositiveInt('EMAIL_PREVIEW_PAGE_SIZE', process.env.EMAIL_PREVIEW_PAGE_SIZE, 10),
    // EM8 added tickIntervalMs/tickMaxConnections here for the automatic-sync
    // tick handler; both removed in EM10.6 along with Automatic Email
    // Ingestion itself (EMAIL_SYNC_TICK_INTERVAL_MS/EMAIL_SYNC_TICK_MAX_CONNECTIONS
    // are no longer read anywhere in this repo — see EMAIL_INGESTION.md's
    // EM10.6 record).
    // EL2 (Architecture/architecture/LIVE_EMAIL_LOOKUP.md §4) — hard,
    // server-side caps for the read-only search_email_messages/
    // get_email_content tools, enforced by
    // services/emailToolValidation.js. These are ceilings, not
    // model-adjustable defaults: a tool-call argument requesting more than
    // the max is rejected, never silently clamped past it.
    liveLookup: {
      maxResultsPerSearch: parsePositiveInt('EMAIL_LIVE_LOOKUP_MAX_RESULTS', process.env.EMAIL_LIVE_LOOKUP_MAX_RESULTS, 25),
      defaultResultsPerSearch: parsePositiveInt('EMAIL_LIVE_LOOKUP_DEFAULT_RESULTS', process.env.EMAIL_LIVE_LOOKUP_DEFAULT_RESULTS, 10),
      maxMessagesPerThread: parsePositiveInt('EMAIL_LIVE_LOOKUP_MAX_THREAD_MESSAGES', process.env.EMAIL_LIVE_LOOKUP_MAX_THREAD_MESSAGES, 20),
      defaultMessagesPerThread: parsePositiveInt('EMAIL_LIVE_LOOKUP_DEFAULT_THREAD_MESSAGES', process.env.EMAIL_LIVE_LOOKUP_DEFAULT_THREAD_MESSAGES, 5),
      // EL4 (§4, §7, §9) — hard, server-side content-size and timeout caps
      // for search_email_messages/get_email_content, enforced by
      // services/emailLiveLookupService.js. Not model-adjustable.
      snippetMaxChars: parsePositiveInt('EMAIL_LIVE_LOOKUP_SNIPPET_MAX_CHARS', process.env.EMAIL_LIVE_LOOKUP_SNIPPET_MAX_CHARS, 200),
      bodyMaxChars: parsePositiveInt('EMAIL_LIVE_LOOKUP_BODY_MAX_CHARS', process.env.EMAIL_LIVE_LOOKUP_BODY_MAX_CHARS, 3000),
      searchTimeoutMs: parsePositiveInt('EMAIL_LIVE_LOOKUP_SEARCH_TIMEOUT_MS', process.env.EMAIL_LIVE_LOOKUP_SEARCH_TIMEOUT_MS, 8000),
      contentTimeoutMs: parsePositiveInt('EMAIL_LIVE_LOOKUP_CONTENT_TIMEOUT_MS', process.env.EMAIL_LIVE_LOOKUP_CONTENT_TIMEOUT_MS, 10000),
      // Fallback org-wide max-historical-days bound when a client has no
      // enabled organization policy rules yet — mirrors
      // emailPolicyService.js's own DEFAULT_MAX_HISTORICAL_DAYS (90),
      // duplicated rather than imported since config/ has no service deps.
      defaultMaxHistoricalDays: 90,
      // EL9 (§8.3, §7) — the per-connection tool-call budget
      // (services/emailLiveLookupService.js's in-memory sliding window).
      // Shared across search_email_messages/get_email_content — a cost/
      // abuse backstop, not a business limit; both are generous enough
      // that a real user should never hit them in normal use.
      rateLimitWindowMs: parsePositiveInt('EMAIL_LIVE_LOOKUP_RATE_LIMIT_WINDOW_MS', process.env.EMAIL_LIVE_LOOKUP_RATE_LIMIT_WINDOW_MS, 5 * 60 * 1000),
      rateLimitMaxCallsPerWindow: parsePositiveInt('EMAIL_LIVE_LOOKUP_RATE_LIMIT_MAX_CALLS', process.env.EMAIL_LIVE_LOOKUP_RATE_LIMIT_MAX_CALLS, 20),
    },
  },
  aikb: {
    apiBaseUrl: process.env.AIKB_API_BASE_URL,
    apiKey: process.env.AIKB_API_KEY,
    supabaseUrl: process.env.AIKB_SUPABASE_URL,
    supabaseServiceRoleKey: process.env.AIKB_SUPABASE_SERVICE_ROLE_KEY,
    storageBucket: process.env.AIKB_STORAGE_BUCKET || 'aikb-documents',
    // Architecture Review Phase 4, Milestone 4 — timeout for the fast
    // accept-and-enqueue call to POST /api/knowledge/ask made synchronously
    // inside the Slack /events handler, before acking Slack (services/aikbAskClient.js).
    askTimeoutMs: parseInt(process.env.AIKB_ASK_TIMEOUT_MS || '4000', 10),
    // ADR-007 — best-effort callback to AIKB's POST /api/knowledge/chat/redact
    // once a Slack event reaches the terminal delivery_failed state
    // (services/aikbRedactClient.js). Deliberately short: this call happens
    // after the delivery outcome is already decided, never blocking it.
    redactTimeoutMs: parseInt(process.env.AIKB_REDACT_TIMEOUT_MS || '4000', 10),
  },
  // ADR-007 — bounded, immediate Slack delivery retries, replacing the
  // removed scheduled sweep (services/retryWithBackoff.js). Every retry
  // happens synchronously within the request/flow that triggered it; no
  // background job or scheduler ever revisits a Slack event. See
  // roadmap/FEATURE_BACKLOG.md item H5.
  slackDelivery: {
    maxAttempts: parseInt(process.env.SLACK_DELIVERY_MAX_ATTEMPTS || '3', 10),
    backoffMs: (process.env.SLACK_DELIVERY_BACKOFF_MS || '2000,5000')
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n >= 0),
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    // Voice-transcription model pair (services/openaiService.js#transcribeAudio).
    // primary is tried first; fallback is used only if primary 404s / reports
    // model_not_found / the error message mentions "model" (isModelUnavailableError).
    transcribePrimaryModel: process.env.OPENAI_TRANSCRIBE_PRIMARY_MODEL || 'gpt-4o-mini-transcribe',
    transcribeFallbackModel: process.env.OPENAI_TRANSCRIBE_FALLBACK_MODEL || 'whisper-1',
  },
  // Backlog M6 — general-purpose rate limiting (middleware/rateLimiters.js,
  // routes/auth.js's password-reset limiter). See architecture/SECURITY.md
  // and roadmap/FEATURE_BACKLOG.md H6 for the in-memory-store limitation
  // these thresholds operate under (not addressed by this config change).
  rateLimits: {
    // routes/admin.js#POST /login — a single shared admin password, so this
    // guards against brute-forcing it.
    adminLogin: {
      windowMs: parsePositiveInt('ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS', process.env.ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
      max: parsePositiveInt('ADMIN_LOGIN_RATE_LIMIT_MAX', process.env.ADMIN_LOGIN_RATE_LIMIT_MAX, 10),
    },
    // Shared by routes/team.js#GET /team/invites/verify and
    // routes/auth.js#POST /complete-invite — same unauthenticated
    // token-guessing threat model.
    teamInvite: {
      windowMs: parsePositiveInt('TEAM_INVITE_RATE_LIMIT_WINDOW_MS', process.env.TEAM_INVITE_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
      max: parsePositiveInt('TEAM_INVITE_RATE_LIMIT_MAX', process.env.TEAM_INVITE_RATE_LIMIT_MAX, 30),
    },
    // routes/auth.js#POST /password-reset/request's hand-rolled in-memory
    // limiter (_isResetRateLimited) — a distinct mechanism from the
    // express-rate-limit-backed limiters above, but the same kind of
    // tunable threshold.
    passwordReset: {
      windowMs: parsePositiveInt('PASSWORD_RESET_RATE_LIMIT_WINDOW_MS', process.env.PASSWORD_RESET_RATE_LIMIT_WINDOW_MS, 10 * 60 * 1000),
      maxAttempts: parsePositiveInt('PASSWORD_RESET_RATE_LIMIT_MAX_ATTEMPTS', process.env.PASSWORD_RESET_RATE_LIMIT_MAX_ATTEMPTS, 3),
    },
  },
  limits: {
    maxDocuments: parseInt(process.env.MAX_DOCUMENTS || '50', 10),
    maxMonthlyQuestions: parseInt(process.env.MAX_MONTHLY_QUESTIONS || '500', 10),
    maxStorageMb: parseInt(process.env.MAX_STORAGE_MB || '500', 10),
    maxFileSizeMb: parseInt(process.env.MAX_FILE_SIZE_MB || '20', 10),
    maxAudioSizeMb: parseInt(process.env.MAX_AUDIO_SIZE_MB || '10', 10),
    maxZipSizeMb: parseInt(process.env.MAX_ZIP_SIZE_MB || '50', 10),
    maxZipFiles: parseInt(process.env.MAX_ZIP_FILES || '100', 10),
    maxZipEntryMb: parseInt(process.env.MAX_ZIP_ENTRY_MB || '20', 10),
    maxZipTotalMb: parseInt(process.env.MAX_ZIP_TOTAL_MB || '200', 10),
  },
};
