// tests/radar.test.mjs —— 纯逻辑单测，不打网络。
// 跑：node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { diffTags, buildIssue, patchOf, pairingNote, readState, fetchPackage, main } from '../scripts/radar.js';

const CLI = '@anthropic-ai/claude-code';
const SDK = '@anthropic-ai/claude-agent-sdk';

// 造一份 curr 形态（fetchPackage 的返回值形状）
const snap = (tags, times = {}) => ({ tags, times });

// ──────────────────────── diffTags ────────────────────────

test('首次见到某个包记为初始化，不产出变更', () => {
  const curr = { [CLI]: snap({ latest: '2.1.220', stable: '2.1.212', next: '2.1.220' }) };
  const { changes, initialized } = diffTags({}, curr);

  assert.equal(changes.length, 0, '首跑不该把当前版本全报成新发布');
  assert.equal(initialized.length, 1);
  assert.equal(initialized[0].pkg, CLI);
});

test('版本没动时无变更', () => {
  const prev = { [CLI]: { latest: '2.1.220', stable: '2.1.212', next: '2.1.220' } };
  const curr = { [CLI]: snap({ latest: '2.1.220', stable: '2.1.212', next: '2.1.220' }) };

  assert.deepEqual(diffTags(prev, curr).changes, []);
});

test('latest 前进产出一条变更，带发布时间', () => {
  const prev = { [CLI]: { latest: '2.1.220', stable: '2.1.212', next: '2.1.220' } };
  const curr = {
    [CLI]: snap(
      { latest: '2.1.221', stable: '2.1.212', next: '2.1.221' },
      { '2.1.221': '2026-08-03T10:00:00.000Z' },
    ),
  };
  const { changes } = diffTags(prev, curr);

  // latest 和 next 都动了 → 两条
  assert.equal(changes.length, 2);
  const latest = changes.find(c => c.tag === 'latest');
  assert.deepEqual(
    { from: latest.from, to: latest.to, publishedAt: latest.publishedAt },
    { from: '2.1.220', to: '2.1.221', publishedAt: '2026-08-03T10:00:00.000Z' },
  );
});

test('stable 单独前进也能抓到（latest 没动）', () => {
  const prev = { [CLI]: { latest: '2.1.220', stable: '2.1.212', next: '2.1.220' } };
  const curr = { [CLI]: snap({ latest: '2.1.220', stable: '2.1.220', next: '2.1.220' }) };
  const { changes } = diffTags(prev, curr);

  assert.equal(changes.length, 1);
  assert.equal(changes[0].tag, 'stable');
  assert.equal(changes[0].from, '2.1.212');
});

test('上游新增 tag 时 from 为 null 而不是崩', () => {
  const prev = { [CLI]: { latest: '2.1.220', next: '2.1.220' } }; // 此前没有 stable
  const curr = { [CLI]: snap({ latest: '2.1.220', stable: '2.1.212', next: '2.1.220' }) };
  const { changes } = diffTags(prev, curr);

  assert.equal(changes.length, 1);
  assert.equal(changes[0].from, null);
  assert.equal(changes[0].to, '2.1.212');
});

test('某个包这次没抓到时，不把它当作变更（保留旧 state）', () => {
  const prev = { [CLI]: { latest: '2.1.220' }, [SDK]: { latest: '0.3.220' } };
  const curr = { [CLI]: snap({ latest: '2.1.221' }) }; // SDK 抓取失败，不在 curr 里
  const { changes } = diffTags(prev, curr);

  assert.equal(changes.length, 1);
  assert.equal(changes[0].pkg, CLI, 'SDK 没抓到就不该产生任何 SDK 相关的变更');
});

test('未列入监控的 tag 被忽略', () => {
  // SDK 的监控 tag 只有 latest/next，上游即使有 stable 也不报
  const prev = { [SDK]: { latest: '0.3.220', next: '0.3.220' } };
  const curr = { [SDK]: snap({ latest: '0.3.220', next: '0.3.220', stable: '0.3.100' }) };

  assert.deepEqual(diffTags(prev, curr).changes, []);
});

// ──────────────────────── patch 配对 ────────────────────────

test('patchOf 取版本号第三段，非法输入给 null', () => {
  assert.equal(patchOf('2.1.220'), 220);
  assert.equal(patchOf('0.3.201'), 201);
  assert.equal(patchOf('2.1.220-beta.1'), 220);
  assert.equal(patchOf('nonsense'), null);
  assert.equal(patchOf(undefined), null);
});

