# HLS Keeper

HLS Keeper 是一个本地 HLS 下载助手：浏览器扩展捕捉网页播放器真实请求过的 `.m3u8`、`.ts`、`.key` 请求，本地 Python 后台负责保存片段、自动查漏补缺、列出完整进度，并调用 ffmpeg 合并成 mp4。

它适合普通 HLS 视频。它不会破解 DRM，也不会绕过你没有访问权限的内容；它只是复用你浏览器已经合法请求到的媒体 URL 和请求头。

## 名字

我建议叫 **HLS Keeper**。这个名字比较准确：它不是单纯下载器，而是负责“守住”浏览器播放时经过的 HLS 片段、补漏、最后合并。

## 功能

- 浏览器扩展自动发现 `.m3u8`、`.ts`、`.key`。
- 默认只发现候选视频，不会一启动就后台下载。
- 本地后台保存多个视频、多个清晰度。
- 自动向前/向后补抓片段，减少手动拖进度。
- 自动识别异常小片段，例如 `30B/33B` 这种不是有效 TS 的响应。
- 后台页面显示完整列表、缺片、坏小片、下载量、最近请求。
- 后台页面可以直接粘贴 m3u8 URL 开始下载。
- 每个直接下载任务可以设置并行度和请求间隔，按“快/稳/慢”自己调。
- 任务列表显示实时进度条、下载速度、已保存 MB、ETA、失败数和异常小片段数。
- 支持捕捉和下载 CC/字幕资源：`.vtt`、`.srt`、`.ttml`、`.dfxp`、`.ass`、`.ssa`。
- 用户可以在候选视频里选择清晰度；不选时默认尝试最高可用清晰度。
- 一键重试缺片。
- 一键合并：
  - `strict`：只接受完整片段，不缺片。
  - `skip`：缺片直接跳过，连续播放，不插黑屏。
  - `fill-skip`：优先用低清同编号片段补洞，仍然没有就跳过。

## 快速开始

1. 安装依赖：

```powershell
.\scripts\install_requirements.ps1
```

2. 启动后台：

```powershell
.\scripts\start_server.ps1
```

3. 启动带扩展的 Edge：

```powershell
.\scripts\start_edge.ps1
```

4. 在打开的 Edge 窗口里登录/播放视频。

5. 打开后台：

