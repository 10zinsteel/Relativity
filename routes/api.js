const express = require('express');
const router = express.Router();
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const AdmZip = require('adm-zip');
const clientAuth = require('../middleware/clientAuth');
const googleDriveImportService = require('../services/googleDriveImportService');
const aikbService = require('../services/aikbService');
const emailLiveLookupService = require('../services/emailLiveLookupService');
const citationAttributionService = require('../services/citationAttributionService');
const supabaseService = require('../services/supabaseService');
const openaiService = require('../services/openaiService');
const config = require('../config');
const { googleDrive: googleDriveConfig } = require('../config');
const { ALLOWED_EXTENSIONS, sanitizeRelativePath, classifyZipEntries, mergeDocumentImportContext } = require('../services/importMetadata');

const MAX_FILE_MB = config.limits.maxFileSizeMb;

// sourceType values a plain-upload request may claim for itself (ZIP/Google Drive
// routes set their own source_type server-side and never take this from the client).
const ALLOWED_UPLOAD_SOURCE_TYPES = new Set(['local', 'folder_upload']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, ALLOWED_EXTENSIONS.has(path.extname(file.originalname).toLowerCase()));
  },
});

const MAX_AUDIO_MB = config.limits.maxAudioSizeMb;

const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, typeof file.mimetype === 'string' && file.mimetype.startsWith('audio/'));
  },
});

// ---- ZIP / archive import ----

const MAX_ZIP_MB = config.limits.maxZipSizeMb;

const uploadZip = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ZIP_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, path.extname(file.originalname).toLowerCase() === '.zip');
  },
});

// Zip entries carry no browser-supplied mimetype — map by extension instead,
// reusing the same allow-list as direct upload (ALLOWED_EXTENSIONS below).
const EXTENSION_MIME_MAP = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

// ---- Knowledge Base (portal_upload) ----

router.post('/knowledge/upload', clientAuth, (req, res, next) => {
  if (req.member && req.member.role === 'viewer') {
    return res.status(403).json({ error: 'Viewers cannot upload documents' });
  }
  next();
}, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `File too large. Maximum size is ${MAX_FILE_MB} MB.`
        : (err.message || 'File upload error.');
      return res.status(400).json({ error: msg });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file provided or unsupported file type (.txt, .md, .pdf, .docx only).' });
  }

  const clientId = req.client.id;
  const sourceFileId = crypto.randomUUID();

  // Enforce document count limit before accepting the upload
  try {
    const existing = await aikbService.listDocuments(clientId);
    const count = (existing.documents || (Array.isArray(existing) ? existing : [])).filter(d => d.status !== 'deleted').length;
    if (count >= config.limits.maxDocuments) {
      return res.status(429).json({
        error: `Document limit reached (${config.limits.maxDocuments} max). Delete some documents to upload new ones.`,
      });
    }
  } catch { /* non-blocking — proceed if count check fails */ }

  try {
    await aikbService.uploadAndIngest({
      clientId,
      sourceFileId,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      fileBuffer: req.file.buffer,
    });

    const importBatchId = req.body.importBatchId || crypto.randomUUID();
    const sourceType = ALLOWED_UPLOAD_SOURCE_TYPES.has(req.body.sourceType) ? req.body.sourceType : 'local';
    supabaseService.logImportBatch([{
      clientId,
      importBatchId,
      sourceType,
      sourcePath: sanitizeRelativePath(req.body.relativePath),
      fileName: req.file.originalname,
      sourceFileId,
      importedBy: req.member?.id,
    }]).catch((err) => console.error('logImportBatch (upload) failed:', err.message));

    res.status(201).json({ success: true, sourceFileId });
  } catch (err) {
    console.error('POST /api/knowledge/upload error:', err.message);
    res.status(500).json({ error: 'Upload failed. Please try again.' });
  }
});

