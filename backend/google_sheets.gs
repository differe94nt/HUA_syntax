/**
 * AI 輔助華語分級課室語言設計與語法分析－偏誤語料 · Google 試算表＋雲端硬碟後端（Google Apps Script）
 *
 * 用途：讓 GitHub Pages 上的兩個學生網站把答案存到老師的 Google 試算表，
 *       並把學生交的 HTML 成品與截圖存到老師的 Google 雲端硬碟。設定步驟見 backend/README.md。
 *
 * 試算表會自動建立四個工作表：
 *   groups   ：每組一列（id、updatedAt、各欄位的可讀內容、完整 json）
 *   settings ：教師廣播（目前階段）
 *   files    ：每組每一版 HTML 一列（組別、版本 v1/v2、雲端硬碟檔案 ID、網址、檔名、大小、方式、時間）
 *   uploads  ：每張截圖一列（組別、版本、檔案 ID、網址、檔名、上傳時間、是否移除）
 * 檔案存在試算表旁邊的資料夾「語法偏誤AI輔具_成品」。
 *
 * 介面（網站裡的 makeSheetStore 就是對這些端點說話）：
 *   GET  ?action=ping                         → {ok}
 *   GET  ?action=all                          → {ok, groups:{g1:{...}}, settings:{class:{...}}}
 *   GET  ?action=group&id=g4                  → 同上，但 groups 只有 g4
 *   GET  ?action=html&id=g4&slot=v1           → {ok, html}
 *   POST {type:'group'|'settings', id, data}                         → {ok}
 *   POST {type:'html', id:'g4', slot:'v1', name, source, html}       → {ok, files}
 *   POST {type:'upload', id:'g4', slot:'v1', name, mime, data(base64)} → {ok, shots}
 *   POST {type:'unshot', id:'g4', slot:'v1', fileId}                 → {ok, shots}
 *
 * 安全：學生只能透過上面這幾個端點存取。HTML 只能讀「files 工作表裡登記的檔案」，
 *       截圖只能移除「自己組別登記過的檔案」，碰不到你雲端硬碟裡的其他檔案。
 */

const SHEET_GROUPS = 'groups';
const SHEET_SETTINGS = 'settings';
const SHEET_FILES = 'files';
const SHEET_UPLOADS = 'uploads';
const UPLOAD_FOLDER_NAME = '語法偏誤AI輔具_成品';
// true：截圖設為「知道連結的人可以檢視」，教師端才看得到縮圖。HTML 檔不會對外分享。
const SHARE_UPLOADS_WITH_LINK = true;
const SLOTS = ['v1', 'v2'];
const MAX_SHOTS = 4;                       // 每組每一版最多幾張截圖
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_HTML_CHARS = 1500000;
const CELL_MAX = 45000;                    // 試算表一格上限是 50,000 字，留一點空間

// 可讀欄位：和網站裡的 EXPORT_COLUMNS 一致。json 欄永遠保留完整資料。
const GROUP_COLUMNS = [
  ['語料', 'text'],
  ['1標註', 's1.notes'], ['1怎麼指導', 's1.guide'], ['1鎖定時間', 's1.lockedAt'],
  ['2用哪個AI', 'ai1.llm'], ['2AI版本', 'ai1.llmNote'], ['2prompt', 'ai1.prompt'], ['2AI分析', 'ai1.reply'],
  ['2HTML第一版', 'files.v1'], ['2截圖', 'shots.v1'],
  ['3都找到', 's3.hit'], ['3AI漏掉', 's3.miss'], ['3AI誤判', 's3.over'], ['3超出程度的詞', 's3.coctWords'],
  ['3分級觀察', 's3.coctNote'], ['3AI分數', 's3.score'], ['3想改標註', 's3.rethink'],
  ['4prompt有做到', 'p2.had'], ['4最想補上', 'p2.missing'], ['4AI偏好', 'p2.bias'], ['4偏好例子', 'p2.biasNote'],
  ['4用哪個AI', 'ai2.llm'], ['4AI版本', 'ai2.llmNote'], ['4修正指令', 'ai2.prompt'], ['4AI回答', 'ai2.reply'],
  ['4HTML第二版', 'files.v2'], ['4截圖', 'shots.v2'], ['4改善與限制', 'ai2.change'],
  ['5一句話', 'end.share'], ['5重來的prompt', 'end.redo'],
];

