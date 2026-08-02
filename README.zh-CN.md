# Web Keeper 中文文档

> 当前纯扩展开发版：**0.3.6**

Web Keeper 是一个浏览器内 HLS 视频发现、直接下载和辅助抓取工具。视频主流程现在优先使用纯扩展，不要求启动本地服务；原有 Python Dashboard 和 Archive 模块暂时保留，用于旧 captures、ffmpeg 合并和 FANBOX ZIP 等附件任务。

[English README](README.md)

> 当前实现说明：项目目录和 Python 包名暂时仍然是 `hls-keeper` / `hls_keeper`，这样可以避免破坏现有启动脚本。用户可见的项目名已经改为 **Web Keeper**。

## 它做什么

当前有两条彼此独立的运行路径：

```text
默认视频流程：浏览器扩展 -> 扩展私有断点空间 -> 浏览器 Downloads
旧数据/Archive：浏览器扩展或手工输入 -> 本地 Python 服务 -> data / archives / outputs
```

浏览器扩展只观察浏览器已经能够合法访问的请求。它在扩展私有空间保存候选、断点和临时内容，校验成品后再交给浏览器保存到 Downloads；自选文件夹是可选高级模式。它不会自动扫描、迁移或删除原有 `data/captures`，本地 Python 服务不再是视频下载前置条件。

Web Keeper 不破解 DRM，不绕过访问控制，也不会让你访问浏览器本来打不开的内容。

## 模块

### HLS Capture

纯扩展媒体引擎当前识别并执行普通媒体直链、HLS、DASH/CMAF 和浏览器辅助保存：

- 发现普通 MP4、WebM 和音频响应，包括 URL 没有扩展名的媒体；
- 普通媒体文件流式写盘，并在服务器支持 Range 时从已有字节继续；
- 从浏览器发现 `.m3u8`、`.ts`、`.key` 和字幕请求；
- 在扩展任务页记录 playlist、分片、key、字幕和断点；
- 直接下载或保守跟随播放器请求；
- 跳过已经完整保存的分片；
- 在浏览器内处理普通 AES-128 HLS；
- 使用浏览器内转封装组件把含 H.264/AAC 的 MPEG-TS 分片生成可播放 `.mp4`，并支持常见分片式 MP4；
- 对静态 CMAF HLS，识别 `EXT-X-MEDIA` 独立音轨并在浏览器内合并音视频；
- 解析 DASH `SegmentTemplate` / `SegmentTimeline`，分别断点保存音视频轨并在浏览器内合并 CMAF MP4；
- 将检测到的字幕保存到作品旁边。

原有 Python HLS 模块仍提供 ffmpeg 合并、旧 captures 和历史 Dashboard 能力，但不是纯扩展流程的前置条件。

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

1. 启动带扩展的独立 Edge 测试窗口：

```powershell
.\scripts\start_edge.ps1
```

也可以在 Edge 的 `edge://extensions` 开启「开发人员模式」，选择「加载解压缩的扩展」，然后选中项目下的 `extension` 文件夹。修改代码后需要在该页面点击「重新加载」。

2. 打开扩展的「监听网页视频」，回到目标网页播放几秒。扩展图标出现 `!` 后打开 popup，选择清晰度和下载方式。

3. 新任务默认直接开始，并在完成校验后交给浏览器保存到 Downloads。浏览器辅助抓取时保持任务页开启，然后返回视频继续播放。

设置页可以改成“自选文件夹”；这个高级模式才会打开目录选择器。Chromium 可能拒绝在目录选择器里授权 Downloads 根目录，但推荐的“浏览器 Downloads”模式不受此限制。

纯扩展视频流程不需要安装 Helper，也不需要运行 `start_server.ps1`。如果需要管理旧 captures、使用旧 Dashboard/Archive 或原生 ffmpeg，仍可手动运行：

```powershell
.\scripts\start_server.ps1
```

## 浏览器扩展

扩展里只有一个「监听网页视频」开关。监听只负责发现媒体，不会立即下载。发现视频后，popup 会提示选择：

- `直接下载（推荐）`：优先选择浏览器发现的完整媒体文件；只有没有完整直链时才解析 HLS/DASH，按分片保存、断点续传并生成经过视频轨检查的 `.mp4`；通常不需要持续播放网页；
- `浏览器辅助抓取`：任务页只保存播放器实际请求过的分片，默认单线程且不预抓；需要保持任务页开启并继续播放；
- `本次忽略`：不处理当前视频。

