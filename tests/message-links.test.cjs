/* eslint @typescript-eslint/no-require-imports: off -- Exercise ingestion against an isolated SQLite database. */
const assert = require('node:assert/strict');
const { test, mock } = require('node:test');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest } = require('next/server');

const root = resolve(__dirname, '..');
const fixtureDir = mkdtempSync(join(tmpdir(), 'wechat-radar-links-'));
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

test('share-card URLs survive ingestion and repeat scans refresh intelligence', async (t) => {
  const connection = require('../lib/db.ts').db();
  const { extractMessageLinks } = require('../lib/message-links.ts');
  const { bulkInsertMessages } = require('../lib/messages-store.ts');
  const { cache, CK } = require('../lib/cache.ts');
  const message = { local_id: 1, sender: '测试成员', content: '[链接] 卡尔的AI沃茨的文字分享',
    time: '2026-10-07 12:00:00', timestamp: 1791345600, type: '链接/文件' };
  const articleUrl = 'https://mp.weixin.qq.com/s/article-test';
  try {
    await t.test('separate article URL retains the share title and raw source', () => {
      assert.deepEqual(extractMessageLinks(message.content), []);
      const links = extractMessageLinks(message.content, articleUrl);
      assert.equal(links.length, 1);
      assert.equal(links[0].url, articleUrl);
      assert.equal(links[0].title, '卡尔的AI沃茨的文字分享');
      assert.equal(links[0].source, 'wechat_raw');
      assert.equal(links[0].raw_kind, 'appmsg_url_field');
    });

    await t.test('separate tool URLs are recognized and duplicate body URLs collapse', () => {
      const tool = 'https://github.com/example/ai-tool';
      const links = extractMessageLinks(`[链接] 开源工具 ${tool}`, `${tool}?utm_source=wechat`);
      assert.equal(links.length, 1);
      assert.equal(links[0].canonical_url, tool);
      assert.equal(links[0].source, 'wechat_raw');
    });

    await t.test('only complete HTTP or HTTPS URLs are accepted', () => {
      for (const url of ['javascript:alert(1)', 'file:///tmp/private', 'ftp://example.com/file', 'not-a-url', 'https://example.com/…']) {
        assert.deepEqual(extractMessageLinks('[链接] 测试分享', url), []);
      }
    });

    await t.test('plain text and XML links still extract their original metadata', () => {
      const plain = extractMessageLinks('工具说明 https://example.com/tool');
      assert.equal(plain[0].source, 'plain_url');
      const xml = extractMessageLinks(`<msg><appmsg><title>文章标题</title><des>文章简介</des><url>${articleUrl}</url></appmsg></msg>`);
      assert.equal(xml.length, 1);
      assert.equal(xml[0].title, '文章标题');
      assert.equal(xml[0].description, '文章简介');
    });

    await t.test('resync enriches an existing message without duplication or rewriting its body', () => {
      assert.equal(bulkInsertMessages('123@chatroom', [message]), 1);
      assert.equal(connection.prepare('SELECT COUNT(*) AS n FROM message_links').get().n, 0);
      assert.equal(bulkInsertMessages('123@chatroom', [{ ...message, url: articleUrl }]), 0);
      assert.equal(bulkInsertMessages('123@chatroom', [{ ...message, url: articleUrl }]), 0);
      assert.equal(connection.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
      assert.equal(connection.prepare('SELECT COUNT(*) AS n FROM message_links').get().n, 1);
      assert.equal(connection.prepare('SELECT content FROM messages').get().content, message.content);
      const link = connection.prepare('SELECT * FROM message_links').get();
      assert.equal(link.title, '卡尔的AI沃茨的文字分享');
      assert.equal(link.date, '2026-10-07');
    });

    await t.test('the dashboard shows articles without treating transfer or upgrade cards as resources', () => {
      bulkInsertMessages('123@chatroom', [
        { ...message, local_id: 2, content: '[链接] 微信转账', url: 'https://support.weixin.qq.com/transfer' },
        { ...message, local_id: 3, content: '[链接] AI 当前微信版本不支持展示该内容', url: 'https://support.weixin.qq.com/upgrade' },
      ]);
      const { buildDashboardIntelligence } = require('../lib/dashboard-intelligence.ts');
      const result = buildDashboardIntelligence('2026-10-07', new Map([['123@chatroom', '测试群']]));
      assert.equal(result.link_highlights.length, 1);
      assert.equal(result.link_highlights[0].domain, 'mp.weixin.qq.com');
      assert.equal(result.link_highlights[0].kind, 'article');
    });

    await t.test('rescan invalidates intelligence before finishing even when automatic AI is off', async () => {
      const wx = require('../lib/wx.ts');
      const stats = require('../lib/stats-aggregator.ts');
      const topics = require('../lib/topics.ts');
      const previousAutoDays = process.env.WECHAT_RADAR_AUTO_TOPIC_DAYS;
      const previousEnabled = process.env.WECHAT_RADAR_AI_ENABLED;
      process.env.WECHAT_RADAR_AUTO_TOPIC_DAYS = '0';
      process.env.WECHAT_RADAR_AI_ENABLED = '1';
      const sessions = mock.method(wx, 'wxSessions', async () => [{ is_group: true, username: '123@chatroom', chat: '测试群' }]);
      const sync = mock.method(stats, 'syncFullHistory', async () => ({ ok: 1, failed: 0, messages: 0 }));
      const build = mock.method(topics, 'buildTopicsForDate', async () => { throw new Error('Must not start AI'); });
      try {
        cache.set(CK.sessions(), ['stale']);
        cache.set('dashboard-intelligence:2026-10-07:v15', { stale: true });
        cache.set('dashboard-intelligence:2026-10-08:v15', { stale: true });
        connection.prepare('INSERT INTO link_intelligence_cache (date, version, payload, generated_at) VALUES (?, ?, ?, ?)')
          .run('2026-10-07', 'v8', '{}', 1);
        const route = require('../app/api/rescan/route.ts');
        const response = await route.POST(new NextRequest('http://localhost/api/rescan', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ since: '2026-10-07', until: '2026-10-07' }),
        }));
        const events = (await response.text()).trim().split('\n\n').map((event) => JSON.parse(event.slice(5)));
        assert.equal(events.at(-1).type, 'finished');
        assert.equal(events.find((event) => event.type === 'topics_start').dates, 0);
        assert.equal(build.mock.callCount(), 0);
        assert.equal(cache.has(CK.sessions()), false);
        assert.equal(cache.keys().some((key) => key.startsWith('dashboard-intelligence:')), false);
        assert.equal(connection.prepare('SELECT COUNT(*) AS n FROM link_intelligence_cache').get().n, 0);
      } finally {
        sessions.mock.restore();
        sync.mock.restore();
        build.mock.restore();
        if (previousAutoDays === undefined) delete process.env.WECHAT_RADAR_AUTO_TOPIC_DAYS;
        else process.env.WECHAT_RADAR_AUTO_TOPIC_DAYS = previousAutoDays;
        if (previousEnabled === undefined) delete process.env.WECHAT_RADAR_AI_ENABLED;
        else process.env.WECHAT_RADAR_AI_ENABLED = previousEnabled;
      }
    });
  } finally {
    cache.flushAll();
    connection.close();
    if (originalTsLoader) Module._extensions['.ts'] = originalTsLoader;
    else delete Module._extensions['.ts'];
    if (previousDataDir === undefined) delete process.env.WECHAT_RADAR_DATA_DIR;
    else process.env.WECHAT_RADAR_DATA_DIR = previousDataDir;
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
