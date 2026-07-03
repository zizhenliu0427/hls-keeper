# Web Keeper 中文文档

Web Keeper 是一个本地浏览器辅助下载和归档工具。它保留原来的 HLS 捕获能力，同时加入独立的 Archive 模块，用来处理 FANBOX ZIP 这类网页附件下载。

[English README](README.md)

> 当前实现说明：项目目录和 Python 包名暂时仍然是 `hls-keeper` / `hls_keeper`，这样可以避免破坏现有启动脚本。用户可见的项目名已经改为 **Web Keeper**。

## 它做什么

Web Keeper 由三部分组成：

```text
浏览器扩展 -> 本地 Python 服务 -> 本地下载 / 归档 / 输出目录
```

浏览器扩展只观察浏览器已经能够合法访问的请求。本地服务负责保存候选项、使用已捕获的请求头下载文件、跟踪进度，并在 `http://127.0.0.1:17888/` 提供 Dashboard。

Web Keeper 不破解 DRM，不绕过访问控制，也不会让你访问浏览器本来打不开的内容。

## 模块

### HLS Capture

HLS 模块用于普通 `.m3u8` 播放流：

- 从浏览器发现 `.m3u8`、`.ts`、`.key` 和字幕请求；
- 记录 playlist、分片、key、字幕等信息；
- 后台下载 HLS 分片；
- 重试缺失分片；
- 识别 `30B` / `33B` 这类异常小分片；
- 使用 ffmpeg 合并为 MP4；
- 支持只下载字幕和字幕转换流程。

### Archive

Archive 模块用于普通网页附件下载。

当前第一个适配器是 FANBOX ZIP：

- 扫描 FANBOX 创作者页面；
- 对每个 post 调用 `post.info`；
- 从 API 元数据拿原始文件名；
- 使用 `name + extension` 保存 ZIP，不用 UUID URL 当文件名；
- 按 `Page 001`、`Page 002` 分类；
- 写入 `archive_manifest.jsonl`；
- 校验下载后的 ZIP。

Archive 标签页还支持通用批量下载：

- 扫描任意页面 URL，提取直接压缩包链接（`.zip`、`.rar`、`.7z`、`.tar`、`.tar.gz`、`.cbz` 等），自动解析相对路径；
- 也可以直接粘贴压缩包 URL，每行一个；
- 文件名优先取 `Content-Disposition`，否则从 URL 推断；
- 下载后校验 ZIP 完整性，并在同目录写入 `archive_manifest.jsonl`。

Archive 任务会显示在和 HLS 相同的 Dashboard Jobs 列表中。

## 快速开始

1. 安装依赖：

```powershell
.\scripts\install_requirements.ps1
```

2. 启动本地服务：

```powershell
.\scripts\start_server.ps1
```

3. 启动带扩展的 Edge：

```powershell
.\scripts\start_edge.ps1
```

4. 打开 Dashboard：

