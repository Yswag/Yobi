# Issue-002 音訊 session 設定失敗被當成正常

狀態：已分辨環境不支援與真失敗（`audioUnavailable` ＋ 錯誤回報 ＋ 提示），剩 preview／App 兩邊實測。

## 問題

`state/playerStore.ts` 設定 audio session 時用 `catch {}` 收掉，理由是「Preview／非 app 環境可能不允許」。實際結果是：在正式 App 裡真的失敗時，播放照走但沒有聲音，且沒有任何提示。

## 影響

使用者遇到「有畫面沒聲音」只能重開 App。也讓 preview 環境與正式環境的行為差異沒有被記錄。

## 驗收

- 區分「環境不支援」與「設定失敗」：只有前者可以忽略。
- 後者要回報（見 issue-001）並讓播放器狀態帶上 `audioUnavailable`。
- 在 preview 與 App 模式各跑一次，確認兩邊行為。
