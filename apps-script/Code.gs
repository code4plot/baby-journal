/**
 * Newborn Journal API — Google Apps Script web app
 * ------------------------------------------------
 * A JSON endpoint the nanoclaw agent calls to read and write the newborn journal sheet.
 *
 * SETUP
 *   1. script.google.com → New project. Paste this file as Code.gs.
 *      (Or bind it to the template: in the sheet, Extensions → Apps Script.
 *       Every copy of the template then carries the script.)
 *   2. Project Settings → tick "Show appsscript.json". Replace that file with the one supplied.
 *   3. Run `setup()` once from the editor and approve the permissions.
 *      It creates an API token and prints it in the execution log. Give the token to the agent as a secret.
 *   4. Deploy → New deployment → Web app
 *        Execute as:      Me
 *        Who has access:  Anyone
 *      Copy the /exec URL and give it to the agent (e.g. BABY_API_URL).
 *   5. Optional Script Properties (Project Settings → Script properties):
 *        SHEET_ID           default sheet when a request doesn't name one
 *        ALLOWED_SHEET_IDS  comma-separated allowlist. Recommended, because the script runs as you
 *                           and could otherwise open any sheet you can access.
 *
 * REQUESTS
 *   Send every call as POST with a JSON body. Apps Script answers a POST with a 302 redirect,
 *   so the client must follow redirects (curl -L; Python urllib/requests do this by default).
 *
 *   { "sheet": "<sharing link or ID>", "action": "...", ... }
 *
 *   The API key goes in one of two places:
 *     - the URL query parameter  .../exec?key=<API key>   (how OneCLI injects it; Apps Script can't read headers)
 *     - the body field           "token": "<API key>"      (fallback when there's no credential gateway)
 *   If both are sent, the query parameter wins.
 *
 *   action    extra fields                         returns
 *   -------   ----------------------------------   -----------------------------------------
 *   meta      —                                    title, timezone, tabs and row counts
 *   append    tab, rows[]                          rows written (first/last row numbers)
 *   log       entries{tab: rows[]}                 several tabs in one locked write
 *   tail      tab, n (default 5, max 200)          last n rows, each with its row number
 *   query     tab, from, to?, limit?, includeVoid? rows whose Date/Time is in [from, to]
 *   update    tab, row, values{} | values[]        the row after the change (a partial object merges)
 *   void      tab, row                             the row after it is marked VOID
 *   summary   date? (YYYY-MM-DD, default today)    totals for that day
 *
 *   A row is either an object keyed by column header (case-insensitive) or an array
 *   in column order. Date/Time is "YYYY-MM-DD HH:mm+HH:MM" (a UTC offset, or "Z"). The API converts it to the
 *   spreadsheet's timezone. Without an offset it is read in the spreadsheet's timezone.
 *   Every Date/Time the API returns carries the offset, and the sheet cells show it too, e.g. "2026-11-15 14:20 +08:00".
 *   journal-log rows also need "Raw log": the user's text, or the voice-note transcript, verbatim.
 *
 *   Columns
 *     journal-log  Date/Time | Log | Raw log
 *     feed-log     Date/Time | Milk type | Format | Volume (mL) | Duration (min) | Additives | Remarks
 *     poopee-log   Date/Time | Poo | Pee | Remarks
 *     sleep-log    Date/Time | Status | Remarks
 *     vitals-log   Date/Time | Feature | Measurement | Unit | Remarks
 *     notes-log    Date/Time | Notes
 *
 *   Every response is HTTP 200 with JSON:
 *     { "ok": true,  "action": "...", "result": {...} }
 *     { "ok": false, "error": "<code>", "message": "..." }
 *   Error codes: unauthorized, bad_request, sheet_unavailable, sheet_not_allowed,
 *                schema_mismatch, not_found, busy, internal
 */

// ---------------------------------------------------------------- schema