test('CLI 与 SDK patch 号一致 → 配对通过', () => {
  const note = pairingNote({ [CLI]: '2.1.221', [SDK]: '0.3.221' });
  assert.match(note, /✅/);
  assert.doesNotMatch(note, /不配对/);
});

test('patch 号不一致 → 明确标注不配对', () => {
  const note = pairingNote({ [CLI]: '2.1.220', [SDK]: '0.3.201' });
  assert.match(note, /⚠️/);
  assert.match(note, /不配对/);
});

test('只有一个包变化时不下配对结论', () => {
  assert.equal(pairingNote({ [CLI]: '2.1.221' }), null, '缺一边就无从判断配对，不能瞎报');
});

// ──────────────────────── buildIssue ────────────────────────

test('标题只含 latest 的新版本与日期', () => {
  const changes = [
    { pkg: CLI, tag: 'latest', from: '2.1.220', to: '2.1.221', publishedAt: '2026-08-03T10:00:00.000Z' },
    { pkg: CLI, tag: 'stable', from: '2.1.212', to: '2.1.220', publishedAt: null },
    { pkg: SDK, tag: 'latest', from: '0.3.220', to: '0.3.221', publishedAt: '2026-08-03T09:59:58.000Z' },
  ];
  const { title } = buildIssue(changes, { now: new Date('2026-08-03T12:00:00Z') });

  assert.equal(title, 'claude-code 2.1.221 · agent-sdk 0.3.221（2026-08-03）');
  assert.doesNotMatch(title, /stable/, 'stable 变动属于正文，不该撑长标题');
});

test('只有 stable 变化时标题有兜底、不为空', () => {
  const changes = [{ pkg: CLI, tag: 'stable', from: '2.1.212', to: '2.1.220', publishedAt: null }];
  const { title } = buildIssue(changes, { now: new Date('2026-08-03T12:00:00Z') });

  assert.equal(title, 'dist-tag 变动（2026-08-03）');
});

test('正文含每条变化的表格行与 npm 链接', () => {
  const changes = [
    { pkg: CLI, tag: 'latest', from: '2.1.220', to: '2.1.221', publishedAt: '2026-08-03T10:00:00.000Z' },
  ];
  const { body } = buildIssue(changes);

  assert.match(body, /`2\.1\.220`.*→.*`2\.1\.221`/);
  assert.match(body, /npmjs\.com\/package\/@anthropic-ai\/claude-code\/v\/2\.1\.221/);
  assert.match(body, /2026-08-03 10:00:00 UTC/);
  assert.match(body, /github\.com\/anthropics\/claude-code\/releases\/tag\/v2\.1\.221/);
});

test('SDK 不产出 GitHub release 链接（未确认逐版打 release）', () => {
  const changes = [{ pkg: SDK, tag: 'latest', from: '0.3.220', to: '0.3.221', publishedAt: null }];
  const { body } = buildIssue(changes);

  assert.doesNotMatch(body, /releases\/tag/);
  assert.match(body, /npmjs\.com\/package\/@anthropic-ai\/claude-agent-sdk/);
});

test('发布时间缺失时用占位符而不是 undefined', () => {
  const changes = [{ pkg: CLI, tag: 'stable', from: '2.1.212', to: '2.1.220', publishedAt: null }];
  const { body } = buildIssue(changes);

  assert.doesNotMatch(body, /undefined|null/);
});

// ──────────────────────── readState ────────────────────────

test('state 文件不存在时给空壳', () => {
  assert.deepEqual(readState(join(tmpdir(), 'radar-nope-' + Math.random())), { packages: {} });
});

test('state 文件损坏时按首次运行处理，不抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-'));
  const file = join(dir, 'state.json');
  writeFileSync(file, '{ 这不是 JSON');

  assert.deepEqual(readState(file), { packages: {} }, '坏文件不该让雷达从此哑掉');
});

// ──────────────────────── fetchPackage（注入假 fetch）────────────────────────

test('fetchPackage 只取 dist-tags 与 time', async () => {
  const fake = async () => ({
    ok: true,
    json: async () => ({
      'dist-tags': { latest: '2.1.220' },
      time: { '2.1.220': '2026-07-24T23:11:21.821Z' },
      versions: { '2.1.220': { /* 大块无关数据 */ } },
    }),
  });
  const out = await fetchPackage(CLI, { fetchImpl: fake });

  assert.deepEqual(out, { tags: { latest: '2.1.220' }, times: { '2.1.220': '2026-07-24T23:11:21.821Z' } });
});

