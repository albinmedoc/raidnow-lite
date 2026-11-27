import test from 'node:test';
import assert from 'node:assert/strict';
import { MockRaidNowAdapter } from '../src/adapters/mock-raidnow-adapter.js';

test('mock adapter exposes raids and deterministically matches a selected boss', async () => {
  const adapter = new MockRaidNowAdapter({ matchAfterPolls: 2 });
  const raids = await adapter.listRaids();
  const boss = raids[0].rpl_pokemon;
  await adapter.createMatching({ selection: { ranks: [raids[0].rpl_rank], pokemon: [boss] } });
  assert.equal((await adapter.pollMatching()).rpllm_status, 1);
  const match = await adapter.pollMatching();
  assert.equal(match.rpllm_status, 2);
  assert.equal((await adapter.findRaid(match.rpllm_rpl_id)).rpl_pokemon, boss);
});

test('mock adapter supports deterministic fast joining', async () => {
  const adapter = new MockRaidNowAdapter();
  const raid = (await adapter.listRaids())[0];
  const response = await adapter.joinRaidFast(raid.rpl_id, { trainerName: 'Albin123' });
  assert.equal(response.status, 'success');
  assert.equal(response.data.rpl_id, raid.rpl_id);
  assert.equal(response.data.join, 1);
});

test('mock adapter exposes rated lobby players for UI verification', async () => {
  const adapter = new MockRaidNowAdapter();
  const raid = (await adapter.listRaids())[0];
  const details = await adapter.listRaidPlayers(raid.rpl_id);
  assert.equal(details.players[0].level, 50);
  assert.equal(details.players[0].rating, 5);
  assert.equal(details.players[0].countryCode, 'se');
  assert.equal(details.players[2].rating, 0);
  assert.equal(details.readyCount, 1);
});

test('mock adapter exposes demo profile history and blocks', async () => {
  const adapter = new MockRaidNowAdapter();
  assert.equal((await adapter.listJoinedHistory()).length, 1);
  assert.equal((await adapter.listKickedHistory()).length, 1);
  assert.equal((await adapter.listBlocks()).length, 1);
});

test('mock adapter hosts and manages a deterministic demo lobby', async () => {
  const adapter = new MockRaidNowAdapter();
  const bosses = await adapter.listCurrentRaidBosses();
  assert.equal(bosses[0].pokemon, 'Giratina');
  assert.ok(bosses.every((boss) => boss.image.startsWith('https://')));
  assert.deepEqual(await adapter.createHostedLobby({ pokemonId: 'Giratina' }, {}), { raidId: 'demo-host-1' });
  const initial = await adapter.getHostedLobbyStatus('demo-host-1');
  assert.equal(initial.players[0].id, 'demo-host-guest-1');
  assert.equal(initial.raidDeleted, false);
  assert.deepEqual(await adapter.kickHostedGuest('demo-host-1', 'demo-host-guest-1'), { kicked: true });
  assert.equal((await adapter.getHostedLobbyStatus('demo-host-1')).count, 0);
  assert.deepEqual(await adapter.startHostedLobby('demo-host-1'), { started: true });
  assert.deepEqual(await adapter.closeHostedLobby('demo-host-1'), { closed: true });
  assert.equal((await adapter.getHostedLobbyStatus('demo-host-1')).raidDeleted, true);
});

test('mock adapter leaves a matched demo raid without upstream writes', async () => {
  const adapter = new MockRaidNowAdapter({ matchAfterPolls: 1 });
  const raid = (await adapter.listRaids())[0];
  await adapter.createMatching({ selection: { ranks: [raid.rpl_rank], pokemon: [raid.rpl_pokemon] } });
  const match = await adapter.pollMatching();

  assert.equal((await adapter.findRaid(match.rpllm_rpl_id)).join, 1);
  assert.deepEqual(await adapter.leaveRaid(match.rpllm_rpl_id), { status: 'success' });
  assert.equal((await adapter.findRaid(match.rpllm_rpl_id)).join, 0);
});
