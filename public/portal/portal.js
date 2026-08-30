(async function () {
  // 1. Fetch Supabase public config from server (never hardcode keys in frontend)
  const configRes = await fetch('/auth/config');
  const { supabaseUrl, supabaseAnonKey } = await configRes.json();
  const supabase = window.supabase.createClient(supabaseUrl, supabaseAnonKey);

  // 2. Guard: redirect to login if there is no active session
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.location.href = '/login.html';
    return;
  }

  const accessToken = session.access_token;

  // 3. Identify client from server-side JWT resolution
  const meRes = await fetch('/auth/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const me = await meRes.json();

  if (!me.authenticated) {
    // Session exists but there's no usable client membership behind it —
    // clear any cached portal data before signing out so login.js doesn't
    // just bounce us straight back here.
    PortalCache.clearAll();
    await supabase.auth.signOut();
    window.location.href = '/login.html?error=' + encodeURIComponent(me.reason || 'session_invalid');
    return;
  }

  const { clientId, clientName, email, memberId, memberRole } = me;

  // Milestone: portal frontend cache (sessionStorage, stale-while-revalidate).
  // See architecture/PORTAL_FRONTEND_CACHE.md for the full design.
  const CACHE_TTL = {
    collections: 5 * 60 * 1000,
    documents: 2 * 60 * 1000,
    teamMembers: 5 * 60 * 1000,
  };

  const identityName = document.getElementById('clientIdentityName');
  const identityId   = document.getElementById('clientIdentityId');
  if (identityName) identityName.textContent = email || 'User';
  if (identityId) {
  const roleLabel = memberRole ? memberRole.charAt(0).toUpperCase() + memberRole.slice(1) : 'Member';
  identityId.textContent = `${clientName || 'Client'} • ${roleLabel}`;
}

  const isOwnerAdmin = memberRole === 'owner' || memberRole === 'admin';

  // Milestone 5: Knowledge Collections. Shared cache of this org's
  // collections, used both by the Collections tab's table and by the
  // per-document "move to collection" control on the Documents tab.
  // null = not yet fetched.
  let loadedCollections = null;

  // Show team tab for owner and admin roles
  if (isOwnerAdmin) {
    const teamTabBtn = document.getElementById('sidebar-tab-team');
    if (teamTabBtn) teamTabBtn.hidden = false;
    initTeamSection();
    loadMembers();

    const collectionsTabBtn = document.getElementById('sidebar-tab-collections');
    if (collectionsTabBtn) collectionsTabBtn.hidden = false;
    initCollectionsSection();
  }

  // ---- Sidebar / tab navigation ----
  const TAB_NAMES = ['overview', 'knowledge', 'documents', 'chat-history', 'team', 'collections', 'support'];
  const DEFAULT_TAB = 'knowledge';

  const portalSidebar  = document.getElementById('portal-sidebar');
  const sidebarOverlay = document.getElementById('sidebar-overlay');
  const menuToggleBtn  = document.getElementById('btn-menu-toggle');
  const sidebarTabBtns = document.querySelectorAll('.sidebar-tab');

  function closeSidebarMobile() {
    if (portalSidebar) portalSidebar.classList.remove('portal-sidebar--open');
    if (sidebarOverlay) sidebarOverlay.classList.remove('sidebar-overlay--visible');
    if (menuToggleBtn) menuToggleBtn.setAttribute('aria-expanded', 'false');
  }

  function openSidebarMobile() {
    if (portalSidebar) portalSidebar.classList.add('portal-sidebar--open');
    if (sidebarOverlay) sidebarOverlay.classList.add('sidebar-overlay--visible');
    if (menuToggleBtn) menuToggleBtn.setAttribute('aria-expanded', 'true');
  }

  function setActiveTab(tabName, { updateHash = true } = {}) {
    if (!TAB_NAMES.includes(tabName)) tabName = DEFAULT_TAB;
    if (tabName === 'team' && !isOwnerAdmin) tabName = DEFAULT_TAB;
    if (tabName === 'collections' && !isOwnerAdmin) tabName = DEFAULT_TAB;

    TAB_NAMES.forEach((name) => {
      const panel = document.getElementById(`tab-${name}`);
      if (panel) panel.classList.toggle('tab-panel--active', name === tabName);
    });

    sidebarTabBtns.forEach((btn) => {
      btn.classList.toggle('sidebar-tab--active', btn.dataset.tab === tabName);
    });

    if (updateHash) {
      window.history.replaceState(null, '', `#${tabName}`);
    }

    closeSidebarMobile();
  }

  sidebarTabBtns.forEach((btn) => {
    btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
  });

  if (menuToggleBtn) {
    menuToggleBtn.addEventListener('click', () => {
      if (portalSidebar && portalSidebar.classList.contains('portal-sidebar--open')) {
        closeSidebarMobile();
      } else {
        openSidebarMobile();
      }
    });
  }

  if (sidebarOverlay) sidebarOverlay.addEventListener('click', closeSidebarMobile);

  window.addEventListener('hashchange', () => {
    setActiveTab(window.location.hash.replace('#', ''), { updateHash: false });
  });

  setActiveTab(window.location.hash.replace('#', '') || DEFAULT_TAB, { updateHash: false });

  // 4. Handle post-OAuth redirect params (Slack is the only remaining
  // connect flow — backlog M15 removed Google Drive/Dropbox's, which used
  // to hit the bare connected=/error= params handled here previously).
  const params = new URLSearchParams(window.location.search);
  const error = params.get('error');
  const integrationParam = params.get('integration');
  const statusParam = params.get('status');

  const SLACK_ERROR_MESSAGES = {
    access_denied: 'Slack authorization was cancelled.',
    invalid_state: 'Your Slack connection attempt was invalid or already used. Please try connecting again.',
    expired_state: 'Your Slack connection attempt expired. Please try connecting again.',
    connection_failed: 'Could not connect Slack. Please try again or contact support.',
  };

  if (integrationParam === 'slack') {
    if (statusParam === 'connected') {
      showBanner('success', 'Slack connected successfully.');
    } else if (error) {
      showBanner('error', SLACK_ERROR_MESSAGES[error] || 'Slack connection failed. Please try again.');
    }
    window.history.replaceState({}, '', `/portal/portal.html${window.location.hash}`);
  }

  // EM2 — Gmail per-member OAuth connect. Mirrors Slack's redirect-banner
  // handling above, keyed off the same REDIRECT constants emailConnectionService.js uses.
  const GMAIL_ERROR_MESSAGES = {
    access_denied: 'Gmail authorization was cancelled.',
    invalid_state: 'Your Gmail connection attempt was invalid or already used. Please try connecting again.',
    expired_state: 'Your Gmail connection attempt expired. Please try connecting again.',
    connection_failed: 'Could not connect Gmail. Please try again or contact support.',
  };

  if (integrationParam === 'gmail') {
    if (statusParam === 'connected') {
      showBanner('success', 'Gmail connected successfully.');
    } else if (error) {
      showBanner('error', GMAIL_ERROR_MESSAGES[error] || 'Gmail connection failed. Please try again.');
    }
    window.history.replaceState({}, '', `/portal/portal.html${window.location.hash}`);
  }

  // 4b. Slack Integration
  const slackStatusBadge   = document.getElementById('slack-status-badge');
  const slackWorkspaceName = document.getElementById('slack-workspace-name');
  const slackConnectBtn    = document.getElementById('slack-connect-btn');
  const slackDisconnectBtn = document.getElementById('slack-disconnect-btn');

  function renderSlackStatus(data) {
    if (!slackStatusBadge) return;
    const isConnected = !!data.connected;
    slackStatusBadge.textContent = isConnected ? 'Connected' : 'Not connected';
    slackStatusBadge.className = `integration-status badge ${isConnected ? 'badge--indexed' : 'badge--soon'}`;
    if (slackWorkspaceName) {
      slackWorkspaceName.textContent = isConnected && data.workspaceName ? data.workspaceName : '';
    }
    if (slackConnectBtn) slackConnectBtn.hidden = !isOwnerAdmin || isConnected;
    if (slackDisconnectBtn) slackDisconnectBtn.hidden = !isOwnerAdmin || !isConnected;

    // Milestone 5: which collections Slack may search — owner/admin only,
    // and only once Slack is actually connected.
    const slackCollectionsSection = document.getElementById('slack-collections-section');
    if (slackCollectionsSection) {
      const show = isConnected && isOwnerAdmin;
      slackCollectionsSection.hidden = !show;
      if (show) loadSlackAllowedCollections();
    }
  }

  async function loadSlackAllowedCollections() {
    const listEl = document.getElementById('slack-collections-list');
    const saveBtn = document.getElementById('slack-collections-save-btn');
    const statusEl = document.getElementById('slack-collections-save-status');
    if (!listEl) return;

    listEl.innerHTML = '<span class="kb-doc-meta">Loading…</span>';

    try {
      const [collectionsRes, allowedRes] = await Promise.all([
        fetch('/api/collections', { headers: { Authorization: `Bearer ${accessToken}` } }),
        fetch('/api/integrations/slack/collections', { headers: { Authorization: `Bearer ${accessToken}` } }),
      ]);
      if (!collectionsRes.ok || !allowedRes.ok) throw new Error('failed to load');

      const { collections } = await collectionsRes.json();
      const { allowedCollectionIds } = await allowedRes.json();
      const allowedSet = new Set(allowedCollectionIds || []);

      if (!collections || !collections.length) {
        listEl.innerHTML = '<span class="kb-doc-meta">No collections yet — create one in the Collections tab.</span>';
        return;
      }

      listEl.innerHTML = collections.map((c) => `
        <label class="slack-collection-option">
          <input type="checkbox" value="${escHtml(c.id)}" ${allowedSet.has(c.id) ? 'checked' : ''} />
          ${escHtml(c.name)}
        </label>
      `).join('');
    } catch {
      listEl.innerHTML = '<span class="kb-doc-meta">Could not load collections.</span>';
    }

    if (saveBtn && !saveBtn._bound) {
      saveBtn._bound = true;
      saveBtn.addEventListener('click', async () => {
        const collectionIds = Array.from(listEl.querySelectorAll('input[type="checkbox"]:checked')).map((el) => el.value);
        saveBtn.disabled = true;
        if (statusEl) { statusEl.hidden = true; }
        try {
          const res = await fetch('/api/integrations/slack/collections', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
            body: JSON.stringify({ collectionIds }),
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || 'Could not save.');
          }
          if (statusEl) {
            statusEl.textContent = 'Saved.';
            statusEl.className = 'kb-upload-status kb-upload-status--success';
            statusEl.hidden = false;
          }
        } catch (err) {
          if (statusEl) {
            statusEl.textContent = err.message || 'Could not save.';
            statusEl.className = 'kb-upload-status kb-upload-status--error';
            statusEl.hidden = false;
          }
        } finally {
          saveBtn.disabled = false;
        }
      });
    }
  }

  async function loadSlackStatus() {
    if (!slackStatusBadge) return;
    try {
      const res = await fetch('/api/integrations/slack/status', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error('status request failed');
      renderSlackStatus(await res.json());
    } catch {
      slackStatusBadge.textContent = 'Unavailable';
      slackStatusBadge.className = 'integration-status badge badge--failed';
      if (slackWorkspaceName) slackWorkspaceName.textContent = '';
    }
  }

  if (slackConnectBtn) {
    slackConnectBtn.addEventListener('click', async () => {
      slackConnectBtn.disabled = true;
      try {
        const res = await fetch('/api/integrations/slack/start', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.url) {
          window.location.href = body.url;
          return;
        }
        showBanner('error', body.error || 'Could not start Slack connection.');
      } catch {
        showBanner('error', 'Network error. Please try again.');
      } finally {
        slackConnectBtn.disabled = false;
      }
    });
  }

  if (slackDisconnectBtn) {
    slackDisconnectBtn.addEventListener('click', async () => {
      if (!confirm('Disconnect Slack from this organization?')) return;
      slackDisconnectBtn.disabled = true;
      try {
        const res = await fetch('/api/integrations/slack/disconnect', {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (res.ok) {
          showBanner('success', 'Slack disconnected.');
        } else {
          const body = await res.json().catch(() => ({}));
          showBanner('error', body.error || 'Could not disconnect Slack.');
        }
      } catch {
        showBanner('error', 'Network error. Please try again.');
      } finally {
        slackDisconnectBtn.disabled = false;
        loadSlackStatus();
      }
    });
  }

  loadSlackStatus();

  // 4c. Gmail Integration (EM2 — per-member OAuth connect only; no policy,
  // label, or sync UI yet, see Architecture/architecture/EMAIL_INGESTION.md).
  // Self-service: any active member whose role isn't 'viewer' may connect
  // their OWN mailbox — this is the one visibility difference from Slack's
  // card, which is owner/admin-only.
  const gmailStatusBadge    = document.getElementById('gmail-status-badge');
  const gmailMailboxAddress = document.getElementById('gmail-mailbox-address');
  const gmailConnectBtn     = document.getElementById('gmail-connect-btn');
  const gmailDisconnectBtn  = document.getElementById('gmail-disconnect-btn');
  const canConnectGmail     = memberRole !== 'viewer';

  // EM4 — member mailbox settings (§7, §13.1, §31): own search-contribution
  // toggle, shown only while connected. (The sync-mode selector this
  // section also used to render — a member's choice between manual_selected
  // and automatic — was removed in EM10.6 along with Automatic Email
  // Ingestion itself; Gmail ingestion is label-driven only now. See
  // EMAIL_INGESTION.md's EM10.6 record.)
  const emailMailboxSettingsSection = document.getElementById('email-mailbox-settings-section');
  const emailSearchEnabledToggle    = document.getElementById('email-search-enabled-toggle');
  const emailMailboxSettingsStatus  = document.getElementById('email-mailbox-settings-save-status');

  // EM5/EM6 — Gmail label workflow shell (§7, §10, §14.2, §17, §31): "Open
  // Gmail" shortcut, label instructions (manual mode only), and "Sync now"
  // (real historical import as of EM6).
  const emailSyncShellSection    = document.getElementById('email-sync-shell-section');
  const emailManualInstructions  = document.getElementById('email-manual-instructions');
  const emailSyncNowBtn          = document.getElementById('email-sync-now-btn');
  const emailSyncNowStatus       = document.getElementById('email-sync-now-status');
  const emailPreviewResult       = document.getElementById('email-preview-result');

  function renderGmailStatus({ connections, configured }) {
    if (!gmailStatusBadge) return;
    const own = (connections || [])[0] || null;
    const isConnected = !!own;

    // Server has no Gmail OAuth client configured at all — hide the Connect
    // button entirely rather than let a member click it and only find out
    // it fails after the round trip. A pre-existing connection (e.g. config
    // was removed after the fact) still gets shown so it can be disconnected.
    if (!configured && !isConnected) {
      gmailStatusBadge.textContent = 'Not available';
      gmailStatusBadge.className = 'integration-status badge badge--soon';
      if (gmailMailboxAddress) gmailMailboxAddress.textContent = '';
      if (gmailConnectBtn) gmailConnectBtn.hidden = true;
      if (gmailDisconnectBtn) gmailDisconnectBtn.hidden = true;
      if (emailMailboxSettingsSection) emailMailboxSettingsSection.hidden = true;
      if (emailSyncShellSection) emailSyncShellSection.hidden = true;
      return;
    }

    gmailStatusBadge.textContent = isConnected ? 'Connected' : 'Not connected';
    gmailStatusBadge.className = `integration-status badge ${isConnected ? 'badge--indexed' : 'badge--soon'}`;
    if (gmailMailboxAddress) {
      gmailMailboxAddress.textContent = isConnected && own.mailboxAddress ? own.mailboxAddress : '';
    }
    if (gmailConnectBtn) gmailConnectBtn.hidden = !canConnectGmail || isConnected || !configured;
    if (gmailDisconnectBtn) {
      gmailDisconnectBtn.hidden = !isConnected;
      gmailDisconnectBtn.dataset.connectionId = isConnected ? own.connectionId : '';
    }

    if (emailMailboxSettingsSection) emailMailboxSettingsSection.hidden = !isConnected;

    if (emailSyncShellSection) emailSyncShellSection.hidden = !isConnected;
    if (isConnected && emailSyncNowBtn) {
      emailSyncNowBtn.dataset.connectionId = own.connectionId;
      loadEmailSyncRunHistory(own.connectionId);
    }
  }

  async function loadGmailStatus() {
    if (!gmailStatusBadge) return;
    try {
      const res = await fetch('/api/integrations/email/connections', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error('connections request failed');
      const body = await res.json();
      renderGmailStatus(body);
    } catch {
      gmailStatusBadge.textContent = 'Unavailable';
      gmailStatusBadge.className = 'integration-status badge badge--failed';
      if (gmailMailboxAddress) gmailMailboxAddress.textContent = '';
    }
  }

  if (gmailConnectBtn) {
    gmailConnectBtn.addEventListener('click', async () => {
      gmailConnectBtn.disabled = true;
      try {
        const res = await fetch('/api/integrations/email/gmail/start', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.url) {
          window.location.href = body.url;
          return;
        }
        showBanner('error', body.error || 'Could not start Gmail connection.');
      } catch {
        showBanner('error', 'Network error. Please try again.');
      } finally {
        gmailConnectBtn.disabled = false;
      }
    });
  }

  if (gmailDisconnectBtn) {
    gmailDisconnectBtn.addEventListener('click', async () => {
      const connectionId = gmailDisconnectBtn.dataset.connectionId;
      if (!connectionId) return;
      if (!confirm('Disconnect your Gmail account?')) return;
      gmailDisconnectBtn.disabled = true;
      try {
        const res = await fetch(`/api/integrations/email/connections/${encodeURIComponent(connectionId)}/disconnect`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (res.ok) {
          showBanner('success', 'Gmail disconnected.');
        } else {
          const body = await res.json().catch(() => ({}));
          showBanner('error', body.error || 'Could not disconnect Gmail.');
        }
      } catch {
        showBanner('error', 'Network error. Please try again.');
      } finally {
        gmailDisconnectBtn.disabled = false;
        loadGmailStatus();
      }
    });
  }

  loadGmailStatus();

  // EM4 — member mailbox settings: the member's own search_enabled flag
  // (independent of any specific connection, but only shown/meaningful
  // while a mailbox is connected).
  async function loadEmailMemberSettings() {
    if (!emailSearchEnabledToggle) return;
    try {
      const res = await fetch('/api/integrations/email/member-settings', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return;
      const { searchEnabled } = await res.json();
      emailSearchEnabledToggle.checked = searchEnabled !== false;
    } catch {
      // Leave the toggle at its default (checked) — a load failure here
      // shouldn't block the rest of the Gmail card from rendering.
    }
  }

  loadEmailMemberSettings();

  if (emailSearchEnabledToggle) {
    emailSearchEnabledToggle.addEventListener('change', async () => {
      const searchEnabled = emailSearchEnabledToggle.checked;
      emailSearchEnabledToggle.disabled = true;
      if (emailMailboxSettingsStatus) emailMailboxSettingsStatus.hidden = true;
      try {
        const res = await fetch('/api/integrations/email/member-settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ searchEnabled }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || 'Could not save.');
        if (emailMailboxSettingsStatus) {
          emailMailboxSettingsStatus.textContent = 'Saved.';
          emailMailboxSettingsStatus.className = 'kb-upload-status kb-upload-status--success';
          emailMailboxSettingsStatus.hidden = false;
        }
      } catch (err) {
        emailSearchEnabledToggle.checked = !searchEnabled; // revert on failure
        if (emailMailboxSettingsStatus) {
          emailMailboxSettingsStatus.textContent = err.message || 'Could not save.';
          emailMailboxSettingsStatus.className = 'kb-upload-status kb-upload-status--error';
          emailMailboxSettingsStatus.hidden = false;
        }
      } finally {
        emailSearchEnabledToggle.disabled = false;
      }
    });
  }

  // EM6/EM7 — "Sync now" runs real import: POST /connections/:id/sync
  // (manual mode only — §14.2, §15, §17, §18). A first click starts a fresh
  // run (no pageToken/runType); each page's {imported, skipped, failed}
  // counts accumulate into a running total, mirroring the existing
  // ZIP-import structured-summary pattern (§27). When a page reports
  // complete: false, the next page is walked automatically — passing back
  // BOTH the returned nextPageToken AND runType, since EM7 added a second
  // sync type (incremental) that needs to be threaded through resumed pages
  // — up to a small safety cap so a runaway loop can never hang the tab
  // indefinitely.
  const EMAIL_SYNC_MAX_AUTO_PAGES = 40; // 40 * HISTORICAL_PAGE_SIZE(25) = 1000 messages per click, a generous ceiling
  let emailSyncTotals = { imported: 0, skipped: 0, failed: 0 };

  function renderSyncResult(result, { inProgress }) {
    if (!emailPreviewResult) return;
    emailSyncTotals.imported += result.imported.length;
    emailSyncTotals.skipped += result.skipped.length;
    emailSyncTotals.failed += result.failed.length;

    const sampleHtml = result.imported.length
      ? '<ul class="email-preview-sample-list">' + result.imported.slice(0, 10).map((m) => `
          <li>${escHtml(m.subject || '(no subject)')}</li>
        `).join('') + '</ul>'
      : '';
    // EM7 — surfaces which sync mechanism actually ran: "incremental"
    // (fast, only what changed since the last sync) vs "historical" (a full
    // bounded re-scan — the first sync ever, or a fallback after the stored
    // cursor expired, §18.4).
    const runTypeLabel = result.runType === 'incremental' ? 'Quick check' : 'Full scan';
    const statusLine = inProgress
      ? `Syncing (${runTypeLabel})… ${emailSyncTotals.imported} imported so far.`
      : `${runTypeLabel} complete: ${emailSyncTotals.imported} imported, ${emailSyncTotals.skipped} skipped, ${emailSyncTotals.failed} failed.`;
    emailPreviewResult.innerHTML = `<p>${escHtml(statusLine)}</p>${sampleHtml}`;
    emailPreviewResult.hidden = false;
  }

  async function runSync() {
    const connectionId = emailSyncNowBtn && emailSyncNowBtn.dataset.connectionId;
    if (!connectionId) return;
    emailSyncTotals = { imported: 0, skipped: 0, failed: 0 };
    emailSyncNowBtn.disabled = true;
    if (emailSyncNowStatus) emailSyncNowStatus.hidden = true;

    let pageToken = null;
    let runType = null;
    let pagesRun = 0;
    try {
      for (;;) {
        const res = await fetch(`/api/integrations/email/connections/${encodeURIComponent(connectionId)}/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ pageToken, runType }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || 'Could not sync.');

        pagesRun++;
        renderSyncResult(body, { inProgress: !body.complete });

        if (body.complete || !body.nextPageToken || pagesRun >= EMAIL_SYNC_MAX_AUTO_PAGES) break;
        pageToken = body.nextPageToken;
        runType = body.runType;
      }
      loadGmailStatus();
      loadEmailSyncRunHistory(connectionId);
    } catch (err) {
      if (emailSyncNowStatus) {
        emailSyncNowStatus.textContent = err.message || 'Could not sync.';
        emailSyncNowStatus.className = 'kb-upload-status kb-upload-status--error';
        emailSyncNowStatus.hidden = false;
      }
    } finally {
      emailSyncNowBtn.disabled = false;
    }
  }

  if (emailSyncNowBtn) {
    emailSyncNowBtn.addEventListener('click', () => runSync());
  }

  // EM7 — sync-run history view (§27, §31 EM7 Frontend): the connection's
  // last few sync runs (type, status, counts, when), loaded on connect and
  // refreshed after every "Sync now" click.
  const emailSyncHistoryList = document.getElementById('email-sync-history-list');

  function renderSyncRunHistory(syncRuns) {
    if (!emailSyncHistoryList) return;
    if (!syncRuns || syncRuns.length === 0) {
      emailSyncHistoryList.innerHTML = '<li class="email-sync-history-empty">No syncs yet.</li>';
      return;
    }
    emailSyncHistoryList.innerHTML = syncRuns.map((run) => {
      const typeLabel = run.run_type === 'incremental' ? 'Quick check' : 'Full scan';
      const when = run.started_at ? new Date(run.started_at).toLocaleString() : '';
      const counts = `${run.messages_ingested || 0} imported, ${run.messages_failed || 0} failed`;
      return `<li class="email-sync-history-item email-sync-history-item--${escHtml(run.status || 'unknown')}">
        <span class="email-sync-history-type">${escHtml(typeLabel)}</span>
        <span class="email-sync-history-status">${escHtml(run.status || '')}</span>
        <span class="email-sync-history-counts">${escHtml(counts)}</span>
        <span class="email-sync-history-when">${escHtml(when)}</span>
      </li>`;
    }).join('');
  }

  async function loadEmailSyncRunHistory(connectionId) {
    if (!emailSyncHistoryList || !connectionId) return;
    try {
      const res = await fetch(`/api/integrations/email/connections/${encodeURIComponent(connectionId)}/sync-runs`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return;
      const { syncRuns } = await res.json();
      renderSyncRunHistory(syncRuns);
    } catch {
      // Non-blocking — the history list simply stays as-is on a load failure.
    }
  }

  // 4d. Email organization policy (EM3 — Architecture/architecture/
  // EMAIL_INGESTION.md §14.1, §16, §31). Owner/admin sees and edits the full
  // rule builder; every other active member sees a read-only summary of
  // what already bounds their own mailbox (§7's "Organization policy
  // summary" requirement). Still no ingestion happens from this UI — that's
  // EM5/EM6. (The org-wide automatic-sync toggle this section also used to
  // render was removed in EM10.6 along with Automatic Email Ingestion
  // itself — see EMAIL_INGESTION.md's EM10.6 record.)
  const emailPolicySummarySection = document.getElementById('email-policy-summary-section');
  const emailPolicySummaryText    = document.getElementById('email-policy-summary-text');
  const emailPolicyBuilderSection = document.getElementById('email-policy-builder-section');
  const emailPolicyRulesList      = document.getElementById('email-policy-rules-list');
  const emailPolicyAddRuleBtn     = document.getElementById('email-policy-add-rule-btn');
  const emailPolicySaveBtn        = document.getElementById('email-policy-save-btn');
  const emailPolicySaveStatus     = document.getElementById('email-policy-save-status');

  function summarizePolicy(rules) {
    const enabled = (rules || []).filter((r) => r.enabled);
    if (!enabled.length) return 'No rules configured — nothing is imported from any mailbox until an owner/admin adds one.';
    const allowCount = enabled.filter((r) => r.ruleType === 'allow').length;
    const denyCount = enabled.filter((r) => r.ruleType === 'deny').length;
    return `${allowCount} allow rule${allowCount === 1 ? '' : 's'}, ${denyCount} deny rule${denyCount === 1 ? '' : 's'} currently bound your mailbox.`;
  }

  function ruleRowTemplate(rule = {}) {
    const collectionOptions = (loadedCollections || []).map((c) => `
      <option value="${escHtml(c.id)}" ${rule.destinationCollectionId === c.id ? 'selected' : ''}>${escHtml(c.name)}</option>
    `).join('');
    return `
      <div class="email-policy-rule-row">
        <select class="ep-rule-type">
          <option value="allow" ${rule.ruleType !== 'deny' ? 'selected' : ''}>Allow</option>
          <option value="deny" ${rule.ruleType === 'deny' ? 'selected' : ''}>Deny</option>
        </select>
        <input type="text" class="ep-label" placeholder="Gmail label" value="${escHtml(rule.labelOrFolder || '')}" />
        <input type="text" class="ep-sender" placeholder="Sender: @domain.com or address" value="${escHtml(rule.senderPattern || '')}" />
        <label class="email-policy-rule-checkbox"><input type="checkbox" class="ep-include-sent" ${rule.includeSent ? 'checked' : ''}/> Sent</label>
        <label class="email-policy-rule-checkbox"><input type="checkbox" class="ep-include-attachments" ${rule.includeAttachments ? 'checked' : ''}/> Attachments</label>
        <label class="email-policy-rule-checkbox">Max days <input type="number" class="ep-max-days" min="1" max="730" value="${rule.maxHistoricalDays || 90}" /></label>
        <select class="ep-collection">
          <option value="">Default collection</option>
          ${collectionOptions}
        </select>
        <button type="button" class="email-policy-rule-remove-btn">Remove</button>
      </div>
    `;
  }

  function renderRuleRows(rules) {
    if (!emailPolicyRulesList) return;
    if (!rules || !rules.length) {
      emailPolicyRulesList.innerHTML = '<span class="kb-doc-meta">No rules yet — add one below. Nothing imports until at least one allow rule exists.</span>';
      return;
    }
    emailPolicyRulesList.innerHTML = rules.map(ruleRowTemplate).join('');
  }

  function collectRuleRowsFromDom() {
    return Array.from(emailPolicyRulesList.querySelectorAll('.email-policy-rule-row')).map((row) => ({
      ruleType: row.querySelector('.ep-rule-type').value,
      labelOrFolder: row.querySelector('.ep-label').value.trim() || null,
      senderPattern: row.querySelector('.ep-sender').value.trim() || null,
      includeSent: row.querySelector('.ep-include-sent').checked,
      includeAttachments: row.querySelector('.ep-include-attachments').checked,
      maxHistoricalDays: Number(row.querySelector('.ep-max-days').value) || 90,
      destinationCollectionId: row.querySelector('.ep-collection').value || null,
      enabled: true,
    }));
  }

  async function loadEmailPolicySummary() {
    if (!emailPolicySummarySection) return;
    try {
      const res = await fetch('/api/integrations/email/policy', { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) throw new Error('failed');
      const { rules } = await res.json();
      if (emailPolicySummaryText) emailPolicySummaryText.textContent = summarizePolicy(rules);
      emailPolicySummarySection.hidden = false;
    } catch {
      emailPolicySummarySection.hidden = true;
    }
  }

  async function loadEmailPolicyBuilder() {
    if (!emailPolicyBuilderSection || !isOwnerAdmin) return;
    emailPolicyBuilderSection.hidden = false;
    try {
      const needsCollections = !loadedCollections;
      const [policyRes, collectionsRes] = await Promise.all([
        fetch('/api/integrations/email/policy', { headers: { Authorization: `Bearer ${accessToken}` } }),
        needsCollections
          ? fetch('/api/collections', { headers: { Authorization: `Bearer ${accessToken}` } })
          : Promise.resolve(null),
      ]);
      if (collectionsRes) {
        const body = await collectionsRes.json().catch(() => ({}));
        loadedCollections = body.collections || [];
      }
      if (policyRes.ok) {
        const { rules } = await policyRes.json();
        renderRuleRows(rules);
      } else if (emailPolicyRulesList) {
        emailPolicyRulesList.innerHTML = '<span class="kb-doc-meta">Could not load policy.</span>';
      }
    } catch {
      if (emailPolicyRulesList) emailPolicyRulesList.innerHTML = '<span class="kb-doc-meta">Could not load policy.</span>';
    }
  }

  if (emailPolicyAddRuleBtn) {
    emailPolicyAddRuleBtn.addEventListener('click', () => {
      if (!emailPolicyRulesList.querySelector('.email-policy-rule-row')) emailPolicyRulesList.innerHTML = '';
      emailPolicyRulesList.insertAdjacentHTML('beforeend', ruleRowTemplate({ ruleType: 'allow' }));
    });
  }

  if (emailPolicyRulesList) {
    emailPolicyRulesList.addEventListener('click', (e) => {
      if (!e.target.classList.contains('email-policy-rule-remove-btn')) return;
      const row = e.target.closest('.email-policy-rule-row');
      if (row) row.remove();
      if (!emailPolicyRulesList.querySelector('.email-policy-rule-row')) {
        emailPolicyRulesList.innerHTML = '<span class="kb-doc-meta">No rules yet — add one below. Nothing imports until at least one allow rule exists.</span>';
      }
    });
  }

  if (emailPolicySaveBtn) {
    emailPolicySaveBtn.addEventListener('click', async () => {
      emailPolicySaveBtn.disabled = true;
      if (emailPolicySaveStatus) emailPolicySaveStatus.hidden = true;
      try {
        const rules = collectRuleRowsFromDom();
        const res = await fetch('/api/integrations/email/policy', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ rules }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || 'Could not save policy.');
        renderRuleRows(body.rules);
        if (emailPolicySaveStatus) {
          emailPolicySaveStatus.textContent = 'Saved.';
          emailPolicySaveStatus.className = 'kb-upload-status kb-upload-status--success';
          emailPolicySaveStatus.hidden = false;
        }
      } catch (err) {
        if (emailPolicySaveStatus) {
          emailPolicySaveStatus.textContent = err.message || 'Could not save policy.';
          emailPolicySaveStatus.className = 'kb-upload-status kb-upload-status--error';
          emailPolicySaveStatus.hidden = false;
        }
      } finally {
        emailPolicySaveBtn.disabled = false;
      }
    });
  }

  // EM10.6 removed the org-wide automatic-sync toggle's change listener
  // along with Automatic Email Ingestion itself — see EMAIL_INGESTION.md's
  // EM10.6 record.

  if (isOwnerAdmin) {
    loadEmailPolicyBuilder();
  } else {
    loadEmailPolicySummary();
  }

  // 5. Knowledge Base
  const kbFileInput       = document.getElementById('kb-file-input');
  const kbUploadBtn       = document.getElementById('kb-upload-btn');
  const kbUploadStatus    = document.getElementById('kb-upload-status');
  const kbDocsList        = document.getElementById('kb-docs-list');
  const kbDocsCount       = document.getElementById('kb-docs-count');
  const kbJobsList        = document.getElementById('kb-jobs-list');
  const kbQueryInput      = document.getElementById('kb-query-input');
  const kbAskBtn          = document.getElementById('kb-ask-btn');
  const kbMessages        = document.getElementById('kb-messages');
  const kbSessionsList    = document.getElementById('kb-sessions-list');
  const kbNewChatBtn      = document.getElementById('kb-new-chat-btn');
  const kbClearHistoryBtn = document.getElementById('kb-clear-history-btn');
  const kbClearChatBtn    = document.getElementById('kb-clear-chat-btn');
  const kbGdriveBtn       = document.getElementById('kb-gdrive-btn');
  const kbZipInput        = document.getElementById('kb-zip-input');
  const kbZipBtn          = document.getElementById('kb-zip-btn');
  const kbFolderInput     = document.getElementById('kb-folder-input');
  const kbFolderBtn       = document.getElementById('kb-folder-btn');
  const kbMicBtn          = document.getElementById('kb-mic-btn');
  const kbMicTimer        = document.getElementById('kb-mic-timer');
  const kbMicError        = document.getElementById('kb-mic-error');
  const kbCollectionsFilterDetails = document.getElementById('kb-collections-filter');
  const kbCollectionsFilterList    = document.getElementById('kb-collections-filter-list');
  const kbCollectionsFilterLabel   = document.getElementById('kb-collections-filter-label');
  const liveLookupConsentModal   = document.getElementById('live-lookup-consent-modal');
  const liveLookupConsentAccept  = document.getElementById('live-lookup-consent-accept');
  const liveLookupConsentDecline = document.getElementById('live-lookup-consent-decline');

  let _pickerConfig       = null;
  let _gapiPickerLoaded   = false;
  let _gisInited          = false;
  let _tokenClient        = null;

  let currentSessionId = null;
  let chatSessions     = [];

  // Backlog M10: which collections the portal's own chat may search — the
  // same allowedCollectionIds concept Slack already uses (loadSlackAllowedCollections
  // above), scoped to this member's browser rather than client-wide, since
  // portal chat is per-user, not a shared workspace-level setting like
  // Slack's. null = unrestricted (search every collection, the pre-existing
  // default behavior); an array (possibly empty) restricts retrieval.
  const KB_COLLECTIONS_FILTER_KEY = `kbAllowedCollections:${clientId}`;
  let kbAllowedCollectionIds = (() => {
    try {
      const raw = localStorage.getItem(KB_COLLECTIONS_FILTER_KEY);
      if (raw === null) return null;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  })();
  const pendingDeletes = new Set();
  const pendingUploads = new Map();

  const MAX_RECORDING_MS = 2 * 60 * 1000; // auto-stop safety timeout

  let mediaRecorder       = null;
  let recordedChunks      = [];
  let micState            = 'idle'; // 'idle' | 'recording' | 'transcribing'
  let micPermissionDenied = false;
  let recordingStartedAt  = null;
  let recordingTimerId    = null;   // setInterval — updates the elapsed display
  let recordingTimeoutId  = null;   // setTimeout  — enforces MAX_RECORDING_MS

  // Dismissed ingestion jobs are hidden client-side only — the job history in Supabase is untouched.
  const DISMISSED_JOBS_KEY = `dismissedIngestionJobs:${clientId}`;

  function getDismissedJobIds() {
    try {
      const raw = localStorage.getItem(DISMISSED_JOBS_KEY);
      return new Set(raw ? JSON.parse(raw) : []);
    } catch {
      return new Set();
    }
  }

  function dismissJob(jobKey) {
    const dismissed = getDismissedJobIds();
    dismissed.add(jobKey);
    try {
      localStorage.setItem(DISMISSED_JOBS_KEY, JSON.stringify([...dismissed]));
    } catch { /* storage unavailable — dismissal just won't persist */ }
  }

  function getJobKey(job) {
    return job.id || job.job_id || job.jobId
      || `${job.sourceFileId || job.source_file_id || ''}:${job.created_at || ''}`;
  }

  // Shared state for onboarding progress — updated as docs and sessions load
  let loadedDocs      = null;
  let loadedSessions  = null;
  let loadedAnalytics = null;
  let loadedMembers   = null; // null = not yet fetched; [] = no other members

  const MAX_QUERY_HEIGHT = 120;

  function adjustQueryHeight() {
    kbQueryInput.style.height = 'auto';
    const nextHeight = Math.min(kbQueryInput.scrollHeight, MAX_QUERY_HEIGHT);
    kbQueryInput.style.height = `${nextHeight}px`;
    kbQueryInput.style.overflowY = kbQueryInput.scrollHeight > MAX_QUERY_HEIGHT ? 'auto' : 'hidden';
  }

  loadDocuments();
  loadSessions();
  loadJobs();
  loadAnalytics();
  loadPickerConfig();
  loadImportHistory();

  // Mirrors the server's allow-list (routes/api.js ALLOWED_EXTENSIONS) — folder pickers
  // ignore `accept`, so we pre-filter client-side to avoid wasted upload requests.
  const KB_ALLOWED_EXTENSIONS = new Set(['.txt', '.md', '.pdf', '.docx']);
  function hasAllowedExtension(file) {
    const dot = file.name.lastIndexOf('.');
    const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
    return KB_ALLOWED_EXTENSIONS.has(ext);
  }

  kbUploadBtn.addEventListener('click', () => kbFileInput.click());
  kbFileInput.addEventListener('change', () => {
    const files = Array.from(kbFileInput.files || []);
    kbFileInput.value = '';
    if (files.length === 0) return;
    kbUploadStatus.hidden = true;
    kbUploadStatus.textContent = '';
    if (files.length === 1) {
      uploadDocument(files[0]);
    } else {
      uploadMultipleFiles(files);
    }
  });

  kbZipBtn.addEventListener('click', () => kbZipInput.click());
  kbZipInput.addEventListener('change', () => {
    const file = kbZipInput.files[0];
    kbZipInput.value = '';
    if (!file) return;
    kbUploadStatus.hidden = true;
    kbUploadStatus.textContent = '';
    uploadZipFile(file);
  });

  kbFolderBtn.addEventListener('click', () => kbFolderInput.click());
  kbFolderInput.addEventListener('change', () => {
    const files = Array.from(kbFolderInput.files || []).filter(hasAllowedExtension);
    kbFolderInput.value = '';
    if (files.length === 0) return;
    kbUploadStatus.hidden = true;
    kbUploadStatus.textContent = '';
    uploadMultipleFiles(files, { sourceType: 'folder_upload', triggerBtn: kbFolderBtn });
  });

  kbGdriveBtn.addEventListener('click', () => {
    if (!_pickerConfig?.clientId) {
      showBanner('error', 'Google Drive import is not configured.');
      return;
    }
    if (!_gisInited || !_gapiPickerLoaded) {
      initPicker(() => _tokenClient.requestAccessToken({ prompt: 'select_account' }));
    } else {
      _tokenClient.requestAccessToken({ prompt: '' });
    }
  });

  kbAskBtn.addEventListener('click', askQuestion);
  kbMicBtn.addEventListener('click', () => {
    if (micState === 'idle') startRecording();
    else if (micState === 'recording') stopRecording();
    // 'transcribing': button is disabled, click is a no-op
  });
  kbQueryInput.addEventListener('input', adjustQueryHeight);
  kbQueryInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      askQuestion();
    }
  });

  // Clears the visible conversation only — saved sessions in Chat History are untouched.
  function startFreshChat() {
    currentSessionId = null;
    kbMessages.innerHTML = '';
    updateChatWelcome();
    renderSessions(chatSessions);
    adjustQueryHeight();
    kbQueryInput.focus();
  }

  kbNewChatBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setActiveTab('knowledge');
    startFreshChat();
  });

  if (kbClearChatBtn) {
    kbClearChatBtn.addEventListener('click', () => {
      startFreshChat();
    });
  }

  updateChatWelcome();

  kbClearHistoryBtn.addEventListener('click', async () => {
    if (!confirm('Clear all chat history? This cannot be undone.')) return;
    try {
      const res = await fetch('/api/knowledge/chat/history', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res.ok) {
        chatSessions = [];
        loadedSessions = [];
        currentSessionId = null;
        kbMessages.innerHTML = '';
        updateChatWelcome();
        renderSessions([]);
        maybeUpdateProgress();
      } else {
        const body = await res.json().catch(() => ({}));
        showBanner('error', body.error || 'Failed to clear history.');
      }
    } catch {
      showBanner('error', 'Network error. Please try again.');
    }
  });

  kbDocsList.addEventListener('click', async (e) => {
    const btn = e.target.closest('.btn-kb-delete');
    if (!btn) return;

    const sourceFileId = btn.dataset.sourceId;
    const name = btn.dataset.name;
    if (!confirm(`Delete "${name}" from your knowledge base? This cannot be undone.`)) return;

    // Optimistically hide the document immediately
    pendingDeletes.add(sourceFileId);
    refreshDocuments();

    try {
      const res = await fetch(`/api/knowledge/document/${encodeURIComponent(sourceFileId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (res.ok) {
        // A deleted document changes its collection's documentCount.
        PortalCache.invalidate(clientId, memberId, 'collections');
        // Poll until the document is confirmed gone from the server
        const settled = await pollUntilSettled(async () => {
          const docs = await fetchDocuments();
          if (docs) renderDocuments(docs);
          if (!docs) return false;
          return !docs.find(d => (d.sourceFileId || d.source_file_id) === sourceFileId);
        });
        pendingDeletes.delete(sourceFileId);
        if (!settled) {
          showBanner('error', 'Delete is still processing. Refresh again in a moment.');
        }
        refreshDocuments();
      } else {
        pendingDeletes.delete(sourceFileId);
        const body = await res.json().catch(() => ({}));
        showBanner('error', body.error || 'Failed to delete document.');
        refreshDocuments();
      }
    } catch {
      pendingDeletes.delete(sourceFileId);
      showBanner('error', 'Network error. Please try again.');
      refreshDocuments();
    }
  });

  kbDocsList.addEventListener('change', async (e) => {
    const select = e.target.closest('.doc-collection-select');
    if (!select) return;

    const sourceFileId = select.dataset.sourceId;
    const collectionId = select.value;
    select.disabled = true;

    try {
      const res = await fetch(`/api/knowledge/document/${encodeURIComponent(sourceFileId)}/collection`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ collectionId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Could not move document.');
      }
      // Moving a document changes documentCount on both the source and target collection.
      PortalCache.invalidate(clientId, memberId, 'collections');
      refreshDocuments();
    } catch (err) {
      showBanner('error', err.message || 'Could not move document.');
      refreshDocuments();
    } finally {
      select.disabled = false;
    }
  });

  if (kbJobsList) {
    kbJobsList.addEventListener('click', (e) => {
      const dismissBtn = e.target.closest('.btn-kb-job-dismiss');
      if (!dismissBtn) return;
      // Prevent the click from also toggling the <details> row open/closed
      e.preventDefault();
      e.stopPropagation();
      dismissJob(dismissBtn.dataset.jobKey);
      refreshJobs();
    });
  }

  kbSessionsList.addEventListener('click', async (e) => {
    const renameBtn = e.target.closest('.btn-kb-session-rename');
    if (renameBtn) {
      const sessionId = renameBtn.dataset.sessionId;
      const currentTitle = renameBtn.dataset.title || '';
      const newTitle = prompt('Rename chat session', currentTitle);
      if (newTitle === null) return;
      const trimmed = newTitle.trim();
      if (!trimmed || trimmed === currentTitle) return;
      try {
        const res = await fetch(`/api/knowledge/chat/sessions/${encodeURIComponent(sessionId)}/title`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ title: trimmed }),
        });
        if (res.ok) {
          const session = chatSessions.find(s => (s.id || s.session_id) === sessionId);
          if (session) session.title = trimmed;
          renderSessions(chatSessions);
        } else {
          const body = await res.json().catch(() => ({}));
          showBanner('error', body.error || 'Failed to rename session.');
        }
      } catch {
        showBanner('error', 'Network error. Please try again.');
      }
      return;
    }

    const deleteBtn = e.target.closest('.btn-kb-session-delete');
    if (deleteBtn) {
      const sessionId = deleteBtn.dataset.sessionId;
      if (!confirm('Delete this chat session?')) return;
      try {
        const res = await fetch(`/api/knowledge/chat/sessions/${encodeURIComponent(sessionId)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (res.ok) {
          chatSessions = chatSessions.filter(s => (s.id || s.session_id) !== sessionId);
          loadedSessions = chatSessions;
          if (currentSessionId === sessionId) {
            currentSessionId = null;
            kbMessages.innerHTML = '';
          }
          renderSessions(chatSessions);
          maybeUpdateProgress();
        } else {
          const body = await res.json().catch(() => ({}));
          showBanner('error', body.error || 'Failed to delete session.');
        }
      } catch {
        showBanner('error', 'Network error. Please try again.');
      }
      return;
    }

    const item = e.target.closest('.kb-session-item');
    if (item) {
      const sessionId = item.dataset.sessionId;
      await openChatFromHistory(sessionId);
    }
  });

  async function fetchDocuments() {
    try {
      const res = await fetch('/api/knowledge/documents', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return null;
      const data = await res.json();
      const docs = data.documents || (Array.isArray(data) ? data : []);
      // Keep the cache fresh on every successful fetch, regardless of caller
      // (initial load, post-mutation refresh, or delete/upload polling) — see
      // architecture/PORTAL_FRONTEND_CACHE.md.
      PortalCache.set(clientId, memberId, 'documents', docs);
      return docs;
    } catch {
      return null;
    }
  }

  function renderDocuments(documents) {
    if (documents === null) {
      kbDocsList.innerHTML = `<div class="empty-state"><span>Failed to load documents.</span></div>`;
      return;
    }

    const visible = documents.filter(d => {
      const id = d.sourceFileId || d.source_file_id || '';
      return !pendingDeletes.has(id) && d.status !== 'deleted';
    });

    const placeholders = [];
    for (const [fileName, meta] of pendingUploads) {
      const alreadySettled = documents.find(d =>
        docMatchesTarget(d, meta) && (d.status === 'indexed' || d.status === 'failed')
      );
      if (!alreadySettled) {
        placeholders.push({ fileName, status: 'indexing', _isPending: true });
      }
    }

    const rows = [...placeholders, ...visible];

    if (!rows.length) {
      kbDocsCount.textContent = '';
      kbDocsList.innerHTML = `
        <div class="empty-state-card">
          <span class="empty-state-icon">📄</span>
          <span class="empty-state-title">No documents uploaded yet</span>
          <span class="empty-state-desc">Upload SOPs, FAQs, pricing sheets, or training docs to build your knowledge base.</span>
        </div>`;
      return;
    }

    kbDocsCount.textContent = `${rows.length} document${rows.length === 1 ? '' : 's'}`;
    kbDocsList.innerHTML = rows.map(renderDocRow).join('');
  }

  async function refreshDocuments() {
    const docs = await fetchDocuments();
    renderDocuments(docs);
    return docs;
  }

  function pollUntilSettled(predicate, intervalMs = 1500, timeoutMs = 45000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = async () => {
        if (Date.now() - start >= timeoutMs) { resolve(false); return; }
        const done = await predicate().catch(() => false);
        if (done) { resolve(true); return; }
        setTimeout(tick, intervalMs);
      };
      setTimeout(tick, intervalMs);
    });
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Robust document matching: prefer sourceFileId, fall back to fileName.
  function docMatchesTarget(doc, { fileName, sourceFileId } = {}) {
    const docSourceId = doc.sourceFileId || doc.source_file_id || null;
    if (sourceFileId && docSourceId) return docSourceId === sourceFileId;
    const docName = doc.fileName || doc.file_name || doc.name || null;
    return !!fileName && docName === fileName;
  }

  // Refreshes both documents and ingestion jobs together, keeping onboarding progress in sync.
  async function refreshKnowledgeStatus() {
    // Every call site is a consequence of an upload/import mutation, which can
    // change a collection's documentCount — invalidate so the Collections tab
    // never shows a stale count on its next load.
    PortalCache.invalidate(clientId, memberId, 'collections');
    const [docs, jobs] = await Promise.all([refreshDocuments(), refreshJobs()]);
    if (docs) { loadedDocs = docs; maybeUpdateProgress(); }
    return { docs, jobs };
  }

  // Polls documents + jobs until every target (matched by sourceFileId or fileName) is
  // indexed/failed, or timeoutMs elapses. Returns per-target settle results for the caller.
  async function pollKnowledgeStatusUntilSettled({ fileNames = [], sourceFileIds = [], intervalMs = 1500, timeoutMs = 45000 } = {}) {
    const targets = fileNames.map((fileName, i) => ({ fileName, sourceFileId: sourceFileIds[i] || null }));
    const results = new Map();
    const start = Date.now();

    while (true) {
      const { docs } = await refreshKnowledgeStatus();
      let allSettled = true;
      for (const target of targets) {
        const match = (docs || []).find(d => docMatchesTarget(d, target));
        if (match && (match.status === 'indexed' || match.status === 'failed')) {
          results.set(target.fileName, match);
        } else {
          allSettled = false;
        }
      }
      if (allSettled) return { settled: true, timedOut: false, docs, results };
      if (Date.now() - start >= timeoutMs) return { settled: false, timedOut: true, docs, results };
      await delay(intervalMs);
    }
  }

  function showDocumentsLoadingSkeleton() {
    kbDocsList.innerHTML = `
      <div class="kb-doc-row loading-row">
        <div class="kb-doc-info">
          <div class="skeleton skeleton-line" style="width:52%"></div>
          <div class="skeleton skeleton-line skeleton-line--sm" style="width:28%"></div>
        </div>
        <div class="skeleton" style="width:58px;height:20px;border-radius:99px"></div>
      </div>
      <div class="kb-doc-row loading-row">
        <div class="kb-doc-info">
          <div class="skeleton skeleton-line" style="width:41%"></div>
          <div class="skeleton skeleton-line skeleton-line--sm" style="width:22%"></div>
        </div>
        <div class="skeleton" style="width:58px;height:20px;border-radius:99px"></div>
      </div>`;
  }

  async function loadDocuments() {
    await PortalCache.staleWhileRevalidate({
      clientId, memberId, resource: 'documents', maxAgeMs: CACHE_TTL.documents,
      // fetchDocuments() resolves to null (rather than rejecting) on failure —
      // translate that into a rejection so the cache is never overwritten with
      // a failed result and the SWR helper's "keep cache on failure" logic applies.
      fetchFn: async () => {
        const docs = await fetchDocuments();
        if (docs === null) throw new Error('Failed to load documents');
        return docs;
      },
      onLoading: showDocumentsLoadingSkeleton,
      onData: (docs) => {
        loadedDocs = docs || [];
        renderDocuments(docs);
        maybeUpdateProgress();
      },
      onError: () => {
        loadedDocs = [];
        renderDocuments(null);
        maybeUpdateProgress();
      },
    });
  }

  async function loadSessions() {
    try {
      const res = await fetch('/api/knowledge/chat/sessions', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) { loadedSessions = []; renderSessions([]); maybeUpdateProgress(); return; }
      const data = await res.json();
      chatSessions = (data.sessions || (Array.isArray(data) ? data : [])).filter(s => !s.deleted_at);
      loadedSessions = chatSessions;
      renderSessions(chatSessions);
      maybeUpdateProgress();
    } catch {
      loadedSessions = [];
      renderSessions([]);
      maybeUpdateProgress();
    }
  }

  // ---- Onboarding Progress ----

  function maybeUpdateProgress() {
    if (loadedDocs !== null) {
      renderOnboardingProgress(loadedDocs, loadedSessions || [], loadedAnalytics, loadedMembers);
    }
  }

  function renderOnboardingProgress(docs, sessions, analytics, members) {
    const el = document.getElementById('progress-checklist');
    if (!el) return;

    const hasDoc     = docs.length > 0;
    const hasIndexed = docs.some(d => d.status === 'indexed') ||
                       (analytics ? (analytics.indexedDocuments ?? analytics.indexed_documents ?? 0) > 0 : false);
    const hasSession = sessions.length > 0;
    const hasCitation = analytics
      ? (analytics.totalQuestions ?? analytics.total_questions ?? 0) > 0
      : false;

    const isOwnerAdmin = memberRole === 'owner' || memberRole === 'admin';

    const lastStep = isOwnerAdmin
      ? { label: 'Invite team member',   done: Array.isArray(members) && members.some(m => m.role !== 'owner') }
      : { label: 'Explore chat history', done: hasSession };

    const steps = [
      { label: 'Account created',               done: true },
      { label: 'Upload first document',         done: hasDoc },
      { label: 'Document indexed successfully', done: hasIndexed },
      { label: 'Ask first test question',       done: hasSession },
      { label: 'Verify answer source citation', done: hasCitation },
      lastStep,
    ];

    el.innerHTML = `
      <ul class="progress-steps">
        ${steps.map(s => `
          <li class="progress-step ${s.done ? 'progress-step--done' : 'progress-step--pending'}">
            <span class="progress-icon">${s.done ? '✓' : '○'}</span>
            <span>${escHtml(s.label)}</span>
          </li>
        `).join('')}
      </ul>
    `;
  }

  // ---- Ingestion Jobs ----

  async function fetchJobs() {
    try {
      const res = await fetch('/api/knowledge/jobs', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.jobs || (Array.isArray(data) ? data : []);
    } catch {
      return null;
    }
  }

  async function loadJobs() {
    const jobsList = document.getElementById('kb-jobs-list');
    if (!jobsList) return;
    jobsList.innerHTML = `
      <div class="kb-doc-row loading-row">
        <div class="kb-doc-info">
          <div class="skeleton skeleton-line" style="width:48%"></div>
          <div class="skeleton skeleton-line skeleton-line--sm" style="width:20%"></div>
        </div>
        <div class="skeleton" style="width:58px;height:20px;border-radius:99px"></div>
      </div>
      <div class="kb-doc-row loading-row">
        <div class="kb-doc-info">
          <div class="skeleton skeleton-line" style="width:60%"></div>
        </div>
        <div class="skeleton" style="width:58px;height:20px;border-radius:99px"></div>
      </div>`;

    const jobs = await fetchJobs();
    renderJobs(jobs || []);
  }

  // Like loadJobs(), but skips the loading skeleton — used while polling so the
  // Recent Ingestion Jobs list doesn't flicker on every refresh tick.
  async function refreshJobs() {
    const jobs = await fetchJobs();
    renderJobs(jobs || []);
    return jobs;
  }

  async function loadAnalytics() {
    try {
      const res = await fetch('/api/knowledge/analytics', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) { loadedAnalytics = null; maybeUpdateProgress(); return; }
      loadedAnalytics = await res.json();
      maybeUpdateProgress();
    } catch {
      loadedAnalytics = null;
      maybeUpdateProgress();
    }
  }

  async function loadImportHistory() {
    const listEl = document.getElementById('kb-import-history-list');
    if (!listEl) return;
    try {
      const res = await fetch('/api/knowledge/import-history', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await res.json().catch(() => ({}));
      renderImportHistory(data.batches || []);
    } catch {
      renderImportHistory([]);
    }
  }

  function renderImportHistory(batches) {
    const listEl = document.getElementById('kb-import-history-list');
    if (!listEl) return;

    if (!batches.length) {
      listEl.innerHTML = `
        <div class="empty-state-card">
          <span class="empty-state-icon">📥</span>
          <span class="empty-state-title">No imports yet</span>
          <span class="empty-state-desc">Batches from Upload Files, Import Archive, and Google Drive will appear here.</span>
        </div>`;
      return;
    }

    listEl.innerHTML = batches.map(b => {
      const label = b.sourceLabel || 'Local upload';
      const date = b.createdAt
        ? new Date(b.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : '';
      return `
        <div class="kb-doc-row">
          <div class="kb-doc-info">
            <span class="kb-doc-name">${escHtml(label)}</span>
            <span class="kb-doc-meta">${b.fileCount} document${b.fileCount === 1 ? '' : 's'}${date ? ` · ${date}` : ''}</span>
          </div>
        </div>`;
    }).join('');
  }

  async function loadMembers() {
    await PortalCache.staleWhileRevalidate({
      clientId, memberId, resource: 'teamMembers', maxAgeMs: CACHE_TTL.teamMembers,
      fetchFn: async () => {
        const res = await fetch('/api/team/members', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok) throw new Error('Failed to load members');
        return res.json();
      },
      onData: (members) => {
        loadedMembers = members;
        maybeUpdateProgress();
      },
      onError: () => {
        loadedMembers = [];
        maybeUpdateProgress();
      },
    });
  }

  function renderJobs(jobs) {
    const jobsList = document.getElementById('kb-jobs-list');
    const dismissed = getDismissedJobIds();
    const visible = jobs.filter(job => !dismissed.has(getJobKey(job)));

    if (!visible.length) {
      if (jobsList) jobsList.innerHTML = `
        <div class="empty-state-card">
          <span class="empty-state-icon">⏱</span>
          <span class="empty-state-title">No processing history yet</span>
          <span class="empty-state-desc">Your recent uploads and indexing status will appear here.</span>
        </div>`;
      return;
    }

    const recent = visible.slice(0, 5);
    const html = recent.map(job => {
      const status = job.status || 'unknown';
      const statusClass = {
        completed: 'badge--indexed',
        running:   'badge--indexing',
        queued:    'badge--indexing',
        failed:    'badge--failed',
      }[status] || 'badge--indexing';

      const sourceFileId = job.sourceFileId || job.source_file_id || '';
      const documentId   = job.documentId || job.document_id || '';
      const jobId        = job.id || job.job_id || job.jobId || '';
      const updatedAt    = job.updated_at || job.updatedAt || '';
      const name = job.fileName || job.file_name || sourceFileId || 'Unknown file';
      const date = job.created_at
        ? new Date(job.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : '';
      const jobKey = getJobKey(job);

      const detailRows = [
        jobId        && ['Job ID', jobId],
        sourceFileId && ['Source File ID', sourceFileId],
        documentId   && ['Document ID', documentId],
        job.created_at && ['Created', new Date(job.created_at).toLocaleString()],
        updatedAt    && ['Updated', new Date(updatedAt).toLocaleString()],
        (status === 'failed' && job.error_message) && ['Error', job.error_message],
      ].filter(Boolean).map(([label, value]) => {
        const isError = label === 'Error';
        return `
          <div class="kb-job-detail-row${isError ? ' kb-job-detail-row--error' : ''}">
            <span>${escHtml(label)}</span>
            <span>${escHtml(String(value))}</span>
          </div>`;
      }).join('');

      return `
        <details class="kb-job-row" data-job-key="${escHtml(jobKey)}">
          <summary class="kb-job-summary">
            <div class="kb-doc-info">
              <span class="kb-doc-name" title="${escHtml(name)}">${escHtml(name)}</span>
              ${date ? `<span class="kb-doc-meta">${date}</span>` : ''}
            </div>
            <span class="badge ${statusClass}">${escHtml(status)}</span>
            <button type="button" class="btn-kb-job-dismiss" data-job-key="${escHtml(jobKey)}" title="Dismiss">&times;</button>
          </summary>
          <div class="kb-job-details">
            ${detailRows || '<div class="kb-job-detail-row"><span>No additional details available.</span></div>'}
          </div>
        </details>
      `;
    }).join('');

    if (jobsList) jobsList.innerHTML = html;
  }

  function renderSessions(sessions) {
    if (!sessions.length) {
      kbSessionsList.innerHTML = `
        <div class="empty-state-card empty-state-card--compact">
          <span class="empty-state-title">No chats yet</span>
          <span class="empty-state-desc">Ask your first question after uploading a document.</span>
        </div>`;
      return;
    }
    kbSessionsList.innerHTML = sessions.map(s => {
      const id = s.id || s.session_id || '';
      const title = s.title || 'Chat session';
      const rawDate = s.updated_at || s.created_at || null;
      const dateStr = rawDate
        ? new Date(rawDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : '';
      const isActive = id === currentSessionId ? ' kb-session-item--active' : '';
      return `
        <div class="kb-session-item${isActive}" data-session-id="${escHtml(id)}">
          <span class="kb-session-title" title="${escHtml(title)}">${escHtml(title)}</span>
          ${dateStr ? `<span class="kb-session-date">${escHtml(dateStr)}</span>` : ''}
          <button class="btn-kb-session-rename" data-session-id="${escHtml(id)}" data-title="${escHtml(title)}" title="Rename session">&#9998;</button>
          <button class="btn-kb-session-delete" data-session-id="${escHtml(id)}" title="Delete session">&times;</button>
        </div>
      `;
    }).join('');
  }

  async function loadSessionMessages(sessionId) {
    currentSessionId = sessionId;
    kbMessages.innerHTML = `<div class="empty-state"><span>Loading…</span></div>`;
    updateChatWelcome();
    renderSessions(chatSessions);

    try {
      const res = await fetch(`/api/knowledge/chat/sessions/${encodeURIComponent(sessionId)}/messages`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        kbMessages.innerHTML = `<div class="empty-state"><span>Failed to load messages.</span></div>`;
        updateChatWelcome();
        return;
      }
      const data = await res.json();
      const messages = (data.messages || (Array.isArray(data) ? data : [])).filter(m => !m.deleted_at);
      kbMessages.innerHTML = '';
      messages.forEach(m => {
        const role    = m.role === 'user' ? 'user' : 'assistant';
        const content = m.content || '';
        const sources = role === 'assistant' ? (m.sources || []) : [];
        appendMessage(role, content, sources);
      });
      updateChatWelcome();
    } catch {
      kbMessages.innerHTML = `<div class="empty-state"><span>Failed to load messages.</span></div>`;
      updateChatWelcome();
    }
  }

  async function openChatFromHistory(sessionId) {
    setActiveTab('knowledge');
    await loadSessionMessages(sessionId);
    kbMessages.scrollTop = kbMessages.scrollHeight;
    if (kbQueryInput) kbQueryInput.focus();
  }

  function appendMessage(role, content, sources) {
    const wrap = document.createElement('div');
    wrap.className = `kb-message kb-message--${role}`;

    const bubble = document.createElement('div');
    bubble.className = 'kb-message-bubble';

    if (role === 'assistant') {
      // EL6 (§6.3) — live sources are split out and always shown in their
      // own box when present; shouldShowSourcesBox's inline-"Source:"-line
      // suppression only ever applied to the stored/durable case.
      const allSources = sources || [];
      const liveSources = allSources.filter(isLiveSource);
      const storedSources = allSources.filter(s => !isLiveSource(s));
      const showStoredBox = shouldShowSourcesBox(content, storedSources);

      // EM10.5 Scenario 2 bug fix — when the structured box below is going
      // to render these same sources, drop the model's own inline "Source:"
      // line from the visible bubble text so the citation isn't shown
      // twice. Both boxes are appended as CHILDREN of this bubble (not
      // siblings under wrap) so citations render as part of the same
      // message rather than a visually separate second bubble.
      bubble.textContent = showStoredBox ? stripInlineSourceLine(content) : content;
      wrap.appendChild(bubble);

      if (showStoredBox) {
        bubble.appendChild(buildSourcesBox(storedSources));
      }
      if (liveSources.length > 0) {
        bubble.appendChild(buildLiveSourcesBox(liveSources));
      }
    } else {
      bubble.textContent = content;
      wrap.appendChild(bubble);
    }

    kbMessages.appendChild(wrap);
    kbMessages.scrollTop = kbMessages.scrollHeight;
    updateChatWelcome();
  }

  function showGapCard(body, originalQuery) {
    const card = document.createElement('div');
    card.className = 'kb-gap-card';

    const label = document.createElement('span');
    label.className = 'kb-gap-card__label';
    label.textContent = 'Knowledge gap detected';
    card.appendChild(label);

    const desc = document.createElement('p');
    desc.className = 'kb-gap-card__text';
    desc.textContent = 'No approved documentation was found for this question. Save it for review?';
    card.appendChild(desc);

    const actions = document.createElement('div');
    actions.className = 'kb-gap-card__actions';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'kb-gap-card__btn kb-gap-card__btn--save';
    saveBtn.textContent = 'Save gap';

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'kb-gap-card__btn kb-gap-card__btn--dismiss';
    dismissBtn.textContent = 'Dismiss';

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        const r = await fetch('/api/knowledge/gaps', {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: body.sessionId,
            messageId: body.userMessageId || null,
            question: originalQuery,
            reason: body.gapReason,
          }),
        });
        if (r.ok) {
          card.innerHTML = '';
          const saved = document.createElement('span');
          saved.className = 'kb-gap-card__saved';
          saved.textContent = 'Saved for review.';
          card.appendChild(saved);
        } else {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save gap';
          let errEl = card.querySelector('.kb-gap-card__error');
          if (!errEl) {
            errEl = document.createElement('span');
            errEl.className = 'kb-gap-card__error';
            card.appendChild(errEl);
          }
          errEl.textContent = 'Failed to save. Try again.';
        }
      } catch {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save gap';
      }
    });

    dismissBtn.addEventListener('click', () => card.remove());

    actions.appendChild(saveBtn);
    actions.appendChild(dismissBtn);
    card.appendChild(actions);

    kbMessages.appendChild(card);
    kbMessages.scrollTop = kbMessages.scrollHeight;
  }

  // EM10 (EMAIL_INGESTION.md §23) — the pure shaping logic (grouping,
  // suppression rules, date formatting) lives in portalCitations.js, loaded
  // as a separate <script> before this file (portal.html) so it's directly
  // unit-testable via node:test without a DOM, mirroring portalCache.js's
  // existing split. Only the DOM-building below stays in this file.
  const { shouldShowSourcesBox, isEmailSource, isLiveSource, citationDate, formatCitationDate, groupSourcesForDisplay, stripInlineSourceLine } = PortalCitations;

  // EL6 (§6.2, §6.3) — `live` adds the small "🔴 Live" badge and reads
  // citationDate (sentAt for stored, receivedAt for live) instead of
  // sentAt directly, so this one function renders both citation kinds.
  function renderEmailCitationLine(s) {
    const li = document.createElement('li');
    if (isLiveSource(s)) {
      const badge = document.createElement('span');
      badge.className = 'kb-live-badge';
      badge.textContent = '🔴 Live';
      li.appendChild(badge);
    }
    const subject = s.subject || '(no subject)';
    const from = s.from || 'unknown sender';
    const date = formatCitationDate(citationDate(s));
    // EM10.8 (EMAIL_INGESTION.md §23) — contributor attribution: whose
    // connection actually contributed this message, as distinct from
    // `from` (the message's original sender) — not always the same
    // person. Resolved server-side (citationAttributionService); this file
    // only ever renders the already-resolved name. Shown before the
    // deep link specifically so a member knows, before clicking "Open in
    // Gmail", whether it's even their own mailbox that link will try to
    // open.
    const attribution = typeof s.contributingMemberName === 'string' && s.contributingMemberName.trim()
      ? ` — via ${s.contributingMemberName.trim()}'s mailbox`
      : '';
    li.appendChild(document.createTextNode(`Email — "${subject}" from ${from}${date ? `, ${date}` : ''}${attribution}`));
    if (s.deepLinkUrl) {
      li.appendChild(document.createTextNode(' — '));
      const link = document.createElement('a');
      link.href = s.deepLinkUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'kb-message-sources-link';
      link.textContent = 'Open in Gmail';
      li.appendChild(link);
    }
    return li;
  }

  // EL6 (§6.3) — "Live sources" get their own visually distinct box,
  // deliberately never merged into buildSourcesBox's "Sources" list below —
  // a live result is fresher and can change or disappear, unlike a durable
  // ingested citation.
  function buildLiveSourcesBox(liveSources) {
    const box = document.createElement('div');
    box.className = 'kb-message-live-sources';
    const label = document.createElement('span');
    label.className = 'kb-message-sources-label';
    label.textContent = 'Live sources';
    box.appendChild(label);

    const ul = document.createElement('ul');
    groupSourcesForDisplay(liveSources).forEach(group => {
      if (group.length > 1) {
        const heading = document.createElement('li');
        heading.className = 'kb-message-sources-thread-heading';
        heading.textContent = `${group.length} messages in this thread matched`;
        ul.appendChild(heading);
        const nested = document.createElement('ul');
        nested.className = 'kb-message-sources-thread-list';
        group.forEach(s => nested.appendChild(renderEmailCitationLine(s)));
        const nestedWrap = document.createElement('li');
        nestedWrap.appendChild(nested);
        ul.appendChild(nestedWrap);
      } else {
        ul.appendChild(renderEmailCitationLine(group[0]));
      }
    });
    box.appendChild(ul);
    return box;
  }

  function buildSourcesBox(sources) {
    const srcBox = document.createElement('div');
    srcBox.className = 'kb-message-sources';
    const label = document.createElement('span');
    label.className = 'kb-message-sources-label';
    label.textContent = 'Sources';
    srcBox.appendChild(label);

    const ul = document.createElement('ul');
    groupSourcesForDisplay(sources).forEach(group => {
      if (isEmailSource(group[0])) {
        if (group.length > 1) {
          const heading = document.createElement('li');
          heading.className = 'kb-message-sources-thread-heading';
          heading.textContent = `${group.length} messages in this thread matched`;
          ul.appendChild(heading);
          const nested = document.createElement('ul');
          nested.className = 'kb-message-sources-thread-list';
          group.forEach(s => nested.appendChild(renderEmailCitationLine(s)));
          const nestedWrap = document.createElement('li');
          nestedWrap.appendChild(nested);
          ul.appendChild(nestedWrap);
        } else {
          ul.appendChild(renderEmailCitationLine(group[0]));
        }
        return;
      }

      const s = group[0];
      const name = typeof s === 'string' ? s : (s.fileName || s.file_name || s.name || String(s));
      let display = name;
      if (s && s.pages && s.pages.length > 0) {
        const prefix = s.pages.length === 1 ? 'p.' : 'pp.';
        display = `${name} — ${prefix} ${s.pages.join(', ')}`;
      }
      const li = document.createElement('li');
      li.textContent = display;
      ul.appendChild(li);
    });
    srcBox.appendChild(ul);
    return srcBox;
  }

  function renderDocRow(doc) {
    const status = doc.status || 'indexing';
    const badgeClass = { indexing: 'badge--indexing', failed: 'badge--failed' }[status];
    const badge = badgeClass ? `<span class="badge ${badgeClass}">${escHtml(status)}</span>` : '';

    const fileName = doc.fileName || doc.file_name || doc.name || 'Untitled';
    const sourceFileId = doc.sourceFileId || doc.source_file_id || '';

    // Source label / folder path / imported date — portal-specific import context merged
    // onto the AIKB document by GET /knowledge/documents. AIKB's own fileName/status stay
    // authoritative; this is purely additive display metadata.
    const sourceLabel = doc.sourceLabel || 'Local upload';
    let folderPath = '';
    if (doc.sourceType === 'folder_upload' && doc.sourcePath) {
      const segments = doc.sourcePath.split('/');
      segments.pop(); // drop the trailing filename segment — it's already the row title
      folderPath = segments.join('/');
    }
    const importedRaw = doc.importedAt || doc.created_at;
    const importedDate = importedRaw
      ? new Date(importedRaw).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : '';
    const metaParts = [sourceLabel];
    if (folderPath) metaParts.push(folderPath);
    if (importedDate) metaParts.push(`Imported ${importedDate}`);
    const sourceMeta = metaParts.map(escHtml).join(' · ');

    let deleteBtn = '';
    if (!doc._isPending) {
      if (sourceFileId) {
        deleteBtn = `<button class="btn-kb-delete" data-source-id="${escHtml(sourceFileId)}" data-name="${escHtml(fileName)}">Delete</button>`;
      } else {
        console.warn('[portal] renderDocRow: missing sourceFileId for document', fileName, doc);
        deleteBtn = `<button class="btn-kb-delete" disabled title="Cannot delete: document identifier is missing">Delete</button>`;
      }
    }

    // Milestone 5: move-to-collection control — owner/admin only, and only
    // once the org's collection list is known (loadedCollections is set by
    // initCollectionsSection, which only runs for owner/admin).
    let collectionSelect = '';
    if (!doc._isPending && sourceFileId && isOwnerAdmin && Array.isArray(loadedCollections) && loadedCollections.length) {
      const currentCollectionId = doc.collectionId || doc.collection_id || '';
      const options = loadedCollections.map((c) =>
        `<option value="${escHtml(c.id)}"${c.id === currentCollectionId ? ' selected' : ''}>${escHtml(c.name)}</option>`
      ).join('');
      collectionSelect = `<select class="doc-collection-select" data-source-id="${escHtml(sourceFileId)}" title="Move to collection">${options}</select>`;
    }

    return `
      <div class="kb-doc-row">
        <div class="kb-doc-info">
          <span class="kb-doc-name" title="${escHtml(fileName)}">${escHtml(fileName)}</span>
          <span class="kb-doc-meta">${sourceMeta}</span>
        </div>
        ${badge}
        ${collectionSelect}
        ${deleteBtn}
      </div>
    `;
  }

  // Uploads a single file to /api/knowledge/upload and polls until it settles.
  // UI-agnostic w.r.t. shared button/status state — callers own kbUploadBtn/kbUploadStatus.
  // Returns { status: 'ok'|'limit'|'error'|'timeout', message?, sourceFileId?, indexStatus? }.
  async function uploadOneFile(file, { relativePath, batchId, sourceType } = {}) {
    showUploadPhase('Preparing upload…', 0, file.name);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('relativePath', relativePath || file.name);
    if (batchId) formData.append('importBatchId', batchId);
    if (sourceType) formData.append('sourceType', sourceType);

    let result;
    try {
      result = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = Math.min(Math.round((e.loaded / e.total) * 100), 99);
            showUploadPhase('Uploading…', pct, file.name);
          }
        };

        xhr.onload = () => {
          try {
            resolve({ status: xhr.status, body: JSON.parse(xhr.responseText) });
          } catch {
            resolve({ status: xhr.status, body: {} });
          }
        };

        xhr.onerror = () => reject(new Error('Network error. Please try again.'));

        xhr.open('POST', '/api/knowledge/upload');
        xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);
        xhr.send(formData);
      });
    } catch (err) {
      return { status: 'error', message: err.message || 'Network error. Please try again.' };
    }

    if (result.status === 429) {
      return { status: 'limit', message: result.body.error || 'Document limit reached.' };
    }
    if (result.status < 200 || result.status >= 300) {
      return { status: 'error', message: result.body.error || 'Upload failed. Please try again.' };
    }

    showUploadPhase('Processing document…', 100, file.name);
    const sourceFileId = result.body.sourceFileId || result.body.source_file_id || null;
    pendingUploads.set(file.name, { fileName: file.name, sourceFileId });
    await refreshKnowledgeStatus();

    showUploadPhase('Indexing in knowledge base…', 100, file.name);

    const { settled, results } = await pollKnowledgeStatusUntilSettled({
      fileNames: [file.name],
      sourceFileIds: [sourceFileId],
    });
    pendingUploads.delete(file.name);

    if (!settled) {
      showUploadPhase('Indexing is taking longer than expected…', 100, file.name);
      return { status: 'timeout', sourceFileId };
    }

    showUploadPhase('Ready in knowledge base.', 100, file.name);
    return { status: 'ok', sourceFileId, indexStatus: results.get(file.name)?.status };
  }

  // Thin single-file wrapper — preserves the exact pre-refactor single-file UX/messages.
  async function uploadDocument(file) {
    kbUploadStatus.hidden = true;
    kbUploadStatus.textContent = '';
    kbUploadStatus.className = 'kb-upload-status';
    kbUploadBtn.disabled = true;

    try {
      const r = await uploadOneFile(file);

      if (r.status === 'limit' || r.status === 'error') {
        kbUploadStatus.textContent = r.message;
        kbUploadStatus.className   = 'kb-upload-status kb-upload-status--error';
        kbUploadStatus.hidden      = false;
      } else if (r.status === 'timeout') {
        showBanner('error', 'Indexing is taking longer than expected. Refresh in a moment.');
      } else {
        kbUploadStatus.textContent = `"${file.name}" is ready in your knowledge base.`;
        kbUploadStatus.className   = 'kb-upload-status kb-upload-status--success';
        kbUploadStatus.hidden      = false;
      }

      await refreshKnowledgeStatus();
      loadImportHistory();
      await delay(900);
    } catch (err) {
      kbUploadStatus.textContent = err.message || 'Network error. Please try again.';
      kbUploadStatus.className   = 'kb-upload-status kb-upload-status--error';
      kbUploadStatus.hidden      = false;
    } finally {
      hideUploadPanel();
      kbUploadBtn.disabled = false;
    }
  }

  // Multi-file / folder upload — concurrency-2 worker pool over uploadOneFile, continues on
  // individual failure. One batchId per call (reused across a retry so everything traces
  // back to the same logical import). `priorImported` lets a retry-failed-only call produce
  // a cumulative summary instead of resetting counts; failed entries retain their actual
  // File object so "Retry failed" has something to resend.
  async function uploadMultipleFiles(fileArray, { batchId, priorImported = [], sourceType, triggerBtn } = {}) {
    const btn = triggerBtn || kbUploadBtn;
    const effectiveBatchId = batchId || crypto.randomUUID();
    btn.disabled = true;
    kbUploadStatus.hidden = true;
    kbUploadStatus.className = 'kb-upload-status';
    hideImportResult();

    const total = fileArray.length;
    let doneCount = 0;
    const imported = [...priorImported];
    const failed = [];

    showImportStatus(`Uploading file 1 of ${total}…`);

    let nextIndex = 0;
    async function worker() {
      while (nextIndex < fileArray.length) {
        const i = nextIndex++;
        const item = fileArray[i];
        const relativePath = item.webkitRelativePath || item.name;
        showImportStatus(`Uploading file ${Math.min(doneCount + 1, total)} of ${total}: "${item.name}"…`);
        const r = await uploadOneFile(item, { relativePath, batchId: effectiveBatchId, sourceType });
        doneCount++;
        if (r.status === 'ok' && r.indexStatus !== 'failed') {
          imported.push({ fileName: item.name, sourceFileId: r.sourceFileId });
        } else {
          failed.push({
            fileName: item.name,
            reason: r.message || (r.status === 'timeout' ? 'Indexing is taking longer than expected' : 'Indexing failed'),
            file: item,
          });
        }
        showImportStatus(`Uploaded ${doneCount} of ${total} file${total > 1 ? 's' : ''}…`);
      }
    }

    const CONCURRENCY = 2;
    try {
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
      const onRetry = failed.length > 0
        ? () => uploadMultipleFiles(failed.map(f => f.file), {
            batchId: effectiveBatchId,
            priorImported: imported,
            sourceType,
            triggerBtn: btn,
          })
        : null;
      await finishImportResult({ imported, skipped: [], failed, onRetry });
    } finally {
      hideUploadPanel();
      hideImportStatus();
      btn.disabled = false;
    }
  }

  // Archive import — one request to the server, which extracts + ingests entries itself and
  // returns the aggregated {imported, skipped, failed} shape directly; we only poll + render.
  // One batchId per archive submission, reused for a retry so both attempts trace back to the
  // same logical import. Retry re-sends the whole file (extracted bytes aren't kept server-side
  // between requests) but asks the server to only reprocess the previously-failed paths.
  async function uploadZipFile(file, { batchId, retryOnly, priorImported = [] } = {}) {
    const effectiveBatchId = batchId || crypto.randomUUID();
    kbZipBtn.disabled = true;
    kbUploadStatus.hidden = true;
    kbUploadStatus.className = 'kb-upload-status';
    hideImportResult();
    showImportStatus(`Processing archive "${file.name}"…`);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('importBatchId', effectiveBatchId);
    if (retryOnly) formData.append('retryOnly', JSON.stringify(retryOnly));

    try {
      const res = await fetch('/api/knowledge/import-zip', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: formData,
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        kbUploadStatus.textContent = body.error || 'Archive import failed. Please try again.';
        kbUploadStatus.className = 'kb-upload-status kb-upload-status--error';
        kbUploadStatus.hidden = false;
        return;
      }

      const imported = [...priorImported, ...(body.imported || [])];
      const skipped  = body.skipped || [];
      const failed   = [...(body.failed || [])];

      body.imported?.forEach(f => pendingUploads.set(f.fileName, { fileName: f.fileName, sourceFileId: f.sourceFileId }));
      await refreshKnowledgeStatus();

      let settledImported = imported;
      if (body.imported?.length > 0) {
        showImportStatus(`Indexing ${body.imported.length} imported document${body.imported.length === 1 ? '' : 's'}…`);
        const { results } = await pollKnowledgeStatusUntilSettled({
          fileNames: body.imported.map(f => f.fileName),
          sourceFileIds: body.imported.map(f => f.sourceFileId),
        });
        body.imported.forEach(f => pendingUploads.delete(f.fileName));

        settledImported = imported.filter(f => results.get(f.fileName)?.status !== 'failed');
        body.imported
          .filter(f => results.get(f.fileName)?.status === 'failed')
          .forEach(f => failed.push({ fileName: f.fileName, reason: 'Indexing failed', relativePath: f.relativePath }));
      }

      const onRetry = failed.length > 0
        ? () => uploadZipFile(file, {
            batchId: effectiveBatchId,
            priorImported: settledImported,
            retryOnly: failed.map(f => f.relativePath || f.fileName),
          })
        : null;

      await finishImportResult({ imported: settledImported, skipped, failed, onRetry });
    } catch (err) {
      kbUploadStatus.textContent = err.message || 'Network error. Please try again.';
      kbUploadStatus.className = 'kb-upload-status kb-upload-status--error';
      kbUploadStatus.hidden = false;
    } finally {
      hideUploadPanel();
      hideImportStatus();
      kbZipBtn.disabled = false;
    }
  }

  // Shared result-handling tail for every multi-outcome import source (local multi-file,
  // archive import, Google Drive) — renders the aggregate status + Import Complete card,
  // refreshes knowledge status, and refreshes the Recent Imports history.
  async function finishImportResult({ imported = [], skipped = [], failed = [], onRetry = null }) {
    const importedCount = imported.length;

    const parts = [];
    if (importedCount > 0) parts.push(`Imported ${importedCount} document${importedCount === 1 ? '' : 's'}`);
    if (skipped.length)    parts.push(`Skipped ${skipped.length} unsupported file${skipped.length === 1 ? '' : 's'}`);
    if (failed.length)     parts.push(`Failed ${failed.length} file${failed.length === 1 ? '' : 's'}`);

    kbUploadStatus.textContent = parts.length ? `${parts.join('. ')}.` : 'No files were imported.';
    kbUploadStatus.className = 'kb-upload-status' + (failed.length ? ' kb-upload-status--error' : ' kb-upload-status--success');
    kbUploadStatus.hidden = false;

    renderImportResult({ importedCount, skipped, failed, onRetry });

    await refreshKnowledgeStatus();
    loadImportHistory();
    await delay(900);
  }

  function renderImportResult({ importedCount = 0, skipped = [], failed = [], onRetry = null }) {
    const details  = document.getElementById('kb-import-result');
    const counts   = document.getElementById('kb-import-result-counts');
    const list     = document.getElementById('kb-import-summary');
    const retryBtn = document.getElementById('kb-import-retry-btn');
    if (!details || !counts || !list) return;

    if (importedCount === 0 && skipped.length === 0 && failed.length === 0) {
      details.hidden = true;
      list.innerHTML = '';
      if (retryBtn) retryBtn.hidden = true;
      return;
    }

    const parts = [`✓ ${importedCount}`];
    if (skipped.length) parts.push(`Skipped ${skipped.length}`);
    if (failed.length)  parts.push(`Failed ${failed.length}`);
    counts.textContent = parts.join(' · ');

    const rows = [];
    skipped.forEach(s => rows.push(
      `<li class="kb-import-summary-item--skipped">Skipped "${escHtml(s.fileName)}" — ${escHtml(s.reason || 'unsupported')}</li>`));
    failed.forEach(f => rows.push(
      `<li class="kb-import-summary-item--failed">Failed "${escHtml(f.fileName)}"${f.reason ? ` — ${escHtml(f.reason)}` : ''}</li>`));
    list.innerHTML = rows.join('');
    details.hidden = false;

    if (retryBtn) {
      if (onRetry) {
        retryBtn.hidden = false;
        retryBtn.onclick = () => { retryBtn.disabled = true; onRetry(); };
        retryBtn.disabled = false;
      } else {
        retryBtn.hidden = true;
        retryBtn.onclick = null;
      }
    }
  }

  function hideImportResult() {
    const details = document.getElementById('kb-import-result');
    if (details) details.hidden = true;
    const list = document.getElementById('kb-import-summary');
    if (list) list.innerHTML = '';
    const retryBtn = document.getElementById('kb-import-retry-btn');
    if (retryBtn) retryBtn.hidden = true;
  }

  function showUploadPhase(phase, pct, fileName) {
    const panel   = document.getElementById('upload-progress-panel');
    const bar     = document.getElementById('upload-progress-bar');
    const pctEl   = document.getElementById('upload-percent-text');
    const phaseEl = document.getElementById('upload-phase-text');
    const nameEl  = document.getElementById('upload-file-name');
    if (!panel) return;
    if (nameEl)  nameEl.textContent  = fileName;
    if (bar)     bar.style.width     = `${pct}%`;
    if (pctEl)   pctEl.textContent   = `${pct}%`;
    if (phaseEl) phaseEl.textContent = phase;
    panel.hidden = false;
  }

  function hideUploadPanel() {
    const panel = document.getElementById('upload-progress-panel');
    if (panel) panel.hidden = true;
  }

  // ---- Google Drive one-shot import ----

  async function loadPickerConfig() {
    try {
      const res = await fetch('/api/google-drive/picker-config', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res.ok) _pickerConfig = await res.json();
    } catch { /* non-fatal — button will show a banner if config missing */ }
  }

  function initPicker(callback) {
    gapi.load('picker', () => {
      _gapiPickerLoaded = true;
      if (_gisInited) callback();
    });
    _tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: _pickerConfig.clientId,
      scope: 'https://www.googleapis.com/auth/drive.readonly',
      callback: (response) => {
        if (response.access_token) openPicker(response.access_token);
      },
    });
    _gisInited = true;
    if (_gapiPickerLoaded) callback();
  }

  function openPicker(tempToken) {
    const docsView = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setMimeTypes([
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'text/plain',
        'text/markdown',
      ].join(','));

    new google.picker.PickerBuilder()
      .addView(docsView)
      .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
      .setOAuthToken(tempToken)
      .setDeveloperKey(_pickerConfig.apiKey)
      .setCallback((data) => {
        if (data.action === google.picker.Action.PICKED) {
          importFromGoogleDrive(data.docs, tempToken);
        }
      })
      .build()
      .setVisible(true);
  }

  async function importFromGoogleDrive(docs, tempToken) {
    kbGdriveBtn.disabled = true;
    kbUploadStatus.hidden = true;
    kbUploadStatus.className = 'kb-upload-status';
    hideImportResult();

    const files = docs.map(d => ({ id: d.id, name: d.name, mimeType: d.mimeType }));
    const total = files.length;
    const batchId = crypto.randomUUID();

    const imported = [];       // { fileName, sourceFileId } — successfully requested imports
    const importErrors = [];   // fileNames that failed the import request itself

    try {
      for (let i = 0; i < total; i++) {
        const file = files[i];
        showImportStatus(`Importing file ${i + 1} of ${total}: “${file.name}”…`);

        try {
          const res = await fetch('/api/google-drive/import', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${accessToken}`,
              'X-Google-Access-Token': tempToken,
            },
            body: JSON.stringify({ files: [file], importBatchId: batchId }),
          });
          const body = await res.json().catch(() => ({}));

          if (!res.ok) {
            importErrors.push(file.name);
            continue;
          }

          const entry = (body.imported && body.imported[0]) || {};
          const sourceFileId = entry.sourceFileId || entry.source_file_id || null;

          // Show a pending placeholder row immediately for this file
          pendingUploads.set(file.name, { fileName: file.name, sourceFileId });
          imported.push({ fileName: file.name, sourceFileId });
          await refreshKnowledgeStatus();
        } catch {
          importErrors.push(file.name);
        }
      }

      const failed = importErrors.map(name => ({ fileName: name, reason: 'Import failed' }));
      let settledImported = imported;

      if (imported.length > 0) {
        showImportStatus('Indexing imported documents…');

        const { results } = await pollKnowledgeStatusUntilSettled({
          fileNames: imported.map(f => f.fileName),
          sourceFileIds: imported.map(f => f.sourceFileId),
        });

        imported.forEach(f => pendingUploads.delete(f.fileName));

        settledImported = imported.filter(f => results.get(f.fileName)?.status !== 'failed');
        imported
          .filter(f => results.get(f.fileName)?.status === 'failed')
          .forEach(f => failed.push({ fileName: f.fileName, reason: 'Indexing failed' }));

        const stillPending = imported.filter(f => !results.get(f.fileName));
        if (stillPending.length > 0) {
          showBanner('error', `Still indexing: ${stillPending.map(f => f.fileName).join(', ')}. Refresh again in a moment.`);
          settledImported = settledImported.filter(f => results.get(f.fileName));
        }
      }

      await finishImportResult({ imported: settledImported, skipped: [], failed });
    } catch (err) {
      kbUploadStatus.textContent = err.message || 'Network error. Please try again.';
      kbUploadStatus.className = 'kb-upload-status kb-upload-status--error';
      kbUploadStatus.hidden = false;
    } finally {
      hideImportStatus();
      kbGdriveBtn.disabled = false;
    }
  }

  function showImportStatus(message) {
    const panel   = document.getElementById('upload-progress-panel');
    const phaseEl = document.getElementById('upload-phase-text');
    const nameEl  = document.getElementById('upload-file-name');
    const barEl   = document.getElementById('upload-progress-bar');
    const pctEl   = document.getElementById('upload-percent-text');
    if (panel)   panel.hidden        = false;
    if (phaseEl) phaseEl.textContent = message;
    if (nameEl)  nameEl.textContent  = '';
    if (barEl)   barEl.style.width   = '100%';
    if (pctEl)   pctEl.textContent   = '';
  }

  function hideImportStatus() {
    const panel = document.getElementById('upload-progress-panel');
    if (panel) panel.hidden = true;
  }

  // ---- Voice input: recording ----

  function isVoiceInputSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  }

  function pickRecorderMimeType() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus',
      'audio/ogg',
    ];
    return candidates.find(type => window.MediaRecorder.isTypeSupported(type)) || '';
  }

  function formatElapsed(ms) {
    const totalSec = Math.floor(ms / 1000);
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }

  function showMicNotice(message, { isError = true } = {}) {
    kbMicError.textContent = message;
    kbMicError.classList.toggle('kb-mic-error--notice', !isError);
    kbMicError.hidden = false;
    clearTimeout(showMicNotice._t);
    showMicNotice._t = setTimeout(() => { kbMicError.hidden = true; }, 5000);
  }

  // ---- Voice input: UI state ----

  function setMicState(next) {
    micState = next;
    kbMicBtn.classList.toggle('is-recording', next === 'recording');
    kbMicBtn.setAttribute('aria-pressed', String(next === 'recording'));
    kbMicBtn.disabled = next === 'transcribing';

    const label = next === 'recording' ? 'Stop recording'
      : next === 'transcribing' ? 'Transcribing…'
      : 'Record voice question';
    kbMicBtn.title = label;
    kbMicBtn.setAttribute('aria-label', label);

    // Don't let a question be submitted while a transcript is still being
    // recorded/produced. askQuestion() independently disables kbMicBtn
    // while a typed question is in flight, so the two guard each other.
    if (next !== 'idle') {
      kbAskBtn.disabled = true;
    } else if (!kbAskBtn.dataset.askInFlight) {
      kbAskBtn.disabled = false;
    }
  }

  // ---- Voice input: elapsed timer ----

  function startRecordingTimer() {
    recordingStartedAt = Date.now();
    kbMicTimer.hidden = false;
    kbMicTimer.textContent = '0:00';
    recordingTimerId = setInterval(() => {
      kbMicTimer.textContent = formatElapsed(Date.now() - recordingStartedAt);
    }, 1000);
  }

  function stopRecordingTimer() {
    clearInterval(recordingTimerId);
    recordingTimerId = null;
    kbMicTimer.hidden = true;
    kbMicTimer.textContent = '0:00';
  }

  // ---- Voice input: permission + recording ----

  async function resolveMicPermission() {
    if (!navigator.permissions || !navigator.permissions.query) return 'unknown';
    try {
      const status = await navigator.permissions.query({ name: 'microphone' });
      return status.state; // 'granted' | 'denied' | 'prompt'
    } catch {
      return 'unknown'; // e.g. Safari doesn't support the 'microphone' permission name
    }
  }

  async function startRecording() {
    if (!isVoiceInputSupported()) {
      showMicNotice('Voice input is not supported in this browser.');
      return;
    }

    const permissionState = await resolveMicPermission();
    if (permissionState === 'denied' || micPermissionDenied) {
      showMicNotice('Microphone access is disabled. Please enable microphone permissions in your browser settings.');
      return;
    }

    const mimeType = pickRecorderMimeType();
    if (!mimeType) {
      showMicNotice('Voice input is not supported in this browser.');
      return;
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        micPermissionDenied = true;
        showMicNotice('Microphone access is disabled. Please enable microphone permissions in your browser settings.');
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        showMicNotice('No microphone was found on this device.');
      } else {
        showMicNotice('Could not access the microphone. Please try again.');
      }
      return;
    }

    recordedChunks = [];
    try {
      mediaRecorder = new MediaRecorder(stream, { mimeType });
    } catch {
      stream.getTracks().forEach(t => t.stop());
      showMicNotice('Voice input is not supported in this browser.');
      return;
    }

    mediaRecorder.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    });

    let stoppedByTimeout = false;
    mediaRecorder.addEventListener('stop', () => {
      stream.getTracks().forEach(t => t.stop());
      stopRecordingTimer();
      clearTimeout(recordingTimeoutId);
      handleRecordingStopped(mimeType, stoppedByTimeout);
    });

    mediaRecorder.start();
    setMicState('recording');
    startRecordingTimer();

    recordingTimeoutId = setTimeout(() => {
      stoppedByTimeout = true;
      stopRecording();
    }, MAX_RECORDING_MS);
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
  }

  // ---- Voice input: upload + transcribe (isolated so a future streaming mode can replace just this) ----

  async function uploadAndTranscribe(blob, ext) {
    const formData = new FormData();
    formData.append('audio', blob, `recording.${ext}`);

    const res = await fetch('/api/voice/transcribe', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: formData,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.text) {
      throw new Error(body.error || 'Transcription failed. Please try again.');
    }
    return body.text;
  }

  async function handleRecordingStopped(mimeType, stoppedByTimeout) {
    setMicState('transcribing');

    const blob = new Blob(recordedChunks, { type: mimeType });
    recordedChunks = [];

    if (!blob.size) {
      setMicState('idle');
      showMicNotice('No audio recorded. Please try again.');
      return;
    }

    const ext = (mimeType.split(';')[0].split('/')[1]) || 'webm';

    try {
      const text = await uploadAndTranscribe(blob, ext);
      insertTranscript(text);
      if (stoppedByTimeout) {
        showMicNotice('Maximum recording length (2:00) reached.', { isError: false });
      }
    } catch (err) {
      showMicNotice(err.message || 'Transcription failed. Please try again.');
    }

    setMicState('idle');
  }

  // ---- Voice input: transcript insertion ----

  function insertTranscript(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    kbQueryInput.value = kbQueryInput.value.trim()
      ? `${kbQueryInput.value.trim()} ${trimmed}`
      : trimmed;
    adjustQueryHeight();
    kbQueryInput.focus();
  }

  async function loadKbCollectionsFilter() {
    if (!kbCollectionsFilterList) return;
    try {
      const res = await fetch('/api/collections', { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) throw new Error('failed to load');
      const { collections } = await res.json();

      // Nothing meaningful to filter by (no collections, or just the
      // single default one) — keep the control hidden, chat stays
      // unrestricted exactly as before this feature existed.
      if (!collections || collections.length <= 1) {
        if (kbCollectionsFilterDetails) kbCollectionsFilterDetails.hidden = true;
        return;
      }

      if (kbCollectionsFilterDetails) kbCollectionsFilterDetails.hidden = false;
      const allowedSet = kbAllowedCollectionIds ? new Set(kbAllowedCollectionIds) : null;
      kbCollectionsFilterList.innerHTML = collections.map((c) => `
        <label class="slack-collection-option">
          <input type="checkbox" value="${escHtml(c.id)}" ${!allowedSet || allowedSet.has(c.id) ? 'checked' : ''} />
          ${escHtml(c.name)}
        </label>
      `).join('');
      updateKbCollectionsFilterLabel(collections.length);

      kbCollectionsFilterList.querySelectorAll('input[type="checkbox"]').forEach((box) => {
        box.addEventListener('change', () => {
          const checked = Array.from(kbCollectionsFilterList.querySelectorAll('input[type="checkbox"]:checked')).map((el) => el.value);
          kbAllowedCollectionIds = checked.length === collections.length ? null : checked;
          try {
            if (kbAllowedCollectionIds === null) localStorage.removeItem(KB_COLLECTIONS_FILTER_KEY);
            else localStorage.setItem(KB_COLLECTIONS_FILTER_KEY, JSON.stringify(kbAllowedCollectionIds));
          } catch { /* storage unavailable — selection just won't persist across reloads */ }
          updateKbCollectionsFilterLabel(collections.length);
        });
      });
    } catch {
      kbCollectionsFilterList.innerHTML = '<span class="kb-doc-meta">Could not load collections.</span>';
    }
  }

  function updateKbCollectionsFilterLabel(totalCount) {
    if (!kbCollectionsFilterLabel) return;
    kbCollectionsFilterLabel.textContent = kbAllowedCollectionIds
      ? `${kbAllowedCollectionIds.length} of ${totalCount}`
      : 'All collections';
  }

  loadKbCollectionsFilter();

  // EL6 (LIVE_EMAIL_LOOKUP.md §2.1) originally exposed a three-way mode
  // selector here (`Automatic` / `Company knowledge only` / `Live email`,
  // localStorage-persisted per client). Per §2.2's confirmed long-term
  // direction, the selector is no longer exposed in the standard client UI —
  // every query silently uses `automatic`, the canonical value routes/api.js
  // already defaults to for a missing/invalid `emailLookupMode`. The
  // underlying `company_knowledge`/`live_email` modes are untouched
  // server-side and remain available to the automatic router.
  const kbEmailLookupMode = 'automatic';
  let liveLookupConsentedAt = null;
  let hasActiveGmailConnection = false;

  function openLiveLookupConsentModal() {
    if (liveLookupConsentModal) liveLookupConsentModal.hidden = false;
  }
  function closeLiveLookupConsentModal() {
    if (liveLookupConsentModal) liveLookupConsentModal.hidden = true;
  }

  if (liveLookupConsentAccept) {
    liveLookupConsentAccept.addEventListener('click', async () => {
      liveLookupConsentAccept.disabled = true;
      try {
        const res = await fetch('/api/integrations/email/live-lookup-settings', {
          method: 'PUT',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ consent: true }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok) liveLookupConsentedAt = body.consentedAt || new Date().toISOString();
      } catch { /* consent modal simply reappears next attempt — server stays fail-closed either way */ }
      liveLookupConsentAccept.disabled = false;
      closeLiveLookupConsentModal();
    });
  }
  if (liveLookupConsentDecline) {
    liveLookupConsentDecline.addEventListener('click', () => closeLiveLookupConsentModal());
  }
  if (liveLookupConsentModal) {
    liveLookupConsentModal.addEventListener('click', (e) => { if (e.target === liveLookupConsentModal) closeLiveLookupConsentModal(); });
  }

  // §2.3 — trigger: the first time Automatic/Live email mode would actually
  // attempt a mailbox search for this member. Approximated here as "the
  // first time a mode allowing live lookup is active and a question is
  // about to be sent," not a deeper per-question intent check the portal
  // has no way to run client-side — the server-side consent gate
  // (services/emailLiveLookupService.js) is what's actually authoritative
  // regardless of whether this modal was ever shown.
  function maybeShowLiveLookupConsentModal() {
    if (kbEmailLookupMode === 'company_knowledge') return;
    if (!hasActiveGmailConnection) return;
    if (liveLookupConsentedAt) return;
    openLiveLookupConsentModal();
  }

  // Still needed with the mode selector gone: `automatic` mode can still
  // trigger the live-lookup consent modal and the "Searching connected
  // email…" hint below, both of which depend on knowing whether a Gmail
  // mailbox is connected and already consented.
  async function loadEmailLookupUI() {
    try {
      const [connRes, settingsRes] = await Promise.all([
        fetch('/api/integrations/email/connections', { headers: { Authorization: `Bearer ${accessToken}` } }),
        fetch('/api/integrations/email/live-lookup-settings', { headers: { Authorization: `Bearer ${accessToken}` } }),
      ]);
      if (connRes.ok) {
        const { connections } = await connRes.json();
        hasActiveGmailConnection = Array.isArray(connections) && connections.length > 0;
      }
      if (settingsRes.ok) {
        const body = await settingsRes.json();
        liveLookupConsentedAt = body.consentedAt || null;
      }
    } catch { /* chat still works in the unrestricted default */ }
  }

  loadEmailLookupUI();

  async function askQuestion() {
    const query = kbQueryInput.value.trim();
    if (!query) return;

    kbQueryInput.value = '';
    adjustQueryHeight();
    kbAskBtn.disabled = true;
    kbAskBtn.dataset.askInFlight = '1';
    kbAskBtn.textContent = '…';
    kbMicBtn.disabled = true;

    appendMessage('user', query, []);
    const showLiveEmailHint = kbEmailLookupMode !== 'company_knowledge' && hasActiveGmailConnection;
    const loadingBubble = appendLoadingBubble(showLiveEmailHint);
    maybeShowLiveLookupConsentModal();

    try {
      const res = await fetch('/api/knowledge/query', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          sessionId: currentSessionId,
          ...(kbAllowedCollectionIds ? { collectionIds: kbAllowedCollectionIds } : {}),
          emailLookupMode: kbEmailLookupMode,
        }),
      });

      const body = await res.json().catch(() => ({}));
      loadingBubble.remove();

      if (res.ok) {
        const answer  = body.answer || 'No answer returned.';
        const sources = body.sources || [];
        appendMessage('assistant', answer, sources);
        if (body.isKnowledgeGap === true) {
          showGapCard(body, query);
        }
        if (!currentSessionId && body.sessionId) {
          currentSessionId = body.sessionId;
        }
        await loadSessions();
      } else {
        appendMessage('assistant', body.error || 'Failed to get an answer.', []);
      }
    } catch {
      loadingBubble.remove();
      appendMessage('assistant', 'Network error. Please try again.', []);
    }

    delete kbAskBtn.dataset.askInFlight;
    kbAskBtn.disabled = false;
    kbAskBtn.textContent = 'Ask';
    kbMicBtn.disabled = micState === 'transcribing';
  }

  function shortId(id) {
    const value = String(id || '');
    if (value.length <= 12) return value;
    return `${value.slice(0, 8)}...${value.slice(-4)}`;
  }

  function escHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // 10. Logout button
  const logoutBtn = document.getElementById('btn-logout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      PortalCache.clearAll();
      await supabase.auth.signOut();
      window.location.href = '/login.html';
    });
  }

  // 10. Issue report form
  const issueForm = document.getElementById('issue-form');
  if (issueForm) {
    issueForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const subject   = document.getElementById('issue-subject').value.trim();
      const issueType = document.getElementById('issue-type').value;
      const message   = document.getElementById('issue-message').value.trim();
      const errorEl   = document.getElementById('issue-error');
      const successEl = document.getElementById('issue-success');
      const submitBtn = document.getElementById('issue-submit');

      errorEl.hidden   = true;
      successEl.hidden = true;

      if (!subject || !issueType || !message) {
        errorEl.textContent = 'Please fill in all fields.';
        errorEl.hidden = false;
        return;
      }

      submitBtn.disabled    = true;
      submitBtn.textContent = 'Submitting…';

      try {
        const res = await fetch('/api/portal/issues', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ subject, issueType, message }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Submission failed. Please try again.');
        }

        successEl.textContent = "Issue submitted. We'll be in touch within one business day.";
        successEl.hidden = false;
        issueForm.reset();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      } finally {
        submitBtn.disabled    = false;
        submitBtn.textContent = 'Submit Issue';
      }
    });
  }

  function showBanner(type, message) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    toast.innerHTML = `<span class="toast-icon">${type === 'success' ? '✓' : '✕'}</span><span class="toast-text">${escHtml(message)}</span>`;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('toast--visible'));
    setTimeout(() => {
      toast.classList.remove('toast--visible');
      toast.addEventListener('transitionend', () => toast.remove(), { once: true });
    }, 4000);
  }

  // EL6 (§2.1) — `showLiveEmailHint` still reflects whether a live mailbox
  // lookup could plausibly be in play for this question (kept for callers
  // and any future reuse), but the loading bubble itself is presentation-
  // only: just the animated dots, no explanatory text underneath.
  function appendLoadingBubble(showLiveEmailHint) {
    const wrap = document.createElement('div');
    wrap.className = 'kb-message kb-message--assistant';
    const bubble = document.createElement('div');
    bubble.className = 'kb-message-bubble';
    bubble.innerHTML = '<span class="loading-dots"><span></span><span></span><span></span></span>';
    wrap.appendChild(bubble);
    kbMessages.appendChild(wrap);
    kbMessages.scrollTop = kbMessages.scrollHeight;
    updateChatWelcome();
    return wrap;
  }

  function updateChatWelcome() {
    const welcome = document.getElementById('chat-welcome');
    if (!welcome) return;
    welcome.hidden = kbMessages.children.length > 0;
  }

  // ── Team Section ────────────────────────────────────────────────────────────

  function initTeamSection() {
    const tbody       = document.getElementById('team-members-tbody');
    const modal       = document.getElementById('team-invite-modal');
    const inviteBtn   = document.getElementById('btn-team-invite');
    const cancelBtn   = document.getElementById('team-invite-cancel');
    const inviteForm  = document.getElementById('team-invite-form');
    const emailInput  = document.getElementById('team-invite-email');
    const roleSelect  = document.getElementById('team-invite-role');
    const inviteError = document.getElementById('team-invite-error');
    const submitBtn   = document.getElementById('team-invite-submit');

    if (!tbody) return;

    function statusBadge(status) {
      const labels = { invited: 'Invited', active: 'Active', disabled: 'Disabled', revoked: 'Revoked' };
      const cls    = { invited: 'invited', active: 'active', disabled: 'disabled', revoked: 'disabled' };
      return `<span class="team-status-badge team-status-badge--${cls[status] || 'disabled'}">${labels[status] || status}</span>`;
    }

    function fmtDate(iso) {
      if (!iso) return '—';
      return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    }

    function showTeamMembersLoadingSkeleton() {
      tbody.innerHTML = `
        <tr class="loading-row">
          <td><div class="skeleton skeleton-line" style="width:70%"></div></td>
          <td><div class="skeleton skeleton-line" style="width:50%"></div></td>
          <td><div class="skeleton skeleton-line" style="width:40%"></div></td>
          <td><div class="skeleton skeleton-line" style="width:55%"></div></td>
          <td><div class="skeleton skeleton-line" style="width:45%"></div></td>
          <td></td>
        </tr>
        <tr class="loading-row">
          <td><div class="skeleton skeleton-line" style="width:60%"></div></td>
          <td><div class="skeleton skeleton-line" style="width:45%"></div></td>
          <td><div class="skeleton skeleton-line" style="width:35%"></div></td>
          <td><div class="skeleton skeleton-line" style="width:50%"></div></td>
          <td><div class="skeleton skeleton-line" style="width:40%"></div></td>
          <td></td>
        </tr>`;
    }

    async function loadTeamMembers() {
      await PortalCache.staleWhileRevalidate({
        clientId, memberId, resource: 'teamMembers', maxAgeMs: CACHE_TTL.teamMembers,
        fetchFn: async () => {
          const res = await fetch('/api/team/members', {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (!res.ok) throw new Error('Failed to load members');
          return res.json();
        },
        onLoading: showTeamMembersLoadingSkeleton,
        onData: renderMembers,
        onError: () => {
          tbody.innerHTML = `<tr><td colspan="6" class="team-empty-state">Could not load team members.</td></tr>`;
        },
      });
    }

    function renderMembers(members) {
      if (!members.length) {
        tbody.innerHTML = `<tr><td colspan="6">
          <div class="empty-state-card">
            <span class="empty-state-icon">👥</span>
            <span class="empty-state-title">No team members yet</span>
            <span class="empty-state-desc">Invite your first teammate so they can access the company knowledge base.</span>
          </div>
        </td></tr>`;
        return;
      }

      tbody.innerHTML = members.map(m => {
        const isCurrentUser = m.id === memberId;
        const isOwner       = m.role === 'owner';
        const isPending     = m.status === 'invited';
        const isDisabled    = m.status === 'disabled' || m.status === 'revoked';
        const isReenableable = m.status === 'disabled';
        const nameOrEmail   = m.full_name
          ? `<span class="team-member-name">${esc(m.full_name)}</span><br><span class="team-member-email">${esc(m.email)}</span>`
          : `<span class="team-member-email">${esc(m.email)}</span>`;

        const roleOptions = ['owner','admin','member','viewer']
          .map(r => `<option value="${r}"${r === m.role ? ' selected' : ''}>${r.charAt(0).toUpperCase()+r.slice(1)}</option>`)
          .join('');

        let actions = '';
        if (!isCurrentUser) {
          if (isPending) {
            actions += `<button class="btn-team-action" data-action="resend" data-id="${m.id}">Resend</button>`;
            actions += `<button class="btn-team-action btn-team-action--danger" data-action="revoke" data-id="${m.id}">Revoke</button>`;
          } else if (isReenableable) {
            actions += `<button class="btn-team-action btn-team-action--success" data-action="enable" data-id="${m.id}">Re-enable</button>`;
          } else if (!isDisabled) {
            actions += `<button class="btn-team-action btn-team-action--danger" data-action="disable" data-id="${m.id}">Disable</button>`;
          }
        }
        if (isCurrentUser) {
          actions = '<span class="team-you-label">You</span>';
        }

        const roleCell = isCurrentUser || isOwner
          ? `<span class="team-role-label">${m.role.charAt(0).toUpperCase()+m.role.slice(1)}</span>`
          : `<select class="team-role-select" data-id="${m.id}">${roleOptions}</select>`;

        return `<tr>
          <td>${nameOrEmail}</td>
          <td>${roleCell}</td>
          <td>${statusBadge(m.status)}</td>
          <td>${fmtDate(m.invited_at)}</td>
          <td>${fmtDate(m.last_active_at)}</td>
          <td class="team-actions-cell">${actions}</td>
        </tr>`;
      }).join('');

      // Role change handlers
      tbody.querySelectorAll('.team-role-select').forEach(sel => {
        sel.addEventListener('change', async () => {
          const mid  = sel.dataset.id;
          const role = sel.value;
          sel.disabled = true;
          try {
            const res = await fetch(`/api/team/members/${mid}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
              body: JSON.stringify({ role }),
            });
            if (!res.ok) {
              const d = await res.json().catch(() => ({}));
              alert(d.error || 'Could not update role');
              await loadTeamMembers();
            } else {
              // No reload happens on the success path (the <select> already
              // shows the new role) — invalidate so a later page load can't
              // serve the pre-change role from cache.
              PortalCache.invalidate(clientId, memberId, 'teamMembers');
            }
          } catch { alert('Could not update role'); await loadTeamMembers(); }
          sel.disabled = false;
        });
      });

      // Action button handlers
      tbody.querySelectorAll('.btn-team-action').forEach(btn => {
        btn.addEventListener('click', async () => {
          const action = btn.dataset.action;
          const mid    = btn.dataset.id;
          btn.disabled = true;

          try {
            if (action === 'resend') {
              const res = await fetch('/api/team/invites/resend', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
                body: JSON.stringify({ memberId: mid }),
              });
              if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed');
              alert('Invite resent.');
            } else if (action === 'revoke') {
              if (!confirm('Revoke this invitation?')) { btn.disabled = false; return; }
              const res = await fetch('/api/team/invites/revoke', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
                body: JSON.stringify({ memberId: mid }),
              });
              if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed');
            } else if (action === 'disable') {
              if (!confirm('Disable this member? They will no longer be able to access the portal.')) { btn.disabled = false; return; }
              const res = await fetch(`/api/team/members/${mid}/disable`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${accessToken}` },
              });
              if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed');
            } else if (action === 'enable') {
              if (!confirm('Re-enable this member? They will regain access to the portal.')) { btn.disabled = false; return; }
              const res = await fetch(`/api/team/members/${mid}/enable`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${accessToken}` },
              });
              if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed');
            }
            // resend doesn't change roster data — only invalidate for the actions that do.
            if (action !== 'resend') PortalCache.invalidate(clientId, memberId, 'teamMembers');
            await loadTeamMembers();
          } catch (err) {
            alert(err.message || 'Action failed');
            btn.disabled = false;
          }
        });
      });
    }

    function esc(s) {
      return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // Modal open/close
    inviteBtn.addEventListener('click', () => {
      inviteError.hidden = true;
      inviteForm.reset();
      modal.hidden = false;
    });
    cancelBtn.addEventListener('click', () => { modal.hidden = true; });
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });

    // Invite form submit
    inviteForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      inviteError.hidden = true;
      const email = emailInput.value.trim();
      const role  = roleSelect.value;

      if (!email) {
        inviteError.textContent = 'Email is required.';
        inviteError.hidden = false;
        return;
      }

      submitBtn.disabled    = true;
      submitBtn.textContent = 'Sending…';

      try {
        const res = await fetch('/api/team/invite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ email, role }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not send invite');

        modal.hidden = true;
        PortalCache.invalidate(clientId, memberId, 'teamMembers');
        await loadTeamMembers();
      } catch (err) {
        inviteError.textContent = err.message;
        inviteError.hidden = false;
      } finally {
        submitBtn.disabled    = false;
        submitBtn.textContent = 'Send Invite';
      }
    });

    loadTeamMembers();
  }

  // ---- Knowledge Collections (Milestone 5, owner/admin only) ----

  function initCollectionsSection() {
    const tbody      = document.getElementById('collections-tbody');
    const modal      = document.getElementById('collection-modal');
    const modalTitle = document.getElementById('collection-modal-title');
    const newBtn     = document.getElementById('btn-collection-new');
    const cancelBtn  = document.getElementById('collection-form-cancel');
    const form       = document.getElementById('collection-form');
    const nameInput  = document.getElementById('collection-name-input');
    const formError  = document.getElementById('collection-form-error');
    const submitBtn  = document.getElementById('collection-form-submit');

    if (!tbody) return;

    let editingCollectionId = null; // null = creating a new collection

    function showCollectionsLoadingSkeleton() {
      tbody.innerHTML = `
        <tr class="loading-row">
          <td><div class="skeleton skeleton-line" style="width:60%"></div></td>
          <td><div class="skeleton skeleton-line" style="width:30%"></div></td>
          <td></td>
        </tr>`;
    }

    async function loadCollectionsTable() {
      await PortalCache.staleWhileRevalidate({
        clientId, memberId, resource: 'collections', maxAgeMs: CACHE_TTL.collections,
        fetchFn: async () => {
          const res = await fetch('/api/collections', {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (!res.ok) throw new Error('Failed to load collections');
          const data = await res.json();
          return data.collections || [];
        },
        onLoading: showCollectionsLoadingSkeleton,
        onData: (collections) => {
          loadedCollections = collections;
          renderCollectionsTable(collections);
          // Refresh document rows so the "move to collection" select reflects
          // the current collection list once it's known.
          if (loadedDocs) renderDocuments(loadedDocs);
        },
        onError: () => {
          loadedCollections = [];
          tbody.innerHTML = `<tr><td colspan="3" class="team-empty-state">Could not load collections.</td></tr>`;
        },
      });
    }

    function renderCollectionsTable(collections) {
      if (!collections.length) {
        tbody.innerHTML = `<tr><td colspan="3" class="team-empty-state">No collections yet.</td></tr>`;
        return;
      }

      tbody.innerHTML = collections.map((c) => {
        const isDefault = !!c.isDefault || !!c.is_default;
        const docCount  = c.documentCount ?? c.document_count ?? 0;

        let deleteBtn;
        if (isDefault) {
          deleteBtn = `<button class="btn-team-action btn-team-action--danger" disabled title="The default collection cannot be deleted">Delete</button>`;
        } else if (docCount > 0) {
          deleteBtn = `<button class="btn-team-action btn-team-action--danger" disabled title="Move or delete its documents first">Delete</button>`;
        } else {
          deleteBtn = `<button class="btn-team-action btn-team-action--danger" data-action="delete" data-id="${c.id}" data-name="${escHtml(c.name)}">Delete</button>`;
        }

        return `<tr>
          <td>${escHtml(c.name)}${isDefault ? ' <span class="team-you-label">Default</span>' : ''}</td>
          <td>${docCount}</td>
          <td class="team-actions-cell">
            <button class="btn-team-action" data-action="rename" data-id="${c.id}" data-name="${escHtml(c.name)}">Rename</button>
            ${deleteBtn}
          </td>
        </tr>`;
      }).join('');

      tbody.querySelectorAll('.btn-team-action').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const action = btn.dataset.action;
          if (action === 'rename') {
            editingCollectionId = btn.dataset.id;
            modalTitle.textContent = 'Rename Collection';
            nameInput.value = btn.dataset.name;
            formError.hidden = true;
            modal.hidden = false;
            nameInput.focus();
          } else if (action === 'delete') {
            if (!confirm(`Delete the "${btn.dataset.name}" collection?`)) return;
            btn.disabled = true;
            try {
              const res = await fetch(`/api/collections/${btn.dataset.id}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${accessToken}` },
              });
              if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error || 'Could not delete collection');
              }
              PortalCache.invalidate(clientId, memberId, 'collections');
              await loadCollectionsTable();
            } catch (err) {
              alert(err.message);
              btn.disabled = false;
            }
          }
        });
      });
    }

    newBtn.addEventListener('click', () => {
      editingCollectionId = null;
      modalTitle.textContent = 'New Collection';
      form.reset();
      formError.hidden = true;
      modal.hidden = false;
      nameInput.focus();
    });

    cancelBtn.addEventListener('click', () => { modal.hidden = true; });
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      formError.hidden = true;
      const name = nameInput.value.trim();
      if (!name) {
        formError.textContent = 'Name is required.';
        formError.hidden = false;
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Saving…';

      try {
        const url = editingCollectionId ? `/api/collections/${editingCollectionId}` : '/api/collections';
        const method = editingCollectionId ? 'PATCH' : 'POST';
        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ name }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not save collection');

        modal.hidden = true;
        PortalCache.invalidate(clientId, memberId, 'collections');
        await loadCollectionsTable();
      } catch (err) {
        formError.textContent = err.message;
        formError.hidden = false;
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Save';
      }
    });

    loadCollectionsTable();
  }

})();
