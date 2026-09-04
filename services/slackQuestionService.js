'use strict';

// Question extraction/normalization for app_mention events (Architecture
// Review Phase 4, Milestone 4, §4.11). Pure, no I/O — never forwards the
// raw Slack event to AIKB, only the extracted natural-language question.
// Slack markup inside the text is treated as inert data, never as
// instructions to the model (Phase 2 §10 prompt-injection demarcation).

const config = require('../config');

const EMPTY_QUESTION_REPLY = 'Please include a question after mentioning me.';
const TOO_LONG_QUESTION_REPLY = 'That question is too long — please shorten it and ask again.';

/**
 * Builds a regex matching the bot's own <@BOT_ID> or <@BOT_ID|label> mention
 * token, anchored so only a LEADING occurrence is stripped (a mention that
 * appears mid-sentence is left intact, since it's part of the question).
 */
function buildLeadingMentionPattern(botUserId) {
  const escaped = botUserId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*<@${escaped}(\\|[^>]*)?>\\s*`, 'g');
}

/**
 * @param {string} rawText - event.text from a verified app_mention event.
 * @param {string} botUserId - the resolved connection's bot_user_id (never trusted from the payload itself).
 * @param {number} [maxLength] - defaults to config.slack.questionMaxLength.
 * @returns {{ ok: boolean, question: string|null, reason: 'empty'|'too_long'|null }}
 */
function extractQuestion(rawText, botUserId, maxLength = config.slack.questionMaxLength) {
  const text = typeof rawText === 'string' ? rawText : '';

  let stripped = text;
  if (botUserId) {
    stripped = stripped.replace(buildLeadingMentionPattern(botUserId), '');
  }
  // Any further leading mentions (e.g. someone @-tags the bot after another
  // user) are left in place — only the bot's own leading mention is removed,
  // per §4.11.

  const question = stripped.trim();

  if (!question) {
    return { ok: false, question: null, reason: 'empty' };
  }
  if (question.length > maxLength) {
    return { ok: false, question: null, reason: 'too_long' };
  }

  return { ok: true, question, reason: null };
}

module.exports = {
  extractQuestion,
  EMPTY_QUESTION_REPLY,
  TOO_LONG_QUESTION_REPLY,
};
