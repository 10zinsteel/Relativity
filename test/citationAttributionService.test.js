const test = require('node:test');
const assert = require('node:assert/strict');
const { createCitationAttributionService } = require('../services/citationAttributionService');

const CLIENT_ID = 'client-a';

function makeService(members) {
  const calls = [];
  const supabaseService = {
    getClientMembersByIds: async (clientId, memberIds) => {
      calls.push({ clientId, memberIds });
      return members;
    },
  };
  return { service: createCitationAttributionService({ supabaseService }), calls };
}

test('requires clientId', async () => {
  const { service } = makeService([]);
  await assert.rejects(() => service.enrichSourcesWithContributorNames(null, []), /requires clientId/);
});

test('an empty or missing sources array is returned as-is, no lookup performed', async () => {
  const { service, calls } = makeService([]);
  assert.deepEqual(await service.enrichSourcesWithContributorNames(CLIENT_ID, []), []);
  assert.deepEqual(await service.enrichSourcesWithContributorNames(CLIENT_ID, null), []);
  assert.equal(calls.length, 0);
});

test('sources with no contributingMemberId at all (e.g. every source is a plain document) skip the lookup entirely', async () => {
  const { service, calls } = makeService([]);
  const sources = [{ documentId: 'd1', fileName: 'PTO.pdf' }];
  const result = await service.enrichSourcesWithContributorNames(CLIENT_ID, sources);
  assert.deepEqual(result, sources);
  assert.equal(calls.length, 0);
});

test('resolves contributingMemberId to full_name, stripping the raw id from the returned source', async () => {
  const { service, calls } = makeService([{ id: 'member-a', email: 'alex@example.com', full_name: 'Alex Doe' }]);
  const result = await service.enrichSourcesWithContributorNames(CLIENT_ID, [
    { documentId: 'd1', subject: 'Renewal', contributingMemberId: 'member-a' },
  ]);
  assert.deepEqual(calls[0], { clientId: CLIENT_ID, memberIds: ['member-a'] });
  assert.deepEqual(result, [{ documentId: 'd1', subject: 'Renewal', contributingMemberName: 'Alex Doe' }]);
  assert.ok(!('contributingMemberId' in result[0]));
});

test('falls back to email when full_name is null', async () => {
  const { service } = makeService([{ id: 'member-a', email: 'alex@example.com', full_name: null }]);
  const result = await service.enrichSourcesWithContributorNames(CLIENT_ID, [
    { documentId: 'd1', contributingMemberId: 'member-a' },
  ]);
  assert.equal(result[0].contributingMemberName, 'alex@example.com');
});

test('a lookup miss (e.g. hard-deleted member) gets no attribution, not a "via undefined" name — id still stripped', async () => {
  const { service } = makeService([]); // member row no longer exists
  const result = await service.enrichSourcesWithContributorNames(CLIENT_ID, [
    { documentId: 'd1', contributingMemberId: 'member-gone' },
  ]);
  assert.deepEqual(result, [{ documentId: 'd1' }]);
  assert.ok(!('contributingMemberName' in result[0]));
});

test('distinct contributingMemberIds across multiple sources are batched into ONE lookup call, deduplicated', async () => {
  const { service, calls } = makeService([
    { id: 'member-a', email: 'a@x.com', full_name: 'A' },
    { id: 'member-b', email: 'b@x.com', full_name: 'B' },
  ]);
  const result = await service.enrichSourcesWithContributorNames(CLIENT_ID, [
    { documentId: 'd1', contributingMemberId: 'member-a' },
    { documentId: 'd2', contributingMemberId: 'member-b' },
    { documentId: 'd3', contributingMemberId: 'member-a' }, // duplicate id
    { documentId: 'd4' }, // plain document, no contributingMemberId at all
  ]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].memberIds.sort(), ['member-a', 'member-b']);
  assert.equal(result[0].contributingMemberName, 'A');
  assert.equal(result[1].contributingMemberName, 'B');
  assert.equal(result[2].contributingMemberName, 'A');
  assert.deepEqual(result[3], { documentId: 'd4' });
});

test('security: a pre-existing contributingMemberName on an incoming source (never set by AIKB in practice) is stripped, not trusted, when there is no matching contributingMemberId', async () => {
  const { service } = makeService([]);
  const result = await service.enrichSourcesWithContributorNames(CLIENT_ID, [
    { documentId: 'd1', contributingMemberName: 'Attacker-Controlled Name' },
  ]);
  assert.deepEqual(result, [{ documentId: 'd1' }]);
});

test('security: a pre-existing contributingMemberName is replaced (not appended to or trusted) by the real resolved name when a valid contributingMemberId is also present', async () => {
  const { service } = makeService([{ id: 'member-a', email: 'a@x.com', full_name: 'Real Name' }]);
  const result = await service.enrichSourcesWithContributorNames(CLIENT_ID, [
    { documentId: 'd1', contributingMemberId: 'member-a', contributingMemberName: 'Attacker-Controlled Name' },
  ]);
  assert.deepEqual(result, [{ documentId: 'd1', contributingMemberName: 'Real Name' }]);
});

test('does not mutate the input array or its objects', async () => {
  const { service } = makeService([{ id: 'member-a', email: 'a@x.com', full_name: 'A' }]);
  const original = [{ documentId: 'd1', contributingMemberId: 'member-a' }];
  const originalCopy = JSON.parse(JSON.stringify(original));
  await service.enrichSourcesWithContributorNames(CLIENT_ID, original);
  assert.deepEqual(original, originalCopy);
});
