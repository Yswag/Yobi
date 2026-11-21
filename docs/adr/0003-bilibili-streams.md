# ADR-0003 bilibili 取流：SegmentList、單一編碼、HLS 優先

## 狀態

已採用。

## 決策

`dash` payload 進來後不直接丟給播放器，先整理：

- **只留一份編碼**。播放器會把同一個 `AdaptationSet` 裡每個 `Representation` 都當一條軌讀；bili 同畫質固定給 AVC／HEVC／AV1 三份，4K 時等於三倍流量。優先 AVC，其次 HEVC、AV1。4K 以上不取 AVC（4K60 要 13 Mbps，native 解不動，音訊會 underrun）。8K 反過來優先 AV1，HEVC 8K native 開不起來。
- **seek 要 SegmentList**。播放器對 SegmentBase 把整個檔當一段讀，seek 只能從檔頭線性讀到目標（4K 中段要讀上百 MB）。拆成 SegmentList 後每個子片段有明確範圍。播放器不認 SegmentList 裡的 SegmentTimeline（會從頭走並報 preroll 錯誤），只能給單一 duration。
- **段號計算用「去掉最後一段後最長的片段時長」**。播放器用「目標時間 ÷ duration」算段號，取最長只會把段號算小，讀到的那段一定從目標之前開始，再往後解到目標。bili 偶爾夾一段短片段（例如 5s 之間一段 1.6s），取平均會把段號算大、跳過目標。
- **優先用 HLS**。native 後端會提前抓下一段，段邊界不會露出空窗；沒有 sidx 或串流伺服器起不來才退回 SegmentList MPD。軌道只準備一次，兩種 manifest 共用同一份準備結果，避免兩邊選到不同 track。
- **片段一律走本機代理**。bili 的 CDN 要 `Referer`，但播放器對本機 manifest 的片段請求不會帶 header。MPD 也由 `localProxy` 供檔，回應必須帶 `Content-Length`，DASH 解析器才讀得懂。
- **開片前先向 CDN 直接抓檔頭**（0 到 indexRange 結尾，init＋sidx 約 2 KB）。走代理要先下載整個 1 MB 的第 0 格。抓到的位元組種進代理，播放器要 init 時直接回；每條軌並行拿，不然音軌得等影片軌。
- **HLS 由 dash payload 直接生**，不經過 MPD：每段一個帶副檔名的本機網址（native 後端沒副檔名會回 no playable track），時長取 sidx 的精確值。音軌整條當一片：AAC 在 fMP4 每個 segment 各自帶 priming，切段播放會在接縫出現雜音。
- **HLS 標記**：分數幀率要轉十進位（`2997/100`）。DoVi 不能直接宣告 `dvh1`，要改回 `hvc1` 並用 `SUPPLEMENTAL-CODECS` 描述（125 = HDR10，126 = 杜比視界）。不壓幀率。`bandwidth` 要宣告峰值，DASH 的均值太低會被 CoreMedia 判 -12318。
- **線路評分**只用播放本來就要抓的 1 MB 格子計分，不另外測速；分數是每 MB 耗時的指數平均，越低越好，跨影片共用、只在這次執行內有效。換主線路要快 1.5 倍以上才換，否則只會來回切。試線的格子算進網速但不是主線路，不更新面板上的「線路」；被播放器搬回來的試線不記分（只知道「至少這麼慢」）。
- **4K 以上沒有替代編碼就整條畫質不給**，不降級硬播。

## 後果

畫質選單由 provider 決定，UI 不必知道編碼差異。代價是所有特例都集中在 `services/bilibili/dashMpd.ts`，新增畫質或編碼要一起改 encode 選擇與 HLS 標記。
