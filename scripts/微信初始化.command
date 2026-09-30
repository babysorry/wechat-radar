#!/bin/zsh
set -eu
setopt PIPE_FAIL
umask 077
project_dir="${0:A:h:h}"
cd "$project_dir"
wx_bin="$project_dir/.cache/wx-cli/bin/wx"
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

fail() {
  print "\n$1"
  print '请保留终端错误信息，回到 Codex 继续处理。'
  if [[ -t 0 ]]; then read '?按回车关闭…'; fi
  exit 1
}

[[ -x "$wx_bin" ]] || fail '新版微信读取组件尚未就绪。'
"$wx_bin" --version
print '本机内存读取修复版：遇到无法读取的内存区域会跳过。'
[[ $# -eq 0 || ( $# -eq 1 && "${1:-}" == '--refresh-keys' ) ]] || fail '用法：微信初始化.command [--refresh-keys]'

check_connection() {
  "$wx_bin" doctor --json | node "$project_dir/scripts/verify-wx-doctor.mjs"
}

if [[ "${1:-}" != '--refresh-keys' ]] && check_connection; then
  print '\n已有密钥满足普通群聊读取要求，无需重新扫描。'
else
  print '请先打开微信并登录。接下来会请求本机管理员密码，输入时屏幕不会显示字符。'
  print '此步骤让 wx-cli 读取你自己的本机微信数据库。'
  print '等待期间请在微信中打开几个最近聊天、切换会话并向上翻阅消息，帮助加载数据库密钥。'
  print '如果进入补充扫描，最长会等待约 90 秒。'
  "$wx_bin" daemon stop
  if /usr/bin/sudo "$wx_bin" key extract --hook-seconds 90; then
    :
  else
    scan_exit=$?
    print "读取组件退出代码：$scan_exit"
    fail '密钥提取未完成，微信数据尚未接通。'
  fi
  print '\n正在检查普通聊天数据库和解密能力…'
  if ! check_connection; then
    fail '普通聊天数据库检查未通过，微信数据尚未接通。'
  fi
fi
print '\n数据库检查通过，正在验证会话查询…'
if "$wx_bin" sessions --json -n 1 > /dev/null; then
  print '普通群聊连接成功，可在看板查看群列表并同步消息。'
  /usr/bin/open 'http://localhost:3000'
else
  fail '会话查询失败，微信数据尚未接通。'
fi
if [[ -t 0 ]]; then read '?按回车关闭…'; fi