router.post('/knowledge/import-zip', clientAuth, (req, res, next) => {
  if (req.member && req.member.role === 'viewer') {
    return res.status(403).json({ error: 'Viewers cannot import documents' });
  }
  next();
}, (req, res, next) => {
  uploadZip.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `ZIP too large. Maximum size is ${MAX_ZIP_MB} MB.`
        : (err.message || 'ZIP upload error.');
      return res.status(400).json({ error: msg });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No ZIP file provided.' });
  }

  const clientId = req.client.id;
  const importBatchId = req.body.importBatchId || crypto.randomUUID();

  // Retry-only support: client re-sends the whole archive (extracted bytes aren't kept
  // between requests) but asks us to only reprocess specific previously-failed paths.
  let retryOnlySet = null;
  if (req.body.retryOnly) {
    try {
      const paths = JSON.parse(req.body.retryOnly);
      if (Array.isArray(paths)) retryOnlySet = new Set(paths.map((p) => String(p).replace(/\\/g, '/')));
    } catch { /* malformed retryOnly — ignore and process the full archive */ }
  }

  let zip;
  try {
    zip = new AdmZip(req.file.buffer);
  } catch {
    return res.status(400).json({ error: 'Could not read ZIP archive. It may be corrupted.' });
  }

  const entries = zip.getEntries();

  // Pass 1: classify entries (no decompression yet) — validates paths, skips hidden/system
  // files and unsupported extensions, applies retryOnly, and catches in-batch duplicates.
  const { valid, skipped } = classifyZipEntries(entries, { retryOnlySet });

  // A retryOnly path that isn't in the re-uploaded archive at all (edited out between
  // attempts) would otherwise vanish silently — surface it as a failure instead.
  const retryMissing = [];
  if (retryOnlySet) {
    const presentPaths = new Set(
      entries.filter((e) => !e.isDirectory).map((e) => e.entryName.replace(/\\/g, '/'))
    );
    for (const p of retryOnlySet) {
      if (!presentPaths.has(p)) {
        retryMissing.push({ fileName: p.split('/').pop() || p, reason: 'File no longer present in archive', relativePath: p });
      }
    }
  }

  if (valid.length > config.limits.maxZipFiles) {
    return res.status(400).json({
      error: `ZIP contains too many files (${valid.length}). Maximum is ${config.limits.maxZipFiles}.`,
    });
  }

  if (valid.length === 0) {
    return res.status(200).json({ success: true, imported: [], skipped, failed: retryMissing, importBatchId });
  }

  // --- Enforce max individual extracted size + max total extracted size ---
  // header.size is the uncompressed size, known without calling getData().
  let totalSize = 0;
  const sizedValid = [];
  for (const item of valid) {
    const size = item.entry.header.size;
    if (size > config.limits.maxZipEntryMb * 1024 * 1024) {
      skipped.push({ fileName: item.fileName, reason: `File exceeds ${config.limits.maxZipEntryMb} MB limit` });
      continue;
    }
    totalSize += size;
    sizedValid.push(item);
  }
  if (totalSize > config.limits.maxZipTotalMb * 1024 * 1024) {
    return res.status(400).json({
      error: `Extracted contents too large (limit ${config.limits.maxZipTotalMb} MB total).`,
    });
  }

  if (sizedValid.length === 0) {
    return res.status(200).json({ success: true, imported: [], skipped, failed: retryMissing, importBatchId });
  }

  // --- Enforce document count limit, accounting for all valid entries ---
  try {
    const existing = await aikbService.listDocuments(clientId);
    const count = (existing.documents || (Array.isArray(existing) ? existing : [])).filter(d => d.status !== 'deleted').length;
    if (count + sizedValid.length > config.limits.maxDocuments) {
      return res.status(429).json({
        error: `Document limit reached (${config.limits.maxDocuments} max). Delete some documents to import more.`,
      });
    }
  } catch { /* non-blocking — proceed if count check fails */ }

  // --- Pass 2: extract + ingest, concurrency-2, continue on individual failure ---
  const imported = [];
  const failed = [...retryMissing];

  let nextIndex = 0;
  async function worker() {
    while (nextIndex < sizedValid.length) {
      const i = nextIndex++;
      const { entry, fileName, relativePath, ext } = sizedValid[i];
      const sourceFileId = crypto.randomUUID();
      try {
        const fileBuffer = entry.getData();
        await aikbService.uploadAndIngest({
          clientId,
          sourceFileId,
          fileName,
          mimeType: EXTENSION_MIME_MAP[ext] || 'application/octet-stream',
          fileBuffer,
        });
        imported.push({ fileName, sourceFileId, relativePath });
      } catch (err) {
        console.error(`ZIP import failed for ${fileName}:`, err.message);
        failed.push({ fileName, reason: 'Ingestion failed', relativePath });
      }
    }
  }

  const CONCURRENCY = 2;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sizedValid.length) }, worker));

  if (imported.length > 0) {
    supabaseService.logImportBatch(imported.map((f) => ({
      clientId,
      importBatchId,
      sourceType: 'zip',
      sourcePath: f.relativePath,
      fileName: f.fileName,
      sourceFileId: f.sourceFileId,
      importedBy: req.member?.id,
    }))).catch((err) => console.error('logImportBatch (import-zip) failed:', err.message));
  }

  res.status(201).json({
    success: true,
    imported: imported.map(({ fileName, sourceFileId, relativePath }) => ({ fileName, sourceFileId, relativePath })),
    skipped,
    failed,
    importBatchId,
  });
});

