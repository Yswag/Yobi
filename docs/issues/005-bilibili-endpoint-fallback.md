# Issue-005 bilibili endpoint fallback 鏈沒有錯誤分類

## 問題

`services/bilibili/index.ts` 對幾乎每個查詢都準備了 2–3 個 endpoint：`/view` → 舊版、`popular` → `ranking`、`reply/main` → legacy、頻道卡片 → public card、搜尋 → 以 UP 主名義重搜。失敗時只會「換下一個」，不區分風控（-412）、參數錯誤、還是端點下線。

## 影響

- 風控被當成「端點壞了」，重試會讓風控更嚴重。
- 端點真的下線時，錯誤要到最後一層才浮現，且沒有紀錄指出是哪一層擋住。
- 無法測試：每個分支都要真的打線上 API 才能驗證。

## 驗收

- 把 fallback 收斂成一個帶分類的 helper：`retryable`／`banned`／`deprecated`／`unknown`。
- 風控要停止 fallback 並回報。
- 每個端點至少一個 mock 測試，覆蓋成功與分類失敗。
