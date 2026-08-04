# Web Keeper 交接文档（Handoff）

## 0.4.0 – 0.4.6 旧库导入、抓取加速与时间轴判定（2026-08-04）

这一段是补记：0.4.0–0.4.6 的实现先于文档完成，本节按代码实际行为回填。常量都在 `extension/download.js` 顶部，判定逻辑在 `extension/media-engine.js`。

### 清晰度只显示一档、直接下载卡住、有效性检查误删（2026-08-04）

- **只有 720p**：清晰度不是从主播放列表解析的，而是从**浏览器实际请求过的 URL 路径**（`/1280x720/`）里认出来的，所以播放器菜单里有 1080p/720p/404p/270p，扩展却只显示「1 个清晰度」。background 新增 `masterPlaylistVariants` / `expandMasterPlaylist`：记录到播放列表候选时读一次主播放列表，把每个 `EXT-X-STREAM-INF` 都登记成可选清晰度（`fromMasterPlaylist: true`，避免递归展开）。URL 里没有分辨率时用 `RESOLUTION` 属性补上。
- **大量缺片时直接下载卡住**：`runHlsDirect` 把整批分片交给 `mapConcurrent`，**任何一个分片抛错就整批 reject**，一条过期 URL 能把其余几千个一起带走。现在每个分片自带 `DIRECT_SEGMENT_RETRIES`（3 次，退避 400/800 ms），仍失败就记下并跳过，本轮结束后报「N/M 个暂未保存」；只有**全部**失败（且 ≥5 个）才当作会话过期抛出。
- **有效性检查误删可用分片**：`readStoredSegment` 在播放列表里找不到对应条目时退回 `{ sequence }`（无 key），`decryptIfNeeded` 于是**原样返回密文** —— 密文当然不是 TS，被判无效并**删除**。现在分三类：有效 / 确定无效（尺寸不对，或明文且非 TS/MP4）/ **无法判定**（加密未解开、原文件读不到）；只删「确定无效」，其余原样保留并单独报数（`verifyUndecided`）。
- 顺带：`pytest.ini` 限定 `testpaths = tests`，否则收集阶段会走进 `data/captures`（正在下载的目录会中途消失，导致整轮 FileNotFoundError）。

### 外挂字幕：从「检测不到」到「分段合并」（2026-08-04）

用户的站点把字幕放在一个 gRPC-Web 接口后面，一路排查下来是六层问题，逐层都已修：

- **只认扩展名**：检测端原本要求 `.vtt/.srt/...`，这个接口的 URL 没有扩展名。现在 `recordResponseCandidate` 也按 content-type 或路径含 `subtitle` 归类，记进 `item.subtitleTypes`。
- **HLS 侧轨没收**：`EXT-X-MEDIA:TYPE=SUBTITLES` 指向的媒体播放列表会被当成主播放列表，`discoverSubtitles` 现在会区分主/媒体播放列表并按 `EXT-X-MEDIA` 拉侧轨。
- **GET 返回 415**：这是个只接受 POST 的 gRPC-Web 接口。`background.js` 用 `onBeforeRequest` + `["requestBody"]` 把原始请求体录下来（base64，`pendingSubtitleRequests`，120 秒过期），任务页原样重放，`content-type` 加进 `allowedHeaders` 白名单。
- **响应看不懂**：响应是 gRPC-Web 分帧（5 字节前缀）包 protobuf 包 base64 包 AES-CBC。`grpcWebPayload` / `protobufStringField` / `decodeEncryptedSubtitle` 逐层拆开；密钥随 `subtitleUserIdFromHeaders`（JWT payload）派生。
- **只有几分钟**：播放器**按播放进度分段**调用同一个地址，每次请求体的分页参数不同。原来每个 URL 只存一次调用，所以只拿到一段。现在 `item.subtitleCalls` 按请求体去重保留全部调用（上限 200 条），任务页重放**每一条**并用 `mergeVttDocuments` 合并 —— 按 `起始时间|正文` 去重、按时间排序、只保留一个 `WEBVTT` 头，所以重复保存不会产生重复字幕。
- **覆盖不足要说出来**：`subtitleCoverageSeconds` 取最后一条 cue 的结束时间，不足视频时长 90% 时报 `subtitleCoverageShort`（覆盖到哪 / 视频多长 / 怎么补）；只录到一次调用时另报 `subtitlePartialCoverage`。

补齐不再需要用户手动重播，两条路，先自动后兜底：

- **最终结果**：2312 条、覆盖 00:00–08:00:38，与视频等长。两处缺一不可 —— (1) 请求要带**字幕请求自己的头**（会员 token 决定给全片还是 5 分钟预览；此前用的是播放列表请求的头，一个 token 都没有），(2) AES 的 IV 由登录用户 ID 推导，而该 ID 未必在请求头里，改为收集页面 localStorage/sessionStorage/cookie 里的 JWT 与数字 ID，**逐个试解密并用文本里有没有 `-->` 判定**，成功的身份缓存在内存里。这些值只用于在内存里构造 IV，不落盘、不进诊断报告。
- **清晰度名要以 manifest 为准**：URL 路径里的 `720p` 是营销名，实际编码是 `720x404`。`expandMasterPlaylist` 一度让 URL 标签压过 `EXT-X-STREAM-INF` 的 `RESOLUTION`，导致文件夹名与真实分辨率对不上。现在 manifest 优先，URL 只作兜底。
- **真正的根因（av.jkforum.net，2026-08-04 由用户 DevTools 定案）**：播放器那次 `AvideoSubtitle` 的响应是 **246 kB**，我们重放同一个请求体拿到的是 **5547 字节**。同一个 body、不同的答复 —— 差别在**身份**。扩展页面（`chrome-extension://`）发出的是跨源匿名请求，带不上会员会话（接口清单里 `UseTicket` / `IsAvPlus` / `CheckMember` 印证了这是会员分级站点），服务器只给免费预览的 4:54。新增 `postInPage`：用 `chrome.scripting.executeScript`（`world: "MAIN"`）**在网页自己的上下文里**发这个 POST，再把字节 base64 回传。`requestSubtitleRaw` 优先走这条路，失败才退回扩展页面直连。**在此之前所有关于分页、流式多帧、repeated 字段、站点只有 5 分钟的推断都是错的** —— 它们解释的是同一个被身份阉割过的响应。
- **实测结论（旧，已被上一条推翻）**：`字幕接口诊断` 导出的真实形状是 —— 请求 `1=int:1159810`（只有视频 ID），响应 5547 字节 / **1 帧** / 密文 5504 字节，完整解出 2676 字符 56 条、覆盖 00:00–04:54。**没有分页，也没有截断**：这个接口只接受视频 ID，返回什么就是全部。此前关于「分页游标」「服务端流式多帧」「repeated 字段」的三个假设对这个站点都不成立 —— 相关代码保留（对真正分页的接口仍然有效），但不再是这里的解释。`subtitlePagingAbsent` 现在在花请求去试探之前先判断这种「只带 ID」的形状，直接给出结论，不再让用户去追一个不存在的游标。
- **多帧 / repeated 密文**（对其他站点仍然重要）
- **回复本身就是完整的，是我们只读了 1/N**：`grpcWebPayload` 只返回 `frames[0]`，而 gRPC-Web 回复可以是**服务端流式**的 —— 一个 HTTP 响应里很多个 DATA 帧；同样 `protobufStringField` 只取该字段的第一个值，而密文字段是 **repeated** 的。于是「8 小时的视频只有 56 条字幕、覆盖 4:54」「改任何整数参数都返回同一段」「播放器走一遍录不到新调用」三件事同时成立 —— 因为根本没有分页，是解码截断了。新增 `grpcWebPayloads` / `protobufStringFields`，`decodeEncryptedSubtitle` 解出**每一帧的每一条**密文再 `mergeVttDocuments` 合并；单条密文解密失败不再丢弃其余部分。旧的单值访问器保持原语义，其他调用方不受影响。
- **只录到一次调用时靠试探**（`probeSubtitlePaging`）：差分需要两次调用，但常见情况就是只录到一次。此时逐个改动请求体里的整数字段再问一次，**用返回内容验证** —— 只有当回复真的伸到了原来那段之后才认这个字段。`subtitlePagingProbes` 按「秒 → 毫秒 → 页序号」排出候选（步长取本段时长），上限 `SUBTITLE_PROBE_LIMIT`（24）次请求。服务器忽略的字段会原样返回同一段，自动被否掉。全试完还不动就明说游标不是简单数字（多半是字符串 token），请改用播放器兜底。
- **页面缓冲区不能提前返回**：`fetchSubtitleContent` 第一步会取网页已经收到的字节，原来命中后 `if (!buffer)` 把整个重放 + 扩展分支**全跳过了**，于是保存成功但内容和以前一模一样。现在：这个地址有已录调用（说明是分段接口）时，缓冲副本降级为**第一段**而不是全部答案；没有已录调用时（普通 .vtt/.srt 侧轨）保持原样返回，不会被 `mergeVttDocuments` 改写格式。
- **结果必须自报**：拼完无条件记一条 `subtitleAssembled`（几段拼成 / 多少条 cue / 覆盖区间），「保存了但很短」不再需要猜。
- **旧版本存下的调用要认**：`subtitleCalls` 数组是这一版才有的，更早的版本只写 `subtitleRequests`（每个 URL 一条）。`refreshSubtitleCalls` 现在把这张表也 seed 进来 —— 否则会出现「保存字幕能成功，却报录到 0 段」这种自相矛盾的状态。
- **直接抽取（默认，无需网页）**：`inferSubtitlePaging` 对已录到的请求体**做差分** —— 解出 protobuf 里的整数字段（`protobufVarintFields`），凡是在多次调用之间变化的就是分页游标，变化间距就是页长。start/end 这类成对移动的字段允许一起变，但**步长必须一致**；只有一次调用、或多个字段以不同速率变化时返回 `null`，不做任何猜测（会提示改用播放器兜底）。随后 `protobufSetVarint` 重新编码该字段（新值字节数可能不同，所以是重建而非原地打补丁）、`grpcWebFrame` 重新分帧，把游标推到播放器从未请求过的范围。停止条件是**这一页的覆盖不再前进**（即到了轨道末尾），`SUBTITLE_SWEEP_LIMIT`（400）只防游标不终止；每次请求之间 120 ms 节流。
- **让播放器走一遍（兜底，需接上网页）**：`sweepPlayerForSubtitles` 复用 capture 的 `stepSeekForward` 驱动播放器走完全片，由站点自己发字幕请求、background 记录，边走边 `refreshSubtitleCalls` 显示「新录到 N 段 / 当前位置」，随时可停。这条路对任何分页格式都有效（包括字符串游标）。走完自动保存，已有部分自动合并。任务已完成或暂停时 `stepSeekForward` 需要 `{ ignorePause: true }`，否则捕获用的暂停守卫会让每一步变成空操作。