// ---- Voice Input (transcription) ----

router.post('/voice/transcribe', clientAuth, (req, res, next) => {
  uploadAudio.single('audio')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `Audio too large. Maximum size is ${MAX_AUDIO_MB} MB.`
        : (err.message || 'Audio upload error.');
      return res.status(400).json({ error: msg });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
    return res.status(400).json({ error: 'No audio provided.' });
  }

  try {
    const text = await openaiService.transcribeAudio(req.file.buffer, req.file.mimetype);
    if (!text) {
      return res.status(422).json({ error: 'Could not transcribe audio. Please try again.' });
    }
    res.json({ text });
  } catch (err) {
    console.error('POST /api/voice/transcribe error:', err.message);

    if (err.code === 'OPENAI_NOT_CONFIGURED') {
      return res.status(500).json({ error: 'Voice transcription is not configured on the server.' });
    }
    res.status(500).json({ error: 'Transcription failed. Please try again.' });
  }
});

// ---- Google Drive one-shot import ----

router.get('/google-drive/picker-config', clientAuth, (req, res) => {
  res.json({
    clientId: googleDriveConfig.clientId,
    apiKey: googleDriveConfig.pickerApiKey,
  });
});

router.post('/google-drive/import', clientAuth, async (req, res) => {
  if (req.member?.role === 'viewer') {
    return res.status(403).json({ error: 'Viewers cannot import documents' });
  }

  const googleToken = req.headers['x-google-access-token'];
  const { files } = req.body;

  if (!googleToken) {
    return res.status(400).json({ error: 'Missing Google access token.' });
  }
  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'No files provided.' });
  }

  for (const f of files) {
    if (!googleDriveImportService.ALLOWED_MIME_TYPES.has(f.mimeType)) {
      return res.status(400).json({ error: `Unsupported file type: ${f.mimeType}` });
    }
  }

  const clientId = req.client.id;
  const maxBytes = config.limits.maxFileSizeMb * 1024 * 1024;

  try {
    const existing = await aikbService.listDocuments(clientId);
    const count = (existing.documents || (Array.isArray(existing) ? existing : [])).filter(d => d.status !== 'deleted').length;
    if (count + files.length > config.limits.maxDocuments) {
      return res.status(429).json({ error: `Document limit reached (${config.limits.maxDocuments} max).` });
    }
  } catch { /* non-blocking */ }

  const imported = [];
  for (const file of files) {
    const sourceFileId = crypto.randomUUID();
    try {
      const meta = await googleDriveImportService.getFileMetadata(googleToken, file.id);
      const fileSize = parseInt(meta.size || '0', 10);
      if (fileSize > maxBytes) {
        return res.status(400).json({
          error: `"${file.name}" exceeds the maximum upload size of ${config.limits.maxFileSizeMb} MB.`,
        });
      }

      const fileBuffer = await googleDriveImportService.downloadFileBuffer(googleToken, file.id);
      await aikbService.uploadAndIngest({
        clientId,
        sourceFileId,
        fileName: file.name,
        mimeType: file.mimeType,
        fileBuffer,
      });
      imported.push({ sourceFileId, fileName: file.name });
    } catch (err) {
      console.error(`Google Drive import failed for ${file.name}:`, err.message);
      return res.status(500).json({ error: `Failed to import "${file.name}". Please try again.` });
    }
  }

  if (imported.length > 0) {
    const importBatchId = req.body.importBatchId || crypto.randomUUID();
    supabaseService.logImportBatch(imported.map((f) => ({
      clientId,
      importBatchId,
      sourceType: 'google_drive',
      fileName: f.fileName,
      sourceFileId: f.sourceFileId,
      importedBy: req.member?.id,
    }))).catch((err) => console.error('logImportBatch (google-drive) failed:', err.message));
  }

  res.status(201).json({ success: true, imported });
});