const TABS = {
  'journal-log': ['Date/Time', 'Log', 'Raw log'],
  'feed-log':    ['Date/Time', 'Milk type', 'Format', 'Volume (mL)', 'Duration (min)', 'Additives', 'Remarks'],
  'poopee-log':  ['Date/Time', 'Poo', 'Pee', 'Remarks'],
  'sleep-log':   ['Date/Time', 'Status', 'Remarks'],
  'vitals-log':  ['Date/Time', 'Feature', 'Measurement', 'Unit', 'Remarks'],
  'notes-log':   ['Date/Time', 'Notes'],
};

// Raw log holds the user's message as sent: the text, or the voice-note transcript, verbatim.
const REQUIRED = new Set(['Date/Time', 'Raw log']);
const NUMERIC = new Set(['Volume (mL)', 'Duration (min)', 'Measurement', 'Poo', 'Pee']);
const ENUMS = {
  'Milk type': ['formula', 'breast milk'],
  'Format':    ['breast', 'bottle'],
  'Status':    ['sleep', 'wake'],
  'Poo':       [0, 1],
  'Pee':       [0, 1],
};

const DT_OUT = 'yyyy-MM-dd HH:mm';     // Utilities.formatDate pattern (the offset is added by formatDT_)
const DT_CELL = 'yyyy-mm-dd hh:mm';    // Sheets number format (cellFormat_ adds the offset as literal text)
const VOID = 'VOID';
const MAX_TAIL = 200;
const MAX_QUERY = 1000;
const MAX_ROWS_PER_CALL = 100;

const HANDLERS = {
  meta: handleMeta_,
  append: handleAppend_,
  log: handleLog_,
  tail: handleTail_,
  query: handleQuery_,
  update: handleUpdate_,
  void: handleVoid_,
  summary: handleSummary_,
};

// ---------------------------------------------------------------- entry points

/** Health check only. It returns no data, so it needs no token. */
function doGet() {
  return json_({ ok: true, service: 'newborn-journal-api', version: 1 });
}

function doPost(e) {
  let action = null;
  try {
    const req = parseBody_(e);
    action = req.action;
    // API key: the ?key= query parameter (injected by OneCLI on nanoclaw) wins over "token" in the body.
    checkToken_((e.parameter && e.parameter.key) || req.token);
    const handler = HANDLERS[action];
    if (!handler) throw apiError_('bad_request', 'Unknown action: ' + action);
    const ss = openSheet_(req.sheet);
    return json_({ ok: true, action: action, result: handler(ss, req) });
  } catch (err) {
    if (!err.code) console.error(err && err.stack || err);
    return json_({
      ok: false,
      action: action,
      error: err.code || 'internal',
      message: String(err && err.message || err),
    });
  }
}

/**
 * Run once from the editor: pick "setup" in the function dropdown, then click Run.
 * It creates the API token. You can read the token in either place:
 *   - the Execution log under the editor, or
 *   - Project Settings (gear icon) → Script properties → API_TOKEN
 */
function setup() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('API_TOKEN');
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('API_TOKEN', token);
    Logger.log('Created API_TOKEN = ' + token);
  } else {
    Logger.log('API_TOKEN already set = ' + token + '  (run rotateToken() to replace it)');
  }
  return token;
}

/** Run from the editor to issue a new token. The old one stops working. */
function rotateToken() {
  PropertiesService.getScriptProperties().deleteProperty('API_TOKEN');
  setup();
}

// ---------------------------------------------------------------- handlers

function handleMeta_(ss) {
  const tabs = {};
  Object.keys(TABS).forEach(function (tab) {
    const sh = ss.getSheetByName(tab);
    tabs[tab] = { rows: Math.max(0, sh.getLastRow() - 1), headers: TABS[tab] };
  });
  return {
    sheetId: ss.getId(),
    title: ss.getName(),
    timezone: ss.getSpreadsheetTimeZone(),
    tabs: tabs,
  };
}

function handleAppend_(ss, req) {
  const tab = requireTab_(req.tab);
  const rows = prepareRows_(tab, req.rows, ss.getSpreadsheetTimeZone());
  return withLock_(function () {
    return writeRows_(ss.getSheetByName(tab), rows, ss.getSpreadsheetTimeZone());
  });
}

