# Codex Reset Radar

监控 [@thsottiaux](https://x.com/thsottiaux)（OpenAI Codex 负责人）的 **Codex 限额重置公告**：
一旦他宣布重置用量额度，立刻发系统通知——不错过"额度到账、快去用"的窗口。

![界面截图](docs/screenshot.png)

## 功能

- **四路数据源并行**（任一可用不影响其他，自动限流退避）
  - **登录态接口**：用你自己的 X 登录态走内部接口，数据最全最实时（20 条/轮）
  - **公开主页**：免登录抓最新推文 ID，实时性高
  - **搜索发现**：Brave / DuckDuckGo 引擎轮换，补齐历史推文
  - **官方嵌入接口**：X 时间线兜底
- **三级判定**
  - 规则引擎：限额词/重置词邻近匹配、公告语气、银行式重置（banked reset）等加权评分 + 否决规则防误报
  - AI 判定：本地 CLI（claude / codex / ollama）优先，可用 OpenAI / Anthropic 兼容的 HTTP 接口替代；不可用时自动退回规则引擎
  - 图片 OCR：他用截图发公告时，用 macOS Vision 识别图中文字并参与判定
- **逐条 AI 翻译**：任意推文一键译成简体中文（结果缓存本地，不重复消耗 AI）
- **通知与留痕**：系统通知（仅在"新鲜窗口"内提醒，历史公告不打扰）、本地 SQLite 存储、警报历史
- **桌面常驻**：Tauri v2——菜单栏托盘、关窗不退出、开机自启、原生通知
- **界面**：零依赖 Web UI，深色 / 浅色 / 跟随系统

## 下载安装

到 [Releases](https://github.com/luckylee6666/codex-reset-radar/releases) 下载：

- **macOS**：`.dmg`（Universal，arm64 + x64）。应用未签名，首次打开请 **右键 → 打开**
- **Windows**：`.exe` 或 `.msi`。未签名，SmartScreen 提示时选择"仍要运行"

## 工作原理

```
轮询（默认 10 分钟，可调 10/15/30/60m）
 ├─ 登录态接口（Cookie + X 内部 GraphQL，最全）
 ├─ 公开主页（免登录，拿最新推文 ID）
 ├─ 搜索发现（默认 10 分钟一次，引擎轮换 + 冷却）
 └─ 官方时间线（失败独立退避，不拖累其他源）
      ↓ 入库去重（SQLite）＋ 单推补全（含父推）
 ├─ 规则引擎（正文）
 ├─ OCR 通道（近 7 天带图推文 → 图片文字并入判定）
 └─ AI 判定（带着图片文字重判，结果缓存）
      ↓
 命中 → 系统通知 + UI 实时弹窗（SSE / Tauri IPC）
      ↓
 任意推文 → AI 翻译（结果缓存，原文/译文可折叠对照）
```

## 快速开始

### 桌面应用（推荐）

```bash
pnpm -C desktop install
pnpm app          # 开发运行
pnpm app:build    # 打包应用
```

### 浏览器模式

```bash
pnpm start        # http://127.0.0.1:4173
pnpm poll         # 单次抓取
pnpm simulate "We've reset Codex rate limits"   # 注入模拟公告，验证通知链路
pnpm test         # 单测
```

## 配置（设置面板）

- **轮询间隔 / 发现间隔**：默认 10 分钟，最短 10 分钟（越短越易被限流）
- **X 登录 Cookie**（可选，启用后数据最全）：
  - 「从剪贴板导入」：浏览器 DevTools → 任意 x.com 请求 → 右键 **Copy as cURL** → 点按钮自动提取
  - 或直接把 cURL 整段粘进 auth_token 输入框（自动拆分）
  - Cookie 只存本机 `config.json`（权限 600），界面不回显真实值
- **AI 引擎**：`auto` 依次尝试 HTTP 接口 → claude → codex → ollama；HTTP 支持 OpenAI 兼容与 Anthropic 协议，本地无鉴权端点可留空 Key
- **图片 OCR**：macOS Vision（首次使用自动编译一个 20 行 Swift 助手并缓存），需要 Xcode Command Line Tools；非 macOS 自动跳过
- 通知开关/声音、新鲜窗口（默认 6h）、触发阈值、自定义关键词、RSS 备用源

## 项目结构

```
src/                     Node 版（浏览器模式 / 开发调试）
  fetch.js               数据源：时间线、公开主页、搜索发现、单推抓取
  x-graphql.js           登录态接口（X 内部 GraphQL，含 queryId 轮换）
  detect.js              规则引擎（加权评分 + 否决规则）
  ai.js                  AI 判定与翻译（CLI / HTTP 双通道）
  ocr.js + ocr.swift     图片 OCR（macOS Vision）
  poller.js store.js server.js notify.js
public/                  共享前端（HTTP 与 Tauri IPC 双通道适配）
desktop/                 Tauri v2 桌面端（Rust 重写后端，托盘/通知/自启）
test/                    单测（node --test + cargo test）
```

## 已知限制

- X 接口会限流（HTTP 429），程序自动指数退避；搜索源同样有冷却
- 登录态会过期，届时应用会提示，用「从剪贴板导入」更新即可
- 应用内登录窗口不支持 Google / Apple 弹窗（Google 对嵌入式浏览器的限制），请用剪贴板导入
- 图片 OCR 仅 macOS；Windows 版未经实机验证
- 应用未签名/未公证，首次打开需右键；分发给他人需自行签名
- 国内网络需要能访问 X 的网络环境（走系统代理设置）
- 本项目为个人工具，与 OpenAI 无关