router.get('/knowledge/documents', clientAuth, async (req, res) => {
  try {
    const data = await aikbService.listDocuments(req.client.id);
    const docs = data.documents || (Array.isArray(data) ? data : null);

    if (!docs) {
      res.json(data);
      return;
    }

    // Merge in portal-specific import context (source type/label/path/imported-at).
    // AIKB remains authoritative for the document itself — fileName/status are untouched.
    const importLogMap = await supabaseService.getImportLogMap(req.client.id).catch(() => new Map());
    const enriched = mergeDocumentImportContext(docs, importLogMap);

    res.json(Array.isArray(data) ? enriched : { ...data, documents: enriched });
  } catch (err) {
    console.error('GET /api/knowledge/documents error:', err.message);
    res.status(500).json({ error: 'Could not load your documents. Please try again.' });
  }
});

router.get('/knowledge/jobs', clientAuth, async (req, res) => {
  try {
    const data = await aikbService.listIngestionJobs(req.client.id);
    res.json(data);
  } catch (err) {
    console.error('GET /api/knowledge/jobs error:', err.message);
    res.json({ jobs: [] }); // graceful fallback — endpoint may not exist on AIKB yet
  }
});

router.get('/knowledge/import-history', clientAuth, async (req, res) => {
  try {
    const batches = await supabaseService.getImportHistory(req.client.id);
    res.json({ batches });
  } catch (err) {
    console.error('GET /api/knowledge/import-history error:', err.message);
    res.json({ batches: [] }); // graceful fallback — this is a nice-to-have history view
  }
});

router.get('/knowledge/summary', clientAuth, async (req, res) => {
  try {
    const data = await aikbService.getClientSummary(req.client.id);
    res.json(data);
  } catch (err) {
    console.error('GET /api/knowledge/summary error:', err.message);
    res.status(500).json({ error: 'Could not load your AI knowledge base data. Please try again.' });
  }
});

router.get('/knowledge/analytics', clientAuth, async (req, res) => {
  try {
    const data = await aikbService.getClientAnalytics(req.client.id);
    res.json(data);
  } catch (err) {
    console.error('GET /api/knowledge/analytics error:', err.message);
    res.status(500).json({ error: 'Could not load analytics. Please try again.' });
  }
});

router.get('/knowledge/usage', clientAuth, async (req, res) => {
  try {
    const data = await aikbService.listDocuments(req.client.id);
    const docs = (data.documents || (Array.isArray(data) ? data : [])).filter(d => d.status !== 'deleted');
    res.json({
      documentCount: docs.length,
      maxDocuments: config.limits.maxDocuments,
      maxFileSizeMb: config.limits.maxFileSizeMb,
    });
  } catch (err) {
    console.error('GET /api/knowledge/usage error:', err.message);
    res.status(500).json({ error: 'Could not load usage data.' });
  }
});

