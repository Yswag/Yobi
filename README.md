# Yobi

專為 iOS Scripting 設計的 YouTube 與 bilibili 雙來源原生串流播放器。

---

## 功能亮點

- **雙平台聚合**：首頁發燒推薦、頻道訂閱動態與即時搜尋；貼上 YouTube 連結、bilibili 番號（BV / AV）或短網址即可直接播放。
- **流暢播放體驗**：
  - **迷你播放器**：全螢幕與底部迷你列無縫過渡，支援跟手下拉手勢收合。
  - **直覺手勢**：滑動螢幕即可直覺調節播放進度、音量與亮度。
  - **彈幕與字幕**：支援 bilibili 原生彈幕渲染、字級調節與多語字幕。
  - **高畫質影音**：最高支援 4K 超高清畫質串流。
  - **子母畫面 (PiP)**：支援系統懸浮視窗背景播放。
- **SponsorBlock**：智慧跳過片頭、片尾與工商贊助片段。
- **媒體庫與隱私安全**：
  - 本地播放歷史、自訂清單與訂閱管理，無須帳號也能獨立運作。
  - 登入憑證與敏感 Cookie 妥善存放於系統 Keychain，保護帳號安全。

---

## 介面導覽

- **首頁**：探索 YouTube 與 bilibili 的熱門推薦內容。
- **訂閱**：集中查看已訂閱頻道與 UP 主的最新更新。
- **媒體庫**：隨時回顧觀看歷史、稍後觀看與收藏影片。
- **搜尋**：跨平台關鍵字搜尋與即時補全建議。

---

## 專案檔案

- [index.tsx](file:///var/mobile/Library/Mobile%20Documents/iCloud~com~thomfang~Scripting/Documents/scripts/Yobi/index.tsx) — 應用程式進入點
- [script.json](file:///var/mobile/Library/Mobile%20Documents/iCloud~com~thomfang~Scripting/Documents/scripts/Yobi/script.json) — 腳本中繼資料與外觀設定
- [docs/adr](file:///var/mobile/Library/Mobile%20Documents/iCloud~com~thomfang~Scripting/Documents/scripts/Yobi/docs/adr/README.md) — 決策紀錄；程式碼不寫註解，理由看 0010
