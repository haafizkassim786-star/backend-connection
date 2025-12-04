// sheets.js
// ESM module for Google Sheets access using service account JSON file
// Defensive initSheets: accepts SERVICE_ACCOUNT_KEY_PATH or SERVICE_ACCOUNT_JSON (base64/raw),
// normalizes private_key newlines, writes a normalized JSON file and uses it for GoogleAuth.
// Exports: initSheets, getHeaders, getAllRows, getRowByTrackingId, createRow, updateRow, deleteRow

import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let sheetsClient = null;
let spreadsheetId = null;
let sheetName = null;

/* Helper: column number to letter (1 -> A, 27 -> AA) */
function colLetter(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/* Robustly parse 'history' cell */
function parseHistory(historyStr) {
  try {
    if (historyStr === undefined || historyStr === null || historyStr === '') return [];
    if (Array.isArray(historyStr)) return historyStr;
    if (typeof historyStr === 'object') return Array.isArray(historyStr) ? historyStr : [];

    if (typeof historyStr === 'string') {
      const trimmed = historyStr.trim();

      // Looks like JSON array/object
      if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try {
          const parsed = JSON.parse(trimmed);
          return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
          try {
            // sometimes double-encoded: "\"[...]""
            const unescaped = trimmed.replace(/^"(.+)"$/, '$1').replace(/\\"/g, '"');
            const parsed2 = JSON.parse(unescaped);
            return Array.isArray(parsed2) ? parsed2 : [];
          } catch (e2) {
            return [];
          }
        }
      }

      // plain text -> wrap as single history message
      return [{ date: '', location: '', message: trimmed }];
    }

    return [];
  } catch {
    return [];
  }
}

/* Normalize history for writing to sheet (always a JSON string) */
function normalizeHistoryForStorage(history) {
  try {
    if (history === undefined || history === null) return '[]';
    if (Array.isArray(history)) return JSON.stringify(history);
    if (typeof history === 'string') {
      const trimmed = history.trim();
      if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try {
          const parsed = JSON.parse(trimmed);
          return JSON.stringify(Array.isArray(parsed) ? parsed : []);
        } catch {
          try {
            const unescaped = trimmed.replace(/^"(.+)"$/, '$1').replace(/\\"/g, '"');
            const parsed2 = JSON.parse(unescaped);
            return JSON.stringify(Array.isArray(parsed2) ? parsed2 : []);
          } catch {
            return JSON.stringify([{ date: '', location: '', message: trimmed }]);
          }
        }
      }
      return JSON.stringify([{ date: '', location: '', message: trimmed }]);
    }
    return '[]';
  } catch {
    return '[]';
  }
}

/* Quote sheet/tab name when it contains special characters */
function quoteSheetNameIfNeeded(name) {
  if (!name) return name;
  const needsQuote = /[ \'\!\,\(\)\[\]\{\}\+\-\*\:\?\/\\]/.test(name);
  return needsQuote ? `'${name.replace(/'/g, "''")}'` : name;
}

/* Build a safe A1 range for rows */
function safeRangeForRows(name, fromRow = 1, toRow = null) {
  const quoted = quoteSheetNameIfNeeded(name);
  if (toRow !== null && toRow !== undefined) {
    return `${quoted}!${fromRow}:${toRow}`;
  }
  return `${quoted}!${fromRow}:`;
}

/* Ensure initialized before calls */
async function ensureInitialized() {
  if (!sheetsClient) throw new Error('Sheets client not initialized. Call initSheets() first.');
}

/**
 * initSheets(serviceAccountPathArg, sheetId, sheetNameOverride='')
 *
 * Behavior:
 *  - If environment variable SERVICE_ACCOUNT_JSON or SERVICE_ACCOUNT_KEY_JSON exists,
 *    it prefers that (accepts raw JSON or base64-encoded JSON).
 *  - Otherwise it uses serviceAccountPathArg or SERVICE_ACCOUNT_KEY_PATH or './service-account.json'.
 *  - It normalizes private_key by replacing literal "\\n" sequences with real newlines.
 *  - Writes a normalized copy and uses it for GoogleAuth.
 *  - Logs diagnostic info to help identify misconfigured secrets on cloud platforms.
 */
export async function initSheets(serviceAccountPathArg, sheetId, sheetNameOverride = '') {
  const envJson = process.env.SERVICE_ACCOUNT_JSON || process.env.SERVICE_ACCOUNT_KEY_JSON || '';
  let keyFilePathCandidate = serviceAccountPathArg || process.env.SERVICE_ACCOUNT_KEY_PATH || './service-account.json';

  // If env JSON is present, decode and write a temp file
  if (envJson && envJson.trim()) {
    let raw = envJson.trim();
    // Heuristic decode if base64-encoded
    if (!raw.startsWith('{') && /^[A-Za-z0-9+/=\s]+$/.test(raw)) {
      try {
        const decoded = Buffer.from(raw, 'base64').toString('utf8');
        if (decoded.trim().startsWith('{')) raw = decoded;
      } catch {
        // ignore decode error, proceed with raw
      }
    }
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error('initSheets: SERVICE_ACCOUNT_JSON present but invalid JSON:', e.message);
      throw new Error('SERVICE_ACCOUNT_JSON present but not valid JSON: ' + e.message);
    }

    // normalize escaped newlines if present
    if (parsed.private_key && typeof parsed.private_key === 'string') {
      parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
    }

    const dest = path.join(__dirname, 'service-account-from-env.json');
    fs.writeFileSync(dest, JSON.stringify(parsed), { encoding: 'utf8', mode: 0o600 });
    keyFilePathCandidate = dest;
    console.log('initSheets: using service account from SERVICE_ACCOUNT_JSON ->', dest);
  } else {
    if (!path.isAbsolute(keyFilePathCandidate)) keyFilePathCandidate = path.join(__dirname, keyFilePathCandidate);
    console.log('initSheets: using service account key file path ->', keyFilePathCandidate);
  }

  if (!fs.existsSync(keyFilePathCandidate)) {
    const msg = `Service account key JSON not found at ${keyFilePathCandidate}`;
    console.error('initSheets:', msg);
    throw new Error(msg);
  }

  // Read and parse file
  const rawFile = fs.readFileSync(keyFilePathCandidate, 'utf8');
  let parsedFile = null;
  try {
    parsedFile = JSON.parse(rawFile);
  } catch (e) {
    console.error('initSheets: service account file is not valid JSON:', e.message);
    console.error('initSheets: file head (first 300 chars) ->', rawFile.slice(0, 300).replace(/\n/g, '\\n'));
    throw new Error('Service account file is not valid JSON: ' + e.message);
  }

  // Diagnostics
  const pk = parsedFile.private_key;
  console.log('initSheets: typeof private_key =', typeof pk);
  if (typeof pk === 'string') {
    // show masked preview (first part only) to help debug in cloud logs
    const sample = pk.replace(/\n/g, '\\n').slice(0, 200);
    console.log('initSheets: private_key preview (masked):', sample.slice(0, 120));
    // normalize again defensively
    parsedFile.private_key = parsedFile.private_key.replace(/\\n/g, '\n');
  } else {
    const preview = Object.keys(parsedFile)
      .slice(0, 10)
      .reduce((acc, k) => {
        acc[k] = typeof parsedFile[k] === 'string' ? String(parsedFile[k]).slice(0, 80) : typeof parsedFile[k];
        return acc;
      }, {});
    console.error('initSheets: private_key is not a string. typeof=', typeof pk, ' keysPreview=', JSON.stringify(preview));
    throw new Error('Service account JSON does not contain a valid private_key string (check the uploaded secret).');
  }

  // write normalized copy and use it
  const normalizedDest = path.join(__dirname, 'service-account-normalized.json');
  fs.writeFileSync(normalizedDest, JSON.stringify(parsedFile), { encoding: 'utf8', mode: 0o600 });
  console.log('initSheets: wrote normalized key file ->', normalizedDest);

  // Initialize Google Auth
  const auth = new google.auth.GoogleAuth({
    keyFile: normalizedDest,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const client = await auth.getClient();
  sheetsClient = google.sheets({ version: 'v4', auth: client });
  spreadsheetId = sheetId;
  sheetName = sheetNameOverride && String(sheetNameOverride).trim().length ? String(sheetNameOverride).trim() : null;

  // Resolve sheet tab and return
  await resolveSheetTab();
  console.log('Sheets initialized. Using sheet tab:', sheetName);
  return true;
}

/* List sheet tab titles */
async function listSheetTitles() {
  await ensureInitialized();
  const meta = await sheetsClient.spreadsheets.get({ spreadsheetId });
  return (meta.data.sheets || []).map((s) => s.properties && s.properties.title).filter(Boolean);
}

async function resolveSheetTab() {
  await ensureInitialized();

  if (sheetName) {
    try {
      await readHeader(sheetName);
      return;
    } catch (err) {
      console.warn('Requested sheet tab failed to read header:', err.message || err);
    }
  }

  const titles = await listSheetTitles();
  if (!titles || titles.length === 0) throw new Error('No sheet tabs found in spreadsheet');

  if (sheetName) {
    const lower = sheetName.toLowerCase();
    const match = titles.find((t) => t.toLowerCase() === lower);
    if (match) {
      sheetName = match;
      return;
    }
  }

  sheetName = titles[0];
}

/* Read header row (row 1) */
async function readHeader(name) {
  await ensureInitialized();
  const range = safeRangeForRows(name, 1, 1);
  try {
    const resp = await sheetsClient.spreadsheets.values.get({ spreadsheetId, range });
    const vals = resp.data.values || [];
    if (!vals || vals.length === 0) throw new Error('Header row is empty');
    return vals[0].map((v) => (typeof v === 'string' ? v.trim() : v));
  } catch (err) {
    try {
      const fallbackRange = quoteSheetNameIfNeeded(name);
      const fallback = await sheetsClient.spreadsheets.values.get({ spreadsheetId, range: fallbackRange });
      const all = fallback.data.values || [];
      if (!all || all.length === 0) throw new Error('Sheet exists but contains no rows');
      return all[0].map((v) => (typeof v === 'string' ? v.trim() : v));
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      throw new Error(msg);
    }
  }
}

export async function getHeaders() {
  await ensureInitialized();
  if (!sheetName) await resolveSheetTab();
  try {
    return await readHeader(sheetName);
  } catch (err) {
    await resolveSheetTab();
    return await readHeader(sheetName);
  }
}

/* Read all rows and map to objects */
export async function getAllRows() {
  await ensureInitialized();
  if (!sheetName) await resolveSheetTab();

  const range = quoteSheetNameIfNeeded(sheetName);
  const resp = await sheetsClient.spreadsheets.values.get({ spreadsheetId, range });
  const vals = resp.data.values || [];
  if (vals.length === 0) return { headers: [], rows: [] };

  const headers = vals[0].map((h) => (typeof h === 'string' ? h.trim() : h));
  const dataRows = vals.slice(1).map((row) => {
    const obj = {};
    headers.forEach((h, idx) => {
      const val = row[idx] === undefined ? '' : row[idx];
      obj[h] = h === 'history' ? parseHistory(val) : val;
    });
    return obj;
  });

  return { headers, rows: dataRows };
}

/* Find row by trackingId (case-insensitive match). Returns { rowIndex, data } */
export async function getRowByTrackingId(trackingId) {
  await ensureInitialized();
  if (!sheetName) await resolveSheetTab();
  if (!trackingId) return null;

  const range = quoteSheetNameIfNeeded(sheetName);
  const resp = await sheetsClient.spreadsheets.values.get({ spreadsheetId, range });
  const vals = resp.data.values || [];
  if (vals.length < 2) return null;

  const headers = vals[0].map((h) => (typeof h === 'string' ? h.trim() : h));
  const trackingIdx = headers.findIndex((h) => String(h).trim() === 'trackingId');
  if (trackingIdx === -1) throw new Error('trackingId column not found in headers');

  const rows = vals.slice(1);
  const needle = String(trackingId).trim().toUpperCase();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rawCell = row[trackingIdx] === undefined ? '' : String(row[trackingIdx]);
    const cell = rawCell.replace(/\u00A0/g, ' ').trim().toUpperCase();

    if (cell === needle) {
      const obj = {};
      headers.forEach((h, idx) => {
        const val = row[idx] === undefined ? '' : row[idx];
        obj[h] = h === 'history' ? parseHistory(val) : val;
      });
      return { rowIndex: i + 2, data: obj };
    }
  }
  return null;
}

/* Append a new row using header order */
export async function createRow(rowData) {
  await ensureInitialized();
  if (!sheetName) await resolveSheetTab();
  const headers = await getHeaders();

  const payload = headers.map((h) => {
    if (h === 'history') return normalizeHistoryForStorage(rowData.history || []);
    return rowData[h] !== undefined && rowData[h] !== null ? String(rowData[h]) : '';
  });

  await sheetsClient.spreadsheets.values.append({
    spreadsheetId,
    range: quoteSheetNameIfNeeded(sheetName),
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [payload] },
  });

  const created = {};
  headers.forEach((h, idx) => {
    created[h] = h === 'history' ? parseHistory(payload[idx]) : payload[idx];
  });
  return created;
}

/* Update an existing row by trackingId */
export async function updateRow(trackingId, rowData) {
  await ensureInitialized();
  const found = await getRowByTrackingId(trackingId);
  if (!found) throw new Error('Tracking ID not found');

  const headers = await getHeaders();
  const payload = headers.map((h) => {
    if (h === 'history') return normalizeHistoryForStorage(rowData.history || []);
    return rowData[h] !== undefined && rowData[h] !== null ? String(rowData[h]) : '';
  });

  const lastCol = colLetter(headers.length);
  const quotedName = quoteSheetNameIfNeeded(sheetName);
  const range = `${quotedName}!A${found.rowIndex}:${lastCol}${found.rowIndex}`;

  await sheetsClient.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'RAW',
    requestBody: { values: [payload] },
  });

  const updated = {};
  headers.forEach((h, idx) => {
    updated[h] = h === 'history' ? parseHistory(payload[idx]) : payload[idx];
  });
  return updated;
}

/* Delete a row by trackingId */
export async function deleteRow(trackingId) {
  await ensureInitialized();
  const found = await getRowByTrackingId(trackingId);
  if (!found) throw new Error('Tracking ID not found');

  const meta = await sheetsClient.spreadsheets.get({ spreadsheetId });
  const sheetMeta = (meta.data.sheets || []).find((s) => s.properties && s.properties.title === sheetName);
  if (!sheetMeta) throw new Error('Sheet tab not found for deletion');
  const sheetId = sheetMeta.properties.sheetId;

  await sheetsClient.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex: found.rowIndex - 1,
              endIndex: found.rowIndex,
            },
          },
        },
      ],
    },
  });

  return true;
}