产品承诺的边界因此变成：**字幕能覆盖到分页游标可推进的范围**；只有当游标规律无法从录到的调用中解出时，才退回「播放器实际请求过的范围」。

简繁 / 英美转换用的是内置字表，只覆盖常用字。`unconvertedChineseCount` 统计样本里没有规则的汉字，设置页和运行日志都会明说，不假装是完整转换。输出格式可选「源格式 / SRT / VTT」（`applySubtitleFormat`），选 SRT 时 `webVttToSrt` 会去掉 `WEBVTT`、NOTE、cue 设置并把 `.` 换成 `,`。

当前自动化测试 50 项通过（含 `node tests/smoke_download_page.js` 真实加载 `download.js` 的冒烟测试）。字幕链路的真实站点验收由用户在自己的目标站点进行。

### 导入旧库的三个严重问题（2026-08-04 修正）

用户实测：导入 `idbd00965`（`1280x720` 有 9360 个 .ts，播放列表 12959 条，缺 3599 片）时，导到九千多片后进度显示满、自动切到低清晰度继续，最后浏览器崩溃。三个原因都已修：

- **自动导入所有清晰度**：`importLegacyCapture` 原本 `for (const variant of variants)` 把作品夹下每个清晰度依次导一遍。现在先扫描并列出每档的分片数和体积，默认只勾最大的那档，用户确认后才开始（`chooseLegacyVariants`）。
- **收尾的缺口判定读了数 GB 且不让出主线程**：`reclassifySkippableGaps` 会对每个缺口读前后各 512 KB；几千个缺口直接把标签页内存打爆。现在每轮上限 `MAX_RECLASSIFY_PER_PASS`（120）、每 10 个 `await waitFor(0)`，其余缺口留到后续轮次。
- **O(N²) 状态复制**：`segmentSkipVerdicts` 每次都整份展开复制、`skippableSequences` 每次插入都排序、`skippableSequenceSet()` 每次调用都重建 Set，导入时还每 12 个分片就把整份状态写进 IndexedDB。现在改为原地写入（`recordSkipVerdict`，上限 400 条诊断记录）、去掉排序、按任务缓存 Set，落盘改为最多每 500 ms 一次。
- 顺带把 `playlistSegmentBySequence` 从线性 `find` 改成按 sequence 的 Map，合并长作品时同样是 O(N²)。

### 导入改为「就地引用」而不是复制（默认行为）

用户的真实诉求是**查漏补缺**，而原实现是把本地 9360 个分片解密后**复制**进扩展存储（这一个作品约 10 GB），既慢又翻倍占盘。现在默认不复制：

- 分片记录写成 `source: "legacy-link"`，`fileName` 指向原目录里的文件名；变体目录句柄存进 `handles` store（`legacy:<jobId>`）。
- 新增统一读取器 `readStoredSegment(record, meta)` / `storedSegmentSize(record)`：链接记录从原目录读原始字节并**读时解密**，普通记录仍从任务空间读。合并、TS 转封装、fMP4 拼接、PTS 采样、`reconcileSaved` 全部改走这条路。
- 重开任务时 `loadMediaPlaylist` 会先走 `loadLocalLegacyPlaylist` 读任务空间里的 `source.m3u8` 并用 `file.key` 重建解密缓存，因此读时解密在重启后仍可用。
- 目录授权失效时 `ensureLegacySource` 会在用户操作（合并）时请求重新授权，失败则明确报 `legacySourceUnavailable`，不会静默产出坏文件。
- 仍保留「复制一份到扩展存储」勾选项（默认关）。选择复制则原目录可随意移动；选择链接则**生成视频前不能移动或删除原目录**，导入完成的提示里会写明。

### 0.4.0 导入旧 `data/captures`

产品行为见 §4.2.4，这里只补实现细节：

- 按钮由 `showTaskList` 动态渲染（id `importLegacy`，空列表时 `importLegacyEmpty`），`collectLegacyVariants` 递归识别 captures 根 / 作品夹 / 清晰度夹；只选清晰度夹时会要求输入作品名。
- `buildSyntheticLegacyPlaylist` 按磁盘上的 `.ts` 文件名合成播放列表，`rewriteLegacyPlaylistKey` 把 `#EXT-X-KEY` 指向内部伪 URL（`https://legacy.local/aes-key/…`），由 `cacheLegacyAesKey` 把同目录 `file.key` 预置进解密缓存 —— 因此导入过程完全离线，不会向任何站点发请求。
- 导入阶段就跳过无效的极小文件（同 `MIN_SEGMENT_BYTES`）。

### 0.4.1 – 0.4.2 抓取加速

- 「播放加速」先试网页播放器的 `playbackRate`（2/4/8x，自动静音）；站点禁用或限速时自动回退到定时快进（`startSeekBoost` / `stepSeekForward`），即用户最早提出的「每秒按一次右方向键」思路，但直接改 `currentTime` 并附带派发方向键事件。
- 快进参数可调并持久化在任务状态：`captureSeekIntervalSec`（0.25–30 秒，默认 1）、`captureSeekStepSeconds`（1–120 秒，默认 10），由 `normalizedSeekBoostSettings` 夹取范围。改动即时重启快进；暂停停止、继续恢复。

### 0.4.3 卡住强提示与补洞反馈

- `checkProgressStall` 每 5 秒轮询，`done`/`bytes` 超过 `STALL_WARN_MS`（45 秒）没变就把提示条转红并弹一次 alert（`stallAlertShown` 保证同一轮只弹一次）。网页辅助会附带网页播放位置、是否在缺口附近、下一处缺口时间。覆盖跟播、快进、智能补全和直接下载。
- 智能补全增加当前缺口高亮（`smartFillActiveRange`）、一段补完提示下一处缺口、播放器偏离目标超过 `SMART_FILL_SEEK_SKEW_SECONDS`（20 秒）告警。

