/* eslint @typescript-eslint/no-require-imports: off -- CJS module reloads simulate service restarts. */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const Module = require('node:module');
const Database = require('better-sqlite3');
const ts = require('typescript');
const { NextRequest } = require('next/server');

const root = resolve(__dirname, '..');
const fixtureDir = mkdtempSync(join(tmpdir(), 'wechat-radar-categories-'));
const previousDataDir = process.env.WECHAT_RADAR_DATA_DIR;
process.env.WECHAT_RADAR_DATA_DIR = fixtureDir;

// Exercise the actual TypeScript data layer and routes with an isolated SQLite database.
const originalTsLoader = Module._extensions['.ts'];
Module._extensions['.ts'] = (module, filename) => {
  const source = readFileSync(filename, 'utf8').replace(/from\s+(['"])@\/([^'"]+)\1/g,
    (_match, _quote, path) => `from ${JSON.stringify(join(root, path))}`);
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  });
  module._compile(output.outputText, filename);
};

function clearAppModules() {
  for (const filename of Object.keys(require.cache)) {
    if (filename.startsWith(join(root, 'lib') + '/') || filename.startsWith(join(root, 'app') + '/')) {
      delete require.cache[filename];
    }
  }
}

function request(method, body, query = '') {
  return new NextRequest(`http://localhost:3000/api/groups${query}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

test('category migration, mutations and classifier persistence', async (t) => {
  let connection;
  try {
    const legacy = new Database(join(fixtureDir, 'radar.db'));
    legacy.exec(`
      CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
        color TEXT NOT NULL, emoji TEXT, sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('seed_version', 'qiaomu_v2_2026_05_23');
      INSERT INTO groups VALUES (10, '生活 · 兴趣', '#fb7185', '🏘️', 0, 1);
      INSERT INTO groups VALUES (20, 'AIGC · 内容创作', '#ec4899', '🎨', 1, 1);
      INSERT INTO groups VALUES (30, '自定义', '#28745b', NULL, 2, 1);
    `);
    legacy.close();

    const groups = require('../lib/groups.ts');
    const classifier = require('../lib/group-classifier.ts');
    const route = require('../app/api/groups/route.ts');
    connection = require('../lib/db.ts').db();
    groups.tagGroup('fixture@chatroom', 10);
    groups.tagGroup('fixture@chatroom', 20);
    connection.prepare(`INSERT INTO messages (chatroom_id, local_id, sender, content, time, timestamp, type, date)
      VALUES ('fixture@chatroom', 1, '测试', '测试消息', '2026-09-30 10:00:00', 1, 'text', '2026-09-30')`).run();

    await t.test('legacy categories receive stable rules without replacing IDs or tags', () => {
      assert.equal(groups.listGroups().length, 3);
      assert.equal(groups.listGroups().find((g) => g.id === 10).classifier_key, '生活 · 兴趣');
      assert.equal(groups.listGroups().find((g) => g.id === 30).classifier_key, null);
      assert.deepEqual(groups.tagsForChatroom('fixture@chatroom'), [10, 20]);
    });

    await t.test('renaming preserves manual assignments and automatic matches', async () => {
      const response = await route.PATCH(request('PATCH', { id: 10, name: ' 家人朋友 ', color: '#123456', emoji: '🏠' }));
      assert.equal(response.status, 200);
      const renamed = groups.listGroups().find((g) => g.id === 10);
      assert.equal(renamed.name, '家人朋友');
      assert.equal(renamed.color, '#123456');
      assert.equal(renamed.emoji, '🏠');
      assert.deepEqual(groups.tagsForChatroom('fixture@chatroom'), [10, 20]);
      const guess = classifier.classifyGroupHeuristic('小区篮球群', '', groups.listGroups());
      assert.equal(guess.group_id, 10);
      assert.equal(guess.group_name, '家人朋友');
      assert.deepEqual(classifier.effectiveGroupIds('小区篮球群', '', [20], groups.listGroups()), [20]);
    });

    await t.test('blank names, duplicate names and invalid identifiers cannot mutate categories', async () => {
      assert.equal((await route.POST(request('POST', { name: '  ', color: '#123456' }))).status, 400);
      assert.equal((await route.POST(request('POST', { name: '自定义', color: '#123456' }))).status, 409);
      assert.equal((await route.PATCH(request('PATCH', { id: 10, name: '自定义', color: '#123456' }))).status, 409);
      assert.equal((await route.PATCH(request('PATCH', { id: 999, name: '不存在', color: '#123456' }))).status, 404);
      for (const id of ['0', '-1', '1.5', 'abc']) {
        assert.equal((await route.DELETE(request('DELETE', undefined, `?id=${id}`))).status, 400);
      }
      assert.equal(groups.listGroups().length, 3);
      assert.equal(groups.listGroups().find((g) => g.id === 10).name, '家人朋友');
    });

    await t.test('new categories can be created and edited without inheriting unrelated rules', async () => {
      const response = await route.POST(request('POST', { name: ' 工作 ', color: '#abcdef', emoji: '💼' }));
      assert.equal(response.status, 201);
      const { id } = await response.json();
      assert.equal(groups.listGroups().find((g) => g.id === id).name, '工作');
      assert.equal(groups.listGroups().find((g) => g.id === id).classifier_key, null);
      assert.equal((await route.PATCH(request('PATCH', { id, name: '团队', color: '#112233', emoji: '' }))).status, 200);
      assert.equal(groups.listGroups().find((g) => g.id === id).emoji, null);
    });

    await t.test('smart classification uses the same renamed category and rejects stale batches atomically', async () => {
      require('../lib/wx.ts').wxSessions = async () => [{ username: 'suggestion@chatroom', chat: '小区篮球群', summary: '', is_group: true }];
      const classifyRoute = require('../app/api/ai-classify/route.ts');
      const result = await (await classifyRoute.GET()).json();
      assert.equal(result.suggestions[0].suggested_group_id, 10);
      assert.equal(result.suggestions[0].suggested_group_name, '家人朋友');
      const response = await classifyRoute.POST(request('POST', { picks: [
        { chatroom_id: 'suggestion@chatroom', group_id: 20 },
        { chatroom_id: 'stale@chatroom', group_id: 999 },
      ] }));
      assert.equal(response.status, 400);
      assert.deepEqual(groups.tagsForChatroom('suggestion@chatroom'), []);
    });

    await t.test('deleting only removes that category and its assignments, preserving messages and other tags', async () => {
      assert.equal((await route.DELETE(request('DELETE', undefined, '?id=10'))).status, 200);
      assert.equal((await route.DELETE(request('DELETE', undefined, '?id=10'))).status, 404);
      assert.deepEqual(groups.tagsForChatroom('fixture@chatroom'), [20]);
      assert.equal(connection.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
      assert.equal(classifier.classifyGroupHeuristic('小区篮球群', '', groups.listGroups()), null);
    });

    await t.test('restart preserves edits and does not restore deleted categories', () => {
      connection.close();
      clearAppModules();
      connection = require('../lib/db.ts').db();
      const restored = require('../lib/groups.ts');
      assert.equal(restored.listGroups().some((g) => g.id === 10), false);
      assert.equal(restored.listGroups().some((g) => g.name === '团队'), true);
      assert.deepEqual(restored.tagsForChatroom('fixture@chatroom'), [20]);
      assert.equal(connection.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
    });

    await t.test('fresh installs seed rules once and support an empty category list after restart', () => {
      connection.close();
      clearAppModules();
      process.env.WECHAT_RADAR_DATA_DIR = join(fixtureDir, 'fresh');
      connection = require('../lib/db.ts').db();
      const freshGroups = require('../lib/groups.ts');
      assert.equal(freshGroups.listGroups().length, 14);
      assert.equal(freshGroups.listGroups().every((g) => !!g.classifier_key), true);
      for (const group of freshGroups.listGroups()) freshGroups.deleteGroup(group.id);
      connection.close();
      clearAppModules();
      connection = require('../lib/db.ts').db();
      assert.deepEqual(require('../lib/groups.ts').listGroups(), []);
    });
  } finally {
    if (connection?.open) connection.close();
    clearAppModules();
    if (originalTsLoader) Module._extensions['.ts'] = originalTsLoader;
    else delete Module._extensions['.ts'];
    if (previousDataDir === undefined) delete process.env.WECHAT_RADAR_DATA_DIR;
    else process.env.WECHAT_RADAR_DATA_DIR = previousDataDir;
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
