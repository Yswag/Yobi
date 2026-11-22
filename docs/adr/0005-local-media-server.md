# ADR-0005 本機媒體伺服器與位元組代理

## 狀態

已採用。

## 決策

播放器只認本機 HTTP。`services/mediaServer.ts` 是自寫的 HTTP/1.1（`node:net`），`services/localProxy.ts` 是路由與快取，`services/prefetch.ts` 決定先抓哪幾塊。兩者透過處理器註冊介面提供串流、SABR、HLS 轉手與分塊代理，不反向依賴各平台模組，並對 session 與虛擬 manifest 設上限淘汰。

### 路由

`HttpRequest.path` 不含 query string，所以參數全部編進路徑：

```
/manifest/:id/:file
/bili-file/:id/:itag/file.m4s
/hls-master/:sessionId/master.m3u8
/hls-media/:sessionId/:itag/playlist.m3u8
/sabr-init/:sessionId/:itag/init.mp4
/sabr-seg/:sessionId/:itag/:seq/seg.mp4
/sabr/:sessionId/master.m3u8
/sabr/:sessionId/manifest.mpd
/relay/:id/playlist.m3u8
/relay/:id/:index/seg.ts
```

### 格子

- bili 的 m4s 整個檔按固定 1 MB 切格子預抓。回應是「從起點最多一格、不超過要求的結尾」，跨格就拼兩格。
- DASH 子片段是明確範圍，只回到格子邊界會截斷樣本，播放器回 Invalid data；所以帶明確結尾的請求要拼滿整段，開放式請求最多回一格。
- 206 一定要吐完整一格。比要求的少就代表上游截斷，拼起來的片段會壞；上游回 200 錯誤頁時，那些位元組不能進快取。
- 伺服器忽略 Range 回整個檔時，自己切出這一格。
- 播放器正在等這一格時（playhead 追上）要搶跑：取消試線、改走主線路，並更新 playhead；拼整段時每等一格都要做。
- 主線路超過預期沒回來、而播放器已在等這格，就同時再要一次，先到先用。backup 可以是同一條線：Akamai 會把個別請求限到約 1.5 Mbps，重發通常馬上回來。預抓發出的格子也適用。
- 丟例外而不是回 null：回 null 會被預抓器當成檔案結尾。

### 預抓

- 窗口用時間算，不是固定 MB：20 Mbps 約 2.5 MB/s，15 秒就是 ~38 格；6 Mbps 只要 12 格（下限 16）。不知道碼率時 32 格。
- 所有預抓器共用一個記憶體上限；同時只會播一支影片。
- 正在播的影片的軌不當成閒置：播放器緩衝滿了會十幾秒不要資料，音軌 1 MB 更是一分多鐘才要一格。
- 拖動後舊範圍的預抓取消，但播放器還在等的那塊不動，否則新舊請求會互相取消。保留前一塊（播放器偶爾重抓）與後面範圍。
- 「正在抓」的塊算進連續可用位元組，否則數字會在滿與 0 之間亂跳。對外取「最多的那個」是影片軌：音軌位元組少，換算秒數會失真。
- 開片前先抓續播位置那一帶，並另外放一份：開片時播放器先讀檔頭，一般快取會以檔頭為中心清掉遠處的塊。

### 回應

- 先送 header，之後每格到就寫一段。清單只有幾 KB，同源供檔，播放器不必跨 port 解析相對網址。
- 背壓時等播放器讀完，不設時限：音軌一格 1 MB 要播一分多鐘才讀得完。播放器不要了會關連線，那時才算失敗。
- 開始送 body 後不再用閒置逾時：播放器照播放速度讀，長時間沒進度是正常的。但等格子時 socket 閒置逾時不能比單格逾時短。
- `Content-Range` 只能出現在 206，跟 200 一起送 ffmpeg 會回 Invalid data。
- 中途拿不到格子時只能斷線（長度已經宣告了），抓格子本身先重試。檔尾長度不足要先修正結尾，不要宣告了長度又寫不滿。
- 音軌不切段：整條當一片送，避免每個接縫的 AAC priming 造成雜音。
- 轉手外部 HLS 媒體清單時，片段網址照 YouTube 用 `seg.ts` 結尾、類型給 octet-stream（影片其實是 fMP4、音訊是 ADTS AAC）：帶 `.mp4` 回 Invalid data，不帶副檔名回 no playable track。
- 同一個 group 代表同一支影片；換到新 group 時，舊影片的轉手全部移除。

## 後果

播放器對上游格式一無所知，所有 header、Range、截斷問題都在本機解決。代價是代理同時是 HTTP 伺服器與快取，改動時要顧錯誤路徑與背壓。