### 0.4.4 – 0.4.6 极小分片与时间轴判定（本轮最实质的改动）

- `MIN_SEGMENT_BYTES = 188`（一个 MPEG-TS 包）。小于此的一律不算已保存。
- 关键判断不是「极小就永远缺」，而是**跳过它之后前后接不接得上**：`classifySkippedSequence` 取前一片尾 + 后一片头各 `TS_TIMESTAMP_SAMPLE_BYTES`（512 KB），用 `transportTimestamps` 扫 PTS（没有则 PCR），交给 `assessSkippedSegmentContinuity` 判定：
  - 间隔 ≤ `max(0.35, 时长×0.25)` → `skippable`，这一片本来就没有媒体，不再重试也不参与合并；
  - 间隔 ≈ 播放列表时长（±`max(0.75, 时长×0.4)`）或明显偏大 → `needed`，真缺片；
  - 读不到时间戳、缺邻居、跨 `#EXT-X-DISCONTINUITY` → `unknown`，**保守当缺片**。
- `assessAdjacentSegmentContinuity` 用同样的采样监测任务中途的时间轴漂移：回跳 < −1.5 秒判 `PTS_RESET_OR_JUMP_BACK`，前跳超过 `max(时长×1.8, 时长+2.5, 3)` 判 `PTS_FORWARD_JUMP`；播放列表自带断点不算异常。
- 发现漂移后**不阻塞**：`adjustTimelineShiftAndContinue` 在接缝序号记 `timelineBreaks`、作废旧的可跳过结论、保留已下分片并继续下载，合并阶段由 mux.js（`keepOriginalTimestamps: false`）重排时间戳。接缝处仍可能有轻微跳变，这不是 ffmpeg 级对齐。
- 暂停超过 `LONG_PAUSE_MS`（5 分钟）后恢复会走 `prepareTimelineAfterIdle`，先作废旧结论再按当前分片重判，避免用过期结论。
- `missingTimeline` 增加第三个参数排除 skippable；缺片面板显示「已确认 N 个可跳过」；合并的 `missing` 计算排除 skippable，完成提示说明跳过了几个。
- 全程不使用 ffmpeg、不新增权限、不做整片解码。

### 这一段的验证边界

- `media-engine.js` 侧的判定（`assessSkippedSegmentContinuity`、`assessAdjacentSegmentContinuity`、`missingTimeline` 排除 skippable）**有真实 node 行为测试**。
- `download.js` 侧的导入、快进、卡住提示**只有契约断言**（函数名/元素 id 存在），因为依赖 `chrome.scripting` 和完整 DOM，只能在真实浏览器里验。
- 真实站点仍未验收。特别是「暂停很久后时间轴变化」这条，需要在直播或会过期的片源上实测。

### 顺带修正（本次补文档时）

- `background.js` 的 `SCRIPT_VERSION` 之前一直停在 `0.3.9`，写进 storage 的 `engineVersion` 是过期值（popup 显示的是 manifest 版本，所以用户看到的是对的）。已改为跟随 manifest，并加测试把 manifest 版本、`SCRIPT_VERSION`、两个 README 的版本号和发布包名钉在一起，防止再次漂移。

## 0.3.9 Capture 直取播放器数据 + DASH 辅助抓取（2026-08-04）

### 直取播放器已经收到的数据（本轮最重要的改动）

- 新增 `extension/page-capture.js`，在辅助抓取任务启动时通过 `chrome.scripting` 注入到视频页的 **MAIN world**（`allFrames`），包装 `fetch` 和 `XMLHttpRequest`，把播放器已经收到的媒体响应体保留在页面内（上限 96 MB / 单项 24 MB，按插入顺序淘汰）。任务页随后按 URL 取走这份字节。
- 因此 Capture 不再必然“重新请求一遍”。一次性 URL、Referer/Origin、连接绑定、播放器私有 token 这些场景，只要播放器自己拿到了数据，就能保存下来。取不到时仍按原有顺序回落：任务页请求（优先浏览器缓存）→ 原网页会话内请求。
- 时序注意：webRequest 是在**请求发出时**广播的，那一刻响应体还没到，所以取数据是轮询等待（250 ms 一次）。冷启动等 6 秒，命中过之后降到 2.5 秒；从没命中过且连续 3 次落空会关掉等待并记日志，命中后恢复。播放器 seek 取消掉的请求 body 永远不会到，所以等满一次的 URL 会记进 `pageBufferGaveUp`，之后只做零等待的一次性检查，避免智能补全时每片空等。
- **这段轮询/退避逻辑没有自动化测试覆盖**，只有契约断言。它依赖 `chrome.scripting` 和完整 DOM，只能在真实浏览器里验；node 测试覆盖的是 `page-capture.js` 拦截器本身的行为。
- 缓冲区留在页面里，所以任务页短暂关闭期间播放器收到的数据仍然在（只要标签页还在）。任务完成或从列表移除时会调用 `stop()` 还原 `fetch`/XHR 并清空缓冲。
- 页面脚本全程 try/catch，任何异常都直接放行原始请求；只有用户明确对该标签页选择了辅助抓取才会注入。
- **不使用 `chrome.debugger`**，因此不会出现调试横幅，也没有新增权限（`scripting` + `<all_urls>` 已有）。

### 跨标签页继续、播放加速与 DASH 字幕

- `matchesCandidate` 以前两条分支都绑定 tabId（`candidateId` 本身就是 `tabId:product:resolution`），所以未完成的任务在第二天重开视频（新标签页）后收不到任何事件，会一直停在“等待网页继续播放”。现在改成按 product + 页面 URL 匹配，不再看 tabId；匹配到新标签页时把 `candidate.tabId` 切过去并重新注入页面钩子（否则数据直取会打到不存在的旧标签页）。页面 URL 用于区分同一站点下 product 推导相同、实际是不同视频的情况。
- 任务页新增“播放加速”（1/2/4/8x）：在原网页把 `video.playbackRate` 调高并静音，让播放器提前请求后续分片。选择保存在 `state.captureSpeed`，恢复任务和每次智能补全 seek 之后都会重新施加（播放器常在 seek 后重置速率）。站点限制速率时会如实报出实际值。这是比原来 `auto-seek-right.ahk` 盲按方向键更稳的加速方式，缺口仍由智能补全兜底。
- `parseDashManifest` 现在收集 MPD 里的字幕：整文件型（BaseURL 指向 .vtt 等）进 `manifest.subtitles` 并合入 `candidate.subtitles`，复用既有字幕保存路径；分片式文本轨（stpp/wvtt）需要额外提取器，明确跳过并记日志，不做猜测。文本 AdaptationSet 不再有机会进入可下载媒体轨列表。

### 失败重试与暂停语义

- 保存失败的分片以前只把 `state.failed` 加一就丢掉，文案却写着“再次播放到这里时会重试”，承诺大于实现。现在失败的分片会进 `pendingCaptureSegments`，在播放列表/清单刷新、下一次成功保存或任务恢复时自动重试，每个 URL 最多 3 次（`MAX_CAPTURE_RETRIES`），超出后改提示可用智能补全，不再无限重试。成功保存会清掉该 URL 的计数。
- 暂停不再被记成失败。暂停会中止在途请求，抛出的是“下载已暂停”，以前会走进同一个 catch，导致每次暂停都 `failed+1` 并弹一条像出错的提示。现在这种情况只把该分片放回待重试队列，不计数也不报错。
- HLS 和 DASH 两条 capture 路径在恢复时都会重放待重试队列。

### 直播与滚动窗口

- 直播不再自作主张合成：HLS `isLive` 和 DASH `type="dynamic"` 时不触发自动生成，改为持续保存并提示用户自己点「检查并生成视频」。此前直播的 `done >= total` 会在播放中途就把任务标成完成。
- 动态 MPD 刷新改为累积合并（`mergeDashCaptureTracks`）：新窗口的分片追加到已知列表尾部，已保存分片的位置序号保持不变。此前刷新会重排位置，导致 `dash:<track>:<index>` 记录错位、文件互相覆盖。

### DASH 辅助抓取