// EL6 (LIVE_EMAIL_LOOKUP.md §2.1) — the portal's three-way mode selector.
// 'company_knowledge' suppresses tool-offering entirely (never even checks
// availability); 'live_email' forces the gate open regardless of AIKB's own
// classifier signal (still subject to every authorization gate);
// 'automatic' (default) is the ordinary two-stage gate (§1.3 Option C).
const EMAIL_LOOKUP_MODES = ['company_knowledge', 'live_email', 'automatic'];

router.post('/knowledge/query', clientAuth, async (req, res) => {
  const { query, sessionId, collectionIds, emailLookupMode } = req.body;
  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'query is required' });
  }
  const mode = EMAIL_LOOKUP_MODES.includes(emailLookupMode) ? emailLookupMode : 'automatic';
  try {
    // Backlog M10: optional, mirrors Slack's existing allowedCollectionIds
    // scoping (services/slackCollectionAccessService.js) — omitted/not an
    // array means unrestricted, unchanged from before this existed.
    const allowedCollectionIds = Array.isArray(collectionIds) ? collectionIds : null;

    // EL6 — a cheap, DB-only check (no Gmail call) run on every question;
    // 'company_knowledge' mode skips it entirely rather than compute a flag
    // that's about to be ignored anyway.
    const emailLookupAvailable = mode === 'company_knowledge'
      ? false
      : await emailLiveLookupService.isLiveLookupAvailable({ clientId: req.client.id, requestingMemberId: req.member.id });
    const forceLiveLookup = mode === 'live_email' && emailLookupAvailable;

    const data = await aikbService.queryKnowledge(req.client.id, query.trim(), sessionId || null, req.headers.authorization, allowedCollectionIds, { emailLookupAvailable, forceLiveLookup });
    // EM10.8 — resolve each email source's opaque contributingMemberId to a
    // display name before it ever reaches the client; a no-op when no
    // source carries one (plain documents, live-lookup sources).
    if (Array.isArray(data.sources)) {
      data.sources = await citationAttributionService.enrichSourcesWithContributorNames(req.client.id, data.sources);
    }
    // Record which member owns this session in the local mapping table
    const returnedSessionId = data.sessionId || data.session_id;
    if (returnedSessionId && req.member?.id) {
      supabaseService.createMemberSession(req.client.id, req.member.id, returnedSessionId)
        .catch(err => console.error('createMemberSession failed:', err.message));
    }
    res.json(data);
  } catch (err) {
    console.error('POST /api/knowledge/query error:', err.message);
    res.status(500).json({ error: 'Could not get an answer. Please try again.' });
  }
});

router.post('/knowledge/gaps', clientAuth, async (req, res) => {
  const { sessionId, messageId, question, reason } = req.body;
  if (!sessionId || !question || !reason) {
    return res.status(400).json({ error: 'sessionId, question, and reason are required' });
  }
  try {
    const result = await aikbService.saveKnowledgeGap({
      clientId: req.client.id,
      sessionId,
      messageId: messageId || null,
      question,
      reason,
    });
    res.json({ success: true, gap: result.gap });
  } catch (err) {
    console.error('POST /api/knowledge/gaps error:', err.message);
    res.status(500).json({ error: 'Could not save knowledge gap.' });
  }
});

router.get('/knowledge/chat/sessions', clientAuth, async (req, res) => {
  try {
    const [allSessions, memberSessionIds] = await Promise.all([
      aikbService.listChatSessions(req.client.id, req.headers.authorization),
      supabaseService.getMemberSessionIds(req.client.id, req.member.id),
    ]);
    const idSet = new Set(memberSessionIds);
    const sessions = Array.isArray(allSessions) ? allSessions : (allSessions.sessions || []);
    const filtered = sessions.filter(s => idSet.has(s.id || s.session_id));
    res.json(filtered);
  } catch (err) {
    console.error('GET /api/knowledge/chat/sessions error:', err.message);
    res.status(500).json({ error: 'Could not load chat history.' });
  }
});

