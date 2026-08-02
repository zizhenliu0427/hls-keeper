# Web Keeper 待办清单

> 与 `docs/HANDOFF.md` 配套。勾选表示完成。  
> 当前重构的阶段、依赖关系和验收标准以 `docs/REFACTOR-PLAN.md` 为准。  
> 优先级：P0 体验阻断 / P1 核心产品 / P2 扩展能力 / P3 发布

## P0 — 体验与结构

### 当前产品化主线（2026-08-03）

- [x] 定义普通用户状态词典和三层界面：popup / 下载中心 / 设置；工程字段移入诊断抽屉
- [x] 建立 `_locales/zh_CN`、`_locales/en` 与公共 i18n 层；manifest 与主要用户流程已接入
- [x] 普通用户流程全部使用中英文消息资源；诊断日志允许保留技术字段
- [x] `download.html` 已形成作品聚合下载中心 + 单任务详情；后续若体积继续增长再物理拆页
- [x] 核心视频流程安装后不需要启动 Python、PowerShell、localhost 服务或 Helper；旧 Dashboard/Archive 保留为明确的可选路径

### 已完成的第一阶段切片（2026-07-23）

- [x] Work / Variant / Subtitle / Segment / DownloadSession SQLite 账本
- [x] 直接下载跳过已有分片、失败分片持久化为可续传、服务重启自动恢复
- [x] 浏览器辅助抓取写入同一账本
- [x] `GET /api/works` 作品聚合接口和按需旧目录索引
- [x] 扩展 popup 发现后确认：直接下载（推荐）/ 浏览器辅助抓取 / 本次忽略
- [x] 扩展图标新视频角标提示
- [x] 纯扩展下载运行时：专用 download page + IndexedDB + File System Access + 浏览器内常见 CMAF 合并
- [ ] Local Helper / Native Messaging（暂停；仅在纯扩展能力闸门通过后作为可选增强）
- [ ] 主界面作品库和任务页接入新 `/api/works`

- [ ] **1. 前端界面重设计**  
  - 扩展 popup：只保留连接、启停捕获、当前作品摘要、打开主界面  
  - 主界面：作品库 / 任务 / 补洞 / Archive / 设置，信息层级清晰  
  - 文案区分：捕获分片 ≠ 下载任务 ≠ 合并成品 MP4  
  - 将 Dashboard 从 `hls_keeper/server.py` 拆出（独立静态前端或至少 `hls_keeper/web/`）  
  - **状态列用人话重做**（用户明确反馈：`missing 80` / `small 180` / `contig` 等完全看不懂，且会误导）  
    - `磁盘缺片` ≠ `历史失败次数` ≠ `bad_small 历史`  
    - 显示真实体积，禁止轻量接口填假 `0 MB`  
    - Merge 旁给出建议（可 strict / 先补洞 / 仅 skip）  
    - 提示：浏览器 Network 红色 0 B 常为快进取消，不代表本地缺失

- [ ] **2. 纯扩展下载引擎（默认路径）**  
  - [x] Provider 注册层：直链 / HLS / DASH 与网页辅助路由
  - [x] service worker 只做发现和编排，长任务交给专用下载页  
  - [x] IndexedDB 记录任务、目录授权和分片断点；File System Access 直写用户目录  
  - [x] 普通 AES-128 HLS 解密、TS/常见 fMP4 连接和任务内安全删除入口  
  - [x] 浏览器辅助模式跟随实际请求，移除 Helper 前置与 burst-ahead  
  - [x] 任务页意外关闭后恢复为明确的暂停状态；直接写授权目录，不额外复制大文件到 OPFS  
  - 浏览器内完成常见 HLS remux/mux，复杂转码不作为 MVP 前置条件  
  - 在真实目标站点记录 401/403/404/429、响应大小、Token 变化和播放器状态，区分 API 边界与抓取策略问题  
  - 未安装 Helper 也能完成核心流程

