# 本机部署

看板地址：<http://localhost:3000>。后台服务只监听本机地址，登录 Mac 后自动启动。

## 首次接入微信

1. 打开微信并登录。
2. 在 Finder 中双击项目内 `scripts/微信初始化.command`。确认显示 `wx 0.6.3` 和“本机内存读取修复版”。已有密钥可用时直接验证连接；需要提取密钥时才请求本机管理员密码。等待期间打开几个最近聊天、切换会话并翻阅消息，补充扫描最长约 90 秒。
3. 打开 <http://localhost:3000/setup>，填写自己的微信昵称（多个名称以英文逗号分隔），阅读并勾选隐私确认，点击“完成配置”。
4. 在看板点击“重扫”开始同步。需要更长历史时再使用“全量同步”。

脚本检查会话、联系人、磁盘上全部普通消息分片的密钥覆盖、解密能力和会话查询，通过后显示“普通群聊连接成功”。公众号推送或媒体库缺少密钥会保留警告，不阻断普通群聊接入；缺少任一普通消息分片仍会失败。如果初始化报错，请保留终端错误信息以便继续处理。也可以在配置页面选择“使用示例数据体验”。

需要补充公众号或媒体密钥时，在项目目录的终端执行 `./scripts/微信初始化.command --refresh-keys`，等待时在微信打开对应的公众号历史和媒体消息。

## 文件位置

- 运行配置：项目根目录 `.env.local`。
- 看板数据库和用户配置：`data/production/`。
- 后台服务日志：`data/logs/server.log` 和 `data/logs/server-error.log`。
- wx-cli：`.cache/wx-cli/bin/wx`，版本为 `0.6.3`，从同一作者的 [wx-cli-again](https://github.com/jackwener/wx-cli-again) 源码构建。源码保存在 `.cache/wx-cli-source/`，构建信息保存在 `.cache/wx-cli/build-info.json`。
- wx-cli 的初始化配置与数据库缓存：`~/.wx-cli/`。
- 服务注册文件：`~/Library/LaunchAgents/com.wechat-radar.local.plist`。

数据、日志和本地环境文件均已被 Git 忽略。保留项目目录和 `.cache/wx-cli/`，以便后台服务正常运行。

## 管理后台服务

在项目目录的终端中执行：

```sh
node scripts/local-service.mjs status
node scripts/local-service.mjs stop
node scripts/local-service.mjs start
node scripts/local-service.mjs restart
```

`stop` 停止本次运行，下次登录 Mac 后仍会启动。移除自动启动服务可执行：

```sh
node scripts/local-service.mjs uninstall
```

## 更新项目后重新构建

```sh
node scripts/local-service.mjs stop
pnpm install --frozen-lockfile
pnpm build
node scripts/local-service.mjs start
```

此部署已适配当前 pnpm 的原生组件构建配置，并兼容 wx-cli 的旧版数组和新版 metadata 包装格式。

日期范围内没有消息的群会通过统计查询确认空结果，不再误报同步失败；如果出现没有密钥的新普通消息分片，同步仍会提示重新初始化。

本机部署的 `.env.local` 默认设置 `WECHAT_RADAR_AI_ENABLED=0`，同步和统计在本机完成。自动话题及链接的 AI 标题生成未开启；这些功能会调用 Codex CLI，向模型服务发送选取的消息或链接上下文。需要使用时，将该值改为 `1`，配置并登录 Codex CLI，然后重新构建和启动服务。

话题雷达页面会明确显示 AI 分析是否启用。未启用时仍可查看已有话题，构建按钮不可用；打开页面不会自动启动分析。启用后选择日期并点击“构建话题”，按语义聚合当天筛选出的讨论，生成标题、摘要及原消息入口。没有合适的讨论时可能返回零个话题。构建接口会返回具体错误，并阻止同一天重复构建。

本机微信读取组件还修复了 macOS 内存扫描的 SIGBUS 崩溃：通过内核复制到自有缓冲区并跳过无法读取的区域，同时修正系统内存区域结构的对齐。补丁保存在 `scripts/patches/wx-cli-macos-owned-read.patch`，仅适用于上述源码版本；重新构建读取组件时应先应用补丁。补丁通过编译检查和 macOS 内存读取回归测试。微信数据是否接通仍以初始化脚本的完整检查结果为准。

## 分类管理

左侧导航提供“智能分类”和“分类管理”入口。

- “分类管理”支持新增分类，以及编辑名称、颜色、图标；删除分类前需要再次确认。删除只移除分类及关联标签，不删除群聊或聊天记录。
- 原有分类改名后，自动匹配规则仍然保留。新建分类可在“智能分类”页面为群聊手动选择并应用。
- 智能分类使用本机关键词规则，根据群名及最近消息生成建议；与云端 AI 分析开关无关。看板和智能分类页面使用相同规则，手动保存的分类优先。
- 分类更新后会立即刷新侧栏。删除的分类在服务重启后不会自动重新出现。