router.get('/knowledge/chat/sessions/:sessionId/messages', clientAuth, async (req, res) => {
  const { sessionId } = req.params;
  try {
    // Verify ownership via local mapping
    const memberSessionIds = await supabaseService.getMemberSessionIds(req.client.id, req.member.id);
    if (!memberSessionIds.includes(sessionId)) {
      return res.status(403).json({ error: 'Session not found' });
    }
    const data = await aikbService.listChatMessages(req.client.id, sessionId, req.headers.authorization);
    res.json(data);
  } catch (err) {
    console.error('GET /api/knowledge/chat/sessions/:sessionId/messages error:', err.message);
    res.status(500).json({ error: 'Could not load messages.' });
  }
});

router.delete('/knowledge/chat/sessions/:sessionId', clientAuth, async (req, res) => {
  const { sessionId } = req.params;
  try {
    const memberSessionIds = await supabaseService.getMemberSessionIds(req.client.id, req.member.id);
    if (!memberSessionIds.includes(sessionId)) {
      return res.status(403).json({ error: 'Session not found' });
    }
    await aikbService.deleteChatSession(req.client.id, sessionId, req.headers.authorization);
    await supabaseService.deleteMemberSession(req.client.id, req.member.id, sessionId);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/knowledge/chat/sessions/:sessionId error:', err.message);
    res.status(500).json({ error: 'Could not delete session.' });
  }
});

router.delete('/knowledge/chat/history', clientAuth, async (req, res) => {
  try {
    const memberSessionIds = await supabaseService.getMemberSessionIds(req.client.id, req.member.id);
    // Delete each of this member's sessions from AIKB
    await Promise.all(
      memberSessionIds.map(sid =>
        aikbService.deleteChatSession(req.client.id, sid, req.headers.authorization).catch(() => {})
      )
    );
    await supabaseService.deleteMemberAllSessions(req.client.id, req.member.id);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/knowledge/chat/history error:', err.message);
    res.status(500).json({ error: 'Could not clear history.' });
  }
});

router.patch('/knowledge/chat/sessions/:sessionId/title', clientAuth, async (req, res) => {
  const { title } = req.body;
  const { sessionId } = req.params;
  if (!title || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }
  try {
    const memberSessionIds = await supabaseService.getMemberSessionIds(req.client.id, req.member.id);
    if (!memberSessionIds.includes(sessionId)) {
      return res.status(403).json({ error: 'Session not found' });
    }
    const data = await aikbService.updateChatSessionTitle(req.client.id, sessionId, title.trim(), req.headers.authorization);
    res.json(data);
  } catch (err) {
    console.error('PATCH /api/knowledge/chat/sessions/:sessionId/title error:', err.message);
    res.status(500).json({ error: 'Could not update session title.' });
  }
});

router.delete('/knowledge/document/:sourceFileId', clientAuth, async (req, res) => {
  try {
    await aikbService.deleteDocument(req.client.id, req.params.sourceFileId);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/knowledge/document error:', err.message);
    res.status(500).json({ error: 'Could not delete document. Please try again.' });
  }
});

router.post('/portal/issues', clientAuth, async (req, res) => {
  const { subject, issueType, message } = req.body;
  if (!subject || !issueType || !message) {
    return res.status(400).json({ error: 'subject, issueType, and message are required.' });
  }
  try {
    const issue = await supabaseService.createPortalIssue({
      clientId: req.client.id,
      submittedBy: req.user?.id || null,
      submittedEmail: req.user?.email || null,
      subject,
      issueType,
      message,
    });
    res.status(201).json(issue);
  } catch (err) {
    console.error('portal/issues POST error:', err.message);
    res.status(500).json({ error: 'Could not submit your issue. Please try again.' });
  }
});

module.exports = router;
