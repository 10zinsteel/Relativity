const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { supabase: supabaseConfig, appBaseUrl } = require('../config');
const adminAuth = require('../middleware/adminAuth');
const { adminLoginLimiter } = require('../middleware/rateLimiters');
const supabaseService = require('../services/supabaseService');
const aikbService = require('../services/aikbService');
const emailConnectionService = require('../services/emailConnectionService');

if (process.env.NODE_ENV !== 'production') {
  console.log('[aibdr] AI_BDR_API_URL exists:', Boolean(process.env.AI_BDR_API_URL));
  console.log('[aibdr] AI_BDR_INTERNAL_API_KEY exists:', Boolean(process.env.AI_BDR_INTERNAL_API_KEY));
  console.log('[aibdr] AI_BDR_API_URL:', process.env.AI_BDR_API_URL);
}

function aibdrHeaders() {
  return {
    'x-api-key': process.env.AI_BDR_INTERNAL_API_KEY,
    'Content-Type': 'application/json',
  };
}

function aibdrUrl(path) {
  const base = (process.env.AI_BDR_API_URL || '').replace(/\/+$/, '');
  return `${base}${path}`;
}

function handleAibdrError(err, res, label) {
  console.error(`${label} error:`, err.message);
  if (err.response?.status === 401) {
    return res.status(502).json({
      success: false,
      error: 'AI BDR service rejected the proxy request. Check server API key configuration.',
    });
  }
  res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
}

const supabase = createClient(supabaseConfig.url, supabaseConfig.serviceKey);

router.post('/login', adminLoginLimiter, (req, res) => {
  const { password } = req.body;
  if (!password || typeof password !== 'string') {
    return res.status(401).json({ error: 'Invalid password' });
  }
  const passwordBuf = Buffer.from(password, 'utf8');
  const expectedBuf = Buffer.from(process.env.ADMIN_PASSWORD || '', 'utf8');
  const safeEqual = passwordBuf.length === expectedBuf.length
    && crypto.timingSafeEqual(passwordBuf, expectedBuf);
  if (!safeEqual) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  res.json({ token: adminAuth.generateToken() });
});

