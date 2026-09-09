(function () {
  const loginView = document.getElementById('loginView');
  const dashboardView = document.getElementById('dashboardView');
  const logoutBtn = document.getElementById('logoutBtn');

  // ---- Auth helpers ----

  function getToken() { return localStorage.getItem('adminToken'); }
  function saveToken(t) { localStorage.setItem('adminToken', t); }
  function clearToken() { localStorage.removeItem('adminToken'); }

  async function adminFetch(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': getToken() || '',
        ...(options.headers || {}),
      },
    });
    if (res.status === 401) {
      clearToken();
      showLogin();
      throw new Error('Session expired');
    }
    return res;
  }

  // ---- View switching ----

  function showLogin() {
    loginView.hidden = false;
    dashboardView.hidden = true;
    logoutBtn.hidden = true;
  }

  function showDashboard() {
    loginView.hidden = true;
    dashboardView.hidden = false;
    logoutBtn.hidden = false;
    loadClients();
    loadLeads();
    loadIssues();
  }

  // ---- Login form ----

  const loginForm = document.getElementById('adminLoginForm');
  const loginError = document.getElementById('loginError');
  const loginBtn = document.getElementById('loginBtn');

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginBtn.disabled = true;
    loginBtn.textContent = 'Signing in…';
    loginError.hidden = true;

    const password = document.getElementById('adminPassword').value;

    const res = await fetch('/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });

    const body = await res.json();

    if (!res.ok) {
      loginError.textContent = body.error || 'Invalid password.';
      loginError.hidden = false;
      loginBtn.disabled = false;
      loginBtn.textContent = 'Sign In';
      return;
    }

    saveToken(body.token);
    showDashboard();
  });

  // ---- Logout ----

  logoutBtn.addEventListener('click', () => {
    clearToken();
    showLogin();
  });

  // ---- Invite form ----

  const inviteForm = document.getElementById('inviteForm');
  const inviteError = document.getElementById('inviteError');
  const inviteSuccess = document.getElementById('inviteSuccess');
  const inviteBtn = document.getElementById('inviteBtn');

  inviteForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    inviteBtn.disabled = true;
    inviteBtn.textContent = 'Sending…';
    inviteError.hidden = true;
    inviteSuccess.hidden = true;

    const name = document.getElementById('clientName').value.trim();
    const email = document.getElementById('clientEmail').value.trim();

    let res;
    try {
      res = await adminFetch('/admin/invite', {
        method: 'POST',
        body: JSON.stringify({ name, email }),
      });
    } catch {
      inviteBtn.disabled = false;
      inviteBtn.textContent = 'Send Invite';
      return;
    }

    const body = await res.json();

    if (!res.ok) {
      inviteError.textContent = body.error || 'Failed to send invite.';
      inviteError.hidden = false;
      inviteBtn.disabled = false;
      inviteBtn.textContent = 'Send Invite';
      return;
    }

    inviteSuccess.textContent = `Invite sent to ${email}.`;
    inviteSuccess.hidden = false;
    inviteBtn.disabled = false;
    inviteBtn.textContent = 'Send Invite';
    document.getElementById('clientName').value = '';
    document.getElementById('clientEmail').value = '';

    loadClients();
  });

  // ---- Client list ----

  const clientsLoading = document.getElementById('clientsLoading');
  const clientsEmpty = document.getElementById('clientsEmpty');
  const clientsError = document.getElementById('clientsError');
  const clientsTable = document.getElementById('clientsTable');

  async function loadClients() {
    clientsLoading.hidden = false;
    clientsEmpty.hidden = true;
    clientsError.hidden = true;
    clientsTable.hidden = true;

    let res;
    try {
      res = await adminFetch('/admin/clients');
    } catch {
      return;
    }

    const clients = await res.json();
    clientsLoading.hidden = true;

    if (!Array.isArray(clients) || clients.length === 0) {
      clientsEmpty.hidden = false;
      return;
    }

    clientsTable.innerHTML = renderTable(clients);
    clientsTable.hidden = false;
  }

  function fmtDate(val) {
    return val
      ? new Date(val).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : '—';
  }

  function renderTable(clients) {
    const rows = clients.map(renderRow).join('');
    return `
      <div class="table-wrap">
        <table class="admin-table clients-table">
          <thead>
            <tr>
              <th></th>
              <th>Client</th>
              <th>Status</th>
              <th>Team</th>
              <th>Docs</th>
              <th>Indexed</th>
              <th>Failed</th>
              <th>Questions</th>
              <th>Gaps</th>
              <th>Issues</th>
              <th>Integrations</th>
              <th>Last Active</th>
              <th>Joined</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  function renderRow(c) {
    const h = c.aikbHealth || {};

    const statusBadge = c.invite_accepted
      ? `<span class="badge badge--active">Active</span>`
      : c.is_active
        ? `<span class="badge badge--pending">Invite Sent</span>`
        : `<span class="badge badge--closed_lost">Inactive</span>`;

    // Backlog M15 removed Dropbox/Google Drive's persistent-connection flow
    // entirely, leaving Slack as the only provider with a connect status.
    const integrations = `<span class="integration-tag ${c.slack ? 'integration-tag--on' : ''}">Slack</span>`;

    const lastActiveTimestamp = [
      h.lastQuestionAt,
      h.latestIngestionJob?.created_at,
      h.lastIndexedAt,
    ].filter(Boolean).sort().at(-1) || null;

    const teamCell = [
      `<span class="team-count">${c.teamCount || 0}</span>`,
      c.activeMemberCount  ? `<span class="badge badge--active badge--sm">${c.activeMemberCount} active</span>`   : '',
      c.pendingMemberCount ? `<span class="badge badge--pending badge--sm">${c.pendingMemberCount} pending</span>` : '',
    ].filter(Boolean).join(' ');

    const membersRowId = `members-${c.id}`;

    return `
      <tr class="client-row">
        <td class="expand-cell">
          <button class="btn-expand" data-target="${membersRowId}" data-client-id="${esc(c.id)}" aria-expanded="false" title="Show team members">▶</button>
        </td>
        <td>
          <div class="client-name">${esc(c.name)}</div>
          <div class="client-email">${esc(c.email)}</div>
        </td>
        <td>${statusBadge}</td>
        <td class="team-cell">${teamCell}</td>
        <td class="num-cell">${h.totalDocuments     ?? '—'}</td>
        <td class="num-cell">${h.indexedDocuments   ?? '—'}</td>
        <td class="num-cell">${h.failedDocuments    ?? '—'}</td>
        <td class="num-cell">${h.totalQuestions     ?? '—'}</td>
        <td class="num-cell">${h.totalKnowledgeGaps ?? '—'}</td>
        <td class="num-cell">${h.issueCount         ?? '—'}</td>
        <td><div class="integration-list">${integrations}</div></td>
        <td class="client-date">${fmtDate(lastActiveTimestamp)}</td>
        <td class="client-date">${fmtDate(c.created_at)}</td>
        <td><button class="btn-delete" data-id="${esc(c.id)}" data-name="${esc(c.name)}">Delete</button></td>
      </tr>
      <tr id="${membersRowId}" class="members-row" hidden>
        <td colspan="14">
          ${renderMembersPanel(c.teamMembers || [])}
          <div id="email-connections-${esc(c.id)}" class="email-connections-panel" data-loaded="false"></div>
        </td>
      </tr>
    `;
  }

  // EM9 (EMAIL_INGESTION.md §24.5, §27, §31) — every member's Gmail
  // connection for this client, including offboarded members whose
  // connection was never actually disconnected (stillConnectedAfterOffboarding)
  // so that gap is an explicit, visible row rather than a silent one.
  function renderEmailConnectionsPanel(connections) {
    if (!connections.length) {
      return `<div class="members-panel"><p class="members-empty">No email connections.</p></div>`;
    }

    const memberStatusBadge = (status) => {
      const cls = { active: 'badge--active', pending: 'badge--pending' }[status] || 'badge--closed_lost';
      return `<span class="badge ${cls}">${esc(status || 'unknown')}</span>`;
    };

    // EM10.5 Bug 11 fix — this panel was read-only: it listed connections
    // but wired no disconnect action into any row, even though
    // emailConnectionService.disconnect already fully implements the
    // owner/admin-override-plus-cleanup path (§14.1, §24). This is the
    // control for exactly the case the self-service portal button can't
    // reach — e.g. stillConnectedAfterOffboarding above, a mailbox left
    // connected after its member was offboarded.
    const rows = connections.map(conn => {
      const isActive = conn.oauth_status === 'active';
      const disconnectCell = isActive
        ? `<label class="slack-collection-option email-disconnect-cleanup-option">
             <input type="checkbox" class="email-disconnect-cleanup-toggle" />
             cleanup
           </label>
           <button type="button" class="btn-delete btn-email-disconnect"
             data-client-id="${esc(conn.client_id)}"
             data-connection-id="${esc(conn.oauth_connection_id)}"
             data-mailbox="${esc(conn.mailbox_address)}">Disconnect</button>`
        : '—';
      return `
      <tr class="${conn.stillConnectedAfterOffboarding ? 'row--flagged' : ''}">
        <td class="client-email">${esc(conn.mailbox_address)}</td>
        <td class="client-email">${esc(conn.member_email || '—')}</td>
        <td>${memberStatusBadge(conn.member_status)}</td>
        <td>${esc(conn.sync_mode)}</td>
        <td>${conn.sync_enabled ? 'yes' : 'no'}</td>
        <td>${esc(conn.oauth_status || '—')}</td>
        <td>${conn.stillConnectedAfterOffboarding
          ? '<span class="badge badge--pending">Still connected — offboarded</span>'
          : ''}</td>
        <td class="email-disconnect-cell">${disconnectCell}</td>
      </tr>
    `;
    }).join('');

    return `
      <div class="members-panel">
        <h4 class="members-panel-title">Email connections</h4>
        <table class="members-table">
          <thead>
            <tr>
              <th>Mailbox</th>
              <th>Member</th>
              <th>Member status</th>
              <th>Sync mode</th>
              <th>Sync enabled</th>
              <th>OAuth status</th>
              <th></th>
              <th></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  function renderMembersPanel(members) {
    if (!members.length) {
      return `<div class="members-panel"><p class="members-empty">No team members yet.</p></div>`;
    }

    const memberStatusBadge = (status) => {
      const cls = { active: 'badge--active', pending: 'badge--pending' }[status] || 'badge--closed_lost';
      return `<span class="badge ${cls}">${esc(status)}</span>`;
    };

    const rows = members.map(m => `
      <tr>
        <td class="client-name">${esc(m.full_name || '—')}</td>
        <td class="client-email">${esc(m.email)}</td>
        <td><span class="badge badge--role-${esc(m.role)}">${esc(m.role)}</span></td>
        <td>${memberStatusBadge(m.status)}</td>
        <td class="client-date">${fmtDate(m.invited_at)}</td>
        <td class="client-date">${fmtDate(m.accepted_at)}</td>
        <td class="client-date">${fmtDate(m.last_active_at)}</td>
      </tr>
    `).join('');

    return `
      <div class="members-panel">
        <table class="members-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Invited</th>
              <th>Accepted</th>
              <th>Last Active</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  // Delete + expand handler via event delegation (delete checked first)
  clientsTable.addEventListener('click', async (e) => {
    const deleteBtn = e.target.closest('.btn-delete');
    if (deleteBtn) {
      const clientId = deleteBtn.dataset.id;
      const clientName = deleteBtn.dataset.name;
      if (!confirm(`Delete "${clientName}"? This removes their account and all data.`)) return;

      deleteBtn.disabled = true;
      deleteBtn.textContent = 'Deleting…';

      try {
        const res = await adminFetch(`/admin/clients/${clientId}`, { method: 'DELETE' });
        if (res.ok) {
          loadClients();
        } else {
          const body = await res.json().catch(() => ({}));
          alert(body.error || 'Failed to delete client.');
          deleteBtn.disabled = false;
          deleteBtn.textContent = 'Delete';
        }
      } catch {
        deleteBtn.disabled = false;
        deleteBtn.textContent = 'Delete';
      }
      return;
    }

    // EM10.5 Bug 11 fix — admin-override disconnect (with optional cleanup)
    // for a single client's email connection row.
    const emailDisconnectBtn = e.target.closest('.btn-email-disconnect');
    if (emailDisconnectBtn) {
      const clientId = emailDisconnectBtn.dataset.clientId;
      const connectionId = emailDisconnectBtn.dataset.connectionId;
      const mailbox = emailDisconnectBtn.dataset.mailbox;
      const cleanupToggle = emailDisconnectBtn.closest('td').querySelector('.email-disconnect-cleanup-toggle');
      const cleanupIngestedContent = !!(cleanupToggle && cleanupToggle.checked);
      const confirmMessage = cleanupIngestedContent
        ? `Disconnect ${mailbox} and delete the knowledge base content it contributed? This cannot be undone.`
        : `Disconnect ${mailbox}? Content already in the knowledge base will be kept.`;
      if (!confirm(confirmMessage)) return;

      emailDisconnectBtn.disabled = true;
      emailDisconnectBtn.textContent = 'Disconnecting…';
      try {
        const res = await adminFetch(`/admin/clients/${clientId}/email-connections/${connectionId}/disconnect`, {
          method: 'POST',
          body: JSON.stringify({ cleanupIngestedContent }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok) {
          const panel = document.getElementById(`email-connections-${clientId}`);
          if (panel) {
            panel.dataset.loaded = 'false';
            const refreshed = await adminFetch(`/admin/clients/${clientId}/email-connections`);
            const refreshedBody = await refreshed.json();
            panel.innerHTML = renderEmailConnectionsPanel(refreshedBody.connections || []);
            panel.dataset.loaded = 'true';
          }
        } else {
          alert(body.error || 'Failed to disconnect.');
          emailDisconnectBtn.disabled = false;
          emailDisconnectBtn.textContent = 'Disconnect';
        }
      } catch {
        alert('Network error. Please try again.');
        emailDisconnectBtn.disabled = false;
        emailDisconnectBtn.textContent = 'Disconnect';
      }
      return;
    }

    const expandBtn = e.target.closest('.btn-expand');
    if (expandBtn) {
      const targetId = expandBtn.dataset.target;
      const targetRow = document.getElementById(targetId);
      if (targetRow) {
        const nowOpen = targetRow.hidden;
        targetRow.hidden = !nowOpen;
        expandBtn.textContent = nowOpen ? '▼' : '▶';
        expandBtn.setAttribute('aria-expanded', String(nowOpen));

        // EM9 — lazy-load this client's email connections the first time
        // the row is expanded (not pre-fetched for every client up front,
        // matching this list's existing "fetch once, cache in the DOM"
        // shape rather than a new global loading pattern).
        const clientId = expandBtn.dataset.clientId;
        const panel = document.getElementById(`email-connections-${clientId}`);
        if (nowOpen && panel && panel.dataset.loaded !== 'true') {
          panel.dataset.loaded = 'true';
          panel.innerHTML = `<div class="members-panel"><p class="members-empty">Loading email connections…</p></div>`;
          try {
            const res = await adminFetch(`/admin/clients/${clientId}/email-connections`);
            const body = await res.json();
            panel.innerHTML = renderEmailConnectionsPanel(body.connections || []);
          } catch {
            panel.dataset.loaded = 'false';
            panel.innerHTML = `<div class="members-panel"><p class="members-empty">Could not load email connections.</p></div>`;
          }
        }
      }
    }
  });

  // ---- Leads list ----

  const leadsLoading = document.getElementById('leadsLoading');
  const leadsEmpty   = document.getElementById('leadsEmpty');
  const leadsError   = document.getElementById('leadsError');
  const leadsTable   = document.getElementById('leadsTable');

  async function loadLeads() {
    leadsLoading.hidden = false;
    leadsEmpty.hidden   = true;
    leadsError.hidden   = true;
    leadsTable.hidden   = true;

    let res;
    try {
      res = await adminFetch('/admin/leads');
    } catch {
      return;
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      leadsError.textContent = body.error || 'Failed to load leads.';
      leadsError.hidden = false;
      leadsLoading.hidden = true;
      return;
    }

    const leads = await res.json();
    leadsLoading.hidden = true;

    if (!Array.isArray(leads) || leads.length === 0) {
      leadsEmpty.hidden = false;
      return;
    }

    leadsTable.innerHTML = renderLeadsTable(leads);
    leadsTable.hidden = false;
  }

  function renderLeadsTable(leads) {
    const rows = leads.map(renderLeadRow).join('');
    return `
      <table class="admin-table">
        <thead>
          <tr>
            <th>Contact</th>
            <th>Message</th>
            <th>Notes</th>
            <th>Phone / Company</th>
            <th>Status</th>
            <th>Date</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function renderLeadRow(lead) {
    const statusMap = {
      new:           'badge--new',
      contacted:     'badge--contacted',
      proposal_sent: 'badge--proposal_sent',
      booked:        'badge--booked',
      closed_won:    'badge--closed_won',
      closed_lost:   'badge--closed_lost',
    };
    const badgeClass = statusMap[lead.status] || 'badge--new';
    const statusLabel = lead.status.replace('_', ' ');
    const badge = `<span class="badge ${badgeClass}">${esc(statusLabel)}</span>`;

    const msgPreview = lead.message.length > 80 ? lead.message.slice(0, 80) + '…' : lead.message;
    const notesPreview = lead.notes ? (lead.notes.length > 60 ? lead.notes.slice(0, 60) + '…' : lead.notes) : '—';

    const date = new Date(lead.created_at).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    });

    const statusActions = [
      { label: 'Contacted',     payload: { status: 'contacted' } },
      { label: 'Proposal Sent', payload: { status: 'proposal_sent' } },
      { label: 'Booked',        payload: { status: 'booked' } },
      { label: 'Won',           payload: { status: 'closed_won' } },
      { label: 'Lost',          payload: { status: 'closed_lost' } },
    ].map(({ label, payload }) =>
      `<button class="btn-action" data-lead-id="${esc(lead.id)}" data-payload="${esc(JSON.stringify(payload))}">${label}</button>`
    ).join('');

    const notesBtn = `<button class="btn-action btn-notes" data-lead-id="${esc(lead.id)}" data-current-notes="${esc(lead.notes || '')}">Edit Notes</button>`;
    const archiveBtn = `<button class="btn-action" data-lead-id="${esc(lead.id)}" data-payload="${esc(JSON.stringify({ archived: true }))}">Archive</button>`;
    const deleteBtn = `<button class="btn-delete btn-lead-delete" data-lead-id="${esc(lead.id)}" data-lead-name="${esc(lead.name)}">Delete</button>`;

    return `
      <tr>
        <td>
          <div class="client-name">${esc(lead.name)}</div>
          <div class="client-email">${esc(lead.email)}</div>
        </td>
        <td><div class="lead-message" title="${esc(lead.message)}">${esc(msgPreview)}</div></td>
        <td><div class="lead-notes" title="${esc(lead.notes || '')}">${esc(notesPreview)}</div></td>
        <td>
          <div class="client-name">${esc(lead.phone || '—')}</div>
          <div class="client-email">${esc(lead.company || '—')}</div>
        </td>
        <td>${badge}</td>
        <td class="client-date">${date}</td>
        <td>
          <div class="lead-actions">
            ${statusActions}
            ${notesBtn}
            ${archiveBtn}
            ${deleteBtn}
          </div>
        </td>
      </tr>
    `;
  }

  leadsTable.addEventListener('click', async (e) => {
    // Hard delete
    const deleteBtn = e.target.closest('.btn-lead-delete');
    if (deleteBtn) {
      const leadId = deleteBtn.dataset.leadId;
      const leadName = deleteBtn.dataset.leadName;
      if (!confirm(`Permanently delete lead from "${leadName}"? This cannot be undone.`)) return;

      deleteBtn.disabled = true;
      deleteBtn.textContent = 'Deleting…';

      try {
        const res = await adminFetch(`/admin/leads/${leadId}`, { method: 'DELETE' });
        if (res.ok) {
          loadLeads();
        } else {
          const body = await res.json().catch(() => ({}));
          alert(body.error || 'Failed to delete lead.');
          deleteBtn.disabled = false;
          deleteBtn.textContent = 'Delete';
        }
      } catch {
        deleteBtn.disabled = false;
        deleteBtn.textContent = 'Delete';
      }
      return;
    }

    const btn = e.target.closest('.btn-action');
    if (!btn) return;

    const leadId = btn.dataset.leadId;

    // Notes edit uses a prompt instead of a pre-serialized payload
    if (btn.classList.contains('btn-notes')) {
      const current = btn.dataset.currentNotes || '';
      const updated = prompt('Notes:', current);
      if (updated === null) return; // cancelled
      btn.disabled = true;
      try {
        const res = await adminFetch(`/admin/leads/${leadId}`, {
          method: 'PATCH',
          body: JSON.stringify({ notes: updated }),
        });
        if (res.ok) {
          loadLeads();
        } else {
          const body = await res.json().catch(() => ({}));
          alert(body.error || 'Failed to save notes.');
          btn.disabled = false;
        }
      } catch {
        btn.disabled = false;
      }
      return;
    }

    const payload = btn.dataset.payload;
    if (!payload) return;

    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';

    try {
      const res = await adminFetch(`/admin/leads/${leadId}`, {
        method: 'PATCH',
        body: payload,
      });
      if (res.ok) {
        loadLeads();
      } else {
        const body = await res.json().catch(() => ({}));
        alert(body.error || 'Action failed.');
        btn.disabled = false;
        btn.textContent = originalText;
      }
    } catch {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });

  // ---- Issues list ----

  const issuesLoading = document.getElementById('issuesLoading');
  const issuesEmpty   = document.getElementById('issuesEmpty');
  const issuesError   = document.getElementById('issuesError');
  const issuesTable   = document.getElementById('issuesTable');

  async function loadIssues() {
    issuesLoading.hidden = false;
    issuesEmpty.hidden   = true;
    issuesError.hidden   = true;
    issuesTable.hidden   = true;

    let res;
    try {
      res = await adminFetch('/admin/issues');
    } catch {
      return;
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      issuesError.textContent = body.error || 'Failed to load issues.';
      issuesError.hidden = false;
      issuesLoading.hidden = true;
      return;
    }

    const issues = await res.json();
    issuesLoading.hidden = true;

    if (!Array.isArray(issues) || issues.length === 0) {
      issuesEmpty.hidden = false;
      return;
    }

    issuesTable.innerHTML = renderIssuesTable(issues);
    issuesTable.hidden = false;
  }

  function renderIssuesTable(issues) {
    const rows = issues.map(renderIssueRow).join('');
    return `
      <table class="admin-table">
        <thead>
          <tr>
            <th>Subject</th>
            <th>Client</th>
            <th>Type</th>
            <th>Message</th>
            <th>Date</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function renderIssueRow(issue) {
    const typeLabel = (issue.issue_type || 'other').replace(/_/g, ' ');
    const msgPreview = issue.message.length > 80 ? issue.message.slice(0, 80) + '…' : issue.message;
    const date = new Date(issue.created_at).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    });

    const statusSelect = `
      <select class="issue-status-select" data-issue-id="${esc(issue.id)}">
        <option value="open"      ${issue.status === 'open'      ? 'selected' : ''}>Open</option>
        <option value="in_review" ${issue.status === 'in_review' ? 'selected' : ''}>In Review</option>
        <option value="resolved"  ${issue.status === 'resolved'  ? 'selected' : ''}>Resolved</option>
      </select>
    `;

    return `
      <tr>
        <td><div class="client-name">${esc(issue.subject)}</div></td>
        <td><div class="client-email">${esc(issue.client_name || issue.client_id)}</div></td>
        <td><div class="client-email">${esc(typeLabel)}</div></td>
        <td><div class="lead-message" title="${esc(issue.message)}">${esc(msgPreview)}</div></td>
        <td class="client-date">${date}</td>
        <td>${statusSelect}</td>
      </tr>
    `;
  }

  issuesTable.addEventListener('change', async (e) => {
    const select = e.target.closest('.issue-status-select');
    if (!select) return;

    const issueId = select.dataset.issueId;
    const status  = select.value;
    select.disabled = true;

    try {
      const res = await adminFetch(`/admin/issues/${issueId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(body.error || 'Failed to update status.');
        loadIssues();
      }
    } catch {
      loadIssues();
    } finally {
      select.disabled = false;
    }
  });

  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Knowledge Gaps (Backlog M5) ──────────────────────────────────────────
  // Fans out across every client (see routes/admin.js's GET /admin/gaps),
  // so — like CRM — it's lazy-loaded on first tab visit rather than eagerly
  // in showDashboard(), unlike Issues which is a single Relativity-DB query.

  const gapsLoading = document.getElementById('gapsLoading');
  const gapsEmpty   = document.getElementById('gapsEmpty');
  const gapsError   = document.getElementById('gapsError');
  const gapsTable   = document.getElementById('gapsTable');
  const gapsStatusFilter = document.getElementById('gapsStatusFilter');

  async function loadGaps() {
    gapsLoading.hidden = false;
    gapsEmpty.hidden   = true;
    gapsError.hidden   = true;
    gapsTable.hidden   = true;

    let res;
    try {
      const qs = gapsStatusFilter.value ? `?status=${encodeURIComponent(gapsStatusFilter.value)}` : '';
      res = await adminFetch(`/admin/gaps${qs}`);
    } catch {
      return;
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      gapsError.textContent = body.error || 'Failed to load knowledge gaps.';
      gapsError.hidden = false;
      gapsLoading.hidden = true;
      return;
    }

    const gaps = await res.json();
    gapsLoading.hidden = true;

    if (!Array.isArray(gaps) || gaps.length === 0) {
      gapsEmpty.hidden = false;
      return;
    }

    gapsTable.innerHTML = renderGapsTable(gaps);
    gapsTable.hidden = false;
  }

  function renderGapsTable(gaps) {
    const rows = gaps.map(renderGapRow).join('');
    return `
      <table class="admin-table">
        <thead>
          <tr>
            <th>Client</th>
            <th>Question</th>
            <th>Reason</th>
            <th>Origin</th>
            <th>Reported By</th>
            <th>Date</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function renderGapRow(gap) {
    const qPreview = gap.question.length > 80 ? gap.question.slice(0, 80) + '…' : gap.question;
    const date = new Date(gap.created_at).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    });

    const statusSelect = `
      <select class="gap-status-select" data-gap-id="${esc(gap.id)}" data-client-id="${esc(gap.client_id)}">
        <option value="open"     ${gap.status === 'open'     ? 'selected' : ''}>Open</option>
        <option value="reviewed" ${gap.status === 'reviewed' ? 'selected' : ''}>Reviewed</option>
        <option value="resolved" ${gap.status === 'resolved' ? 'selected' : ''}>Resolved</option>
        <option value="ignored"  ${gap.status === 'ignored'  ? 'selected' : ''}>Ignored</option>
      </select>
    `;

    return `
      <tr>
        <td><div class="client-name">${esc(gap.client_name || gap.client_id)}</div></td>
        <td><div class="lead-message" title="${esc(gap.question)}">${esc(qPreview)}</div></td>
        <td><div class="client-email">${esc(gap.reason || '—')}</div></td>
        <td><div class="client-email">${esc(gap.origin || 'legacy')}</div></td>
        <td><div class="client-email">${esc(gap.reported_by || '—')}</div></td>
        <td class="client-date">${date}</td>
        <td>${statusSelect}</td>
      </tr>
    `;
  }

  gapsTable.addEventListener('change', async (e) => {
    const select = e.target.closest('.gap-status-select');
    if (!select) return;

    const { gapId, clientId } = select.dataset;
    const status = select.value;
    select.disabled = true;

    try {
      const res = await adminFetch(`/admin/gaps/${clientId}/${gapId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(body.error || 'Failed to update status.');
        loadGaps();
      }
    } catch {
      loadGaps();
    } finally {
      select.disabled = false;
    }
  });

  gapsStatusFilter.addEventListener('change', () => { if (gapsLoaded) loadGaps(); });

  // ── Tab switching ─────────────────────────────────────────────────────────

  const tabBtns = document.querySelectorAll('.admin-tab');
  const TAB_NAMES = ['clients', 'leads', 'issues', 'gaps', 'crm'];
  let crmProspectsLoaded = false;
  let gapsLoaded = false;

  function switchTab(name) {
    tabBtns.forEach(b => b.classList.toggle('admin-tab--active', b.dataset.tab === name));
    TAB_NAMES.forEach(t => {
      const panel = document.getElementById(`tab-${t}`);
      if (panel) panel.hidden = (t !== name);
    });
    if (name === 'crm' && !crmProspectsLoaded) {
      crmProspectsLoaded = true;
      loadCrmProspects();
    }
    if (name === 'gaps' && !gapsLoaded) {
      gapsLoaded = true;
      loadGaps();
    }
  }

  tabBtns.forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

  // ── CRM (AI BDR) ─────────────────────────────────────────────────────────

  const CRM_API_BASE = '/admin/aibdr/api';

  const crmLoading  = document.getElementById('crmLoading');
  const crmEmpty    = document.getElementById('crmEmpty');
  const crmError    = document.getElementById('crmError');
  const crmTable    = document.getElementById('crmTable');
  const crmStats    = document.getElementById('crmStats');
  const crmModal    = document.getElementById('crmModal');

  let crmProspects = [];
  let crmCurrentId = null;

  async function loadCrmProspects() {
    crmLoading.hidden = false;
    crmEmpty.hidden   = true;
    crmError.hidden   = true;
    crmTable.hidden   = true;

    let res;
    try {
      res = await adminFetch(`${CRM_API_BASE}/leads`);
    } catch (err) {
      crmLoading.hidden = true;
      if (err.message !== 'Session expired') {
        crmError.textContent = 'Could not reach the admin API. Check your connection and try again.';
        crmError.hidden = false;
      }
      return;
    }

    if (res.status === 401) {
      crmLoading.hidden = true;
      crmError.textContent = 'Unauthorized. Please sign in again.';
      crmError.hidden = false;
      return;
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      crmLoading.hidden = true;
      crmError.textContent = body.error || 'Failed to load prospects.';
      crmError.hidden = false;
      return;
    }

    const data  = await res.json();
    const leads = Array.isArray(data) ? data : (data.leads || []);

    crmProspects      = leads;
    crmLoading.hidden = true;

    crmStats.innerHTML = renderCrmStats(leads);

    if (leads.length === 0) {
      crmEmpty.hidden = false;
      return;
    }

    crmEmpty.hidden    = true;
    crmTable.innerHTML = renderCrmTable(leads);
    crmTable.hidden    = false;
  }

  function renderCrmStats(prospects) {
    const p         = Array.isArray(prospects) ? prospects : [];
    const total     = p.length;
    const highPri   = p.filter(x => x.priority === 'high').length;
    const ready     = p.filter(x => x.status === 'outreach_ready').length;
    const contacted = p.filter(x => ['contacted', 'follow_up_needed', 'replied'].includes(x.status)).length;
    const booked    = p.filter(x => x.status === 'booked_call').length;

    const card = (val, label) =>
      `<div class="analytics-card"><div class="analytics-value">${val}</div><div class="analytics-label">${label}</div></div>`;

    return card(total, 'Total Prospects')
         + card(highPri, 'High Priority')
         + card(ready, 'Outreach Ready')
         + card(contacted, 'Contacted')
         + card(booked, 'Booked Calls');
  }

  function crmStatusClass(status) {
    return {
      new:              'badge--new',
      analyzed:         'badge--analyzed',
      scored:           'badge--scored',
      outreach_ready:   'badge--outreach-ready',
      contacted:        'badge--contacted',
      follow_up_needed: 'badge--follow-up',
      replied:          'badge--replied',
      booked_call:      'badge--booked',
      closed_won:       'badge--closed_won',
      closed_lost:      'badge--closed_lost',
      bad_fit:          'badge--bad-fit',
    }[status] || 'badge--new';
  }

  function renderCrmTable(prospects) {
    const rows = prospects.map(p => {
      const score      = p.score != null ? p.score : null;
      const scoreColor = score == null ? 'var(--text-muted)'
                       : score >= 80   ? 'var(--success)'
                       : score >= 60   ? 'var(--warn)'
                       :                 'var(--error)';

      const priority = (p.priority || '').toLowerCase();
      const priClass = { high: 'badge--priority-high', medium: 'badge--priority-medium', low: 'badge--priority-low' }[priority];
      const priBadge = priClass
        ? `<span class="badge ${priClass}">${esc(priority)}</span>`
        : `<span class="client-email">${esc(p.priority || '—')}</span>`;

      const status      = p.status || 'new';
      const statusLabel = status.replace(/_/g, ' ');
      const updated     = fmtDate(p.updated_at || p.created_at);

      return `
        <tr class="crm-prospect-row" data-id="${esc(p.id)}">
          <td>
            <div class="client-name">${esc(p.business_name || '—')}</div>
            ${p.website_url ? `<div class="client-email">${esc(p.website_url)}</div>` : ''}
          </td>
          <td class="client-email">${esc(p.industry || '—')}</td>
          <td class="client-email">${esc(p.location || '—')}</td>
          <td class="num-cell"><span style="color:${scoreColor};font-weight:600;">${score != null ? score : '—'}</span></td>
          <td>${priBadge}</td>
          <td><span class="badge ${crmStatusClass(status)}">${esc(statusLabel)}</span></td>
          <td class="client-email">${esc(p.contact_email || '—')}</td>
          <td class="client-date">${updated}</td>
        </tr>
      `;
    }).join('');

    return `
      <div class="table-wrap">
        <table class="admin-table crm-table">
          <thead>
            <tr>
              <th>Business</th>
              <th>Industry</th>
              <th>Location</th>
              <th style="text-align:right">Score</th>
              <th>Priority</th>
              <th>Status</th>
              <th>Contact Email</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  crmTable.addEventListener('click', e => {
    const row = e.target.closest('.crm-prospect-row');
    if (row) openCrmDetail(row.dataset.id);
  });

  // ── Add Prospect Form ─────────────────────────────────────────────────────

  const toggleAddProspect  = document.getElementById('toggleAddProspect');
  const addProspectWrap    = document.getElementById('addProspectWrap');
  const addProspectForm    = document.getElementById('addProspectForm');
  const addProspectError   = document.getElementById('addProspectError');
  const addProspectSuccess = document.getElementById('addProspectSuccess');
  const addProspectBtn     = document.getElementById('addProspectBtn');

  toggleAddProspect.addEventListener('click', () => {
    const isOpen = !addProspectWrap.hidden;
    addProspectWrap.hidden        = isOpen;
    toggleAddProspect.textContent = isOpen ? '+ Add Prospect' : '− Close Form';
  });

  addProspectForm.addEventListener('submit', async e => {
    e.preventDefault();
    addProspectError.hidden   = true;
    addProspectSuccess.hidden = true;

    const payload = {
      business_name: document.getElementById('prospectBusiness').value.trim(),
      website_url:   document.getElementById('prospectUrl').value.trim(),
      industry:      document.getElementById('prospectIndustry').value.trim(),
      location:      document.getElementById('prospectLocation').value.trim(),
      contact_name:  document.getElementById('prospectContactName').value.trim(),
      contact_email: document.getElementById('prospectContactEmail').value.trim(),
      contact_phone: document.getElementById('prospectContactPhone').value.trim(),
      notes:         document.getElementById('prospectNotes').value.trim(),
    };

    if (!payload.business_name) {
      addProspectError.textContent = 'Business name is required.';
      addProspectError.hidden = false;
      return;
    }

    addProspectBtn.disabled    = true;
    addProspectBtn.textContent = 'Adding…';

    let res;
    try {
      res = await adminFetch(`${CRM_API_BASE}/leads`, {
        method: 'POST',
        body:   JSON.stringify(payload),
      });
    } catch {
      addProspectError.textContent = 'Network error. Please try again.';
      addProspectError.hidden    = false;
      addProspectBtn.disabled    = false;
      addProspectBtn.textContent = 'Add Prospect';
      return;
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      addProspectError.textContent = body.error || 'Failed to add prospect.';
      addProspectError.hidden    = false;
      addProspectBtn.disabled    = false;
      addProspectBtn.textContent = 'Add Prospect';
      return;
    }

    addProspectSuccess.textContent = `"${payload.business_name}" added as a prospect.`;
    addProspectSuccess.hidden      = false;
    addProspectBtn.disabled        = false;
    addProspectBtn.textContent     = 'Add Prospect';
    addProspectForm.reset();
    addProspectWrap.hidden         = true;
    toggleAddProspect.textContent  = '+ Add Prospect';
    loadCrmProspects();
  });

  // ── CRM Detail Modal ──────────────────────────────────────────────────────

  const crmModalClose   = document.getElementById('crmModalClose');
  const crmActionStatus = document.getElementById('crmActionStatus');
  const crmStatusSelect = document.getElementById('crmStatusSelect');

  crmModalClose.addEventListener('click', closeCrmModal);
  crmModal.addEventListener('click', e => { if (e.target === crmModal) closeCrmModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !crmModal.hidden) closeCrmModal(); });

  function closeCrmModal() {
    crmModal.hidden = true;
    crmCurrentId    = null;
  }

  async function openCrmDetail(leadId) {
    crmCurrentId           = leadId;
    crmActionStatus.hidden = true;

    const cached = crmProspects.find(p => p.id === leadId);
    if (cached) populateCrmModal(cached);
    crmModal.hidden = false;

    try {
      const res = await adminFetch(`${CRM_API_BASE}/leads/${leadId}`);
      if (res.ok) {
        const data = await res.json();
        console.log('[crm] single lead raw response:', data);
        const freshLead = data.lead || data;
        console.log('[crm] fresh lead:', freshLead);
        if (crmCurrentId === leadId) {
          populateCrmModal(freshLead);
          crmProspects = crmProspects.map(p => p.id === freshLead.id ? freshLead : p);
        }
      }
    } catch {}
  }

  function renderWebsiteScrape(ws) {
    if (!ws || typeof ws !== 'object') {
      return `<div class="crm-field">
        <span class="crm-field-label">Status</span>
        <span class="crm-field-val crm-ai-empty">Not scraped yet</span>
      </div>`;
    }
    const pageCount  = Array.isArray(ws.pages_scraped) ? ws.pages_scraped.length : '—';
    const lastScraped = ws.scraped_at ? fmtDate(ws.scraped_at) : '—';
    return `
      <div class="crm-field">
        <span class="crm-field-label">Status</span>
        <span class="crm-field-val"><span class="badge badge--outreach-ready">Scraped</span></span>
      </div>
      <div class="crm-field">
        <span class="crm-field-label">Pages</span>
        <span class="crm-field-val">${esc(String(pageCount))}</span>
      </div>
      <div class="crm-field">
        <span class="crm-field-label">Last Scraped</span>
        <span class="crm-field-val">${esc(lastScraped)}</span>
      </div>
    `;
  }

  function renderAnalysis(analysis) {
    if (!analysis || typeof analysis !== 'object') {
      return `<p class="crm-ai-text crm-ai-empty">No analysis yet. Click Analyze to run AI analysis.</p>`;
    }

    const row = (label, val) => val
      ? `<div class="crm-field"><span class="crm-field-label">${label}</span><span class="crm-field-val">${esc(String(val))}</span></div>`
      : '';

    const listSection = (label, arr) => {
      if (!Array.isArray(arr) || !arr.length) return '';
      const items = arr.map(x =>
        `<div class="crm-field" style="gap:6px;">
           <span style="color:var(--text-muted);flex-shrink:0;">•</span>
           <span class="crm-field-val">${esc(String(x))}</span>
         </div>`
      ).join('');
      return `<div style="margin-top:10px;"><div class="crm-detail-label" style="margin-bottom:6px;">${label}</div>${items}</div>`;
    };

    const parts = [
      row('Summary',           analysis.business_summary),
      row('Customer Type',     analysis.likely_customer_type),
      row('AIKB Fit',          analysis.ai_knowledge_base_fit),
      row('Outreach Angle',    analysis.outreach_angle),
      row('Offer',             analysis.recommended_offer),
      row('Urgency',           analysis.urgency_level),
      listSection('Pain Points',              analysis.possible_pain_points),
      listSection('Automation Opportunities', analysis.automation_opportunities),
    ].filter(Boolean);

    return parts.length
      ? parts.join('')
      : `<p class="crm-ai-text crm-ai-empty">No analysis details available.</p>`;
  }

  function populateCrmModal(p) {
    const analysis = (p.analysis && typeof p.analysis === 'object') ? p.analysis : null;
    const scoring  = analysis ? (analysis.scoring || {}) : {};

    // Score: top-level field first, then analysis.scoring.score
    const score = p.score != null ? p.score : (scoring.score != null ? scoring.score : null);

    // Priority: analysis.scoring.priority → p.priority → derived from score
    const rawPriority = (
      (scoring.priority || p.priority || '').toLowerCase() ||
      (score != null ? (score >= 80 ? 'high' : score >= 50 ? 'medium' : 'low') : '')
    );
    const priClass = { high: 'badge--priority-high', medium: 'badge--priority-medium', low: 'badge--priority-low' }[rawPriority];

    const scoreColor = score == null ? 'var(--text-muted)'
                     : score >= 80   ? 'var(--success)'
                     : score >= 60   ? 'var(--warn)'
                     :                 'var(--error)';

    document.getElementById('crmModalName').textContent = p.business_name || 'Unnamed Prospect';

    const statusEl       = document.getElementById('crmModalStatus');
    const status         = p.status || 'new';
    statusEl.textContent = status.replace(/_/g, ' ');
    statusEl.className   = `badge ${crmStatusClass(status)}`;

    document.getElementById('crmDetailBusiness').innerHTML = `
      <div class="crm-field">
        <span class="crm-field-label">Website</span>
        <span class="crm-field-val">${
          p.website_url
            ? `<a href="${esc(p.website_url)}" target="_blank" rel="noopener" class="crm-link">${esc(p.website_url)}</a>`
            : '—'
        }</span>
      </div>
      <div class="crm-field">
        <span class="crm-field-label">Industry</span>
        <span class="crm-field-val">${esc(p.industry || '—')}</span>
      </div>
      <div class="crm-field">
        <span class="crm-field-label">Location</span>
        <span class="crm-field-val">${esc(p.location || '—')}</span>
      </div>
    `;

    document.getElementById('crmDetailWebsite').innerHTML = renderWebsiteScrape(p.website_scrape);

    document.getElementById('crmDetailContact').innerHTML = `
      <div class="crm-field">
        <span class="crm-field-label">Name</span>
        <span class="crm-field-val">${esc(p.contact_name  || '—')}</span>
      </div>
      <div class="crm-field">
        <span class="crm-field-label">Email</span>
        <span class="crm-field-val">${esc(p.contact_email || '—')}</span>
      </div>
      <div class="crm-field">
        <span class="crm-field-label">Phone</span>
        <span class="crm-field-val">${esc(p.contact_phone || '—')}</span>
      </div>
    `;

    document.getElementById('crmDetailScore').innerHTML = `
      <div class="crm-field">
        <span class="crm-field-label">Score</span>
        <span class="crm-field-val" style="color:${scoreColor};font-weight:700;font-size:1.05rem;">${score != null ? score : '—'}</span>
      </div>
      <div class="crm-field">
        <span class="crm-field-label">Priority</span>
        <span class="crm-field-val">${
          priClass
            ? `<span class="badge ${priClass}">${esc(rawPriority)}</span>`
            : esc(rawPriority || '—')
        }</span>
      </div>
    `;

    document.getElementById('crmDetailNotes').innerHTML = p.notes
      ? `<p class="crm-notes-text">${esc(p.notes)}</p>`
      : `<p class="crm-ai-text crm-ai-empty">No notes.</p>`;

    document.getElementById('crmDetailAnalysis').innerHTML = renderAnalysis(analysis);

    // Score breakdown lives at analysis.scoring.score_breakdown
    renderScoreBreakdown(scoring.score_breakdown || analysis?.score_breakdown);

    // Outreach draft: top-level field first, then analysis.outreach.email_body
    const outreachText = p.outreach_draft || (analysis && analysis.outreach && analysis.outreach.email_body) || null;
    document.getElementById('crmDetailOutreach').innerHTML = outreachText
      ? `<pre class="crm-outreach-pre">${esc(outreachText)}</pre>`
      : `<p class="crm-ai-text crm-ai-empty">No outreach draft yet. Click Generate Outreach to create one.</p>`;

    crmStatusSelect.value = status;
  }

  function renderScoreBreakdown(breakdown) {
    const el = document.getElementById('crmDetailBreakdown');
    if (!breakdown || typeof breakdown !== 'object' || Array.isArray(breakdown)) {
      el.innerHTML = `<p class="crm-ai-text crm-ai-empty">No score breakdown yet. Click Score to generate.</p>`;
      return;
    }
    const entries = Object.entries(breakdown);
    if (!entries.length) {
      el.innerHTML = `<p class="crm-ai-text crm-ai-empty">No score breakdown data.</p>`;
      return;
    }
    el.innerHTML = `<div class="crm-score-breakdown">${entries.map(([key, val]) => {
      const pct   = Math.min(100, Math.max(0, Number(val) || 0));
      const color = pct >= 80 ? 'var(--success)' : pct >= 60 ? 'var(--warn)' : 'var(--error)';
      return `
        <div class="crm-score-row">
          <span class="crm-score-key">${esc(key.replace(/_/g, ' '))}</span>
          <div class="crm-score-bar-wrap">
            <div class="crm-score-bar" style="width:${pct}%;background:${color};"></div>
          </div>
          <span class="crm-score-num" style="color:${color};">${pct}</span>
        </div>
      `;
    }).join('')}</div>`;
  }

  // ── Modal action helpers ──────────────────────────────────────────────────

  let actionStatusTimer = null;

  function showActionStatus(msg, isError = false) {
    crmActionStatus.textContent = msg;
    crmActionStatus.style.color = isError ? 'var(--error)' : 'var(--success)';
    crmActionStatus.hidden      = false;
    clearTimeout(actionStatusTimer);
    actionStatusTimer = setTimeout(() => { crmActionStatus.hidden = true; }, 4000);
  }

  const MODAL_ACTION_IDS = ['btnScrape', 'btnAnalyze', 'btnScore', 'btnOutreach', 'btnCopyOutreach', 'btnContacted', 'btnReplied', 'btnBooked', 'crmStatusSelect'];

  function setModalBusy(busy) {
    MODAL_ACTION_IDS.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = busy;
    });
  }

  async function runAiAction(endpoint, btnId, loadingLabel, successMsg, failMsg = 'Action failed.') {
    if (!crmCurrentId) return;
    const btn = document.getElementById(btnId);
    const originalText = btn.textContent;
    setModalBusy(true);
    btn.textContent = loadingLabel;
    try {
      const res = await adminFetch(`${CRM_API_BASE}/${endpoint}/${crmCurrentId}`, { method: 'POST' });
      if (res.ok) {
        showActionStatus(successMsg);
        const savedId = crmCurrentId;
        await openCrmDetail(savedId);
        await loadCrmProspects();
      } else {
        const body = await res.json().catch(() => ({}));
        showActionStatus(body.error || failMsg, true);
      }
    } catch {
      showActionStatus('Network error.', true);
    } finally {
      setModalBusy(false);
      btn.textContent = originalText;
    }
  }

  async function setCrmStatus(status) {
    if (!crmCurrentId) return;
    setModalBusy(true);
    try {
      const res = await adminFetch(`${CRM_API_BASE}/leads/${crmCurrentId}/status`, {
        method: 'PATCH',
        body:   JSON.stringify({ status }),
      });
      if (res.ok) {
        showActionStatus(`Status set to "${status.replace(/_/g, ' ')}".`);
        const savedId = crmCurrentId;
        await openCrmDetail(savedId);
        await loadCrmProspects();
      } else {
        const body = await res.json().catch(() => ({}));
        showActionStatus(body.error || 'Failed to update status.', true);
      }
    } catch {
      showActionStatus('Network error.', true);
    } finally {
      setModalBusy(false);
    }
  }

  document.getElementById('btnScrape').addEventListener('click',
    () => runAiAction('scrape', 'btnScrape', 'Scraping…', 'Website scraped.', 'Website scraping failed. The site may block automated requests.'));

  document.getElementById('btnAnalyze').addEventListener('click',
    () => runAiAction('analyze', 'btnAnalyze', 'Analyzing…', 'Analysis complete.'));

  document.getElementById('btnScore').addEventListener('click',
    () => runAiAction('score', 'btnScore', 'Scoring…', 'Score updated.'));

  document.getElementById('btnOutreach').addEventListener('click',
    () => runAiAction('outreach', 'btnOutreach', 'Generating…', 'Outreach draft ready.'));

  document.getElementById('btnCopyOutreach').addEventListener('click', async () => {
    const pre = document.querySelector('#crmDetailOutreach pre');
    if (!pre) { showActionStatus('No outreach draft to copy.', true); return; }
    try {
      await navigator.clipboard.writeText(pre.textContent);
      const btn = document.getElementById('btnCopyOutreach');
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = orig; }, 2000);
    } catch {
      showActionStatus('Could not copy to clipboard.', true);
    }
  });

  document.getElementById('btnContacted').addEventListener('click', () => setCrmStatus('contacted'));
  document.getElementById('btnReplied').addEventListener('click',   () => setCrmStatus('replied'));
  document.getElementById('btnBooked').addEventListener('click',    () => setCrmStatus('booked_call'));

  crmStatusSelect.addEventListener('change', e => setCrmStatus(e.target.value));

  // ---- Init ----

  if (getToken()) {
    showDashboard();
  } else {
    showLogin();
  }
})();