/** Several tabs in one call, e.g. the journal-log row plus its parsed rows. Validated in full before anything is written. */
function handleLog_(ss, req) {
  const entries = req.entries;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    throw apiError_('bad_request', '"entries" must be an object of {tab: rows[]}');
  }
  const tz = ss.getSpreadsheetTimeZone();
  const prepared = Object.keys(entries).map(function (tab) {
    requireTab_(tab);
    return { tab: tab, rows: prepareRows_(tab, entries[tab], tz) };
  });
  if (!prepared.length) throw apiError_('bad_request', '"entries" is empty');
  return withLock_(function () {
    const out = {};
    prepared.forEach(function (p) { out[p.tab] = writeRows_(ss.getSheetByName(p.tab), p.rows, tz); });
    return out;
  });
}

function handleTail_(ss, req) {
  const tab = requireTab_(req.tab);
  const n = clampInt_(req.n, 5, 1, MAX_TAIL);
  const sh = ss.getSheetByName(tab);
  const last = sh.getLastRow();
  if (last < 2) return { tab: tab, rows: [] };
  const start = Math.max(2, last - n + 1);
  const recs = readRecords_(sh, tab, start, last - start + 1, ss.getSpreadsheetTimeZone());
  return { tab: tab, rows: recs.map(publicRecord_) };
}

function handleQuery_(ss, req) {
  const tab = requireTab_(req.tab);
  const tz = ss.getSpreadsheetTimeZone();
  if (!req.from) throw apiError_('bad_request', '"from" is required (YYYY-MM-DD or YYYY-MM-DD HH:mm)');
  const from = parseBound_(req.from, tz, false);
  const to = req.to ? parseBound_(req.to, tz, true) : new Date(8640000000000000);
  const limit = clampInt_(req.limit, 500, 1, MAX_QUERY);
  const recs = readAll_(ss, tab, tz).filter(function (r) {
    return (req.includeVoid || !r.isVoid) && r.dt && r.dt >= from && r.dt <= to;
  });
  return {
    tab: tab,
    count: recs.length,
    truncated: recs.length > limit,
    rows: recs.slice(0, limit).map(publicRecord_),
  };
}

function handleUpdate_(ss, req) {
  const tab = requireTab_(req.tab);
  const tz = ss.getSpreadsheetTimeZone();
  const sh = ss.getSheetByName(tab);
  const headers = TABS[tab];
  return withLock_(function () {
    const row = requireRow_(sh, req.row);
    let input = req.values;
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      // Partial object: merge it over what's in the row now.
      const current = sh.getRange(row, 1, 1, headers.length).getValues()[0];
      const merged = {};
      headers.forEach(function (h, i) { merged[h] = current[i]; });
      Object.keys(input).forEach(function (k) { merged[resolveHeader_(tab, k)] = input[k]; });
      input = merged;
    }
    const cells = normalizeRow_(tab, input, tz);
    sh.getRange(row, 1, 1, headers.length).setValues([cells]);
    sh.getRange(row, 1).setNumberFormat(cellFormat_(cells[0], tz));
    return publicRecord_(readRecords_(sh, tab, row, 1, tz)[0]);
  });
}

/** Keep Date/Time, clear the other cells and write VOID in the last column. */
function handleVoid_(ss, req) {
  const tab = requireTab_(req.tab);
  const sh = ss.getSheetByName(tab);
  const width = TABS[tab].length;
  return withLock_(function () {
    const row = requireRow_(sh, req.row);
    if (width > 1) {
      const blanks = new Array(width - 1).fill('');
      blanks[blanks.length - 1] = VOID;
      sh.getRange(row, 2, 1, width - 1).setValues([blanks]);
    }
    return publicRecord_(readRecords_(sh, tab, row, 1, ss.getSpreadsheetTimeZone())[0]);
  });
}

