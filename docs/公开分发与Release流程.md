# 公开分发与 GitHub Release 流程

适用版本：1.2.10。默认公开版不包含开发者的 Key、模型预配置、书籍数据库或上传文件。既有用户数据和自行保存的加密设置不随升级删除。

## 构建

```bash
npm ci
# 在 .venv-macos13（Python 3.12）中安装 requirements.txt 与 PyInstaller。
# 项目 .venv 用于运行打包辅助脚本。
npm run package:mac
```

- 公开命令显式设置 `DUOBOOK_INCLUDE_PRIVATE_KEY=0`，不受外部误设的私有模式影响。
- 私人构建只能使用 `npm run package:mac:private`。
- 后端冻结目录分别是 `build/frozen-public` 与 `build/frozen-private`；资源暂存分别在 `build/desktop/public` 与 `build/desktop/private`。
- `distribution.json` 记录模式与根 package.json 版本，打包时必须与当前构建一致。
- `desktop/electron-builder.cjs` 公开模式只复制代码、内置后端和前端；私人配置仅在私人模式资源列表中。
- App ID 为 `com.duobook.reader`，用户数据目录仍是 `~/Library/Application Support/DuoBook/`。

## 公开产物

全部放在 `release/public/`：

- `LogicReading-1.2.10-macOS-arm64.dmg`
- `LogicReading-1.2.10-macOS-arm64.zip`
- `INSTALL.md`
- `SHA256SUMS.txt`
- `public-audit.json`

不得通过 `release/*` 之类的宽泛通配符上传，以免混入历史个人包；上传时显式列出以上五个公开文件。

## 发布前检查

1. 运行后端与浏览器测试、生产构建。
2. 运行 `node desktop/public-smoke.cjs`：确认干净首次启动无 Key、默认本地模式、继承的语音环境凭据被忽略、用户设置加密及重启后保留。
3. 运行现有桌面单行、快捷键、位置、语音解码和主流程回归；脚本默认指向 `release/public/mac-arm64/逻辑阅读.app`。
4. `distribution.py` 在归档前扫描整个 App，检查私人配置名、已知本机 Key、常见 Token 形态、用户数据库、上传文件和外部资源软链接。异常停止打包，错误只显示文件位置，不输出 Key。
5. 用 `hdiutil verify`、`codesign --verify --deep --strict`、`shasum -a 256 -c SHA256SUMS.txt` 检查产物；静态扫描的结论记录在 `public-audit.json`。

## Release 发布

1. 提交构建代码、测试和说明，为验证过的源码创建 `v1.2.10` 标签。
2. 创建 GitHub draft Release，明确它是无 Key 的 macOS ARM64 公开版。
3. 显式上传五个公开文件；核对远程 asset 名称、大小、摘要与本地文件一致。
4. 将 draft 发布为 Latest，验证公开下载地址。
5. 将 README 的下载按钮同步至 main，指向明确版本的 DMG / ZIP 和校验文件。

GitHub 登录凭据仅由系统的 GitHub CLI / 安全存储管理，不写入脚本、仓库、安装说明或审计报告。

## 验证边界

当前是 ad-hoc 签名，未做 Developer ID 签名及 Apple 公证；目标 macOS 13 尚无真机验收。完整桌面启动在 macOS 15 验证。本轮发布不增加 Intel、Windows、Linux 构建或自动更新。
