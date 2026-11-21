# ADR-0008 字幕與彈幕

## 狀態

已採用。

## 決策

- YouTube 的自動字幕 VTT 帶逐字時間標記、空白 cue 與 10ms 的銜接 cue，播放器的解析器整份拒收。`utils/subtitles.ts` 只取時間與純文字，重新輸出成帶 CC 底框樣式的 WebVTT。
- 樣式照 YouTube 的 CC：無襯線粗體、約 70% 不透明的深黑底（播放器只吃 hex）。最後一行放在倒數第二行的位置，離底邊留一行；多行往上長。
- SRT 與 VTT 都是「時間行＋文字行」的區塊，共用同一套解析。
- bilibili 的字幕清單在播放器資訊裡（`/x/player/wbi/v2` 的 `data.subtitle.subtitles`），每條給 `subtitle_url`，內容是 `{ body: [{ from, to, content }] }` 的 JSON，要自己轉 VTT。`ai_type` 0 = 人工、其他 = AI；`ai_status` 不是 2 代表這條 AI 字幕還沒生成好。未登入或 UP 沒上傳時清單是空的。
- SABR 路線給的字幕網址是相對路徑（`/api/timedtext?…`），要補成絕對。
- 字幕不擋開播：manifest 先回，第一幀之後再用 `resolveSubtitles` 補上。
- 沒字幕時也留位置，只是淡掉，使用者才知道這部片沒有字幕可選。
- 迷你播放器收起時關掉字幕與彈幕，展開再依原本的選擇還原（控制器會在 `open()` 時清掉這些設定）。
- 彈幕失敗不影響播放。

## 後果

播放器只吃乾淨的 WebVTT 與已成形的中文內容。代價是兩個平台的格式差異都在 `utils/subtitles.ts` 與 `services/bilibili/subtitles.ts` 收斂。