function handleSummary_(ss, req) {
  const tz = ss.getSpreadsheetTimeZone();
  const day = req.date || Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw apiError_('bad_request', '"date" must be YYYY-MM-DD');
  const from = parseBound_(day, tz, false);
  const to = parseBound_(day, tz, true);
  const inDay = function (tab) {
    return readAll_(ss, tab, tz).filter(function (r) { return !r.isVoid && r.dt && r.dt >= from && r.dt <= to; });
  };

  const feeds = inDay('feed-log');
  const diapers = inDay('poopee-log');
  const sleeps = inDay('sleep-log');
  const vitals = inDay('vitals-log');
  const notes = inDay('notes-log');
  const sum = function (recs, h) {
    return recs.reduce(function (a, r) { return a + (typeof r.data[h] === 'number' ? r.data[h] : 0); }, 0);
  };
  const count = function (recs, h, v) { return recs.filter(function (r) { return r.data[h] === v; }).length; };

  const allFeeds = readAll_(ss, 'feed-log', tz).filter(function (r) { return !r.isVoid && r.dt; });
  const lastFeed = allFeeds.length ? allFeeds.reduce(function (a, b) { return b.dt > a.dt ? b : a; }) : null;

  return {
    date: day,
    timezone: tz,
    feeds: {
      count: feeds.length,
      totalVolumeMl: sum(feeds, 'Volume (mL)'),
      totalDurationMin: sum(feeds, 'Duration (min)'),
      breast: count(feeds, 'Format', 'breast'),
      bottle: count(feeds, 'Format', 'bottle'),
      formula: count(feeds, 'Milk type', 'formula'),
      breastMilk: count(feeds, 'Milk type', 'breast milk'),
    },
    diapers: { entries: diapers.length, poo: count(diapers, 'Poo', 1), pee: count(diapers, 'Pee', 1) },
    sleep: sleeps.map(function (r) { return { time: r.data['Date/Time'], status: r.data['Status'] }; }),
    vitals: vitals.map(publicRecord_),
    notes: notes.length,
    lastFeed: lastFeed ? publicRecord_(lastFeed) : null,
  };
}

// ---------------------------------------------------------------- sheet access

function openSheet_(ref) {
  const props = PropertiesService.getScriptProperties();
  const id = ref ? parseSheetId_(ref) : props.getProperty('SHEET_ID');
  let ss = null;

  if (id) {
    const allow = (props.getProperty('ALLOWED_SHEET_IDS') || '')
      .split(',').map(function (s) { return s.trim(); }).filter(String);
    if (allow.length && allow.indexOf(id) === -1) {
      throw apiError_('sheet_not_allowed', 'Sheet ' + id + ' is not in ALLOWED_SHEET_IDS');
    }
    try {
      ss = SpreadsheetApp.openById(id);
    } catch (e) {
      throw apiError_('sheet_unavailable',
        'Cannot open sheet ' + id + '. Check the link, and that the sheet is shared as Editor ' +
        '(anyone with the link, or the script owner).');
    }
  } else {
    ss = SpreadsheetApp.getActiveSpreadsheet(); // works when the script is bound to the sheet
  }
  if (!ss) throw apiError_('bad_request', 'No sheet given. Send "sheet" (sharing link or ID) or set SHEET_ID.');

  // Only work on sheets built from the template: all six tabs with the expected headers.
  // This also stops the token being used against unrelated sheets.
  const problems = [];
  Object.keys(TABS).forEach(function (tab) {
    const sh = ss.getSheetByName(tab);
    if (!sh) { problems.push('missing tab "' + tab + '"'); return; }
    const want = TABS[tab];
    const got = sh.getRange(1, 1, 1, want.length).getDisplayValues()[0].map(function (s) { return s.trim(); });
    want.forEach(function (h, i) {
      if (got[i].toLowerCase() !== h.toLowerCase()) {
        problems.push(tab + ' column ' + (i + 1) + ' should be "' + h + '" (found "' + got[i] + '")');
      }
    });
  });
  if (problems.length) throw apiError_('schema_mismatch', 'Not a newborn journal sheet: ' + problems.join('; '));
  return ss;
}

function parseSheetId_(ref) {
  const s = String(ref).trim();
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(s)) return s;
  throw apiError_('bad_request', 'Could not find a Google Sheets ID in "sheet"');
}