- 网页辅助保存不再只支持 HLS。候选只有 MPD 时走 `runDashCapture`；HLS 路径在还没保存任何内容、又定位不到分片时会尝试 `switchCaptureToDash`，因此把 DASH 站点误判成 HLS 也能自动纠正。
- `media-engine.js` 新增 `dashCaptureIndex`：把 MPD 里**所有** Representation 的分片和初始化段建成 URL 索引（全 URL 优先，无歧义 pathname 兜底），因此不需要预先猜播放器会用哪一档。
- 播放器第一次请求到的视频轨和音频轨会被锁定为本任务轨道，轨道 id 存进 `state.dashTrackIds`，重开任务仍是同两条轨道；之后播放器切档只提示，不混轨。
- 落盘、断点、合并复用既有 DASH 直接下载实现（`saveDashSegment` / `reconcileDashSaved` / `mergeDashOutput`），Capture 与直接下载共用同一套 `dash/<contentType_trackId>/` 目录和账本记录。
- 缺片时间轴按锁定的视频轨计算，所以智能补全对 DASH 同样可用；动态 MPD 按 8 秒节流刷新。
- `saveDashSegment` / `saveDashInitialization` 与 HLS 一样支持原网页会话回落和浏览器缓存优先（统一为 `fetchMediaBytes`）。
- background 的无扩展名分片识别不再只看 HLS 上下文：manifest 请求同样标记该标签页，候选的 `manifestUrl(s)` 也算作流媒体上下文，manifest 事件也会进入 30 分钟请求队列。
- 顺带修正：辅助抓取任务点「检查并生成视频」以前会调用 `runDirect()` 触发一次完整直接下载，现在直接合并已抓到的内容。`reconcileSaved` 也能按 `dash` / `hls-cmaf` 记录找到对应轨道目录，重开任务不再先显示 0。
- 自动化测试 41 项通过，新增 DASH 索引与滚动窗口累积测试、MPD 字幕解析测试、页面直取拦截器行为测试（播放器仍能读到自己的响应、播放列表不缓冲、取走一次即释放、stop 后还原）。真实站点验收仍未做。

## 0.3.8 Capture 清晰度跟随与会话内重试（2026-08-04）

- 修正 0.3.7 引入的匹配收紧：`candidateId` 现在只作为命中条件，不再作为否决条件。之前分片 URL 带清晰度（候选 id 为 `tab:product:720x404`）而任务候选是 `tab:product:auto` 时，全部分片事件会被静默丢弃。
- Capture 在还没有保存任何分片之前，会按观察到的分片 URL 反查真正在播的清晰度列表（含 master 里的 variants 和音轨），命中后固定使用该列表。保存第一个分片后播放列表锁定，播放器再切清晰度只提示不切换，避免把两种分辨率混进同一个成品。
- 分片定位逻辑移入 `media-engine.js` 的 `segmentLookup`：先全 URL 精确匹配，再无歧义 pathname，最后才允许按序号兜底，且序号兜底要求 URL 与播放列表在同一目录。此前不同清晰度的同序号分片会被写成同一片。
- 暂时对不上播放列表的分片不再丢弃，会进入待处理队列（上限 300），在播放列表刷新或成功保存后重放。播放列表刷新做了 4 秒节流，滚动直播列表不会每次请求都全量重读。
- 任务页请求失败（一次性 URL、Referer/Origin、连接绑定）时，改用 `chrome.scripting` 在原视频页会话内 fetch 该分片并回传字节；页面已关闭或同样失败时保持原有报错。Capture 的分片请求同时改为 `cache: "force-cache"`，可直接复用播放器刚产生的浏览器缓存。
- 自动化测试 34 项通过，新增分片定位（query-only URL、跨清晰度拒绝、带 token 的同名 URL）与 Capture 契约测试。真实目标站点验收仍未做。

## 0.3.7 Capture 可靠性补强与真实边界（2026-08-04）

- 当前 Capture 的准确定位是“普通单轨 VOD HLS 可试用的纯扩展 MVP”，不是适用于任意媒体协议的通用响应截获器。直接文件和 DASH 仍应优先使用直接下载；DASH Capture、复杂独立音轨、直播滚动窗口、严格一次性 URL 尚未完成。
- background 现在把最近 30 分钟、最多 600 条 playlist/segment 请求元数据保存在 `wkMediaEvents`。Capture 任务页重新打开时会恢复这些 URL、headers 和时间信息，并跳过账本中已经保存的分片，减少任务页短暂关闭造成的遗漏。
- 队列只保存请求元数据，不保存浏览器已经收到的响应体。Capture 仍是在看到播放器请求后由任务页重新请求一次；一次性 URL、强 Referer/Origin、连接绑定或播放器私有会话仍可能失败。因此任务页保持开启仍是最可靠的使用方式。
- response Content-Type 现在可以识别没有 `.m3u8` 后缀的 HLS playlist，以及近期 HLS 页面中的无扩展名 MP2T/ISO segment/AAC 和常见 XHR fMP4/octet-stream 分片。完整媒体仍保留独立 direct-file 候选。
- playlist 分片映射先按完整 URL（含 query）精确匹配，只有 URL 不一致时才退回无歧义 pathname/sequence，避免多个 `/chunk?id=...` 被错误映射成同一分片。
- Capture 继续采用单队列、无 burst-ahead；暂停会中止活动请求，缺片可由用户确认的智能 seek 补全，完整后复用视频轨校验、MP4 时长修正和浏览器 Downloads/自定义目录交付。
- 新增无扩展名 HLS 分片入队行为测试；当前自动化测试 32 项通过。真实 Edge 播放 → 关闭任务页 → 继续播放 → 重开恢复仍需用户目标站点验收。

## 0.3.6 成品元数据、命名与速度（2026-08-03）

- 修复 mux.js 初始化段把 `mvhd/tkhd/mdhd` 时长留成 `0xFFFFFFFF` 的问题。部分 Windows 属性页会把这个“未知时长”按 90 kHz 时间基显示成 `13:15:21`，即使播放器能按分片时间戳正确显示约一小时。现在 TS 转 MP4、HLS fMP4 和 DASH/CMAF 都使用 playlist/manifest 的实际时长回填初始化元数据。
- 成品文件名不再优先使用从 URL 推导的内部 `product` ID；依次采用响应文件名、网页抓取标题，最后才回退到内部标识。`auto` 不再附加到正常标题，明确清晰度仍作为必要后缀。
- 下载任务页新增持续可见的下载速度卡片，直接文件和 HLS/DASH/Capture 在保存过程中按已有 `speedMbps` 采样显示。
- “浏览器 Downloads（推荐）”和“自选文件夹”继续同时保留。自选文件夹仍在设置页选择并按任务保存，不会因为默认 Downloads 交付而移除。
- 自动化测试增加 MP4 未知时长回填验证，当前共 31 项。

## 0.3.5 浏览器 Downloads 交付（2026-08-03）

- 纠正 0.3.4 对 Downloads 根目录的判断：受限的是 File System Access 目录授权，不是扩展保存文件。默认成品现在与 Video DownloadHelper 的交付方式一致，先在扩展私有 OPFS 中完成断点、合成和视频轨校验，再调用 `chrome.downloads.download` 保存到浏览器 Downloads。
- 设置新增“浏览器 Downloads（推荐）/自选文件夹”。推荐模式不再弹目录选择器；自选文件夹继续使用 File System Access，所以选 Downloads 根目录仍可能被 Chromium 拒绝，这是高级自选模式的浏览器限制。
- 成品保存成功后记录浏览器下载 ID；任务页“在文件夹中显示”调用浏览器下载记录定位文件，“删除生成的视频”会删除对应磁盘文件。移除任务仍不删除成品，清理临时内容仍不删除成品。
- 字幕若被明确识别，会在主视频之后同样交给浏览器 Downloads；字幕下载不会覆盖主视频的下载 ID。Capture 路径、缺片账本和自选文件夹路径全部保留。
- 0.3.5 仍是纯扩展发布，不包含 Helper 或 Python 服务。真实目标站点需重新加载扩展并重新播放产生新候选后验证。

## 0.3.4 直接下载纠错（2026-08-03）

