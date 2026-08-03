#!/usr/bin/env node
// scripts/radar.js —— Claude 发版雷达
//
// 每天查一次 npm registry，把 @anthropic-ai/claude-code（CLI）与
// @anthropic-ai/claude-agent-sdk（Agent SDK）的 dist-tag 变化记进 state.json，
// 有变化就产出一份 issue 文案交给 workflow 去开 issue（GitHub 再把它发成邮件）。
//
// 设计约束：
// · 零依赖 —— Node 20+ 内置 fetch，仓库不装任何 npm 包，CI 无需 npm ci。
// · 退出码恒 0 —— 上游发版不是本仓库的错，不该把 job 染红。有无变更走 stdout / GITHUB_OUTPUT。
// · 网络只在 fetchPackage 一处，且可注入 —— 其余全是纯函数，单测不打网。

import { readFileSync, writeFileSync, appendFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STATE_FILE = join(ROOT, 'state.json');
const ISSUE_BODY_FILE = join(ROOT, 'issue-body.md');

// 监控对象。tags 是该包**预期存在**的 dist-tag：claude-code 另有一条 stable 线
// （实测 latest=2.1.220 时 stable=2.1.212，落后 8 个版本），SDK 则只有 latest/next。
// 列出但上游实际没有的 tag 会被安静忽略，不报错——上游随时可能增删 tag。
export const PACKAGES = [
  { name: '@anthropic-ai/claude-code', label: 'claude-code (CLI)', tags: ['latest', 'stable', 'next'] },
  { name: '@anthropic-ai/claude-agent-sdk', label: 'claude-agent-sdk', tags: ['latest', 'next'] },
];

const REGISTRY = 'https://registry.npmjs.org';

// ──────────────────────── IO（唯一碰网络的地方）────────────────────────

// 取完整 packument（claude-code 有 472 个版本，响应几 MB），只用其中两块。
// ⚠️ 不能用 `application/vnd.npm.install-v1+json` 那个精简格式省流量：它**不含 time 字段**，
// 发布时间会整列变成占位符。单测喂的假数据带 time 所以照样全绿——这个只有打真网络才看得见。
export async function fetchPackage(name, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${REGISTRY}/${name}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`registry ${res.status} for ${name}`);
  const json = await res.json();
  return { tags: json['dist-tags'] ?? {}, times: json.time ?? {} };
}

export function readState(file = STATE_FILE) {
  if (!existsSync(file)) return { packages: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return { packages: parsed.packages ?? {} };
  } catch {
    // state 损坏当首次运行处理：宁可静默重新初始化，也不要因为一个坏文件让雷达从此哑掉。
    return { packages: {} };
  }
}

// ──────────────────────── 纯逻辑 ────────────────────────

// prev: { [pkg]: { [tag]: version } }
// curr: { [pkg]: { tags: {[tag]: version}, times: {[version]: iso} } }
//
// 首次见到某个包（prev 里没有它）→ 记为初始化，不产出变更。否则第一次跑会把
// 「当前所有版本」全报成新发布，收一封毫无意义的邮件。
export function diffTags(prev, curr) {
  const changes = [];
  const initialized = [];

  for (const { name, tags } of PACKAGES) {
    const seen = curr[name];
    if (!seen) continue; // 该包这次没抓到（网络失败），保留上次 state，不当作变更
    const before = prev[name];

    if (!before) {
      initialized.push({ pkg: name, tags: { ...seen.tags } });
      continue;
    }

    for (const tag of tags) {
      const to = seen.tags[tag];
      if (!to) continue;              // 上游没有这个 tag
      const from = before[tag];
      if (from === to) continue;      // 没动
      changes.push({
        pkg: name,
        tag,
        from: from ?? null,           // null = 上游新增了这个 tag
        to,
        publishedAt: seen.times[to] ?? null,
      });
    }
  }

  return { changes, initialized };
}

export function nextState(curr) {
  const packages = {};
  for (const [name, { tags }] of Object.entries(curr)) packages[name] = { ...tags };
  return { updatedAt: new Date().toISOString(), packages };
}

// 取版本号第三段。CLI 是 2.1.N、SDK 是 0.3.N —— 实测两者由同一条流水线产出
// （201/205/210/215/220 五个采样点跨 3 周，SDK 恒定比 CLI 早 2 秒发布，N 严格配对）。
// 所以 N 不一致是个值得看一眼的信号，说明上游这次没同步发。
export function patchOf(version) {
  const m = /^\d+\.\d+\.(\d+)/.exec(String(version ?? ''));
  return m ? Number(m[1]) : null;
}

export function pairingNote(latestByPkg) {
  const cli = latestByPkg['@anthropic-ai/claude-code'];
  const sdk = latestByPkg['@anthropic-ai/claude-agent-sdk'];
  if (!cli || !sdk) return null;
  const a = patchOf(cli);
  const b = patchOf(sdk);
  if (a === null || b === null) return null;
  return a === b
    ? `✅ patch 号配对：CLI \`${cli}\` ↔ SDK \`${sdk}\`（同一条发版流水线，符合预期）`
    : `⚠️ patch 号**不配对**：CLI \`${cli}\` ↔ SDK \`${sdk}\` —— 上游这次没同步发，用之前确认兼容性。`;
}

function npmLink(pkg, version) {
  return `https://www.npmjs.com/package/${pkg}/v/${version}`;
}

// CLI 的 tag 与 anthropics/claude-code 的 GitHub release 一一对应（v2.1.220）。
// SDK 仓库是 anthropics/claude-agent-sdk-typescript，未确认它逐版打 release，故只给 npm 链接。
function releaseLink(pkg, version) {
  if (pkg === '@anthropic-ai/claude-code') {
    return `https://github.com/anthropics/claude-code/releases/tag/v${version}`;
  }
  return null;
}