[http://127.0.0.1:17888/](http://127.0.0.1:17888/)

## 像 app 一样使用

HLS Keeper 的使用形态是：

```text
浏览器扩展 -> 本地后台 app -> 下载目录/合并输出
```

扩展不是把视频存在浏览器里，而是把浏览器真实请求过的 HLS 地址和请求头发给本机后台。后台网页就是主界面，可以直接看到候选视频、下载列表、任务列表、缺片、坏小片、下载进度、合并按钮。

扩展图标弹窗也提供一个小控制台：连接状态、Discover/Capture 开关、候选视频数量、最近可下载候选、下载任务进度条、实时速度，以及打开完整 Dashboard 的按钮。

网页后台默认每 1 秒自动刷新一次。直接下载任务会显示进度条、百分比、`MB/s`、已保存体积、ETA、失败数和异常小片段数。

默认行为是 consent-first：

- 扩展安装/启动后默认不发现、不下载。
- 用户勾选 `Discover videos` 后，只发现候选 HLS，不保存片段。
- 用户在扩展弹窗点 `Start` 后，才会开始捕获/下载浏览器经过的片段。
- 用户也可以在后台 `Discovered videos` 列表里点 `Direct download`，对某个候选视频开始后台下载。
- 手动粘贴 m3u8 URL 只是高级兜底，不是主流程。

## 后台直接下载

如果后台已经从扩展发现了某个视频，优先在 `Discovered videos` 里点 `Direct download`。后台会使用扩展发现时捕捉到的请求头直接批量下载，不需要你自己找 m3u8。

如果候选来自 master m3u8，后台会解析可用清晰度并显示下拉框，例如 `1920x1080`、`1280x720`、`720x404`。用户选定后再点 `Direct download`。这个下拉框支持多选，按住 Ctrl/Shift 可以一次选择多个清晰度，后台会分别创建下载任务。

如果你想要 `1080p`，但实际只有 `720p`：

- 勾选 `auto fallback if selected quality is missing`：后台会自动下载实际解析到的最高可用清晰度，通常就是 `720p`，任务里会显示 requested/chosen/fallback。
- 取消勾选：后台会严格按你选的清晰度下载；如果没有 `1080p`，任务会失败并提示可用清晰度。

清晰度列表只来自扩展实际抓到的 URL 或 master playlist 里解析到的 `RESOLUTION=`，不会自己假设。若 master 里有 `1080p` 但实际片段下载失败，开启 fallback 时后台会先探测所选清晰度的前几个真实片段；失败后按 playlist 里实际存在的候选清晰度降级。

后台会用 ffprobe 探测已保存片段，列表里显示真实媒体信息：

- 分辨率
- 视频编码
- 帧率

手动 m3u8 URL 也支持多清晰度：`preferred quality` 可以写一个，也可以用逗号写多个：

```text
1920x1080,1280x720
```

如果自动发现不够，才使用 `Advanced fallback: direct m3u8 URL` 手动粘贴 URL。

字段说明：

- `m3u8 URL`：master playlist 或具体清晰度 playlist 都可以。
- `video id`：可选。留空时会尽量从 URL 推断。
- `resolution`：可选，例如 `1280x720`。留空时会尽量从 URL 推断。
- `workers`：并行下载数量。越大越快，但越容易触发限流或短期授权问题。
- `Delay ms/request`：每个请求前等待多少毫秒。网络/源站不稳时调大。
- `headers JSON`：可选。特殊网站需要时可以贴 `{"referer":"...","user-agent":"..."}` 这种 JSON。

建议设置：

| 模式 | workers | Delay ms/request | 适合 |
|---|---:|---:|---|
| 稳妥 | 4 | 100-300 | 容易卡、容易 401、源站限流 |
| 默认 | 8 | 0-100 | 大多数情况 |
| 激进 | 16-32 | 0 | 源站稳定、带宽充足 |

如果出现大量 `401`、`too small`、`failed`，不要盲目加并行，应该降并行或回网页重新播放刷新授权。

## 推荐工作流

1. 打开视频并开始播放。
2. 后台看到新的视频条目后，可以继续让播放器播放，后台会自动抓片段。
3. 后台已经看到 playlist/key 后，可以尝试 `Direct background download` 批量下载。
4. 如果缺片，点 `Retry`，或者在网页播放器拖到缺片时间点前一点，让浏览器刷新授权并重新请求。
5. 完成后点：
   - `Merge strict`：适合无缺片。
   - `Merge fill-skip`：适合少量片段坏掉或某些清晰度缺片。
   - `Merge skip`：适合只想稳定生成连续 mp4。

## CC 字幕

HLS Keeper 会监听常见字幕文件：

```text
.vtt .srt .ttml .dfxp .ass .ssa
```

如果 master m3u8 里有：

```text
#EXT-X-MEDIA:TYPE=SUBTITLES
```

后台直接下载任务会尝试自动下载字幕轨，并保存到：

```text
data/captures/<video>/<resolution>/subtitles/
```

如果字幕只有在网页里打开 CC 后才请求，需要先在扩展里开启 `Discover videos` 或 `Start`，然后在播放器里打开 CC 并播放一小段。旧版本只监听视频片段，所以之前没打开字幕支持时播放过的视频，通常需要重新打开 CC 播放一次才能抓到字幕。

## 我们前面遇到的问题，以及项目里的处理

### 1. 浏览器能播，但下载缺片

网页播放器容错很强，可能跳过 2 秒、降清晰度、使用内部缓存。ffmpeg 合并 mp4 时更严格，所以后台会明确列出缺片。

### 2. `200` 但只有 `30B/33B`

这种不是合法 TS 视频片段。MPEG-TS 包大小至少以 `188 bytes` 为单位；几十字节通常是空响应、占位响应或错误响应。HLS Keeper 默认不会保存这种文件，避免合并时把坏片段塞进去。

### 3. 授权/cookie 过期

后台只保存浏览器当时的请求头。本地重试如果返回 `401`，说明授权过期或该片段的 token 不匹配。解决方式是回到网页重新播放该位置，让扩展捕捉新的请求头。

### 4. 多清晰度时间轴可能不完全一致

`fill-skip` 会按同编号片段用低清补洞。多数 HLS 同编号对应同一时间点，但不绝对保证。后台保留 `skip` 策略作为更稳的选择。

### 5. 同时下载多个视频

可以。后台按 `product/resolution` 分目录保存。多个标签页同时播放时会出现在同一个完整列表里。

## 目录

```text
hls-keeper/
  extension/              # Edge/Chrome 扩展
  hls_keeper/server.py    # 本地后台、API、合并逻辑
  scripts/                # 启动脚本
  data/captures/          # 片段、playlist、key、状态
  outputs/                # 合并后的 mp4
```

## ffmpeg 和 GPU 加速

默认合并使用：

```text
ffmpeg -c copy
```

这只是封装/拷贝音视频流，不重新编码，所以 **不需要 GPU 加速**。GPU 只有在你要转码、压缩体积、统一分辨率时才有意义，例如使用 NVENC：

```powershell
ffmpeg -i input.mp4 -c:v h264_nvenc -preset p5 -cq 23 -c:a copy output_reencoded.mp4
```

但转码会花时间，也可能损失画质；下载合并阶段推荐保持 `-c copy`。

## API

```text
GET  /                  后台页面
GET  /api/status        当前状态
POST /capture           扩展上报媒体请求
POST /ping              扩展心跳
POST /api/retry-missing 手动重试缺片
POST /api/direct-download 后台直接下载 m3u8
POST /api/subtitles-only 只下载字幕
POST /api/start-candidate-subtitles 从候选视频只下载字幕
POST /api/convert-subtitles 转换已保存字幕
POST /api/merge         合并 mp4
```

合并示例：

```powershell
Invoke-RestMethod http://127.0.0.1:17888/api/merge `
  -Method Post `
  -ContentType 'application/json' `
  -Body '{"product":"mizd00509","resolution":"1280x720","strategy":"fill-skip"}'
```

直接下载示例：

```powershell
Invoke-RestMethod http://127.0.0.1:17888/api/direct-download `
  -Method Post `
  -ContentType 'application/json' `
  -Body '{"url":"https://example.com/video/1280x720/first.m3u8","workers":8,"request_delay_ms":100,"use_saved_headers":true}'
```

字幕转换说明见 [docs/subtitle-conversion.md](docs/subtitle-conversion.md)。Dashboard 里的 `CC convert` 可以选择保留原字幕、繁转简、简转繁、英式转美式、美式转英式；转换会另存副本，不覆盖原始字幕。

## 隐私

扩展会把媒体请求头发送到 `127.0.0.1` 的本地后台。请求头里可能包含 cookie 或 authorization token，所以 `data/requests.jsonl` 和 `data/state.json` 不要公开分享。

## 适用范围

HLS Keeper 对普通 HLS 最有用。下面情况可能无法完整下载：

- DRM 加密视频。
- 源站故意返回空片段或一次性片段。
- 清晰度切换时不同分辨率切片表不一致。
- 服务器强制绑定极短期 token、设备指纹、IP 或播放会话。