- 保留两条用户可选路径：`直接下载（推荐）` 与 `浏览器辅助抓取（Capture）`。本次没有删除、弱化或自动替换 Capture；直接下载失败时仍只建议切换，等待用户确认。
- 参考本机 Video DownloadHelper 10.5.24.2 的通用策略重新检查直接下载：它会保留完整 HTTP 媒体、HLS、DASH 等不同候选，普通完整文件可直接交给浏览器下载；流媒体则由浏览器内 LibAV/WASM 正确封装，而不是简单拼接并改扩展名。
- 已修复同一作品的后续音频 `.m3u8` 覆盖主播放列表的问题。background 现在保存 `playlistUrls`/`manifestUrls`/`directFiles`，完整媒体按视频 MIME、文件名、大小和请求类型选择，不再让纯音频响应覆盖完整视频。
- `media` 类型响应即使是 `application/octet-stream` 或 URL 无扩展名，也会作为完整文件候选；优先使用响应中的 `Content-Disposition` 文件名。
- MPEG-TS 直接下载完成后使用内置 mux.js 转封装为 MP4。输出必须通过视频轨检查；只有音频轨、网页/JSON 错误响应、未知损坏格式都不能标记完成，也不能触发自动清理。
- 自动生成和自动清理为设置项；只有输出验证成功后才删除本任务临时切片。旧版未验证的成品会在重新打开时复查，失败时保留旧文件和切片并提示重新播放后继续。
- 字幕只接受已知字幕扩展名或明确字幕 MIME；移除了仅凭 URL 包含 `caption`、`cue` 等关键词造成的误报，并清理已有误报记录。
- 直接下载并发数可选 2/4/6，默认 4；暂停会中止全部并发请求。下载页增加“打开生成的视频”。
- Helper 仍暂停开发和发布；0.3.4 发布包仍为纯扩展，不需要 Python 服务。
- 自动化验证为 30 项，通过后再打包 `dist/Web-Keeper-0.3.4.zip`。目标网站仍需要用户重新加载扩展、重新播放以产生新候选后实测。

> 写给后续接手的人或 AI。目标是理清现状、痛点、目标架构与改造边界，避免继续在混乱结构上堆功能。  
> 创建时间：2026-07-19  
> 当前包名仍是 `hls_keeper` / 目录 `hls-keeper`，用户可见名是 **Web Keeper**。
> 最新执行方案见 `docs/REFACTOR-PLAN.md`；与本文旧建议冲突时，以重构计划为准。

## 最新实施进度（2026-07-23）

第一阶段基础重构已经开始并落地：

- 新增 `hls_keeper/works.py`：稳定的 Work / Variant 标识、分片身份、缺片区间和推荐动作。
- 新增 `hls_keeper/ledger.py`：SQLite 下载账本，记录作品、清晰度、字幕、分片和下载会话；服务或电脑重启后仍可识别待续传片段。
- 浏览器辅助抓取与直接下载已经接入账本；直接下载会跳过已有完整分片，失败分片标为可重试，不会因部分失败误报“全部完成”；服务重启后会自动恢复未完成的直接下载。
- 新增只读 `GET /api/works`、`GET /api/works/{id}`，以及用户主动触发的单目录索引 `POST /api/works/reindex`；没有全量扫描、迁移、删除或重新下载旧数据。
- 扩展 popup 已改为“监听只发现”：发现视频后由用户选择「直接下载（推荐）」「浏览器辅助抓取」或「本次忽略」；选择前不会落盘下载。扩展图标使用 `!` 角标提示新发现。
- 同一作品的多个清晰度和字幕会聚合到一个 Work；默认只选择一个清晰度。
- Local Helper / Native Messaging 已有一份实验性 Windows 原型代码，但**未安装、未修改注册表，当前停止继续实现**。最新决策是先完成纯扩展下载运行时；该原型不得成为 popup 或核心流程的前置条件。

### 纯扩展可试用版（2026-08-03）

- 扩展 manifest 已移除 `nativeMessaging` 必需权限；popup 和 background 不再加载或自动启动 Helper。
- background 将检测到的视频、清晰度、播放列表、最近 headers 和字幕保存在扩展本地存储；popup 离线也能显示候选并由用户选择。
- 新增独立下载任务页：用户主动选择保存目录后才写盘；直接下载按分片保存并断点跳过已有文件。
- 针对当前站点样本实现普通 AES-128 HLS 浏览器内解密，MPEG-TS 完成后连接为可播放 `.ts`；分片式 MP4 支持 init segment + media fragment 连接。
- 浏览器辅助抓取默认只跟随播放器实际请求，单队列处理，不再进行 burst-ahead。任务页保持开启最可靠；0.3.7 起短暂关闭期间会暂存请求元数据并在重开后尝试重新获取，但不会缓存浏览器响应体。
- 任务页提供继续、暂停、保存字幕、检查并生成视频，以及“只删除本任务分片”的入口；不扫描或修改现有 `data/captures`。
- `scripts/start_edge.ps1` 现在直接打开扩展任务页，不再把本地 Dashboard 当启动前置条件。

当前限制：Capture 主要覆盖普通 HLS，并非 DASH/任意响应的通用抓取器；它会重新请求播放器观察到的分片，而不是读取浏览器缓存。DRM、一次性 URL、特殊鉴权、非 CMAF/直播型 HLS 独立音轨和部分非标准清单可能失败。纯扩展真实站点验证优先于继续 Helper。

### 产品化要求补充（2026-08-03）

用户明确要求不要为了尽快可运行而仓促定型。`0.2.0` 是验证技术路线的开发预览，后续必须满足：

- 前端通俗易懂，普通流程不出现 Candidate、Job、segment、playlist、Helper、Server URL、端口等工程术语。
- 用户只安装并打开 Web Keeper，不手动启动 Python、PowerShell、HTTP 服务或其他零散组件。
- 若未来引入本地后端/Helper，必须由正式安装包全集成并由扩展自动管理，不能重新制造“服务未启动”的日常状态。
- 大多数普通无 DRM 网站优先直接下载；Capture/持续播放只作为播放器会话不可替代时的用户可选兜底。
- 通用能力按直链、HLS、DASH/CMAF、音视频分轨、字幕、短期 URL 刷新逐步覆盖；站点适配器只补通用层缺口。
- 建立正式 i18n：中文完整可用，英文保留，新增界面禁止继续散落硬编码文案。

后续实现顺序应先做状态词典、信息架构、i18n 骨架和下载引擎接口，再扩展格式/站点覆盖，最后做发布安装闭环。不要继续在当前单页原型上直接堆按钮。

### 纯扩展产品进度（0.3.3，2026-08-03）

- 已形成三个普通用户入口：popup（当前页面）、下载中心/详情（任务进度与操作）、设置（语言与偏好）。
- 新增 `_locales/zh_CN`、`_locales/en` 和公共 `i18n.js`；manifest、popup、下载中心主要状态与设置页均从消息资源读取。
- 支持跟随浏览器、简体中文和 English 手动选择；中文为默认语言。
- 下载诊断日志默认隐藏，只有用户在高级设置中启用或任务出错时显示。
- popup 中的默认推荐方式与“最高/上次清晰度”设置已接入实际选择逻辑。
- 普通界面已把“分片删除”改成“清理临时下载文件”，确认文案明确不影响成品和已有 captures。
- i18n key 中英文一致性、所有 UI 引用 key 完整性已有自动测试；项目测试现为 28 项通过。
- 媒体 provider 注册层统一选择直链、HLS、DASH 和网页辅助模式。
- 普通 MP4/WebM/音频文件已支持流式写盘和 HTTP Range 断点续传；扩展名缺失时会结合响应 Content-Type 选择文件类型。
- HLS 已补隐式 byterange、GAP、时间轴、字幕轨和滚动列表保守刷新；服务器忽略 Range 时会停止，避免静默生成损坏文件。
- 静态 CMAF HLS 已支持 `EXT-X-MEDIA` 独立音轨断点下载和浏览器内合并；加密初始化段只在有显式 IV 时处理，否则停止以避免损坏文件。非 CMAF 或直播型独立音轨会建议用户确认网页辅助。
- DASH 已支持常见 BaseURL、SegmentTemplate、SegmentTimeline、固定时长模板、音视频分轨断点下载与浏览器内 CMAF 合并；公开 DASH-IF 样例实测输出含 H.264 + AAC 两轨且时长正确。
- 下载卡住会分类为授权、URL 过期、限流、Range、DRM 或网络错误；只提示用户确认切换网页辅助，不自动切换。
- 下载中心以作品聚合清晰度、字幕和任务；默认单清晰度，用户明确勾选后才创建多清晰度任务。字幕默认保存到视频旁边。
- 缺片显示大概时间范围，并提供稳定优先的智能补全：播放器未就绪则减速，连续无进展则停止。
- 默认保存目录可复用；移除任务、清理临时内容、删除成品是三个独立操作。
- 下载中心和任务详情均有「从列表移除」入口；只移除任务记录，不删除成品、部分下载或断点数据。

