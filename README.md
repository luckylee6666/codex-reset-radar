# Codex Reset Radar

监控 [@thsottiaux](https://x.com/thsottiaux)（OpenAI Codex 负责人）的 **Codex 限额重置公告**：
一旦他宣布重置用量额度，立刻发 macOS 系统通知——不错过"额度到账、快去用"的窗口。

![界面截图](docs/screenshot.png)

## 功能

- **多源抓取**：X 嵌入时间线 + 搜索引擎发现（Brave / DuckDuckGo）+ 单推接口，应对限流与快照滞后
- **三级判定**
  - 规则引擎：限额词/重置词邻近匹配、公告语气、银行式重置（banked reset）等加权评分，附否决规则防误报
  - AI 判定：本地 CLI（claude / codex / ollama）优先，可用 OpenAI / Anthropic 兼容的 HTTP 接口替代；不可用时自动退回规则引擎
  - 图片 OCR：他用截图发公告时，用 macOS Vision 识别图中文字并参与判定
- **通知与留痕**：macOS 系统通知（新鲜窗口内才提醒，历史公告不打扰）、本地 SQLite 存储、警报历史
- **桌面常驻**：Tauri v2 应用——菜单栏托盘、关窗不退出、开机自启、原生通知
- **界面**：零依赖 Web UI，深色 / 浅色 / 跟随系统

## 工作原理

```
轮询（默认 5 分钟）
 ├─ X 时间线接口（失败独立退避，不拖累其他源）
 ├─ 搜索发现（默认 10 分钟一次，引擎间轮换 + 冷却）
 └─ 单推抓取（补齐发现到的新推文，含父推）
      ↓ 入库去重（SQLite）
 ├─ 规则引擎（正文）
 ├─ OCR 通道（近 7 天带图推文 → 图片文字并入判定）
 └─ AI 判定（带着图片文字重判，结果缓存）
      ↓
 命中 → 系统通知 + UI 实时弹窗（SSE / Tauri IPC）
```

## 快速开始

### 桌面应用（推荐）

```bash
pnpm -C desktop install
pnpm app          # 开发运行
pnpm app:build    # 打包 Codex Reset Radar.app
```

构建产物：`desktop/src-tauri/target/release/bundle/macos/Codex Reset Radar.app`

### 浏览器模式

```bash
pnpm start        # http://127.0.0.1:4173
pnpm poll         # 单次抓取
pnpm simulate "We've reset Codex rate limits"   # 注入模拟公告，验证通知链路
pnpm test         # 规则/解析单测
```

## 配置

设置面板可调：轮询间隔、发现间隔、通知与声音、新鲜窗口（默认 6h）、触发阈值、自定义关键词、
RSS 备用源、AI 引擎（auto / http / claude / codex / ollama）、HTTP 接口与 Key、图片 OCR 开关。

说明：

- **AI 引擎**：`auto` 优先使用配置好的 HTTP 接口，其次 claude → codex → ollama CLI
- **HTTP 接口**：支持 OpenAI 兼容（`/v1/chat/completions`）与 Anthropic 两种协议；本地无鉴权端点
  （LM Studio / one-api / Ollama）可留空 Key。Key 仅存本机 `config.json`（权限 600），不会回传界面
- **图片 OCR**：使用 macOS Vision（首次使用自动编译一个 20 行 Swift 助手并缓存），
  需要 Xcode Command Line Tools；非 macOS 自动跳过

## 项目结构

```
src/                  Node 版（浏览器模式 / 开发调试）
  fetch.js            数据源：时间线、搜索发现、单推抓取
  detect.js           规则引擎（加权评分 + 否决规则）
  ai.js               AI 判定（CLI / HTTP 双通道）
  ocr.js + ocr.swift  图片 OCR（macOS Vision）
  poller.js store.js server.js notify.js
public/               共享前端（HTTP 与 Tauri IPC 双通道适配）
desktop/              Tauri v2 桌面端（Rust 重写后端，托盘/通知/自启）
test/                 单测（node --test）
```

## 已知限制

- X 的免鉴权接口会限流（HTTP 429），程序自动指数退避重试；搜索源同样有冷却
- 国内网络需要能访问 X 与搜索源的代理（走系统代理设置）
- 应用未签名/未公证，本机自用无碍；分发给他人需自行签名（或右键打开）
- 本项目为个人工具，与 OpenAI 无关