function writeRows_(sh, rows, tz) {
  const start = sh.getLastRow() + 1;
  sh.getRange(start, 1, rows.length, rows[0].length).setValues(rows);
  sh.getRange(start, 1, rows.length, 1).setNumberFormats(rows.map(function (r) { return [cellFormat_(r[0], tz)]; }));
  return { firstRow: start, lastRow: start + rows.length - 1, count: rows.length };
}

function readAll_(ss, tab, tz) {
  const sh = ss.getSheetByName(tab);
  const last = sh.getLastRow();
  return last < 2 ? [] : readRecords_(sh, tab, 2, last - 1, tz);
}

function readRecords_(sh, tab, startRow, numRows, tz) {
  const headers = TABS[tab];
  const values = sh.getRange(startRow, 1, numRows, headers.length).getValues();
  const out = [];
  values.forEach(function (vals, i) {
    if (vals.every(function (v) { return v === '' || v === null; })) return; // skip empty rows
    const data = {};
    headers.forEach(function (h, j) {
      const v = vals[j];
      data[h] = v instanceof Date ? formatDT_(v, tz) : v;
    });
    out.push({
      row: startRow + i,
      dt: vals[0] instanceof Date ? vals[0] : null,
      isVoid: vals[headers.length - 1] === VOID,
      data: data,
    });
  });
  return out;
}

function publicRecord_(r) {
  const o = { row: r.row };
  Object.keys(r.data).forEach(function (k) { o[k] = r.data[k]; });
  if (r.isVoid) o.void = true;
  return o;
}

function requireRow_(sh, row) {
  const n = Number(row);
  if (!Number.isInteger(n) || n < 2 || n > sh.getLastRow()) {
    throw apiError_('not_found', 'Row ' + row + ' does not exist (data rows start at 2)');
  }
  return n;
}

// ---------------------------------------------------------------- validation

function requireTab_(tab) {
  if (!TABS[tab]) throw apiError_('bad_request', 'Unknown tab "' + tab + '". Use one of: ' + Object.keys(TABS).join(', '));
  return tab;
}

function prepareRows_(tab, rows, tz) {
  if (!Array.isArray(rows) || !rows.length) throw apiError_('bad_request', '"rows" for ' + tab + ' must be a non-empty array');
  if (rows.length > MAX_ROWS_PER_CALL) throw apiError_('bad_request', 'At most ' + MAX_ROWS_PER_CALL + ' rows per tab per call');
  return rows.map(function (r, i) {
    try { return normalizeRow_(tab, r, tz); }
    catch (e) { e.message = tab + ' row ' + (i + 1) + ': ' + e.message; throw e; }
  });
}

function resolveHeader_(tab, key) {
  const k = String(key).trim().toLowerCase();
  const h = TABS[tab].filter(function (x) { return x.toLowerCase() === k; })[0];
  if (!h) throw apiError_('bad_request', 'Unknown column "' + key + '" for ' + tab + '. Columns: ' + TABS[tab].join(', '));
  return h;
}

function normalizeRow_(tab, input, tz) {
  const headers = TABS[tab];
  const obj = {};
  if (Array.isArray(input)) {
    if (input.length > headers.length) throw apiError_('bad_request', 'Too many values (' + headers.length + ' columns)');
    headers.forEach(function (h, i) { obj[h] = input[i]; });
  } else if (input && typeof input === 'object') {
    Object.keys(input).forEach(function (k) { obj[resolveHeader_(tab, k)] = input[k]; });
  } else {
    throw apiError_('bad_request', 'Each row must be an object or an array');
  }
  return headers.map(function (h) { return toCell_(h, obj[h], tz); });
}