`0.3.1` 修复 popup 长文案横向撑破布局、内部页面打开不可靠、未开始任务误显示“等待数据”和速度恒为零的问题。`0.3.2` 增加目录子文件夹引导。`0.3.3` 将扩展改为 InPrivate 独立运行，入口优先使用继承当前窗口的原生链接，并让“本次忽略”真正隐藏当前作品 30 分钟；popup 状态会显示实际版本号。发布资产为 `dist/Web-Keeper-0.3.3.zip`，不包含实验 Helper。尚未替用户执行公开 GitHub Release；真实目标站点仍需用户侧验收，特殊鉴权、非标准 MPD/HLS、跨 Period DASH、直播型 HLS 独立音轨和复杂转码可能需要后续适配。

验证：Python、扩展契约和 Node 媒体引擎共 28 项自动测试通过，覆盖重启持久化与自动恢复、直接下载、失败分片续传、用户选择后才抓取、内部页面打开、旧目录只读索引、多清晰度聚合、HLS/DASH 解析和 CMAF 轨道合并。扩展 JS、manifest 与 locale JSON 静态检查通过；独立 Edge 配置中 popup、下载中心、设置页均无运行时错误。公开 DASH-IF 样例已生成 12 秒 H.264 + AAC 双轨 MP4，并通过 ffprobe 检查。

## 0. 当前决策：先把界面做明白（2026-07-23）

**这是当前最高优先级，也是下一阶段唯一主线。**

目前项目主要由作者本人在本机使用。上一轮检查发现的本地 API 鉴权/CORS、路径边界、SSRF、状态持久化并发、日志轮转、SQLite、启动器、Release 打包等问题，现阶段先记录，**暂不作为本轮开发内容，也不要因为这些问题阻塞界面改造**。除非某个底层问题已经直接导致界面无法工作或可能破坏现有下载数据，否则不要先展开安全加固或大规模后端重构。

当前最真实、最急迫的问题是：**界面太乱，概念混在一起，用户完全不知道现在是什么状态、下一步该点什么。**

当前主要站点的实际工作方式是：打开监听/Capture 后，发现视频请求就开始自动下载。重构后调整为：**陌生站点或新作品先在扩展 popup 中提示，用户选择下载方式或本次忽略；用户可记住本次选择，让该站点以后自动采用相同方式。**

下载方式也必须由用户选择：Popup 提供「直接下载（推荐）」和「浏览器辅助抓取」。直接下载受阻时可以建议切换，但必须等待用户确认，不能自动切换。

最新架构决策：**纯扩展优先，Helper 延后且可选。** 先用 offscreen/专用下载页、IndexedDB、File System Access/OPFS 和浏览器内 WASM 尽可能完成直接下载、浏览器辅助抓取、断点续传和常见 HLS 合并。只有目标站点实测证明失败来自浏览器 API 边界，而不是激进预抓、播放器卡顿、短期 URL、鉴权刷新或站点适配问题，才允许继续开发 Helper。

若最终需要 Helper，必须保留一个跨平台的**纯 Python 核心版本**，再分别适配 Windows、macOS、Debian 和鸿蒙。鸿蒙不预设存在 Chrome Native Messaging 或稳定 Python 环境，需先按实际设备和浏览器做能力验证。

### 本轮目标

让第一次打开 Dashboard 的人不看文档也能回答下面几个问题：

1. 本地服务和浏览器扩展是否已连接？当前是否正在捕获？
2. 发现了哪些作品？当前正在处理哪一个？
3. 每个作品是「刚发现」「正在下载」「仍有缺片」「可以合并」还是「已经生成视频」？
4. 此刻是否有任务在运行？进度、失败原因和结果文件在哪里？
5. 用户现在最应该执行的一个操作是什么？

### 界面原则

- 默认界面只展示用户需要做决定的信息；URL、headers、分片编号、内部 job id、历史失败明细等放进「高级信息 / 调试详情」。
- 使用中文和人话，不直接展示 `missing`、`small`、`contig`、`inflight` 等内部字段名。
- 严格区分并解释：**发现候选 → 捕获/下载分片 → 检查完整度 → 合并 → 成品文件**。不要再把 Candidate、Stream、Job 和 Output 混成几张相似表格。
- 以「作品」作为主视图；同一作品的多分辨率、字幕、缺片情况和成品放在同一张卡片或详情页中。
- 每个作品只突出一个推荐主操作，例如「开始下载」「继续补全」「可以合并」「打开成品」。其余操作收进二级菜单。
- 点击 Merge、Retry、Download 后必须立即出现 loading/进度反馈；完成后明确显示文件名、完整路径和「打开文件夹」。
- 空状态和错误状态要告诉用户下一步怎么做，不能只显示 `offline`、`failed` 或空表格。
- 坚持「不自动清理」，但必须提供清楚、容易找到的手动清理入口，并明确区分：删除任务记录、移除作品记录、删除磁盘分片、删除合并成品。任何会删除磁盘文件的操作都要单独确认，不能藏在一个含义模糊的 `Delete` 后面。
- 可以先复用现有后端 API 完成信息架构和视觉重排；不要把拆分 `server.py` 或重做整个后端设成界面改造的前置条件。

### 建议的最小导航

1. **首页 / 作品**：连接与捕获状态、最近作品、每个作品的当前阶段和推荐操作。
2. **任务**：只看正在运行和最近完成的下载、补洞、合并任务。
3. **Archive**：保留 FANBOX 和通用批量下载，但与视频捕获流程分开。
4. **设置**：目录、ffmpeg、扩展连接等低频设置。
5. **调试信息**：候选 URL、分片列表、headers 捕获状态、内部计数和网络流水；默认不打扰普通操作。

### 本轮暂不做

- Local API token、CORS/Origin 收紧、SSRF 防护等安全加固。
- 对现有 `state.json` 和 captures 做一次性全量迁移；允许新增独立下载账本来支持断点续传。
- GitHub Release 成品发布；纯扩展核心流程完成前不做 Helper 安装包与 Native Messaging 系统集成。
- Confluence、Linear 或更多站点适配器。
- 自动清理现有 captures、日志或历史数据。

现有 `data/captures` 体积很大并包含仍可能有用的分片；未经用户明确确认，任何界面改造都不得自动删除、迁移或重新下载这些数据。

## 1. 项目一句话

本地浏览器辅助下载/归档工具：Chrome/Edge 扩展观察浏览器已能访问的请求 → 本地 Python 服务负责落盘、补抓、合并、Dashboard。

```text
extension/  →  http://127.0.0.1:17888  →  data/ / archives/ / outputs/
```

## 2. 现状结构

| 路径 | 作用 |
|------|------|
| `extension/` | MV3 扩展（popup + background service worker） |
| `hls_keeper/server.py` | 本地服务、Dashboard HTML/JS、HLS 捕获/下载/合并 API（体量很大，前后端混在一个文件） |
| `hls_keeper/archive.py` | Archive 适配器（FANBOX + 通用压缩包批量） |
| `scripts/start_server.ps1` | 启动本地服务 |
| `scripts/start_edge.ps1` | 用临时 Edge profile 加载扩展 |
| `data/` | `state.json`、captures、events/requests 日志 |
| `archives/` | Archive 输出 |
| `outputs/` | HLS 合并后的 MP4 |

### 已有能力（可用但不完整）

- HLS Discover / Capture：观察 `.m3u8` / `.ts` / key / 字幕请求
- Capture 模式会本地再下载分片（含 backfill / burst-ahead），不是单纯旁路存浏览器缓存
- Dashboard：候选、流列表、Jobs、Direct download、Retry missing、Merge（strict/skip/fill-skip）
- 字幕下载/转换（含部分短字幕告警）
- Archive：FANBOX ZIP、通用页面扫描压缩包链接 / 粘贴 URL 批量下载
- 最近修过：`/api/status` 过重导致扩展 offline；`state.json` 过大；保存防抖与失败映射裁剪

### 明确没有 / 很弱

