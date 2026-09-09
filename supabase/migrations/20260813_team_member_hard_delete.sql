-- Migration: 20260813_team_member_hard_delete
-- Owner-only "hard delete" for a team member — a true erasure, distinct
-- from the existing soft offboard_client_member (20260725_email_ingestion_em9.sql)
-- which only ever flips status and force-closes email sync.
--
-- email_connections.member_id is ON DELETE RESTRICT
-- (20260723_email_ingestion_em1.sql:222), so a plain
-- `DELETE FROM client_members` fails with a foreign-key violation for any
-- member who has ever connected Gmail. This function tears down that
-- member's mail integrations (and everything that cascades from them —
-- oauth_credentials, email_sync_state, email_sync_runs,
-- email_ingestion_events) before deleting the membership row itself.
--
-- Everything else either cascades automatically (client_member_sessions,
-- oauth_states, slack_link_codes, slack_user_links — all ON DELETE CASCADE
-- off client_members) or is intentionally preserved with the FK nulled
-- (team_invites.invited_by, oauth_connections.connected_by_member_id,
-- email_organization_settings.updated_by_member_id,
-- email_ingestion_rules.created_by_member_id,
-- email_sync_runs.triggered_by_member_id, document_import_log.imported_by,
-- client_members.invited_by) — e.g. an org-level Slack connection this
-- member happened to set up is the organization's, not "their" data, so it
-- survives with connected_by_member_id set to NULL rather than being
-- deleted.
--
-- Supabase-JS has no multi-statement transaction API from the client (the
-- same constraint that motivated replace_active_oauth_connection and
-- offboard_client_member) — this function is the atomicity boundary
-- instead, same shape: one PL/pgSQL function body executes inside one
-- transaction as part of the calling statement.
--
-- auth.users deletion is NOT done here — Postgres RPCs can't call the
-- Supabase Auth admin API. This function returns the deleted row's
-- auth_user_id so the calling service can best-effort
-- supabase.auth.admin.deleteUser(...) afterward (services/supabaseService.js).
--
-- Safe to run multiple times (CREATE OR REPLACE).

CREATE OR REPLACE FUNCTION hard_delete_client_member(
  p_member_id           uuid,
  p_client_id           uuid,
  p_deleted_by_member_id uuid
)
RETURNS TABLE (auth_user_id uuid, email text, role text)
LANGUAGE plpgsql
AS $$
DECLARE
  v_member client_members;
  v_owner_count integer;
BEGIN
  SELECT * INTO v_member
    FROM client_members
   WHERE id = p_member_id
     AND client_id = p_client_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'hard_delete_client_member: member % not found for client %', p_member_id, p_client_id;
  END IF;

  IF v_member.role = 'owner' THEN
    SELECT count(*) INTO v_owner_count
      FROM client_members
     WHERE client_id = p_client_id
       AND role = 'owner'
       AND status = 'active'
       AND id <> p_member_id;
    IF v_owner_count = 0 THEN
      RAISE EXCEPTION 'hard_delete_client_member: cannot delete the last owner';
    END IF;
  END IF;

  -- Audit trail — the only place this member's identity remains visible
  -- once the delete below completes.
  INSERT INTO automation_logs (client_id, event_type, payload)
  VALUES (
    p_client_id,
    'team_member_hard_deleted',
    jsonb_build_object(
      'member_id', v_member.id,
      'email', v_member.email,
      'role', v_member.role,
      'full_name', v_member.full_name,
      'deleted_by_member_id', p_deleted_by_member_id
    )
  );

  -- Every historical Gmail connection this member ever made (not just the
  -- active one) — cascades email_connections, oauth_credentials,
  -- email_sync_state, email_sync_runs, email_ingestion_events.
  DELETE FROM oauth_connections
   WHERE id IN (
     SELECT oauth_connection_id FROM email_connections WHERE member_id = p_member_id
   );

  RETURN QUERY
  DELETE FROM client_members
   WHERE id = p_member_id
     AND client_id = p_client_id
  RETURNING client_members.auth_user_id, client_members.email, client_members.role;
END;
$$;