function toCell_(h, v, tz) {
  if (v === undefined || v === null || v === '') {
    if (REQUIRED.has(h)) throw apiError_('bad_request', h + ' is required');
    return '';
  }
  if (h === 'Date/Time') return parseDateTime_(v, tz);
  if (v === VOID) return v;
  if (h === 'Log' && typeof v === 'object') return JSON.stringify(v);
  if (NUMERIC.has(h)) {
    const n = Number(v);
    if (!isFinite(n)) throw apiError_('bad_request', '"' + h + '" must be a number, got "' + v + '"');
    v = n;
  }
  if (ENUMS[h]) {
    const val = typeof v === 'string' ? v.trim().toLowerCase() : v;
    if (ENUMS[h].indexOf(val) === -1) {
      throw apiError_('bad_request', '"' + h + '" must be one of ' + JSON.stringify(ENUMS[h]) + ', got "' + v + '"');
    }
    return val;
  }
  return v;
}

function parseDateTime_(v, tz) {
  if (v instanceof Date) return v;
  const s = String(v).trim().replace('T', ' ');
  const m = s.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?::\d{2})?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (!m) throw apiError_('bad_request', 'Date/Time must be "YYYY-MM-DD HH:mm+HH:MM", got "' + v + '"');
  if (!m[3]) return Utilities.parseDate(m[1] + ' ' + m[2], tz, 'yyyy-MM-dd HH:mm');
  // Explicit offset: read the wall time as UTC, then shift by the offset to get the real instant.
  const asUtc = Utilities.parseDate(m[1] + ' ' + m[2], 'UTC', 'yyyy-MM-dd HH:mm');
  let offsetMin = 0;
  if (m[3].toUpperCase() !== 'Z') {
    const o = m[3].replace(':', '');
    offsetMin = (o[0] === '-' ? -1 : 1) * (parseInt(o.slice(1, 3), 10) * 60 + parseInt(o.slice(3, 5), 10));
  }
  return new Date(asUtc.getTime() - offsetMin * 60000);
}

/** UTC offset of tz at instant d, as "+08:00". */
function offset_(d, tz) {
  const z = Utilities.formatDate(d, tz, 'Z'); // e.g. +0800
  return z.slice(0, 3) + ':' + z.slice(3);
}

/** "2026-11-15 14:20 +08:00": wall time in the sheet's timezone, plus its offset. */
function formatDT_(d, tz) {
  return Utilities.formatDate(d, tz, DT_OUT) + ' ' + offset_(d, tz);
}

/** Sheets number format that shows the cell's date plus its offset as literal text. */
function cellFormat_(d, tz) {
  return d instanceof Date ? DT_CELL + ' "' + offset_(d, tz) + '"' : DT_CELL;
}

/** A date-only bound covers the whole day: start of day for "from", end of day for "to". */
function parseBound_(v, tz, isEnd) {
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = Utilities.parseDate(s + ' 00:00', tz, 'yyyy-MM-dd HH:mm');
    return isEnd ? new Date(d.getTime() + 24 * 3600 * 1000 - 1) : d;
  }
  const d = parseDateTime_(s, tz);
  return isEnd ? new Date(d.getTime() + 59999) : d; // include the whole end minute
}

function clampInt_(v, dflt, min, max) {
  const n = v === undefined || v === null || v === '' ? dflt : parseInt(v, 10);
  if (isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

// ---------------------------------------------------------------- plumbing

function parseBody_(e) {
  if (!e || !e.postData || !e.postData.contents) throw apiError_('bad_request', 'Expected a JSON body');
  try { return JSON.parse(e.postData.contents); }
  catch (err) { throw apiError_('bad_request', 'Body is not valid JSON'); }
}

function checkToken_(token) {
  const expected = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  if (!expected) throw apiError_('unauthorized', 'API_TOKEN not set. Run setup() in the editor.');
  const got = String(token || '');
  // Compare in time that doesn't depend on where the first mismatch is.
  let diff = got.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) diff |= (got.charCodeAt(i) || 0) ^ expected.charCodeAt(i);
  if (diff !== 0) throw apiError_('unauthorized', 'Invalid token');
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw apiError_('busy', 'Another write is in progress. Retry shortly.');
  try {
    const out = fn();
    SpreadsheetApp.flush();
    return out;
  } finally {
    lock.releaseLock();
  }
}

function apiError_(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
