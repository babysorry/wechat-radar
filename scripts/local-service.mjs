#!/usr/bin/env node
import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const label = 'com.wechat-radar.local';
const domain = `gui/${process.getuid()}`;
const target = `${domain}/${label}`;
const agent = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
const logs = join(root, 'data', 'logs');
const wxBin = join(root, '.cache', 'wx-cli', 'bin');
const command = process.argv[2] || 'status';

function launch(args) {
  return spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
}
function checked(args) {
  const result = launch(args);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `launchctl exited ${result.status}`);
  return result.stdout;
}
function loaded() {
  return launch(['print', target]).status === 0;
}
async function bootstrap() {
  // launchd may take a moment to finish removing a booted-out service.
  let result;
  for (let attempt = 0; attempt < 10; attempt++) {
    result = launch(['bootstrap', domain, agent]);
    if (result.status === 0) return;
    if (result.status !== 5) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(result.stderr || result.stdout || `launchctl exited ${result.status}`);
}
function xml(value) {
  return String(value).replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]);
}
function status() {
  const result = launch(['print', target]);
  if (result.status !== 0) {
    console.log('WeChat Radar 未运行');
    return;
  }
  const state = result.stdout.match(/\n\s*state = (.+)/)?.[1] || 'unknown';
  const pid = result.stdout.match(/\n\s*pid = (\d+)/)?.[1];
  console.log(`WeChat Radar: ${state}${pid ? ` (PID ${pid})` : ''}`);
  console.log('http://localhost:3000');
  console.log(`日志: ${logs}`);
}

try {
  if (process.platform !== 'darwin') throw new Error('此后台服务脚本仅适用于 macOS。');
  if (command === 'install') {
    if (!existsSync(join(root, '.next', 'BUILD_ID'))) throw new Error('请先运行 pnpm build。');
    if (existsSync(agent) && !readFileSync(agent, 'utf8').includes(xml(root))) {
      throw new Error(`已有其他目录使用 ${agent}，请先确认原服务。`);
    }
    const path = [wxBin, join(root, '.cache', 'wx-cli', 'node_modules', '.bin'), dirname(process.execPath), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(join(root, 'node_modules', 'next', 'dist', 'bin', 'next'))}</string>
    <string>start</string><string>--hostname</string><string>127.0.0.1</string><string>--port</string><string>3000</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${xml(path)}</string>
    <key>NODE_ENV</key><string>production</string>
    <key>NEXT_TELEMETRY_DISABLED</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${xml(join(logs, 'server.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logs, 'server-error.log'))}</string>
</dict></plist>
`;
    mkdirSync(dirname(agent), { recursive: true });
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    if (loaded()) checked(['bootout', target]);
    writeFileSync(agent, plist, { mode: 0o600 });
    await bootstrap();
    console.log('已安装后台服务，登录 Mac 后会自动启动。');
    status();
  } else if (command === 'start') {
    if (!existsSync(agent)) throw new Error('请先运行 node scripts/local-service.mjs install。');
    if (loaded()) checked(['kickstart', target]);
    else await bootstrap();
    status();
  } else if (command === 'restart') {
    checked(['kickstart', '-k', target]);
    status();
  } else if (command === 'stop' || command === 'uninstall') {
    if (loaded()) checked(['bootout', target]);
    if (command === 'uninstall' && existsSync(agent)) unlinkSync(agent);
    console.log(command === 'uninstall' ? '已移除后台服务，项目与数据仍保留。' : '已停止服务，下次登录 Mac 会自动启动。');
  } else if (command === 'status') status();
  else throw new Error('用法: node scripts/local-service.mjs install|start|restart|stop|status|uninstall');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