const SHORT = { '@anthropic-ai/claude-code': 'claude-code', '@anthropic-ai/claude-agent-sdk': 'agent-sdk' };

export function buildIssue(changes, { now = new Date() } = {}) {
  const date = now.toISOString().slice(0, 10);

  // 标题只放 latest 的新值：stable/next 的变动放正文，免得标题被撑长。
  const latestByPkg = {};
  for (const c of changes) if (c.tag === 'latest') latestByPkg[c.pkg] = c.to;

  const headline = Object.entries(latestByPkg)
    .map(([pkg, v]) => `${SHORT[pkg] ?? pkg} ${v}`)
    .join(' · ');
  const title = headline ? `${headline}（${date}）` : `dist-tag 变动（${date}）`;

  const lines = ['| 包 | tag | 变化 | 发布时间 |', '| --- | --- | --- | --- |'];
  for (const c of changes) {
    const from = c.from ? `\`${c.from}\`` : '_（新增 tag）_';
    const when = c.publishedAt ? c.publishedAt.replace('T', ' ').slice(0, 19) + ' UTC' : '—';
    lines.push(`| \`${SHORT[c.pkg] ?? c.pkg}\` | \`${c.tag}\` | ${from} → [\`${c.to}\`](${npmLink(c.pkg, c.to)}) | ${when} |`);
  }

  const body = [
    '上游 dist-tag 发生变化：',
    '',
    ...lines,
    '',
  ];

  const note = pairingNote(latestByPkg);
  if (note) body.push(note, '');

  const releases = changes
    .filter(c => c.tag === 'latest' && releaseLink(c.pkg, c.to))
    .map(c => `- [${SHORT[c.pkg]} v${c.to} release notes](${releaseLink(c.pkg, c.to)})`);
  if (releases.length) body.push('### 变更说明', ...releases, '');

  body.push(
    '---',
    '',
    '<sub>由 [radar.yml](../blob/main/.github/workflows/radar.yml) 每日自动开出。',
    '这是一条**上游发布事件**通知，radar 不跟踪任何项目钉的版本 —— 是否升级、什么时候升级，自己判断。</sub>',
  );

  return { title, body: body.join('\n') };
}

// ──────────────────────── 主流程 ────────────────────────

function emitOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

export async function main({
  fetchImpl = fetch,
  stateFile = STATE_FILE,
  issueBodyFile = ISSUE_BODY_FILE, // 与 stateFile 对称可注入：否则单测会把产物写进仓库根
  log = console.log,
} = {}) {
  const prev = readState(stateFile).packages;

  const curr = {};
  const failures = [];
  for (const { name } of PACKAGES) {
    try {
      curr[name] = await fetchPackage(name, { fetchImpl });
    } catch (err) {
      // 单个包抓失败不影响另一个：state 里保留它的旧值，下次再比。
      failures.push(`${name}: ${err.message}`);
    }
  }

  if (failures.length) for (const f of failures) log(`⚠️  抓取失败 ${f}`);
  if (!Object.keys(curr).length) {
    log('两个包都没抓到，本次不更新 state。');
    emitOutput('has_changes', 'false');
    return { changes: [], failed: true };
  }

  const { changes, initialized } = diffTags(prev, curr);

  // 写回 state 时以旧值为底、只覆盖这次抓到的包，避免抓失败的包被抹掉。
  const merged = { ...prev };
  for (const [name, { tags }] of Object.entries(curr)) merged[name] = { ...tags };
  writeFileSync(stateFile, JSON.stringify({ updatedAt: new Date().toISOString(), packages: merged }, null, 2) + '\n');

  // 供 workflow 当 commit message 用——让 git log 直接读出每次记录的版本，state 的历史即发布时间线。
  emitOutput(
    'state_summary',
    Object.entries(merged).map(([name, tags]) => `${SHORT[name] ?? name} ${tags.latest ?? '?'}`).join(' · '),
  );

  for (const init of initialized) {
    log(`📌 首次记录 ${init.pkg}: ${JSON.stringify(init.tags)}（初始化，不开 issue）`);
  }

  if (!changes.length) {
    log(initialized.length ? 'state 已初始化。' : '无变化。');
    emitOutput('has_changes', 'false');
    return { changes: [], initialized };
  }

  const issue = buildIssue(changes);
  writeFileSync(issueBodyFile, issue.body + '\n');
  log(`🚨 ${changes.length} 项变化：`);
  for (const c of changes) log(`   ${SHORT[c.pkg] ?? c.pkg} ${c.tag}: ${c.from ?? '(新增)'} → ${c.to}`);
  log(`\n标题：${issue.title}`);
  log(`正文已写入 ${issueBodyFile}`);

  emitOutput('has_changes', 'true');
  emitOutput('issue_title', issue.title);

  return { changes, issue };
}

// 直接运行才跑 main；被测试 import 时不执行。
// 不能只比字符串：node 加载模块会解析符号链接，import.meta.url 可能已是 realpath 而 argv[1] 不是
// （/var → /private/var 那类，会让入口守卫恒 false、main 静默不执行却退出 0）。
function isMainEntry() {
  const argv = process.argv[1];
  if (!argv) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv)).href;
  } catch {
    return import.meta.url === pathToFileURL(argv).href;
  }
}

if (isMainEntry()) {
  main().catch(err => {
    console.error(`radar 失败：${err.message}`);
    process.exit(1); // 这里是本脚本自己坏了（非上游发版），该红
  });
}
