# 逻辑阅读（DuoBook）

逻辑阅读是一个按章深读的阅读工作台，支持网页版与 macOS 桌面版。当前版本 **1.2.8**。

导入电子书后先确认章节目录；直接阅读原文，需要时再选择一章手动拆分为阅读单元。逻辑地图按“书籍 → 章节 → 阅读单元”展示，点击标题进入对应原文。导入不会自动解析整本书。

## 功能

- EPUB、文字型 PDF、TXT 导入与原版封面提取；目录可确认、调整。
- 按章手动拆分、重新拆分、版本保留与九段阅读笔记。
- 自上而下的章节逻辑地图，支持拖动和进入阅读单元。
- 未拆分章节与阅读单元均可划线摘抄、添加笔记，支持 Markdown / JSON 导出。
- 本地 SQLite 保存书籍、笔记及阅读位置；再次打开自动回到上次位置。
- OpenAI 兼容 / Anthropic 格式解析模型，支持连接测试和独立 MiMo 语音配置。
- 本地系统语音与小米 MiMo 朗读，支持语速、声调、音色及连续翻行。
- 单行阅读：拖动、翻页、语音、两位小数进度与背景透明度。桌面版支持独立悬浮小窗、系统置顶及全局隐藏 / 显示快捷键（默认 `⌘⇧H`）。网页版为页面内阅读条。
- 四款可选应用图标，默认第二款。

## 技术栈

- 前端：React 19、TypeScript、Vite、React Query、React Flow。
- 后端：Python、FastAPI、SQLite。
- 桌面：Electron，内置经 PyInstaller 打包的本地 Python 服务。

## 本地运行

需要 Node.js 22+、Python 3.12+。浏览器回归测试默认使用本机 Google Chrome。

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r services/api/requirements.txt
npm ci
```

在两个终端分别启动后端与前端：

```bash
.venv/bin/uvicorn app.main:app --app-dir services/api --host 127.0.0.1 --port 8000
```

```bash
npm run dev:web
```

打开 <http://127.0.0.1:5173>；API 文档：<http://127.0.0.1:8000/docs>。

生产前端构建：

```bash
npm run build:web
```

## 模型与语音配置

在应用右上角“模型设置”填写协议、API 地址、Key 和模型名称，先测试连接，再保存。解析与语音使用独立配置；使用本地系统语音不需要远程 Key。

解析也可通过环境变量配置。以下仅为占位示例：

```bash
export DUOBOOK_LLM_PROVIDER="openai" # 或 anthropic
export DUOBOOK_LLM_BASE_URL="https://your-provider.example/v1"
export DUOBOOK_LLM_API_KEY="your-api-key"
export DUOBOOK_LLM_MODEL="your-model"
export DUOBOOK_LLM_TIMEOUT_SECONDS="60"
```

MiMo 语音可在界面填写，或在启动后端前设置 `DUOBOOK_TTS_BASE_URL`、`DUOBOOK_TTS_API_KEY`。远程解析失败会保留原文与已发布单元；无远程配置时提供本地结构化生成器用于体验流程。

仓库不包含私人 API Key、私人模型配置、用户书籍、数据库或个人分发包。桌面配置通过系统安全存储加密保存在本机；不要把自己的配置文件提交到 Git。

## 测试

```bash
.venv/bin/python -m pytest services/api/tests -q
npm run build:web
npm run test:e2e
node --test desktop/compact-shortcut.test.cjs
```

如果 8000 / 5173 正在运行网页版，可换端口执行隔离浏览器回归：

```bash
DUOBOOK_E2E_API_PORT=8011 DUOBOOK_E2E_WEB_PORT=5181 npm run test:e2e
```

桌面回归脚本位于 `desktop/*-smoke.cjs` 与 `desktop/smoke.cjs`，需先有本机桌面包及图形会话。当前已验证 macOS ARM64；macOS 13 真机兼容性仍待验证。

## 数据与打包

- 网页默认数据库：`services/api/data/duobook.db`；导入文件：`services/api/data/uploads/`。可用 `DUOBOOK_DB`、`DUOBOOK_UPLOAD_DIR` 修改位置。
- 桌面数据：`~/Library/Application Support/DuoBook/`。App ID 固定为 `com.duobook.reader`，升级保留原有数据。
- `npm run package:mac` 使用本机 Python / PyInstaller 与 Electron 生成 ARM64 App、DMG、ZIP，版本取根目录 `package.json`。
- 当前打包脚本面向私人分发版，需要 `.venv-macos13` 构建环境、PyInstaller、Pillow，以及本机准备的 `services/api/data/model-defaults.json`；语音配置为 `speech-defaults.json`。它们不会提交到仓库，个人安装包也不入库。

## 文档

- [技术方案 v2：按章深读工作台](docs/技术方案v2-按章深读工作台.md)
- [单行阅读使用说明](docs/单行阅读使用说明.md)
- [阅读位置记忆](docs/阅读位置记忆使用说明.md)
- [语音阅读使用说明](docs/语音阅读使用说明.md)
- [版本记录](docs/版本记录.md)
- [修复记录与验证范围](docs/修复记录.md)

许可证见 [LICENSE](LICENSE)。