test('registry 非 200 时抛出带状态码的错误', async () => {
  const fake = async () => ({ ok: false, status: 503, json: async () => ({}) });

  await assert.rejects(() => fetchPackage(CLI, { fetchImpl: fake }), /503/);
});

// ──────────────────────── main 端到端（假网络 + 临时 state）────────────────────────

function fakeRegistry(map) {
  return async url => {
    const name = decodeURIComponent(String(url).replace('https://registry.npmjs.org/', ''));
    if (!map[name]) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, json: async () => map[name] };
  };
}

test('main 首跑写 state 且不产出 issue，二跑无变化', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-'));
  const stateFile = join(dir, 'state.json');
  const issueBodyFile = join(dir, 'issue-body.md');
  const registry = fakeRegistry({
    [CLI]: { 'dist-tags': { latest: '2.1.220', stable: '2.1.212', next: '2.1.220' }, time: {} },
    [SDK]: { 'dist-tags': { latest: '0.3.220', next: '0.3.220' }, time: {} },
  });

  const first = await main({ fetchImpl: registry, stateFile, issueBodyFile, log: () => {} });
  assert.equal(first.changes.length, 0);
  assert.equal(first.initialized.length, 2);
  assert.equal(existsSync(issueBodyFile), false, '无变更时不该产出 issue 正文');

  const written = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(written.packages[CLI].latest, '2.1.220');

  const second = await main({ fetchImpl: registry, stateFile, issueBodyFile, log: () => {} });
  assert.equal(second.changes.length, 0);
  assert.equal(second.initialized.length, 0, '第二次不该再报初始化');
});

test('main 在上游前进时产出 issue', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-'));
  const stateFile = join(dir, 'state.json');
  writeFileSync(stateFile, JSON.stringify({
    packages: { [CLI]: { latest: '2.1.220', stable: '2.1.212', next: '2.1.220' }, [SDK]: { latest: '0.3.220', next: '0.3.220' } },
  }));

  const registry = fakeRegistry({
    [CLI]: { 'dist-tags': { latest: '2.1.221', stable: '2.1.212', next: '2.1.221' }, time: { '2.1.221': '2026-08-03T10:00:00.000Z' } },
    [SDK]: { 'dist-tags': { latest: '0.3.221', next: '0.3.221' }, time: { '0.3.221': '2026-08-03T09:59:58.000Z' } },
  });

  const issueBodyFile = join(dir, 'issue-body.md');
  const out = await main({ fetchImpl: registry, stateFile, issueBodyFile, log: () => {} });

  assert.equal(out.changes.length, 4, 'CLI latest+next、SDK latest+next');
  assert.match(out.issue.title, /claude-code 2\.1\.221/);
  assert.match(out.issue.title, /agent-sdk 0\.3\.221/);
  assert.match(out.issue.body, /✅ patch 号配对/);
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).packages[CLI].latest, '2.1.221');

  // 正文必须落在注入的路径上。写死常量的话这里会红——而那正是它把产物写进仓库根的形态。
  assert.equal(existsSync(issueBodyFile), true, 'issue 正文该写到注入的路径');
  assert.equal(readFileSync(issueBodyFile, 'utf8').trim(), out.issue.body.trim());
});

test('一个包抓失败时另一个照常比对，失败方 state 保留旧值', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-'));
  const stateFile = join(dir, 'state.json');
  writeFileSync(stateFile, JSON.stringify({
    packages: { [CLI]: { latest: '2.1.220' }, [SDK]: { latest: '0.3.220' } },
  }));

  // 只有 CLI 可达，SDK 404
  const registry = fakeRegistry({
    [CLI]: { 'dist-tags': { latest: '2.1.221' }, time: {} },
  });

  const out = await main({ fetchImpl: registry, stateFile, issueBodyFile: join(dir, 'issue-body.md'), log: () => {} });

  assert.equal(out.changes.length, 1);
  assert.equal(out.changes[0].pkg, CLI);

  const written = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(written.packages[SDK].latest, '0.3.220', '抓失败的包不该被从 state 里抹掉');
  assert.equal(written.packages[CLI].latest, '2.1.221');
});

test('两个包都抓不到时不动 state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-'));
  const stateFile = join(dir, 'state.json');
  const before = JSON.stringify({ packages: { [CLI]: { latest: '2.1.220' } } });
  writeFileSync(stateFile, before);

  const out = await main({ fetchImpl: fakeRegistry({}), stateFile, issueBodyFile: join(dir, 'issue-body.md'), log: () => {} });

  assert.equal(out.failed, true);
  assert.equal(readFileSync(stateFile, 'utf8'), before, '全网失败时 state 必须原封不动');
});