- 扩展启动时自动拉起后端（现在必须手动 `start_server.ps1`）
- 统一的「作品」视图（同视频多分辨率/字幕散落）
- 缺片 ↔ 时间轴定位
- Dashboard 内实时「网络/下载流水」视图（现在只能靠浏览器 DevTools Network 看 `.ts`）
- 中文 i18n
- Confluence / Linear 批量下载
- 面向普通用户的 GitHub Release 安装包
- 通用「视频/链接/压缩包/图片」统一批量下载产品体验（现有 generic archive 偏压缩包）

## 3. 用户痛点（本次会话结论）

1. **前后端混乱**：Dashboard 内嵌在 `server.py`；扩展 popup 与 Dashboard 职责重叠；Capture「已在存分片」和「下载任务/成品 MP4」概念不清。
2. **启动体验差**：后端要单独开；扩展 offline 时用户以为全挂了；只想尽量「开扩展就能用」，最好后端随扩展自启。
3. **数据组织差**：同一视频的不同分辨率、字幕不在同一作品维度下，难管理。
4. **补洞难**：缺片只有编号，没有对应时间轴；用户不知道该拖到视频哪里重播。
5. **下载不可见**：想知道「此刻正在下哪些分片/文件、成功还是失败、多大多久」，现在只能开浏览器开发者工具 Network；Dashboard 缺少类似面板。
6. **状态数字看不懂 / 还误导**：Library 一行里的 `missing`、`small`、`contig`、`0 MB` 用户完全看不懂；而且轻量 `/api/status` 后，`missing` 实际常是「历史失败条数」不是磁盘真缺片，`small` 是历史 bad_small 计数，和「能不能 Merge」脱节。浏览器 Network 红色 `0 B` 也常被误当成本地缺文件（其实多半是快进取消请求）。
7. **Merge 体验极差（用户实测）**：点 `Merge strict` 后按钮像没反应；无进度条；请求同步阻塞数分钟才返回，用户看不到「返回在哪」；合完也不知道文件在哪个目录、叫什么名字；Jobs 列表往往也不出现 merge 任务。实际文件在 `outputs/`，但 UI 几乎不引导。
8. **不能自定义目录**：捕获分片默认死在项目下 `data/captures`，合并在 `outputs/`、Archive 在 `archives/`；用户需要能自定义下载/捕获目录（大磁盘、外置盘、按作品分盘等），并在 UI 里能看到当前路径、可改、可打开。
9. **产品化不足**：缺安装包/Release、中文界面、更多站点适配。

## 4. 目标产品形态（建议）

### 4.1 启动模型（优先）

目标：**默认只安装和操作浏览器扩展**，核心下载流程不要求本地后端。

当前主方案：

1. service worker 负责发现、popup 状态和任务编排。
2. offscreen 文档或专用下载页承载长时间下载，避免把长任务寄托在会被回收的 service worker。
3. IndexedDB 保存断点账本，File System Access 直接写用户授权目录，OPFS 只作必要的临时缓冲。
4. 常见 HLS 在浏览器内通过 WASM 合并；复杂转码明确标记为可选增强能力。
5. 浏览器辅助抓取默认保守跟随播放器，先关闭激进 burst-ahead，用状态码、响应大小和播放器状态判断真实失败原因。

可选 Helper 只有通过 `REFACTOR-PLAN.md` 的能力闸门后才继续：纯 Python 核心优先，Windows、macOS、Debian 分平台适配；鸿蒙先验证浏览器扩展、Native Messaging 等价能力和 Python 环境。

约束：

- 浏览器和下载任务页可能需要保持开启，界面必须明确提示。
- 不把现有 113GB captures 自动搬进浏览器存储；旧数据只读索引策略保持不变。
- **用户追问（2026-08-04）**：希望纯扩展也能继续老的 `data/captures` 下载。已实现下载中心「导入旧捕获目录」（见 §4.2.4）：显式选目录 → 解密导入任务空间 → 可生成视频；缺片时可改用网页辅助继续（智能补全/播放加速/字幕与新任务共用）。
- File System Access 目录授权可能失效，任务必须能停在“等待重新授权”而不是丢失进度。
- 纯扩展无法处理 DRM、部分特殊鉴权或复杂转码时，要给出可诊断原因，不能直接归因于“需要 Helper”。

### 4.2 信息架构

用 **Work（作品）** 聚合，而不是扁平 `product/resolution` 列表：

```text
Work: ofje00435
  ├─ variants: 1280x720, 720x404, 480x270
  ├─ subtitles: zh / und / ...
  ├─ completeness: 按主分辨率统计
  ├─ missing timeline: [{start, end, seg_from, seg_to}]
  └─ outputs: merged mp4 / exported subs
```

UI 分层建议：

- **扩展 popup**：连接状态、一键启停捕获、当前页作品摘要、打开 App/Dashboard
- **主界面（重做）**：作品库 / 任务队列 / 补洞时间轴 / **网络流水（类 DevTools Network）** / Archive 批次 / 设置  
  （可继续本地 Web UI，但应从 `server.py` 拆出前端工程或至少独立静态目录）

作品/流列表指标必须用人话（禁止只丢裸字段）：

| 现在（难懂） | 应改成 |
|--------------|--------|
| `missing 80`（其实可能是 failures 条数） | **磁盘缺片 N**；另列「最近下载失败 N」（可折叠） |
| `small 180` | **过小响应历史 N**，并说明「不代表当前文件坏了」；或对当前文件做「可疑过小」单独计数 |
| `contig 0` | **从 0 连续到 xxx** / 「不连续，首个缺口在 …」 |
| `0 MB`（轻量 status 没算） | 真实占用或「计算中…」；不要显示假 0 |
| 浏览器 Network 红字 0 B | 文档/UI 提示：快进取消 ≠ 本地没存上 |

Merge 按钮旁应直接给建议：`可 strict` / `建议先补洞` / `仅可 skip`，不要让用户猜。

### 4.2.1 完成/缺片状态提示（用户明确要求）

需要主动提示，而不是只靠表格数字：

1. **全部分片已齐**（按主清晰度：磁盘连续或 `disk_missing==0` 且文件数达标）  
   - 横幅/Toast/作品徽章：`已就绪，可以 Merge`  
   - 可选：扩展 popup 同步显示「可合并」
2. **看起来播完/下得差不多，但仍有缺片**  
   - 提示：`仍有 N 处缺失（约 HH:MM:SS–…）`，引导 Retry 或按时间轴补洞  
   - 触发条件示例：最近一段时间无新分片写入 + 播放进度接近结尾 / last_segment 接近末尾 + `disk_missing>0`
3. **多作品总览**  
   - 「11 个作品中 8 个可合并，3 个仍有缺片」一类汇总，避免用户盯单行猜

实现注意：提示必须以 **磁盘真实缺片** 为准，不能用现在的 `failures` 冒充 missing，否则会「明明齐了还报警」或反过来。

### 4.2.2 Merge / 导出交互（用户明确吐槽）

当前问题：

- 点击 Merge **无 loading / 无禁用 / 无即时反馈**，体感「点了没反应」
- `/api/merge` **同步执行 ffmpeg**，大文件可卡数分钟；前端若只等 JSON，用户不知道在干活
- 成功后结果埋在 Activity log 或瞬时 toast（易错过），**不展示输出路径、不提供打开文件夹**
- Merge **不进 Jobs 进度模型**，和 Direct download 体验不一致

目标体验：

1. 点击后立即：按钮 loading + 「正在合并…」  
2. Merge 改为 **后台 Job**（或至少 SSE/轮询进度：已处理分片/百分比/ETA）  
3. 完成后醒目结果卡：文件名、大小、路径、`打开文件夹` / `播放`  
4. 失败时展示 ffmpeg 错误摘要，可重试  
5. 重复点击防抖（避免像本次一样生成两份几乎相同的 13GB+ 文件）

### 4.2.4 纯扩展兼容旧 `data/captures`（已实现）

下载中心提供「导入旧捕获目录」：

1. 用户用 File System Access 选择 `data/captures`、作品夹或清晰度夹（显式授权，不静默扫盘）  
2. 读取 `first.m3u8` / `file.key` / `*.ts`（及可选 `subtitles/`）  
3. 解密并规范化写入扩展任务空间（`source=legacy-import`），建立缺片时间轴  
4. 齐了可直接「检查并生成视频」；有缺口可「改用网页辅助」→ 智能补全 / 播放加速继续  
5. 字幕：导入本地字幕文件；也可在绑定原网页后走扩展字幕保存  
6. **不**自动迁移/删除旧树；重复导入同一作品清晰度会打开已有任务