// ---------- 入口 ----------
function doGet(e) {
  try {
    const p = (e && e.parameter) || {};
    if (p.action === 'ping') return json_({ ok: true });
    if (p.action === 'html') return json_(readHtml_(String(p.id || ''), String(p.slot || '')));
    const groups = readGroups_(), settings = readDocs_(sheet_(SHEET_SETTINGS));
    if (p.action === 'group') {
      const id = String(p.id || ''), one = {};
      if (groups[id]) one[id] = groups[id];
      return json_({ ok: true, groups: one, settings: settings });
    }
    return json_({ ok: true, groups: groups, settings: settings });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const type = String(body.type || ''), id = String(body.id || '');
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new Error('id 不合法');
    lock.waitLock(20000);
    if (type === 'group' || type === 'settings') {
      if (typeof body.data !== 'object' || body.data === null) throw new Error('缺少 data');
      upsert_(type === 'group' ? SHEET_GROUPS : SHEET_SETTINGS, id, body.data);
      return json_({ ok: true, id: id });
    }
    if (type === 'html') return json_(saveHtml_(id, body));
    if (type === 'upload') return json_(saveUpload_(id, body));
    if (type === 'unshot') return json_(removeUpload_(id, String(body.slot || ''), String(body.fileId || '')));
    throw new Error('type 不合法');
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

function checkGroupSlot_(groupId, slot) {
  if (!/^g\d{1,3}$/.test(groupId)) throw new Error('組別不合法');
  if (SLOTS.indexOf(slot) < 0) throw new Error('版本不合法');
}

// ---------- HTML 成品 ----------
function saveHtml_(groupId, body) {
  const slot = String(body.slot || '');
  checkGroupSlot_(groupId, slot);
  const html = String(body.html || '');
  if (!html.trim()) throw new Error('HTML 是空的');
  if (html.length > MAX_HTML_CHARS) throw new Error('HTML 太大');
  const source = body.source === 'paste' ? 'paste' : 'upload';
  const orig = String(body.name || '').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 80);
  const fname = '第' + groupId.slice(1) + '組_' + (slot === 'v1' ? '第一版' : '修正版') + '.html';
  const sh = sheet_(SHEET_FILES);
  const r = findFileRow_(sh, groupId, slot);
  let file = null;
  if (r) {
    try { file = DriveApp.getFileById(String(sh.getRange(r, 3).getValue())); if (file.isTrashed()) file = null; } catch (_) { file = null; }
  }
  if (file) file.setContent(html);
  else file = folder_().createFile(Utilities.newBlob(html, 'text/html', fname));
  const row = [groupId, slot, file.getId(), file.getUrl(), orig || fname, html.length, source, new Date().toISOString()];
  if (r) sh.getRange(r, 1, 1, row.length).setValues([row]); else sh.appendRow(row);
  refreshGroupRow_(groupId);
  return { ok: true, files: readFiles_()[groupId] || {} };
}

function readHtml_(groupId, slot) {
  checkGroupSlot_(groupId, slot);
  const sh = sheet_(SHEET_FILES), r = findFileRow_(sh, groupId, slot);
  if (!r) throw new Error('還沒有上傳');
  // 只讀 files 工作表登記的檔案
  const html = DriveApp.getFileById(String(sh.getRange(r, 3).getValue())).getBlob().getDataAsString('UTF-8');
  return { ok: true, html: html };
}

function findFileRow_(sh, groupId, slot) {
  if (sh.getLastRow() < 2) return 0;
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
  for (let i = 0; i < rows.length; i++) if (String(rows[i][0]) === groupId && String(rows[i][1]) === slot) return i + 2;
  return 0;
}

function readFiles_() {
  const sh = sheet_(SHEET_FILES), out = {};
  if (sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 8).getValues().forEach(r => {
    if (!r[0]) return;
    const g = String(r[0]);
    (out[g] = out[g] || {})[String(r[1])] = { id: String(r[2]), url: String(r[3]), name: String(r[4]), size: Number(r[5]) || 0, source: String(r[6]), savedAt: String(r[7]) };
  });
  return out;
}

// ---------- 截圖 ----------
function saveUpload_(groupId, body) {
  const slot = String(body.slot || '');
  checkGroupSlot_(groupId, slot);
  const mime = String(body.mime || 'image/jpeg');
  if (!/^image\/(jpeg|png|webp|gif)$/.test(mime)) throw new Error('只接受圖片');
  const bytes = Utilities.base64Decode(String(body.data || ''));
  if (!bytes.length) throw new Error('圖片是空的');
  if (bytes.length > MAX_UPLOAD_BYTES) throw new Error('圖片太大');
  if (((readUploads_()[groupId] || {})[slot] || []).length >= MAX_SHOTS) throw new Error('每一版最多 ' + MAX_SHOTS + ' 張');

  const name = String(body.name || 'screenshot.jpg').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 80);
  const stamp = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd-HHmmss');
  const file = folder_().createFile(Utilities.newBlob(bytes, mime, groupId + '_' + slot + '_' + stamp + '_' + name));
  if (SHARE_UPLOADS_WITH_LINK) {
    try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (_) {
      // 學校帳號可能不允許對外分享；檔案仍然存好了，只是縮圖要老師登入才看得到
    }
  }
  sheet_(SHEET_UPLOADS).appendRow([groupId, slot, file.getId(), file.getUrl(), name, new Date().toISOString(), '']);
  refreshGroupRow_(groupId);
  return { ok: true, shots: readUploads_()[groupId] || {} };
}

