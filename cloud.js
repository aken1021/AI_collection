// data/library.json is the source of truth. Cloud data never replaces this file.
window.HandbookCloud = (() => {
  for (const id of ['cloud-login', 'cloud-sync', 'cloud-logout']) document.getElementById(id).hidden = true
  const status = document.getElementById('cloud-status')
  const message = text => { status.textContent = text }
  message(location.protocol === 'file:' ? '資料來源：data/library.json。請連接本專案的 data 資料夾；匯入、編輯與刪除會直接寫回檔案。' : '資料來源：data/library.json。')
  return { enabled: false, message }
})()
