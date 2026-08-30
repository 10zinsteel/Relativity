-- Migration: 20260830_slack_live_lookup_removal_el7c
-- EL7C — Slack Live-Email Access Removal
-- (Architecture/architecture/LIVE_EMAIL_LOOKUP.md, EL7C).
--
-- Removes Slack identity linking (EL7A) and Slack's live-email-lookup path
-- (EL7B) entirely. Live email lookup remains portal-only, where the
-- session already resolves the asking member — Slack DMs have no
-- equivalent, and the manual "generate a code in the portal, DM it to the
-- bot" linking flow built to bridge that gap was never actually used:
-- slack_user_links has been empty since it shipped (20260731).
--
-- Drops both tables introduced by 20260731_slack_identity_linking_el7a.sql.
-- No other referencer anywhere in either repo (confirmed) — self-contained
-- to services/slackUserLinkService.js, which is deleted alongside this
-- migration.
--
-- Safe to run multiple times (DROP TABLE IF EXISTS). Destructive only to
-- these two tables' own rows — slack_user_links has been empty since it
-- shipped, and slack_link_codes holds nothing but short-lived, already-
-- expired one-time codes.

DROP TABLE IF EXISTS slack_user_links;
DROP TABLE IF EXISTS slack_link_codes;