router.get('/clients', adminAuth, async (req, res) => {
  try {
    const clients = await supabaseService.getAllClientsWithStatus();
    if (!clients || clients.length === 0) return res.json([]);

    const clientIds = clients.map(c => c.id);

    const membersData = await supabaseService.getClientMembersByClientIds(clientIds).catch(() => []);
    const membersByClient = {};
    membersData.forEach(m => {
      if (!membersByClient[m.client_id]) membersByClient[m.client_id] = [];
      membersByClient[m.client_id].push(m);
    });

    const healthResults = await Promise.allSettled(
      clients.map(async (c) => {
        const [statsR, issueR] = await Promise.allSettled([
          aikbService.getClientKnowledgeStats(c.id),
          supabaseService.getClientIssueCount(c.id),
        ]);

        const stats     = statsR.status === 'fulfilled' ? (statsR.value || {}) : {};
        const latestJob = stats.ingestionJobs?.[0] || stats.latestIngestionJob || null;

        return {
          totalDocuments:     stats.totalDocuments     ?? stats.documentCount   ?? null,
          indexedDocuments:   stats.indexedDocuments   ?? stats.indexedCount    ?? null,
          failedDocuments:    stats.failedDocuments    ?? stats.failedCount     ?? null,
          indexingDocuments:  stats.indexingDocuments  ?? null,
          totalQuestions:     stats.totalQuestions     ?? null,
          totalKnowledgeGaps: stats.totalKnowledgeGaps ?? stats.knowledgeGaps ?? null,
          latestIngestionJob: latestJob ? { status: latestJob.status, created_at: latestJob.created_at } : null,
          lastQuestionAt:     stats.lastQuestionAt      ?? null,
          lastIndexedAt:      stats.lastIndexedAt       ?? null,
          issueCount:         issueR.status === 'fulfilled' ? issueR.value : null,
        };
      })
    );

    const enriched = clients.map((c, i) => {
      const members = membersByClient[c.id] || [];
      const health  = healthResults[i].status === 'fulfilled' ? healthResults[i].value : null;
      return {
        ...c,
        teamMembers:        members,
        teamCount:          members.length,
        activeMemberCount:  members.filter(m => m.status === 'active').length,
        pendingMemberCount: members.filter(m => m.status === 'pending').length,
        aikbHealth:         health,
      };
    });

    res.json(enriched);
  } catch (err) {
    console.error('admin/clients error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/invite', adminAuth, async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) {
    return res.status(400).json({ error: 'name and email are required' });
  }

  let client;
  try {
    client = await supabaseService.createClientRecord(name, email);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const { error: inviteError } = await supabase.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${appBaseUrl}/invite-claim.html`,
    data: { client_id: client.id },
  });

  if (inviteError) {
    try { await supabaseService.deleteClient(client.id); } catch {}
    console.error('Invite error:', inviteError.message);
    return res.status(500).json({ error: inviteError.message });
  }

  res.json({ success: true, clientId: client.id });
});

router.delete('/clients/:clientId', adminAuth, async (req, res) => {
  try {
    await supabaseService.deleteClientFull(req.params.clientId);
    res.json({ success: true });
  } catch (err) {
    console.error('admin/delete client error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// EM9 (EMAIL_INGESTION.md §24.5, §27, §31) — every member's email
// connection for this client, not just the caller's own (the portal's own
// GET /api/integrations/email/connections?all=true is owner/admin-scoped to
// a single client's session; this is Relativity-staff-only, across every
// client). Flags stillConnectedAfterOffboarding so an offboarded member's
// mailbox that was never actually disconnected doesn't silently disappear
// from view.
router.get('/clients/:clientId/email-connections', adminAuth, async (req, res) => {
  try {
    const connections = await supabaseService.getEmailConnectionsForClient(req.params.clientId);
    res.json({ connections });
  } catch (err) {
    console.error('admin/clients/:clientId/email-connections error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// EM10.5 Bug 11 fix — the override half of §14.1's route table
// (emailConnectionService.disconnect already fully implements owner/admin
// override + cleanupIngestedContent; this is simply the first UI ever wired
// to it, for the case the self-service portal button can't reach: an
// offboarded/unreachable member's mailbox left connected — see
// stillConnectedAfterOffboarding above). connectionId here is the
// oauth_connections id (getEmailConnectionsForClient's oauth_connection_id
// field), same identity emailConnectionService.disconnect already expects.
router.post('/clients/:clientId/email-connections/:connectionId/disconnect', adminAuth, async (req, res) => {
  try {
    const { cleanupIngestedContent } = req.body || {};
    const result = await emailConnectionService.disconnect({
      clientId: req.params.clientId,
      connectionId: req.params.connectionId,
      cleanupIngestedContent: cleanupIngestedContent === true,
    });
    res.json(result);
  } catch (err) {
    console.error('admin/clients/:clientId/email-connections/:connectionId/disconnect error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/clients/:clientId/aikb-health', adminAuth, async (req, res) => {
  const { clientId } = req.params;
  const [statsR, issueR] = await Promise.allSettled([
    aikbService.getClientKnowledgeStats(clientId),
    supabaseService.getClientIssueCount(clientId),
  ]);

  const stats     = statsR.status === 'fulfilled' ? (statsR.value || {}) : {};
  const latestJob = stats.ingestionJobs?.[0] || stats.latestIngestionJob || null;

  res.json({
    totalDocuments:     stats.totalDocuments     ?? stats.documentCount   ?? null,
    indexedDocuments:   stats.indexedDocuments   ?? stats.indexedCount    ?? null,
    failedDocuments:    stats.failedDocuments    ?? stats.failedCount     ?? null,
    indexingDocuments:  stats.indexingDocuments  ?? null,
    totalQuestions:     stats.totalQuestions     ?? null,
    totalKnowledgeGaps: stats.totalKnowledgeGaps ?? stats.knowledgeGaps ?? null,
    latestIngestionJob: latestJob ? { status: latestJob.status, created_at: latestJob.created_at } : null,
    lastQuestionAt:     stats.lastQuestionAt      ?? null,
    lastIndexedAt:      stats.lastIndexedAt       ?? null,
    issueCount:         issueR.status === 'fulfilled' ? issueR.value : null,
  });
});

router.get('/analytics', adminAuth, async (req, res) => {
  try {
    const [clients, issueSummary] = await Promise.all([
      supabaseService.getAllClientsWithStatus(),
      supabaseService.getPortalIssueSummary(),
    ]);

    const [aikbDocStats, aikbSummaries] = await Promise.all([
      Promise.allSettled(clients.map(c => aikbService.getClientDocumentStats(c.id))),
      Promise.allSettled(clients.map(c => aikbService.getClientSummary(c.id))),
    ]);

    let totalDocuments = 0;
    let totalIndexed = 0;
    let totalFailed = 0;
    let aikbDataAvailable = true;

    aikbDocStats.forEach(result => {
      if (result.status === 'fulfilled' && result.value.documentCount !== null) {
        totalDocuments += result.value.documentCount;
        totalIndexed += result.value.indexedCount;
        totalFailed += result.value.failedCount;
      } else {
        aikbDataAvailable = false;
      }
    });

    // Backlog M7: totalQuestions rolled up from AIKB's per-client summary
    // endpoint (already used elsewhere, e.g. /clients/:clientId/aikb-health)
    // — same Promise.allSettled-and-accumulate pattern as totalDocuments
    // above, just summed from a different per-client call.
    let totalQuestions = 0;
    let questionsDataAvailable = true;
    aikbSummaries.forEach(result => {
      if (result.status === 'fulfilled' && typeof result.value.totalQuestions === 'number') {
        totalQuestions += result.value.totalQuestions;
      } else {
        questionsDataAvailable = false;
      }
    });

    res.json({
      clientCount: clients.length,
      totalIssues: issueSummary.total,
      openIssues: issueSummary.open,
      totalDocuments: aikbDataAvailable ? totalDocuments : null,
      totalIndexed: aikbDataAvailable ? totalIndexed : null,
      totalFailed: aikbDataAvailable ? totalFailed : null,
      totalQuestions: questionsDataAvailable ? totalQuestions : null,
    });
  } catch (err) {
    console.error('admin/analytics error:', err.message);
    res.status(500).json({ error: 'Failed to load analytics.' });
  }
});

router.get('/leads', adminAuth, async (req, res) => {
  try {
    const leads = await supabaseService.getAllLeads();
    res.json(leads);
  } catch (err) {
    console.error('admin/leads GET error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/leads/:leadId', adminAuth, async (req, res) => {
  const { leadId } = req.params;
  const { status, notes, archived } = req.body;

  try {
    if (archived === true) {
      await supabaseService.archiveLead(leadId);
    } else if (typeof notes === 'string') {
      await supabaseService.updateLeadNotes(leadId, notes);
    } else if (status) {
      await supabaseService.updateLeadStatus(leadId, status);
    } else {
      return res.status(400).json({ error: 'Provide status, notes, or archived:true' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('admin/leads PATCH error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/leads/:leadId', adminAuth, async (req, res) => {
  try {
    await supabaseService.deleteLead(req.params.leadId);
    res.json({ success: true });
  } catch (err) {
    console.error('admin/leads DELETE error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/issues', adminAuth, async (req, res) => {
  try {
    const issues = await supabaseService.getAllPortalIssues();
    res.json(issues);
  } catch (err) {
    console.error('admin/issues GET error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/issues/:issueId', adminAuth, async (req, res) => {
  const { status } = req.body;
  const validStatuses = ['open', 'in_review', 'resolved'];
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
  }
  try {
    await supabaseService.updatePortalIssueStatus(req.params.issueId, status);
    res.json({ success: true });
  } catch (err) {
    console.error('admin/issues PATCH error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Knowledge gap admin review (Backlog M5) ─────────────────────────────────
// Fans out to every client the same way /analytics and aikb-health do,
// since AIKB's gaps list is per-client (requireServiceRequest is signed
// per-client — see aikb/routes/knowledge.js's GET/PATCH /gaps routes).

router.get('/gaps', adminAuth, async (req, res) => {
  try {
    const clients = await supabaseService.getAllClientsWithStatus();
    const status = typeof req.query.status === 'string' ? req.query.status : null;
    const results = await Promise.allSettled(
      clients.map(async (c) => {
        const data = await aikbService.listKnowledgeGaps(c.id, { status });
        const gaps = data.gaps || [];
        return gaps.map((g) => ({ ...g, client_name: c.name || c.id }));
      })
    );
    const gaps = results
      .filter((r) => r.status === 'fulfilled')
      .flatMap((r) => r.value)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json(gaps);
  } catch (err) {
    console.error('admin/gaps GET error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/gaps/:clientId/:gapId', adminAuth, async (req, res) => {
  const { status } = req.body;
  const validStatuses = ['open', 'reviewed', 'resolved', 'ignored'];
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
  }
  try {
    await aikbService.updateKnowledgeGapStatus(req.params.clientId, req.params.gapId, status);
    res.json({ success: true });
  } catch (err) {
    console.error('admin/gaps PATCH error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── AI BDR proxy routes ──────────────────────────────────────────────────────

router.get('/aibdr/api/leads', adminAuth, async (req, res) => {
  try {
    const url = aibdrUrl('/api/leads');
    console.log('[aibdr proxy] fetching leads from:', url);
    const response = await axios.get(url, { headers: aibdrHeaders() });
    console.log('[aibdr proxy] response success:', response.data?.success);
    console.log('[aibdr proxy] lead count:', response.data?.leads?.length);
    res.status(response.status).json(response.data);
  } catch (err) {
    handleAibdrError(err, res, 'admin/aibdr/api/leads GET');
  }
});

router.get('/aibdr/api/leads/:leadId', adminAuth, async (req, res) => {
  try {
    const { data } = await axios.get(aibdrUrl(`/api/leads/${req.params.leadId}`), { headers: aibdrHeaders() });
    res.json(data);
  } catch (err) {
    handleAibdrError(err, res, 'admin/aibdr/api/leads/:leadId GET');
  }
});

router.post('/aibdr/api/leads', adminAuth, async (req, res) => {
  try {
    const { data } = await axios.post(aibdrUrl('/api/leads'), req.body, { headers: aibdrHeaders() });
    res.json(data);
  } catch (err) {
    handleAibdrError(err, res, 'admin/aibdr/api/leads POST');
  }
});

router.patch('/aibdr/api/leads/:leadId/status', adminAuth, async (req, res) => {
  try {
    const { data } = await axios.patch(aibdrUrl(`/api/leads/${req.params.leadId}/status`), req.body, { headers: aibdrHeaders() });
    res.json(data);
  } catch (err) {
    handleAibdrError(err, res, 'admin/aibdr/api/leads/:leadId/status PATCH');
  }
});

router.post('/aibdr/api/analyze/:leadId', adminAuth, async (req, res) => {
  try {
    const { data } = await axios.post(aibdrUrl(`/api/analyze/${req.params.leadId}`), req.body, { headers: aibdrHeaders() });
    res.json(data);
  } catch (err) {
    handleAibdrError(err, res, 'admin/aibdr/api/analyze/:leadId POST');
  }
});

router.post('/aibdr/api/outreach/:leadId', adminAuth, async (req, res) => {
  try {
    const { data } = await axios.post(aibdrUrl(`/api/outreach/${req.params.leadId}`), req.body, { headers: aibdrHeaders() });
    res.json(data);
  } catch (err) {
    handleAibdrError(err, res, 'admin/aibdr/api/outreach/:leadId POST');
  }
});

router.post('/aibdr/api/score/:leadId', adminAuth, async (req, res) => {
  try {
    const { data } = await axios.post(aibdrUrl(`/api/score/${req.params.leadId}`), req.body, { headers: aibdrHeaders() });
    res.json(data);
  } catch (err) {
    handleAibdrError(err, res, 'admin/aibdr/api/score/:leadId POST');
  }
});

router.post('/aibdr/api/scrape/:leadId', adminAuth, async (req, res) => {
  try {
    const { data } = await axios.post(aibdrUrl(`/api/scrape/${req.params.leadId}`), req.body, { headers: aibdrHeaders() });
    res.json(data);
  } catch (err) {
    handleAibdrError(err, res, 'admin/aibdr/api/scrape/:leadId POST');
  }
});

module.exports = router;
