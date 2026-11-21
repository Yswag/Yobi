# ADR-0004 YouTube 取流：client 分工、SABR 與 PO Token

## 狀態

已採用。

## 決策

### client 分工

`services/youtube/innertube.ts` 依用途挑 client，不是隨便挑一個能動的：

| client | 用途 |
| --- | --- |
| `VISIONOS` | 免 PoToken 的 `hlsManifestUrl`，影音合併、可任意 seek，最高 4K；要 visitorData |
| `IOS` | 影片詳情、SABR 備援的直連 adaptiveFormats，以及 init／index 範圍 |
| `WEB` | 搜尋、browse、next、留言；只有 WEB 系能吃 SAPISIDHASH |
| `WEB_SABR` / `MWEB` | 取得 `serverAbrStreamingUrl` 與 ustreamerConfig |
| `ANDROID` / `IOS` / `TVHTML5` | 直播的 `hlsManifestUrl`；只有 app client 會回清單 |

### 串流

- 預設走 SABR。`sabr.ts` 自己解 UMP 封包與 protobuf，並產生本機 HLS／DASH manifest。
- SABR 的 init 一定要跟伺服器拿。直連網址可能指向另一個編碼；part 42（`FormatInitializationMetadata`）的 `lastModified` 才是「伺服器實際在送的那份」，它帶 init 與 index 的位置。直連 URL 只用來讀檔頭的 init／index（那兩段不需要 PO token）。
- 播放清單的段數與時長取自 sidx，取不到才會被 5 秒格點帶去錯的段。產生 init 時要拿掉 sidx：播放器的 ffmpeg 5.0.1 讀到太大的 sidx 會解析錯位並以 `AVERROR_PATCHWELCOME` 拒開，HLS 的分段時間軸本來就看本地清單。
- ABR 請求要跟官方播放器一致：`enabledTrackTypesBitfield`（0 = 影音、1 = 只有音、2 = 只有影）、播放能力、已持有 init 的格式，以及與目標同一個 adaptation set（容器與編碼家族要一致，否則伺服器會換掉 avc1→av01 或 mp4a→opus）。
- 伺服器經常用 backoff 或新的 SABR context 回應而不是媒體，要照播放器那樣重試；每個 session 第一支請求通常要等約 5 秒。
- 有年齡限制與會員專屬的串流只給通過 hash 驗證的 web session。
- 4K 的 AVC 要 13 Mbps 以上，native 解不動，選流時排除。
- SABR 沒有真正的分段時間軸就不播，估算的時間軸會讓字幕與拖動都對不上。
- 單一畫質各自一個 session id，切畫質直接換 master URL；每個 itag 一個預抓器（session 有狀態：context、backoff、token）。
- 交付的是本地 HLS；native 才能進子母畫面，先試能不能直接吃。

### PO Token 與登入頁

- 自己 mint 的 token 走 `potoken.ts`：首頁 ytcfg + `ytAtN` 挑戰 → 臨時 WKWebView 的 BotGuard → GenerateIT → minter。挑戰必須來自首頁快照，不能走 `/api/jnn/v1/Create`：BotGuard 讀的是同一頁的 `yt.config_.EVENT_ID`，沒有它 mint 出來的 token 會被拒。
- `MWEB` 用 Safari/iPhone UA 對 m.youtube.com mint（與之後使用 token 的引擎同家族）；`WEB` 對桌面頁 mint。
- 頁面內 mint 走 `pageMinter.ts`：隱藏 watch page 的播放器在影片資料載入時會同步 mint 任意 videoId 的 token。做法是在 document start 對 `Object.prototype.useLivingRoomPoToken` 掛 setter 捕捉實例，再靠行為找 mint 方法（名稱被 minify 過）。頁面不需播放、不需在畫面上，media 請求要擋掉。
- 伺服器持續拒絕舊 token 時重載頁面再 mint，但只讓一個呼叫端做。
- 登入後的請求要指定第一個帳號槽，否則 YouTube 會留在訪客 session。

### 直播

- 直播沒有時間軸，也不吃 VISIONOS／SABR：只有 app client 會回 `hlsManifestUrl`（實測 ANDROID 有，IOS 只有 adaptiveFormats，WEB／TVHTML5／VISIONOS 被風控擋）。依序問幾個 client，取第一個「master、媒體清單、第一段」都真的抓得到的。
- 清單與片段直接給播放器，不經本機轉手：轉手會把媒體清單快取起來，直播的滑動窗格不會更新，播完一輪就停。
- 後端用 system：native 對直播的 1 秒片段、3 秒窗格會一直轉圈。
- 直播給 master，讓播放器跟著即時頻寬挑 variant；指定畫質再從選單換。
- 直播聊天室：起點游標在 `next` 的 `conversationBar.liveChatRenderer`，之後照 invalidation／timed continuation 追。伺服器常自己 long-poll 十幾秒，所以不照 `timeoutMs` 等：有訊息立刻接下一輪，沒訊息才短歇。前端只留最新幾則，游標照樣推進。

### 解析

- 同時支援舊 `videoRenderer`／`compactVideoRenderer`／`gridVideoRenderer` 與首頁大量使用的 `lockupViewModel`。renderers 用 `thumbnails`，view model 用 `sources`。
- 頻道頁的影片清單不帶作者（合作影片除外，會帶「A and B」）；列表縮圖 16:9，詳情 4:3 帶黑邊，只在沒有時補。
- 續頁 token 取整棵樹裡**最長**的那個（排除剛用掉的）。browse 的主 feed token 最長；取第一個或最深的會拿到子貨架的 token，YouTube 回 400。
- 章節兩條 renderer 是同一份清單又各出現兩遍，唯一鍵用開始秒數；用 title + 毫秒會跟 macro 的秒數對不上，整排重複。
- 留言的「下一頁」token 是 `continuationItems` 最後一項。每則留言的回覆 token 掛在 thread 上，留言本體在 `frameworkUpdates`，要先記下來再配對。展開回覆時遇到一樣形狀的陣列要整塊跳過，否則遞迴會認錯。
- 推薦清單在 `contents.twoColumnWatchNextResults.secondaryResults`，外層再包一層同名節點；其他版型直接掃整塊。
- 排序 chip 依標籤挑（Latest／Popular／Oldest），不要看索引：語系與頻道會有差異。排序不是 browse params，用 chip 自己的 continuation token 當第一頁。
- 頻道總數要從「關於」頁的 `videoCountText` 拿，header 那行會被縮寫成 `1K videos`。header 已經精確時就不必再打關於頁。
- 直播的「正在觀看」人數在 `next` 的 `videoPrimaryInfoRenderer`；`videoDetails.viewCount` 恆為 0。一般影片也有同一個 renderer，要看 `isLive` 或文字。會員專屬影片完全沒有觀看數，`undefined` 不要畫成 0。
- 介面語言／地區只能從頁面 `ytcfg` 讀（`responseContext` 只是回音），登入與 pageMinter 順手記下；讀不到沿用上次，再沒有才退回 en／US。
- `n` 參數用 yt-dlp 的 ejs solver 解，沒有它 SABR 會 403。

## 後果

所有 client 差異集中在 `services/youtube/`。代價是每個新 client 都要驗「master／媒體清單／第一段」三層，不能只看 API 回應。