- [ ] **2B. 可选跨平台 Helper（能力闸门后）**  
  - 当前停止继续编写和安装，现有 Windows 实验原型仅停放  
  - 只有纯扩展实测因浏览器 API 边界失败才启动  
  - 先做可用 `python -m ...` 启动的纯 Python 核心，再做平台注册/启动层  
  - Windows → macOS → Debian；鸿蒙先验证浏览器扩展、Native Messaging 等价机制和 Python 环境  
  - 独立可执行包可选，但必须保留纯 Python 发行方式

## P1 — 数据模型与补洞

- [x] **3. 同一视频多分辨率 / 字幕合并为「作品」视图**  
  - Work 聚合 `product` 下所有 resolution + subtitles + outputs  
  - 支持指定主清晰度；可选清理旁路分辨率占用  
  - 详情页统一展示，而不是散落多行

- [x] **4. 缺片时间轴**  
  - segment index → 时间范围（优先 playlist EXTINF，否则估算并标注）  
  - UI 展示：`缺失 01:23:10–01:24:02（v_006964–v_006989）`  
  - 方便用户拖动播放器到对应位置触发补抓 / 一键 Retry 该区间

- [x] **12. 完成 / 仍有缺片 主动提示**  
  - 全部分片下载完成：横幅/徽章/Toast「已就绪，可以 Merge」（扩展 popup 可同步）  
  - 看似下完但仍有 missing：提示仍缺 N 处 + 时间轴/Retry 引导  
  - 多作品汇总：「X 个可合并 / Y 个仍有缺片」  
  - **必须以磁盘真实缺片为准**，禁止用 failures/bad_small 历史计数触发误报  
  - 与 #1 状态列文案、#4 缺片时间轴一起做

- [ ] **13. Merge 交互重做（用户实测：点了像没反应）**  
  - 点击立即反馈：按钮 loading / 禁用防重复点  
  - Merge 改为后台 Job 或可轮询进度（百分比/ETA），不要同步卡死数分钟无提示  
  - 完成后醒目展示：输出文件名、大小、完整路径；提供「打开文件夹 / 播放」  
  - 默认输出目录说明写进 UI（现在是项目下 `outputs/`，但界面几乎不说）  
  - 失败展示 ffmpeg 错误；Jobs 列表纳入 merge 任务  
  - 与 #12「可以 Merge」提示、#1 前端重设计一起做

- [x] **14. 纯扩展默认保存目录**  
  - 设置里可改并持久化：捕获目录（分片）、合并输出目录、Archive 目录  
  - UI 显示当前完整路径 +「打开文件夹」；校验路径可写  
  - 不仅依赖命令行 `--data-dir` / `--output-dir` / `--archive-dir`  
  - 改目录默认不影响已下载数据（不自动迁移）；文档说明如何手动搬家  
  - 与 #13 输出路径展示、#1 设置页一起做

- [ ] **11. Dashboard 网络流水（类 DevTools Network）**  
  - 主界面增加 Network/下载流水面板，不用开浏览器 F12 也能看清「正在下哪些」  
  - 列：Name / Status / Type / Work+分辨率 / Size / Time / Source（browser-seen vs local-fetch）  
  - 筛选：Media(.ts) / Playlist / Subtitle / Archive；按作品；关键字  
  - 实时尾部追加（SSE 或轮询 ring buffer）；保留最近 N 条；高频时限流/聚合  
  - 后端：`download_one` / archive 成功失败写入事件流；**不要**把流水塞进巨型 `state.json`  
  - 与 Jobs 互补：Jobs=任务总进度，Network=单文件实时明细

## P1 — 国际化

- [x] **6. 中文 i18n**  
  - 扩展 popup、主界面、常见错误/状态中文化  
  - 预留 en 资源；默认跟随系统或设置项

## P2 — 下载能力