function removeUpload_(groupId, slot, fileId) {
  checkGroupSlot_(groupId, slot);
  const sh = sheet_(SHEET_UPLOADS);
  if (sh.getLastRow() > 1) {
    const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues();
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][0]) === groupId && String(rows[i][1]) === slot && String(rows[i][2]) === fileId && !rows[i][6]) {
        sh.getRange(i + 2, 7).setValue('removed ' + new Date().toISOString());
        try { DriveApp.getFileById(fileId).setTrashed(true); } catch (_) {}  // 丟到垃圾桶，30 天內可救回
      }
    }
  }
  refreshGroupRow_(groupId);
  return { ok: true, shots: readUploads_()[groupId] || {} };
}

function readUploads_() {
  const sh = sheet_(SHEET_UPLOADS), out = {};
  if (sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues().forEach(r => {
    if (!r[0] || r[6]) return;
    const g = String(r[0]), s = String(r[1]);
    const o = (out[g] = out[g] || {});
    (o[s] = o[s] || []).push({ id: String(r[2]), url: String(r[3]), name: String(r[4]), at: String(r[5]) });
  });
  return out;
}

function folder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('UPLOAD_FOLDER_ID');
  if (id) {
    try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (_) {}
  }
  let parent = DriveApp.getRootFolder();
  try {
    const ps = DriveApp.getFileById(SpreadsheetApp.getActiveSpreadsheet().getId()).getParents();
    if (ps.hasNext()) parent = ps.next();
  } catch (_) {}
  const f = parent.createFolder(UPLOAD_FOLDER_NAME);
  props.setProperty('UPLOAD_FOLDER_ID', f.getId());
  return f;
}

// ---------- 試算表 ----------
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function headers_(name) {
  if (name === SHEET_GROUPS) return ['id', 'updatedAt'].concat(GROUP_COLUMNS.map(c => c[0]), ['json']);
  if (name === SHEET_FILES) return ['group', 'slot', 'fileId', 'url', 'name', 'size', 'source', 'savedAt'];
  if (name === SHEET_UPLOADS) return ['group', 'slot', 'fileId', 'url', 'name', 'uploadedAt', 'removed'];
  return ['id', 'updatedAt', 'json'];
}

// 取得工作表；不存在就建立。groups／settings 欄位改版時，自動把舊資料搬到新欄位。
function sheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const want = headers_(name);
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  ensureCols_(sh, want.length);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, want.length).setValues([want]);
    sh.setFrozenRows(1);
    return sh;
  }
  if (name === SHEET_GROUPS || name === SHEET_SETTINGS) {
    const have = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
    if (!want.every((h, i) => have[i] === h)) {
      const docs = readDocs_(sh, have);
      sh.clearContents();
      sh.getRange(1, 1, 1, want.length).setValues([want]);
      sh.setFrozenRows(1);
      Object.keys(docs).forEach(id => writeRow_(sh, null, rowFor_(name, id, docs[id])));
    }
  }
  return sh;
}

// 新的工作表只有 26 欄；表頭比較長時先補欄位
function ensureCols_(sh, n) {
  if (n > sh.getMaxColumns()) sh.insertColumnsAfter(sh.getMaxColumns(), n - sh.getMaxColumns());
}

function getPath_(o, p) {
  return p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
}

