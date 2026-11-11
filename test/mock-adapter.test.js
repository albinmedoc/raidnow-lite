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
