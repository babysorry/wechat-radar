/* eslint @typescript-eslint/no-require-imports: off -- Exercise TypeScript routes against isolated legacy data. */
const assert = require('node:assert/strict');
const { test, mock } = require('node:test');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { promisify } = require('node:util');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const childProcess = require('node:child_process');
const net = require('node:net');
const Database = require('better-sqlite3');
const ts = require('typescript');
const { NextRequest } = require('next/server');

const root = resolve(__dirname, '..');
const fixtureDir = mkdtempSync(join(tmpdir(), 'wechat-radar-names-'));
const previousDataDir = process.env.WECHAT_RADAR_DATA_DIR;
process.env.WECHAT_RADAR_DATA_DIR = fixtureDir;
const originalTsLoader = Module._extensions['.ts'];
Module._extensions['.ts'] = (module, filename) => {
  const source = readFileSync(filename, 'utf8').replace(/from\s+(['"])@\/([^'"]+)\1/g,
    (_match, _quote, path) => `from ${JSON.stringify(join(root, path))}`);
  module._compile(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText, filename);
};

test('WeChat names recover, survive failures and resolve legacy messages without merging identities', async (t) => {
  const originalExecFile = childProcess.execFile;
  let connection;
  let ready = false;
  let refreshes = 0;
  const room = '123@chatroom';
  const members = [
    { username: 'wxid_alice', display: '同名', contact_display: '小明', group_nickname: '同名' },
    { username: 'wxid_bob', display: '同名', contact_display: '小红', group_nickname: '同名' },
  ];
  const session = (chat) => ({ username: room, chat, is_group: true, chat_type: 'group',
    summary: '测试', last_sender: 'wxid_alice', last_msg_type: '文本', unread: 1, time: '', timestamp: 1 });
  childProcess.execFile = () => { throw new Error('Use promisified fixture'); };
  childProcess.execFile[promisify.custom] = async (_file, args) => {
    if (args[0] === 'sessions') return { stdout: JSON.stringify({ sessions: [session(ready ? '测试交流群' : room)], meta: { status: 'ok' } }) };
    if (args[0] === 'contacts') return { stdout: JSON.stringify([{ username: 'wxid_alice', display: '小明' }, { username: 'wxid_bob', display: '小红' }]) };
    if (args[0] === 'members') return { stdout: JSON.stringify({ members }) };
    if (args[0] === 'history') return { stdout: JSON.stringify({ messages: [
      { local_id: 1, sender: '同名', sender_username: 'wxid_alice', timestamp: 1 },
      { local_id: 2, sender: '同名', sender_username: 'wxid_bob', timestamp: 2 },
    ] }) };
    throw new Error(`Unexpected command ${args[0]}`);
  };
  const socketMock = mock.method(net, 'createConnection', () => {
    const socket = new EventEmitter();
    socket.setTimeout = () => socket;
    socket.destroy = () => socket;
    socket.write = (payload) => {
      assert.equal(JSON.parse(payload).cmd, 'reload_config');
      refreshes++;
      ready = true;
      queueMicrotask(() => socket.emit('data', Buffer.from('{"ok":true,"contacts":3}\n')));
    };
    queueMicrotask(() => socket.emit('connect'));
    return socket;
  });

  try {
    const legacy = new Database(join(fixtureDir, 'radar.db'));
    legacy.exec(`CREATE TABLE messages (chatroom_id TEXT NOT NULL, local_id INTEGER NOT NULL,
      sender TEXT NOT NULL, content TEXT NOT NULL, time TEXT NOT NULL, timestamp INTEGER NOT NULL,
      type TEXT NOT NULL, date TEXT NOT NULL, PRIMARY KEY (chatroom_id, local_id));
      INSERT INTO messages VALUES ('123@chatroom', 1, 'wxid_alice', '测试一', '2026-10-08 10:00:00', 1, '文本', '2026-10-08');
      INSERT INTO messages VALUES ('123@chatroom', 2, 'wxid_bob', '测试二', '2026-10-08 10:01:00', 2, '文本', '2026-10-08');
      INSERT INTO messages VALUES ('123@chatroom', 3, '赵括二号', '测试三', '2026-10-08 10:02:00', 3, '文本', '2026-10-08');`);
    legacy.close();
    const wx = require('../lib/wx.ts');
    const names = require('../lib/wechat-names.ts');
    const store = require('../lib/messages-store.ts');
    const { cache } = require('../lib/cache.ts');
    const config = require('../lib/config.ts');
    connection = require('../lib/db.ts').db();

    await t.test('empty daemon name maps reload once, accepting wrapped sessions and legacy contact arrays', async () => {
      const [a, b] = await Promise.all([wx.wxSessions(), wx.wxSessions()]);
      assert.equal(refreshes, 1);
      assert.equal(a[0].chat, '测试交流群');
      assert.equal(a[0].last_sender, '小明');
      assert.deepEqual(a, b);
    });

    await t.test('current and legacy member fields resolve by room without overwriting names with raw IDs', async () => {
      await wx.wxMembers(room);
      names.rememberMemberNames('456@chatroom', [{ username: 'wxid_alice', display_name: '另一群昵称' }]);
      names.rememberSessionNames([session(room)]);
      names.rememberContactNames([{ username: 'wxid_alice', display: 'wxid_alice' }]);
      const resolver = names.createNameResolver();
      assert.equal(resolver.chat(room), '测试交流群');
      assert.equal(resolver.sender(room, 'wxid_alice'), '同名');
      assert.equal(resolver.sender('456@chatroom', 'wxid_alice'), '另一群昵称');
      assert.equal(resolver.sender('unknown@chatroom', 'wxid_alice'), '小明');
      assert.equal(resolver.sender(room, '赵括二号'), '赵括二号');
      assert.equal(resolver.sender(room, 'wxid_unknown'), 'wxid_unknown');
    });

    await t.test('legacy group detail resolves names while keeping same-name members separate', async () => {
      const route = require('../app/api/group/[id]/route.ts');
      const result = await (await route.GET(new NextRequest(`http://localhost/api/group/${room}?date=2026-10-08`),
        { params: Promise.resolve({ id: room }) })).json();
      assert.equal(result.stats.chat, '测试交流群');
      assert.deepEqual(result.recent.map((m) => m.sender), ['同名', '同名', '赵括二号']);
      assert.equal(result.stats.top_senders.filter((s) => s.sender === '同名').length, 2);
      assert.equal(result.stats.total, 3);
      assert.equal(connection.prepare('SELECT sender FROM messages WHERE local_id = 1').get().sender, 'wxid_alice');
      const cached = require('../lib/stats-aggregator.ts').getCachedStats(room, '2026-10-08');
      assert.equal(cached.top_senders.filter((s) => ['wxid_alice', 'wxid_bob'].includes(s.sender)).length, 2);
    });

    await t.test('new messages save stable identity, repeat sync enriches old rows, and renames keep counts stable', () => {
      const message = { local_id: 4, sender: '旧昵称', sender_username: 'wxid_alice',
        sender_contact_display: '小明', sender_group_nickname: '新昵称', content: '测试四',
        time: '2026-10-08 11:00:00', timestamp: 4, type: '文本' };
      assert.equal(store.bulkInsertMessages(room, [message]), 1);
      assert.equal(store.bulkInsertMessages(room, [{ ...message, local_id: 1, timestamp: 1 }]), 0);
      assert.equal(connection.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 4);
      const stats = store.aggregateDailyStats(room, ['2026-10-08'])[0];
      assert.equal(stats.top_senders.find((s) => s.sender === 'wxid_alice').count, 2);
      assert.equal(names.createNameResolver().sender(room, '旧昵称', 'wxid_alice'), '新昵称');
      assert.equal(store.listMessagesForDate(room, '2026-10-08')[0].sender_username, 'wxid_alice');
    });

    await t.test('backfill uses original message identity and timestamp, without rewriting history or joining homonyms', () => {
      const before = connection.prepare('SELECT * FROM messages WHERE local_id = 3').get();
      assert.equal(store.backfillMessageIdentities(room, [
        { local_id: 3, sender: '赵括二号', sender_username: 'wrong_user', timestamp: 99 },
      ]), 0);
      assert.deepEqual(connection.prepare('SELECT * FROM messages WHERE local_id = 3').get(), before);
      assert.equal(store.backfillMessageIdentities(room, [
        { local_id: 3, sender: '赵括二号', sender_username: 'known_user', timestamp: 3 },
      ]), 1);
      assert.equal(connection.prepare('SELECT sender FROM messages WHERE local_id = 3').get().sender, '赵括二号');
    });

    await t.test('nickname search finds messages originally stored with user IDs', async () => {
      const route = require('../app/api/search/route.ts');
      const result = await (await route.GET(new NextRequest('http://localhost/api/search?q=新昵称'))).json();
      assert.equal(result.results.find((r) => r.type === 'person').title, '新昵称');
      assert.equal(result.results.filter((r) => r.type === 'message').length, 2);
    });

    await t.test('group and member names remain usable from local data after cache loss and CLI failure', async () => {
      cache.flushAll();
      const fail = mock.method(wx, 'wxSessions', async () => { throw new Error('offline'); });
      const sessions = await (await require('../app/api/sessions/route.ts').GET()).json();
      assert.equal(sessions.groups[0].name, '测试交流群');
      fail.mock.restore();
      config.writeConfig({ demoMode: true });
      const result = await (await require('../app/api/group/[id]/route.ts').GET(
        new NextRequest(`http://localhost/api/group/${room}?date=2026-10-08`), { params: Promise.resolve({ id: room }) })).json();
      assert.equal(result.stats.chat, '测试交流群');
      assert.equal(result.recent[0].sender, '新昵称');
    });

    await t.test('names survive a service restart', () => {
      connection.close();
      for (const path of Object.keys(require.cache)) {
        if (path.startsWith(join(root, 'lib') + '/')) delete require.cache[path];
      }
      connection = require('../lib/db.ts').db();
      const resolver = require('../lib/wechat-names.ts').createNameResolver();
      assert.equal(resolver.chat(room), '测试交流群');
      assert.equal(resolver.sender(room, 'wxid_alice'), '新昵称');
    });
  } finally {
    socketMock.mock.restore();
    childProcess.execFile = originalExecFile;
    if (connection?.open) connection.close();
    if (originalTsLoader) Module._extensions['.ts'] = originalTsLoader;
    else delete Module._extensions['.ts'];
    if (previousDataDir === undefined) delete process.env.WECHAT_RADAR_DATA_DIR;
    else process.env.WECHAT_RADAR_DATA_DIR = previousDataDir;
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
