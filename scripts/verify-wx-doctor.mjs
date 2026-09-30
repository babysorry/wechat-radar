#!/usr/bin/env node
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Radar reads sessions, contacts and ordinary message shards. wx doctor also
// requires media/official-account databases used by other wx-cli commands.
function coreCoverage(result) {
  const configArg = process.argv.indexOf('--config');
  const candidates = configArg === -1
    ? [resolve('config.json'), fileURLToPath(new URL('../.cache/wx-cli/bin/config.json', import.meta.url)), join(homedir(), '.wx-cli/config.json')]
    : [process.argv[configArg + 1]];
  const configPath = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!configPath) throw new Error('未找到微信读取配置，请先初始化');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (typeof config.db_dir !== 'string' || !config.db_dir) throw new Error('微信配置缺少数据目录');
  const dbDir = resolve(config.db_dir);
  const configCheck = result.checks.find((item) => item.name === 'config.json');
  if (configCheck?.ok !== true || resolve(configCheck.detail) !== dbDir) {
    throw new Error('检查结果与当前微信数据目录不一致');
  }
  const keysPath = resolve(dirname(configPath), config.keys_file ?? 'all_keys.json');
  const keys = JSON.parse(readFileSync(keysPath, 'utf8'));
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) throw new Error('数据库密钥文件格式无效');
  const known = new Set(Object.entries(keys)
    .filter(([name, entry]) => !name.startsWith('_') && /^[a-f\d]{64}$/i.test(typeof entry === 'string' ? entry : entry?.enc_key ?? ''))
    .map(([name]) => name.replaceAll('\\', '/')));
  const messageShards = readdirSync(join(dbDir, 'message'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^message_\d+\.db$/.test(entry.name))
    .map((entry) => `message/${entry.name}`).sort();
  if (!messageShards.length) throw new Error('未找到普通聊天消息数据库');
  const missing = [];
  for (const rel of ['session/session.db', 'contact/contact.db', ...messageShards]) {
    const path = join(dbDir, rel);
    if (!existsSync(path) || !statSync(path).isFile()) {
      missing.push(rel);
      continue;
    }
    const fd = openSync(path, 'r');
    const header = Buffer.alloc(16);
    let read;
    try { read = readSync(fd, header, 0, 16, 0); } finally { closeSync(fd); }
    if (read !== 16) throw new Error(`数据库文件不完整：${rel}`);
    if (header.subarray(0, 15).toString() !== 'SQLite format 3' && !known.has(rel)) missing.push(rel);
  }
  return { messageShards: messageShards.length, missing };
}

let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
  const result = JSON.parse(input);
  if (!Array.isArray(result.checks)) throw new Error('组件返回了无效的检查结果');
  const required = ['数据库密钥', 'SQLCipher 在线打开'];
  let failed = false;
  for (const name of required) {
    const check = result.checks.find((item) => item.name === name);
    const ok = check?.ok === true;
    console.log(`${ok ? '✓' : '✗'} ${name}：${check?.detail ?? '未返回该检查结果'}`);
    if (!ok) failed = true;
  }
  const coverage = coreCoverage(result);
  if (coverage.missing.length) {
    console.log(`✗ 普通聊天数据库：缺少 ${coverage.missing.join(', ')}`);
    failed = true;
  } else {
    console.log(`✓ 普通聊天数据库：会话、联系人及 ${coverage.messageShards} 个消息分片已就绪`);
  }
  const fullCheck = result.checks.find((item) => item.name === '关键分片密钥');
  if (!fullCheck || typeof fullCheck.ok !== 'boolean') throw new Error('未返回完整数据库覆盖检查');
  if (fullCheck.ok) {
    console.log(`✓ 读取组件关键数据库：${fullCheck.detail}`);
  } else {
    console.log(`⚠ 读取组件关键数据库：${fullCheck.detail}`);
    if (!failed) console.log('普通群聊可用；公众号历史或部分媒体功能仍需补充密钥。');
  }
  if (failed) process.exitCode = 1;
} catch (error) {
  console.error(`数据库检查失败：${error.message}`);
  process.exitCode = 1;
}
