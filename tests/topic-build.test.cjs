/* eslint @typescript-eslint/no-require-imports: off -- Exercise TypeScript routes with a CJS test loader. */
const assert = require('node:assert/strict');
const { test, mock } = require('node:test');
const { readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest } = require('next/server');
const childProcess = require('node:child_process');

const root = resolve(__dirname, '..');
const originalTsLoader = Module._extensions['.ts'];
Module._extensions['.ts'] = (module, filename) => {
  const source = readFileSync(filename, 'utf8').replace(/from\s+(['"])@\/([^'"]+)\1/g,
    (_match, _quote, path) => `from ${JSON.stringify(join(root, path))}`);
  module._compile(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText, filename);
};

function request(body) {
  return new NextRequest('http://localhost:3000/api/topics/build', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

async function events(response) {
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  return (await response.text()).trim().split('\n\n').map((line) => JSON.parse(line.slice(5).trim()));
}

test('topic build endpoint and disabled analysis state', async (t) => {
  const originalEnabled = process.env.WECHAT_RADAR_AI_ENABLED;
  const topics = require('../lib/topics.ts');
  const buildRoute = require('../app/api/topics/build/route.ts');
  const listRoute = require('../app/api/topics/route.ts');
  try {
    await t.test('invalid and impossible dates never start analysis', async () => {
      process.env.WECHAT_RADAR_AI_ENABLED = '1';
      const build = mock.method(topics, 'buildTopicsForDate', async () => { throw new Error('Must not run'); });
      for (const body of [{}, { date: '2026-02-30' }, { date: '2026-9-30' }, { date: '../private' }]) {
        assert.equal((await buildRoute.POST(request(body))).status, 400);
      }
      assert.equal(build.mock.callCount(), 0);
      build.mock.restore();
    });

    await t.test('disabled endpoint returns the reason and never calls the builder', async () => {
      process.env.WECHAT_RADAR_AI_ENABLED = '0';
      const build = mock.method(topics, 'buildTopicsForDate', async () => { throw new Error('Must not run'); });
      const response = await buildRoute.POST(request({ date: '2026-09-30' }));
      assert.equal(response.status, 409);
      const result = await response.json();
      assert.equal(result.code, 'AI_ANALYSIS_DISABLED');
      assert.match(result.error, /尚未启用/);
      assert.equal(build.mock.callCount(), 0);
      build.mock.restore();
    });

    await t.test('the actual disabled builder rejects before spawning a model process', async () => {
      const spawn = mock.method(childProcess, 'spawn', () => { throw new Error('Must not spawn'); });
      await assert.rejects(topics.buildTopicsForDate('2026-09-30'), /尚未启用/);
      assert.equal(spawn.mock.callCount(), 0);
      spawn.mock.restore();
    });

    await t.test('list endpoint exposes the disabled state while retaining existing topics', async () => {
      const list = mock.method(topics, 'listTopics', () => [{ id: 1, title: '已有话题', date: '2026-09-30' }]);
      const response = await listRoute.GET(new NextRequest('http://localhost:3000/api/topics?date=2026-09-30'));
      const result = await response.json();
      assert.equal(result.build.enabled, false);
      assert.match(result.build.disabledReason, /AI 服务/);
      assert.equal(result.topics.length, 1);
      list.mock.restore();
    });

    await t.test('enabled builds stream progress and completion with the selected date', async () => {
      process.env.WECHAT_RADAR_AI_ENABLED = '1';
      const build = mock.method(topics, 'buildTopicsForDate', async (date, progress) => {
        assert.equal(date, '2026-09-30');
        progress({ type: 'load', message: '加载消息' });
        progress({ type: 'llm', done: 1, total: 1 });
        return { topics: 2, messages: 8 };
      });
      const result = await events(await buildRoute.POST(request({ date: '2026-09-30' })));
      assert.deepEqual(result.map((event) => event.type), ['start', 'load', 'llm', 'finished']);
      assert.equal(result.at(-1).topics, 2);
      assert.equal(result.at(-1).messages, 8);
      build.mock.restore();
    });

    await t.test('empty analysis completes with zero topics rather than failing', async () => {
      const build = mock.method(topics, 'buildTopicsForDate', async () => ({ topics: 0, messages: 0 }));
      const result = await events(await buildRoute.POST(request({ date: '2026-09-30' })));
      assert.equal(result.at(-1).type, 'finished');
      assert.equal(result.at(-1).topics, 0);
      build.mock.restore();
    });

    await t.test('backend errors are visible and do not prevent a retry', async () => {
      const build = mock.method(topics, 'buildTopicsForDate', async () => { throw new Error('模型服务不可用'); });
      const result = await events(await buildRoute.POST(request({ date: '2026-09-30' })));
      assert.equal(result.at(-1).type, 'error');
      assert.equal(result.at(-1).error, '模型服务不可用');
      build.mock.restore();
      const retry = mock.method(topics, 'buildTopicsForDate', async () => ({ topics: 1, messages: 4 }));
      assert.equal((await events(await buildRoute.POST(request({ date: '2026-09-30' })))).at(-1).topics, 1);
      retry.mock.restore();
    });

    await t.test('duplicate requests for an active date are rejected', async () => {
      let complete;
      const build = mock.method(topics, 'buildTopicsForDate', () => new Promise((resolve) => { complete = resolve; }));
      const active = await buildRoute.POST(request({ date: '2026-09-30' }));
      try {
        const duplicate = await buildRoute.POST(request({ date: '2026-09-30' }));
        assert.equal(duplicate.status, 409);
        assert.match((await duplicate.json()).error, /正在构建/);
        assert.equal(build.mock.callCount(), 1);
      } finally {
        complete({ topics: 0, messages: 0 });
        await events(active);
        build.mock.restore();
      }
    });
  } finally {
    mock.restoreAll();
    if (originalTsLoader) Module._extensions['.ts'] = originalTsLoader;
    else delete Module._extensions['.ts'];
    if (originalEnabled === undefined) delete process.env.WECHAT_RADAR_AI_ENABLED;
    else process.env.WECHAT_RADAR_AI_ENABLED = originalEnabled;
  }
});