function readable_(v) {
  if (v == null) return '';
  if (Array.isArray(v)) {
    if (v.length && v[0] && typeof v[0] === 'object' && 'toks' in v[0]) {
      return v.map((n, i) => (i + 1) + '. 【' + (n.type || '？') + '】' + (n.text || '') + ' → ' + (n.fix || '') + (n.why ? '｜' + n.why : '')).join('\n');
    }
    if (v.length && v[0] && typeof v[0] === 'object') return v.map(x => x.url || x.name || '').join('\n');
    return v.map(String).join('、');
  }
  if (typeof v === 'object') return v.url || v.name || JSON.stringify(v);
  return String(v);
}

// 避免學生的文字被當成公式（= + - @ 開頭），並截短到一格的上限
function cell_(s) {
  s = String(s);
  if (s.length > CELL_MAX) s = s.slice(0, CELL_MAX - 1) + '…';
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

// json 太長時切成好幾格；每格前面加 ~，讀回來時拿掉，避免被試算表當成數字或公式
function rowFor_(name, id, data, extra) {
  const doc = JSON.parse(JSON.stringify(data));
  delete doc.files; delete doc.shots;   // HTML 與截圖以 files／uploads 工作表為準
  const row = [id, doc.updatedAt || new Date().toISOString()];
  if (name === SHEET_GROUPS) {
    const view = Object.assign({}, doc, extra || {});
    GROUP_COLUMNS.forEach(([, key]) => row.push(cell_(readable_(getPath_(view, key)))));
  }
  const json = JSON.stringify(doc);
  for (let i = 0; i === 0 || i < json.length; i += CELL_MAX) row.push('~' + json.slice(i, i + CELL_MAX));
  return row;
}

function writeRow_(sh, rowIndex, row) {
  ensureCols_(sh, row.length);
  if (rowIndex) {
    sh.getRange(rowIndex, 1, 1, sh.getLastColumn()).clearContent();
    sh.getRange(rowIndex, 1, 1, row.length).setValues([row]);
  } else {
    sh.appendRow(row);
  }
}

function rowIndexOf_(sh, id) {
  if (sh.getLastRow() < 2) return 0;
  const ids = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(r => String(r[0]));
  const i = ids.indexOf(id);
  return i >= 0 ? i + 2 : 0;
}

function extraFor_(groupId) {
  return { files: readFiles_()[groupId] || {}, shots: readUploads_()[groupId] || {} };
}

function upsert_(name, id, data) {
  const sh = sheet_(name);
  writeRow_(sh, rowIndexOf_(sh, id), rowFor_(name, id, data, name === SHEET_GROUPS ? extraFor_(id) : null));
}

// 上傳 HTML 或截圖後，更新那一組的可讀欄位
function refreshGroupRow_(groupId) {
  const sh = sheet_(SHEET_GROUPS), r = rowIndexOf_(sh, groupId);
  if (!r) return;
  const docs = readDocs_(sh);
  if (docs[groupId]) writeRow_(sh, r, rowFor_(SHEET_GROUPS, groupId, docs[groupId], extraFor_(groupId)));
}

function readDocs_(sh, header) {
  const out = {};
  if (sh.getLastRow() < 2) return out;
  header = header || sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const j = header.indexOf('json');
  if (j < 0) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues().forEach(r => {
    const id = String(r[0]); if (!id) return;
    const text = r.slice(j).map(c => { c = String(c); return c.charAt(0) === '~' ? c.slice(1) : c; }).join('');
    try { out[id] = JSON.parse(text); } catch (_) { out[id] = { id: id, updatedAt: String(r[1]) }; }
  });
  return out;
}

// 每組的答案，加上該組的 HTML 清單與截圖清單
function readGroups_() {
  const groups = readDocs_(sheet_(SHEET_GROUPS)), files = readFiles_(), ups = readUploads_();
  const ids = {};
  Object.keys(groups).concat(Object.keys(files), Object.keys(ups)).forEach(g => { ids[g] = true; });
  Object.keys(ids).forEach(g => {
    const d = groups[g] || (groups[g] = { group: Number(g.slice(1)) || null });
    d.files = files[g] || {};
    d.shots = ups[g] || {};
  });
  return groups;
}

// ---------- 在編輯器手動執行 ----------
// 授權雲端硬碟並建立資料夾：在上方函式選單選 authorizeDrive → 執行，
// 授權畫面請勾選「雲端硬碟」那一項（或「全選」）。執行記錄會印出資料夾網址。
// 想改存到別的資料夾：到「專案設定 → 指令碼屬性」新增 UPLOAD_FOLDER_ID，值填那個資料夾網址最後一段 ID。
function authorizeDrive() {
  const f = folder_();
  Logger.log('成品資料夾：' + f.getName() + '  ' + f.getUrl());
}