- [ ] **通用视频直接下载能力阶梯**  
  - [x] MP4/WebM/音频直链和 Range 断点续传（含无扩展名媒体响应识别；待真实站点扩大验证）  
  - [x] HLS master/media、TS/fMP4、byterange、AES-128、字幕与滚动列表基础覆盖  
  - [x] DASH/CMAF、SegmentTemplate/Timeline 与音视频分轨合并（常见单 Period 清流）  
  - [x] 静态 CMAF HLS 的 `EXT-X-MEDIA` 独立音轨下载与合并；不兼容形态明确回退  
  - [x] 从浏览器最新候选刷新短期 URL/headers，并提供可诊断的授权失效状态  
  - [ ] 通用解析器优先，站点适配器注册表兜底  
  - [x] 浏览器辅助/Capture 仅在用户确认后使用，不作为默认下载方式

- [ ] **7. 通用批量下载**  
  - 视频直链 / 普通链接 / 压缩包 / 图片  
  - 统一任务队列、文件名策略、manifest、失败重试  
  - 复用扩展捕获的 cookies/headers（按站点）

- [ ] **8. FANBOX 批量下载完善**  
  - 现有 ZIP 流程加固：分页、命名、校验、断点、错误可见性  
  - 作品/附件类型覆盖更完整；与作品库/任务列表体验对齐

- [ ] **9. Confluence 文档批量下载完善**  
  - 新 adapter：空间/页面树发现、附件与导出、鉴权（浏览器 headers）  
  - manifest + 输出目录规范 + Dashboard/任务入口

- [ ] **10. Linear 文档批量下载完善**  
  - 新 adapter：项目/Issue/文档或附件拉取（以实际可访问 API/页面为准）  
  - 鉴权复用浏览器会话；任务化与重试

## P3 — 发布

- [ ] **5. GitHub Release 成品**（本地发布包已完成，公开发布需用户确认）  
  - [x] 第一阶段打包不依赖 Helper 的扩展 zip + 简短安装说明（中/英）  
  - 可选 Helper 通过能力闸门后再单独发布纯 Python 包和各平台安装层  
  - 版本号、changelog、最小闭环验收（安装 → 捕获 → 补洞 → 合并）  
  - 挂到 GitHub Releases；README 指向最新 Release

## 改动时顺手记（非独立需求，但常踩坑）

- [ ] Capture 的 `burst-ahead` / 多标签并发策略可配置，避免失败风暴  
- [ ] `state` 持久化勿再做成频繁全量巨型 JSON（可考虑 sqlite / 分文件）  
- [ ] `/api/status` 保持轻量；全量扫盘仅手动或低频缓存  
- [ ] Merge 与 Direct download 的产品文案/引导做清楚  
- [x] **补洞加速：智能补全缺口**（按缺片时间轴 seek，播放器未就绪减速，连续无进展停止）  
  - 现成脚本：`scripts/auto-seek-right.ahk`（全局按键）、`scripts/auto-seek-userscript.js`（油猴/控制台）  
  - 后续可做成扩展内「补洞模式」：按缺片时间轴自动 `video.currentTime = t`，比盲目 +10s 更准  
- [ ] **修 `list_streams_light` 字段语义**：勿再用 `failures` 冒充 `missing_count`；API 分开返回 `disk_missing` / `recent_failures` / `bad_small_historic` / `bytes_mb`

## 建议迭代切片（给后续 PR）

1. `ui-ia`：作品模型 + 前端拆分 + 重设计 + 状态数字语义（missing/small/contig）  
2. `extension-runtime`：纯扩展下载、文件写入和断点运行时  
3. `missing-timeline`：缺片时间轴 + 完成/缺片主动提示  
4. `merge-ux`：Merge 反馈/进度/输出路径/打开文件夹  
5. `custom-dirs`：自定义捕获/输出/Archive 目录  
6. `network-panel`：Dashboard 类 DevTools Network 流水  
7. `i18n-zh`：中文  
8. `archive-generic`：通用批量下载  
9. `archive-fanbox` / `archive-confluence` / `archive-linear`  
10. `extension-release`：纯扩展打包与 GitHub Release  
11. `optional-python-helper`：能力闸门通过后再做纯 Python Helper 与跨平台适配
