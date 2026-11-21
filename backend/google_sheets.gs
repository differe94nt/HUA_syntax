/**
 * AI 輔助華語分級課室語言設計與語法分析－偏誤語料 · Google 試算表＋雲端硬碟後端（Google Apps Script）
 *
 * 用途：讓 GitHub Pages 上的兩個學生網站把答案存到老師的 Google 試算表，
 *       並把學生交的 HTML 成品與截圖存到老師的 Google 雲端硬碟。設定步驟見 backend/README.md。
 *
 * 試算表會自動建立五個工作表：
 *   groups   ：每組一列，永遠是「最新」的答案（id、updatedAt、各欄位的可讀內容、完整 json）
 *   history  ：每一次儲存、上傳、重設都新增一列，只增不改（時間、組別、動作、哪一段、裝置、摘要、json）
 *   settings ：教師廣播（目前階段）
 *   files    ：每組每一版 HTML 一列，指向「最新」的檔案（組別、版本 v1/v2、檔案 ID、網址、檔名、大小、方式、時間、第幾次上傳）
 *   uploads  ：每張截圖一列（組別、版本、檔案 ID、網址、檔名、上傳時間、是否移除）
 * 檔案存在試算表旁邊的資料夾「語法偏誤AI輔具_成品」。每次交 HTML 都是新檔案，舊版不會被覆蓋。
 * 第 0 組是「測試組」：老師示範用，可以換語料、一鍵清空重來；不會出現在全班統計裡。
 *
 * 介面（網站裡的 makeSheetStore 就是對這些端點說話）：
 *   GET  ?action=ping                         → {ok}
 *   GET  ?action=all                          → {ok, groups:{g1:{...}}, settings:{class:{...}}}
 *   GET  ?action=group&id=g4                  → 同上，但 groups 只有 g4
 *   GET  ?action=html&id=g4&slot=v1           → {ok, html}
 *   POST {type:'patch', id:'g4', sec:'s3', set:{...}, notes:{upsert,del}, text, by} → {ok, doc}
 *        只改這一段裡「有改動的欄位」，組員同時儲存不同欄位不會互相蓋掉
 *   POST {type:'reset', id:'g0', text, by}                           → {ok, doc}（只限測試組）
 *   POST {type:'group'|'settings', id, data}                         → {ok}（整份覆蓋；舊版網站用）
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
const SHEET_HISTORY = 'history';
const TEST_GROUP = 'g0';
// 可以存的段落。欄位名稱只要是英數字就收（之後網站加欄位，不用重新部署後端）
const SECTIONS = ['s1', 'ai1', 's3', 'p2', 'ai2', 'end'];
const FIELD_RE = /^[a-z][A-Za-z0-9]{0,23}$/;
const MAX_FIELDS = 30;
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
  ['2生成結果', 'ai1.status'], ['2結果說明', 'ai1.statusNote'],
  ['2HTML第一版', 'files.v1'], ['2截圖', 'shots.v1'],
  ['3都找到', 's3.hit'], ['3AI漏掉', 's3.miss'], ['3AI誤判', 's3.over'], ['3超出程度的詞', 's3.coctWords'],
  ['3分級觀察', 's3.coctNote'], ['3AI分數', 's3.score'], ['3想改標註', 's3.rethink'],
  ['4prompt有做到', 'p2.had'], ['4最想補上', 'p2.missing'], ['4AI偏好', 'p2.bias'], ['4偏好例子', 'p2.biasNote'],
  ['4用哪個AI', 'ai2.llm'], ['4AI版本', 'ai2.llmNote'], ['4修正指令', 'ai2.prompt'], ['4AI回答', 'ai2.reply'],
  ['4生成結果', 'ai2.status'], ['4結果說明', 'ai2.statusNote'],
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
    if (type === 'patch') return json_(patchGroup_(id, body));
    if (type === 'reset') return json_(resetGroup_(id, body));
    if (type === 'group' || type === 'settings') {
      if (typeof body.data !== 'object' || body.data === null) throw new Error('缺少 data');
      upsert_(type === 'group' ? SHEET_GROUPS : SHEET_SETTINGS, id, body.data);
      if (type === 'group') log_(id, 'group', '整份', body.by, '整份覆蓋', body.data);
      return json_({ ok: true, id: id });
    }
    if (type === 'html') return json_(saveHtml_(id, body));
    if (type === 'upload') return json_(saveUpload_(id, body));
    if (type === 'unshot') return json_(removeUpload_(id, String(body.slot || ''), String(body.fileId || ''), body.by));
    throw new Error('type 不合法');
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

function checkGroup_(groupId) {
  if (!/^g\d{1,3}$/.test(groupId)) throw new Error('組別不合法');
}
function checkGroupSlot_(groupId, slot) {
  checkGroup_(groupId);
  if (SLOTS.indexOf(slot) < 0) throw new Error('版本不合法');
}
const by_ = b => String((b && b.by) || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
const nowIso_ = () => new Date().toISOString();

// ---------- 答案：只合併有改動的欄位 ----------
function docWithExtras_(groupId, doc) {
  return Object.assign({}, doc, extraFor_(groupId));
}

function patchGroup_(groupId, body) {
  checkGroup_(groupId);
  const sec = String(body.sec || '');
  if (SECTIONS.indexOf(sec) < 0) throw new Error('段落不合法');
  const set = (body.set && typeof body.set === 'object' && !Array.isArray(body.set)) ? body.set : {};
  if (Object.keys(set).length > MAX_FIELDS) throw new Error('欄位太多');
  Object.keys(set).forEach(k => { if (!FIELD_RE.test(k) || k === 'at') throw new Error('欄位不合法：' + k); });
  const ops = (body.notes && typeof body.notes === 'object') ? body.notes : null;
  if (ops && sec !== 's1') throw new Error('只有階段 1 有標註');

  const sh = sheet_(SHEET_GROUPS);
  const doc = readDocs_(sh)[groupId] || { group: Number(groupId.slice(1)) };
  delete doc.files; delete doc.shots;
  const cur = Object.assign({}, doc[sec] || {});
  if (sec === 's1' && cur.locked && (ops || 'notes' in set || 'guide' in set)) throw new Error('標註已經鎖定，不能再改');

  Object.keys(set).forEach(k => { cur[k] = set[k]; });
  let changed = 0, removed = 0;
  if (ops) {
    let notes = Array.isArray(cur.notes) ? cur.notes.slice() : [];
    const del = Array.isArray(ops.del) ? ops.del.map(String) : [];
    removed = notes.filter(n => del.indexOf(String(n.id)) >= 0).length;
    notes = notes.filter(n => del.indexOf(String(n.id)) < 0);
    (Array.isArray(ops.upsert) ? ops.upsert : []).forEach(n => {
      if (!n || typeof n !== 'object' || !n.id) return;
      const i = notes.findIndex(x => String(x.id) === String(n.id));
      if (i >= 0) notes[i] = n; else notes.push(n);
      changed++;
    });
    cur.notes = notes;
  }
  const at = nowIso_();
  cur.at = at;
  doc[sec] = cur;
  doc.group = Number(groupId.slice(1));
  const text = Number(body.text);
  if (text && !doc.text) doc.text = text;
  doc.updatedAt = at;
  upsert_(SHEET_GROUPS, groupId, doc);

  const parts = Object.keys(set).map(k => k + '：' + readable_(set[k]).slice(0, 300));
  if (ops) parts.push('標註：新增或修改 ' + changed + '、刪除 ' + removed + '，共 ' + cur.notes.length + ' 個');
  log_(groupId, 'save', sec, body.by, parts.join('\n'), { set: set, notes: ops });
  return { ok: true, doc: docWithExtras_(groupId, doc) };
}

// 測試組一鍵清空：答案清掉、HTML 與截圖從清單拿掉（雲端硬碟裡的檔案保留，history 也保留）
function resetGroup_(groupId, body) {
  if (groupId !== TEST_GROUP) throw new Error('只有測試組可以清空');
  const at = nowIso_();
  const doc = { group: 0, text: Number(body.text) || 1, resetAt: at, updatedAt: at };
  const fs = sheet_(SHEET_FILES);
  for (let r = fs.getLastRow(); r >= 2; r--) if (String(fs.getRange(r, 1).getValue()) === groupId) fs.deleteRow(r);
  const us = sheet_(SHEET_UPLOADS);
  if (us.getLastRow() > 1) {
    const rows = us.getRange(2, 1, us.getLastRow() - 1, 7).getValues();
    rows.forEach((r, i) => { if (String(r[0]) === groupId && !r[6]) us.getRange(i + 2, 7).setValue('reset ' + at); });
  }
  upsert_(SHEET_GROUPS, groupId, doc);
  log_(groupId, 'reset', '全部', body.by, '清空測試組，語料 ' + doc.text, doc);
  return { ok: true, doc: docWithExtras_(groupId, doc) };
}

// ---------- 歷程：只增不改 ----------
function log_(groupId, kind, what, by, summary, obj) {
  const sh = sheet_(SHEET_HISTORY);
  const row = [nowIso_(), groupId, kind, what, by_({ by: by }), cell_(summary || '')];
  const json = JSON.stringify(obj == null ? {} : obj);
  for (let i = 0; i === 0 || i < json.length; i += CELL_MAX) row.push('~' + json.slice(i, i + CELL_MAX));
  writeRow_(sh, null, row);
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
  const sh = sheet_(SHEET_FILES);
  const r = findFileRow_(sh, groupId, slot);
  const version = r ? (Number(sh.getRange(r, 9).getValue()) || 1) + 1 : 1;
  const stamp = Utilities.formatDate(new Date(), 'Asia/Taipei', 'MMdd-HHmmss');
  const fname = (groupId === TEST_GROUP ? '測試組' : '第' + groupId.slice(1) + '組') + '_' + (slot === 'v1' ? '第一版' : '修正版') + '_第' + version + '次_' + stamp + '.html';
  // 每次都存成新檔案，舊版留在資料夾裡（history 工作表有每一版的連結）
  const file = folder_().createFile(Utilities.newBlob(html, 'text/html', fname));
  const row = [groupId, slot, file.getId(), file.getUrl(), orig || fname, html.length, source, nowIso_(), version];
  if (r) sh.getRange(r, 1, 1, row.length).setValues([row]); else writeRow_(sh, null, row);
  refreshGroupRow_(groupId);
  log_(groupId, 'html', slot, body.by, '第 ' + version + ' 次（' + (source === 'paste' ? '貼上' : '上傳') + '）' + file.getUrl(),
    { fileId: file.getId(), url: file.getUrl(), name: orig || fname, size: html.length, source: source, version: version });
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
  sh.getRange(2, 1, sh.getLastRow() - 1, 9).getValues().forEach(r => {
    if (!r[0]) return;
    const g = String(r[0]);
    (out[g] = out[g] || {})[String(r[1])] = { id: String(r[2]), url: String(r[3]), name: String(r[4]), size: Number(r[5]) || 0, source: String(r[6]), savedAt: String(r[7]), versions: Number(r[8]) || 1 };
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
  log_(groupId, 'shot', slot, body.by, file.getUrl(), { fileId: file.getId(), url: file.getUrl(), name: name });
  return { ok: true, shots: readUploads_()[groupId] || {} };
}

function removeUpload_(groupId, slot, fileId, by) {
  checkGroupSlot_(groupId, slot);
  const sh = sheet_(SHEET_UPLOADS);
  if (sh.getLastRow() > 1) {
    const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues();
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][0]) === groupId && String(rows[i][1]) === slot && String(rows[i][2]) === fileId && !rows[i][6]) {
        sh.getRange(i + 2, 7).setValue('removed ' + new Date().toISOString());
        try { DriveApp.getFileById(fileId).setTrashed(true); } catch (_) {}  // 丟到垃圾桶，30 天內可救回
        log_(groupId, 'unshot', slot, by, '移除截圖 ' + String(rows[i][3]), { fileId: fileId });
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
  if (name === SHEET_FILES) return ['group', 'slot', 'fileId', 'url', 'name', 'size', 'source', 'savedAt', 'versions'];
  if (name === SHEET_HISTORY) return ['time', 'group', 'kind', 'what', 'by', 'summary', 'json'];
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
  } else {
    // files／uploads／history 只會在後面加欄位，表頭補上就好
    const have = sh.getRange(1, 1, 1, want.length).getValues()[0].map(String);
    if (!want.every((h, i) => have[i] === h)) sh.getRange(1, 1, 1, want.length).setValues([want]);
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