与新能力兼容：缺片时间轴、完成提示、播放加速、智能补全、字幕保存均挂在同一任务模型上（补洞需回到原网页并切换网页辅助）。

### 4.2.3 自定义下载 / 捕获目录（用户明确要求）

现状：主要靠启动参数 `--data-dir` / `--output-dir` / `--archive-dir`，扩展和 Dashboard 几乎不能改，普通用户也不知道。

目标：

- 设置页可配置并持久化：
  - **捕获目录**（HLS 分片，现 `data/captures`）
  - **合并输出目录**（现 `outputs`）
  - **Archive 下载目录**（现 `archives`）
- 支持选盘符/任意路径；校验可写空间；显示当前路径 +「打开文件夹」
- 修改目录后的策略写清：仅影响新任务 / 是否迁移旧数据（默认不自动搬，避免误伤）
- 扩展侧若展示路径，与本地服务配置保持一致

### 4.3 补洞时间轴

对每个 variant：

- 从 playlist `#EXTINF` 累加时长，建立 `segment_index → [t0, t1)`
- 缺片列表转换为用户可读区间：`缺失 01:23:10 – 01:24:02（v_006964–v_006989）`
- Dashboard/扩展提供「复制时间点 / 打开说明」；有 playlist 时优先精确，没有则按平均时长估算并标注「估算」

**补洞加速（已验证的用户技巧，0.4.1–0.4.2 已产品化）**：部分站点播放器「方向右键 ≈ 快进 10s」。每秒按一次可迫使播放器持续请求后续分片，Capture 落盘明显更快。现在这条已经做进任务页的「播放加速」：优先用播放器倍速，站点限速时回退为定时快进，频率和步长可调，默认就是每 1 秒跳 10 秒。下面两个脚本因此只作为历史参考保留。  

- 临时脚本已放：`scripts/auto-seek-right.ahk`、`scripts/auto-seek-userscript.js`（F8 开关）  
- 产品化方向：扩展「补洞模式」按 missing timeline 精确 seek，而不是盲目 +10s

### 4.4 Archive 统一任务模型

所有批量下载（通用链接、FANBOX、Confluence、Linear、图片等）共用：

- Job：进度、重试、输出目录、manifest
- Adapter 接口：`discover()` / `download_item()` / `normalize_filename()`
- 浏览器自动捕获的 headers/cookies 按 site profile 复用

### 4.5 Dashboard「网络流水」面板（类 DevTools Network）

用户期望：不必打开浏览器 F12，在 Dashboard 里就能看到正在下载/刚下载的资源，体验接近 Chrome Network。

建议能力：

| 列/能力 | 说明 |
|---------|------|
| Name | 文件名或 URL 末段（如 `v_000046.ts`） |
| Status | HTTP/业务状态：`200` / `failed` / `skipped` / `queued` |
| Type | `ts` / `m3u8` / `key` / `subtitle` / `archive` / 其他 |
| Work | 所属作品 + 分辨率（若可解析） |
| Size | 字节数（如 `1.3 MB`） |
| Time | 耗时 |
| Source | `browser-seen`（扩展观察到）/ `local-fetch`（后端补抓/Direct download） |
| 筛选 | All / Media(.ts) / Playlist / Subtitle / Archive；按作品过滤；全文过滤 |
| 实时 | 尾部追加；可选暂停滚动；保留最近 N 条（内存环形缓冲，勿塞进 `state.json`） |

数据来源建议（二选一或组合）：

1. **后端下载事件流（优先）**：`download_one` / archive 保存成功失败时写入 ring buffer + `GET /api/network/events` 或 SSE/`websocket` 推送。现有 `events.jsonl` 可参考，但 UI 需要轻量、可筛选的实时 API，不要每次读整份日志。
2. **扩展旁路镜像（可选）**：扩展把观察到的媒体请求摘要 post 到本地（注意脱敏，默认不存完整 Cookie）。用于区分「浏览器在播」vs「本地在补」。

注意：

- 这是**可观测性面板**，不是再实现一套 Chrome DevTools。
- 高频 `.ts` 时必须限流/聚合（如同名合并计数），避免 UI 卡死。
- 与 Jobs 进度条互补：Jobs 看任务总进度，Network 看「此刻下了哪几个文件」。

## 5. 已知技术坑（改设计时务必看）

- Capture 会对每个看到的 ts **预抓 burst-ahead（默认很大）**，多标签并发时失败数会暴涨、磁盘与状态膨胀。
- `state.json` 曾涨到十余 MB；已对 failures 做裁剪 + 保存防抖，但数据模型仍偏「巨型可变 JSON」。
- `/api/status` 不能再同步扫全部分片目录；完整扫描应走独立 API，并缓存。
- Direct download **不会**自动出 MP4；MP4 只在 Merge 后出现在 `outputs/`。产品文案必须讲清。
- 扩展 popup 每秒轮询 `/api/status`；后端一卡，UI 就显示 offline。
- 多分辨率并存时，低清分片也会占大量空间；作品视图应能「主清晰度优先 / 清理旁路分辨率」。
- `list_streams_light()` 为保活把 `missing_count` 映射成 `len(failures)`，会让 UI 在分片已齐时仍显示 missing>0——**重设计时必须拆开字段**，不能再混用。
- 站点分片多为 AES-128；未解密时 ffprobe/看文件头会误判「坏文件」。校验应走「有 key 则解密再探针」，或信任合并链路。

## 6. 建议改造顺序

1. **拆分与信息架构**：Work 模型 + UI 重设计草图 + 把 Dashboard 移出 `server.py`
2. **纯扩展运行时**：offscreen/download page + IndexedDB + File System Access/OPFS + WASM 合并
3. **补洞时间轴**：缺片 → 时间范围；Retry 与引导重播打通
4. **网络流水面板**：类 DevTools Network，实时看到下了哪些分片/文件
5. **作品内合并展示**：分辨率/字幕/输出归并
6. **i18n（中文优先）**：扩展 + 主界面 + 关键错误文案
7. **通用批量下载** 产品化（视频直链/网页链接/压缩包/图片）
8. **FANBOX / Confluence / Linear** adapter 完善
9. **Release 打包**：先发布不依赖 Helper 的扩展；Helper 仅在能力闸门通过后单独发布

## 7. 验收标准（成品向）

- 新用户：只加载扩展即可发现视频、选择下载方式并开始核心下载流程
- 同一作品多码率/字幕在一个详情页管理
- 缺片能按时间轴定位
- Dashboard 能实时看到正在下载的分片/文件（无需开浏览器 Network）
- 普通用户能看懂作品状态：缺片/失败/体积/能否合并，不再出现「分片已齐仍显示 missing 80 / small 180」这类歧义
- 分片齐了有明确「可以 Merge」提示；仍有缺片时有明确「还缺哪些/去哪补」提示
- Merge：有点击反馈、有进度、完成后能看到路径并一键打开 `outputs/`，不会误以为没反应
- 可在设置里自定义捕获/输出/Archive 目录，并清楚知道文件落在哪
- 中文界面可用
- Release 资产可下载、可按文档跑通「捕获 → 补洞 → 合并」最小闭环
- Archive：至少 FANBOX 稳定；Confluence/Linear 有可用 MVP；通用批量下载覆盖常见链接类型

## 8. 相关文档

- `docs/REFACTOR-PLAN.md` — 当前重构执行计划（最新产品决策以此为准）
- `docs/TODO.md` — 待办清单（按优先级）
- `README.zh-CN.md` / `README.md` — 当前使用说明（可能落后于目标形态）
- `docs/subtitle-conversion.md` — 字幕转换

## 9. 给后续 AI 的工作约束

- 先改结构与体验，避免在 `server.py` 巨型文件里继续堆 HTML
- 不破坏「只下载浏览器已授权内容」的边界（不碰 DRM/破解）
- 纯扩展能力优先验证，不要继续编写或安装 Helper，除非计划中的能力闸门已经通过
- 若需要 Helper，核心优先纯 Python；平台适配顺序为 Windows、macOS、Debian，鸿蒙先做环境与浏览器能力验证
- 大数据路径（captures）不要每次 status 全量扫盘
- 用户未明确要求时，不要清空 `data/captures` 里的已下载分片