每个任务先在扩展私有空间中创建 `作品_清晰度` 工作目录，保留断点和 HLS 临时分片；成品通过检查后再调用浏览器下载保存到 Downloads，并按设置清理临时内容。也可在设置中改用自选文件夹。下载中心里的“删除成品”“清理临时内容”“从列表移除”仍是三个独立操作，且都不会碰项目原有 captures。

修改扩展文件后，需要在 Edge/Chrome 里重新加载扩展。

## HLS 工作流

推荐流程：

1. 在扩展里打开「监听网页视频」。
2. 打开视频页面并开始播放。
3. 扩展图标出现 `!` 后打开 popup。
4. 选择清晰度以及「直接下载（推荐）」或「浏览器辅助抓取」。
5. 直接下载中断后重新打开任务并点击「继续」，已保存分片会被跳过。
6. 浏览器辅助模式缺片时回到对应位置重播，再点击「检查并生成视频」。

当前纯扩展版本优先支持普通 MP4/WebM/音频直链、VOD/滚动 HLS、MPEG-TS、AES-128、常见分片式 MP4、静态 CMAF HLS 独立音轨，以及无 DRM 的 DASH/CMAF 音视频分轨。任务页关闭后不会在后台偷偷继续，但重新打开会明确显示“已暂停，可继续”，断点和已保存文件都会保留。特殊鉴权、非标准清单或浏览器无法复用的播放器会话仍可能需要网页辅助；DRM 不在支持范围内。

浏览器辅助模式会显示缺失内容的大概时间范围。用户确认“智能补全”后，扩展会控制原网页播放器只访问缺口；播放器加载变慢时自动减速，连续没有新内容时停止并提示手动位置。

## 本地发布包

开发版 ZIP 位于 `dist/Web-Keeper-0.3.6.zip`。解压后，在 Edge/Chrome 的扩展管理页开启开发人员模式并选择“加载解压缩的扩展”。ZIP 不包含实验性 Helper，也不需要本地 Python 服务。默认通过浏览器下载 API 保存到正常的 Downloads；只有选择“自选文件夹”时才会遇到 Chromium 对系统文件夹根目录的授权限制。

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

默认纯扩展视频流程把候选、URL、必要请求头和断点保存在浏览器本地，不会发送给远程服务，也不会连接 `127.0.0.1`。只有用户主动运行旧 Python Dashboard/Archive 流程时，旧扩展接口才可能把部分请求 URL 和 headers 发送到本机服务。headers 里可能包含 cookie 或 authorization token；不要公开分享这些旧流程文件：

- `data/state.json`
- `data/requests.jsonl`
- `data/events.jsonl`
- 包含私有来源 URL 的 archive manifest

## 限制

Web Keeper 最适合普通 HLS 流和普通附件下载。以下情况可能无法完整处理：

- DRM 加密媒体；
- 源站故意返回空分片或一次性分片；
- 极短期 token，并且绑定设备指纹、IP 或播放会话；
- 非 CMAF 或直播型的 HLS 独立音轨，以及多 Period 或非标准 DASH；
- 真实文件名只存在于特殊站点 API 中，而该站点还没有专门适配器。

## Roadmap

- Browser-captured archive queue：扩展看到压缩包下载请求时，在 Dashboard 里保存为候选项。
- Batch image downloader：捕获或扫描 `.jpg`、`.jpeg`、`.png`、`.webp`、`.gif`、`.avif`、`.bmp` 等图片资源，并按页面、标题、来源站点或用户规则分组。
- Image filename and folder rules：能保留原始文件名时优先保留；URL 不透明时从页面元数据推断；用稳定规则处理重名。
- Shared archive manifest：记录来源 URL、页面 URL、headers 来源、原始文件名、保存路径、文件大小、可行时的 checksum 和重试状态。
- Internal rename cleanup：未来在迁移成本合适时，把包名和脚本从 `hls_keeper` / HLS Keeper 彻底改为 Web Keeper。
- 继续扩大真实站点样本，优先补通用解析器无法覆盖的清单和鉴权刷新模式。
- 参考现有视频下载类浏览器扩展的功能与交互，例如 Video DownloadHelper、CocoCut：工具栏图标上的媒体检测提示（角标显示候选数量）、按标签页分组的候选列表、一键选择画质，以及更广的站点和格式覆盖。