[http://127.0.0.1:17888/](http://127.0.0.1:17888/)

## 浏览器扩展

扩展里有两个主要开关：

- `Discover`：观察有用请求，把候选项发给本地服务。
- `Capture`：主动捕获 HLS 媒体请求用于后台下载。

Archive 流程建议打开 `Discover`。你用这个浏览器访问 FANBOX 时，扩展会自动把最近的 FANBOX 请求头保存到本地服务。Archive 下载会优先使用自动保存的 headers，手动 headers 只是兜底或覆盖。

修改扩展文件后，需要在 Edge/Chrome 里重新加载扩展。

## HLS 工作流

推荐流程：

1. 打开视频页面并开始播放。
2. 在扩展里打开 `Discover`。
3. 等 Dashboard 出现候选视频。
4. 有 playlist 或 segment 候选后，点击 `Direct download`。
5. 如果缺分片，点击 `Retry`，或者在浏览器里重播缺失位置刷新授权。
6. 分片足够后合并。

合并策略：

- `strict`：要求分片完整。
- `skip`：跳过缺失分片，尽量生成连续播放文件。
- `fill-skip`：优先用低清同编号分片补洞，剩下的再跳过。

## Archive 工作流：FANBOX ZIP

打开 Dashboard，使用 `Archive: FANBOX ZIP attachments` 面板。

字段说明：

- `creatorId`：例如 `dollhouse`。
- `start page` / `end page`：页码范围；end 留空表示直到没有下一页。
- `output folder`：可选；留空时保存到 `archives/fanbox/<creatorId>`。
- `use saved browser headers first`：默认开启，优先用扩展自动捕获的浏览器请求头。
- `headers JSON`：可选覆盖/兜底，例如 `{"cookie":"..."}`。
- `ZIP only`：默认只下载 ZIP。

自动 headers 优先。手动 `headers JSON` 会覆盖自动 headers 里的同名字段，因此可以只替换过期 cookie 或 referer，而不需要关闭自动路径。

API 示例：

```powershell
Invoke-RestMethod http://127.0.0.1:17888/api/archive/fanbox `
  -Method Post `
  -ContentType 'application/json' `
  -Body '{"creator_id":"dollhouse","start_page":1,"end_page":10,"workers":4,"request_delay_ms":100,"zip_only":true}'
```

## API

```text
GET  /                         Dashboard
GET  /api/status               当前服务状态
POST /ping                     扩展心跳
POST /candidate                扩展发现的媒体候选
POST /capture                  扩展捕获的 HLS 媒体请求
POST /api/retry-missing        重试缺失 HLS 分片
POST /api/direct-download      开始直接 HLS 下载
POST /api/subtitles-only       只下载字幕
POST /api/start-candidate-download
POST /api/start-candidate-subtitles
POST /api/convert-subtitles
POST /api/export-player-subtitle
POST /api/open-location
POST /api/merge                合并 HLS 输出
POST /api/archive/headers      保存浏览器自动捕获的 Archive headers
POST /api/archive/fanbox       开始 FANBOX 归档下载
```

## 目录结构

```text
hls-keeper/
  extension/              浏览器扩展
  hls_keeper/
    server.py             本地服务、Dashboard、API、HLS 流程
    archive.py            Archive 模块和 FANBOX 适配器
  scripts/                启动和安装脚本
  data/                   本地状态、捕获请求、HLS captures
  archives/               Archive 输出
  outputs/                合并后的 MP4 输出
```

## 配置

查看服务端参数：

```powershell
python -m hls_keeper.server --help
```

常用参数：

- `--port`：本地服务端口，默认 `17888`。
- `--data-dir`：状态和捕获数据目录。
- `--output-dir`：HLS 合并输出目录。
- `--archive-dir`：Archive 输出目录。
- `--ffmpeg`：ffmpeg 路径。
- `--workers`：默认 HLS 并发数。

## 隐私

扩展会把部分浏览器请求 URL 和 headers 发送到 `127.0.0.1`。headers 里可能包含 cookie 或 authorization token。不要公开分享这些文件：

- `data/state.json`
- `data/requests.jsonl`
- `data/events.jsonl`
- 包含私有来源 URL 的 archive manifest

## 限制

Web Keeper 最适合普通 HLS 流和普通附件下载。以下情况可能无法完整处理：

- DRM 加密媒体；
- 源站故意返回空分片或一次性分片；
- 极短期 token，并且绑定设备指纹、IP 或播放会话；
- 真实文件名只存在于特殊站点 API 中，而该站点还没有专门适配器。

## Roadmap

- Browser-captured archive queue：扩展看到压缩包下载请求时，在 Dashboard 里保存为候选项。
- Batch image downloader：捕获或扫描 `.jpg`、`.jpeg`、`.png`、`.webp`、`.gif`、`.avif`、`.bmp` 等图片资源，并按页面、标题、来源站点或用户规则分组。
- Image filename and folder rules：能保留原始文件名时优先保留；URL 不透明时从页面元数据推断；用稳定规则处理重名。
- Shared archive manifest：记录来源 URL、页面 URL、headers 来源、原始文件名、保存路径、文件大小、可行时的 checksum 和重试状态。
- Internal rename cleanup：未来在迁移成本合适时，把包名和脚本从 `hls_keeper` / HLS Keeper 彻底改为 Web Keeper。
- 中文界面本地化：把 Dashboard 和扩展 popup 界面翻译成简体中文，最好提供语言切换。当前界面仅为英文（澳式英语）。
- 参考现有视频下载类浏览器扩展的功能与交互，例如 Video DownloadHelper、CocoCut：工具栏图标上的媒体检测提示（角标显示候选数量）、按标签页分组的候选列表、一键选择画质，以及更广的站点和格式覆盖。
