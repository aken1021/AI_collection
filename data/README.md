# 資料檔案

`library.json` 是唯一主要資料來源，包含全文、附件（文字或 Base64）、
關聯、版本、收藏及回收桶。已從 2026-10-13 備份還原 41 筆資料。

直接開啟 index.html 時，按「連接 data 資料夾」並選取本資料夾；
也可執行 start.ps1 透過本機服務自動讀寫。
每次成功匯入或修改都存回 library.json，library.previous.json 保存上一份。
要讓其他電腦或遠端網站取得更新，請將 library.json commit 並 push。
