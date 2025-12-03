// backend/sheets.js
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let sheetsClient = null;
let spreadsheetId = null;
let sheetName = null;

function colLetter(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Robustly parse the 'history' value from the sheet.
 * Accepts:
 * - an actual array (returned directly)
 * - a JSON array string: "[{...}]"
 * - a double-encoded string (e.g. '"[...]"')
 * - anything else -> returns []
 */
function parseHistory(historyStr) {
  try {
    if (historyStr === undefined || historyStr === null || historyStr === '') return [];
    // If already an array (some Google APIs may already parse it)
    if (Array.isArray(historyStr)) return historyStr;

    // If it's an object (not array), try to coerce to array when reasonable
    if (typeof historyStr === 'object') {
      return Array.isArray(historyStr) ? historyStr : [];
    }

    // If it's a string, attempt parsing JSON
    if (typeof historyStr === 'string') {
      // Trim invisible characters that often come from Sheets
      const trimmed = historyStr.trim();

      // If it looks like an array already, parse it
      if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try {
          const parsed = JSON.parse(trimmed);
          return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
          // try forgiving: sometimes it's double-encoded, like "\"[...]"\"", unescape then parse
          try {
            const unescaped = trimmed.replace(/^"(.+)"$/, '$1').replace(/\\"/g, '"');
            const parsed2 = JSON.parse(unescaped);
            return Array.isArray(parsed2) ? parsed2 : [];
          } catch (e2) {
            return [];
          }
        }
      }

      // If not JSON (plain text), return as single-entry array (so UI can display something)
      return [{ date: '', location: '', message: trimmed }];
    }

    // Anything else -> empty
    return [];
  } catch {
    return [];
  }
}

/**
 * Ensures a stable, valid JSON string is stored in the sheet for `history`.
 * - Arrays -> JSON.stringify(array)
 * - Strings that parse -> normalized JSON string of array
 * - Plain strings -> JSON string of [string]
 * - Otherwise -> '[]'
 */
function normalizeHistoryForStorage(history) {
  try {
    if (history === undefined || history === null) return '[]';
    if (Array.isArray(history)) return JSON.stringify(history);
    if (typeof history === 'string') {
      const trimmed = history.trim();
      // If it already looks like JSON array, try parse then stringify to normalize
      if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try {
          const parsed = JSON.parse(trimmed);
          return JSON.stringify(Array.isArray(parsed) ? parsed : []);
        } catch {
          // try to unescape and parse
          try {
            const unescaped = trimmed.replace(/^"(.+)"$/, '$1').replace(/\\"/g, '"');
            const parsed2 = JSON.parse(unescaped);
            return JSON.stringify(Array.isArray(parsed2) ? parsed2 : []);
          } catch {
            // fallback: wrap as single-message
            return JSON.stringify([{ date: '', location: '', message: trimmed }]);
          }
        }
      }
      // plain text -> wrap
      return JSON.stringify([{ date: '', location: '', message: trimmed }]);
    }
    // If object but not array -> empty array string
    return '[]';
  } catch {
    return '[]';
  }
}

function quoteSheetNameIfNeeded(name) {
  if (!name) return name;
  const needsQuote = /[ \'\!\,\(\)\[\]\{\}\+\-\*\:\?\/\\]/.test(name);
  return needsQuote ? `'${name.replace(/'/g, "''")}'` : name;
}

/* Build range:
   - fromRow only -> returns "SheetName!fromRow:"  (fromRow .. end)
   - fromRow and toRow -> "SheetName!fromRow:toRow"
*/
function safeRangeForRows(name, fromRow = 1, toRow = null) {
  const quoted = quoteSheetNameIfNeeded(name);
  if (toRow !== null && toRow !== undefined) {
    return `${quoted}!${fromRow}:${toRow}`;
  }
  // fromRow to end of sheet
  return `${quoted}!${fromRow}:`;
}

async function ensureInitialized() {
  if (!sheetsClient) throw new Error('Sheets client not initialized. Call initSheets() first.');
}

export async function initSheets(serviceAccountPath, sheetId, sheetNameOverride = '') {
  const keyPath = path.isAbsolute(serviceAccountPath)
    ? serviceAccountPath
    : path.join(__dirname, serviceAccountPath);

  if (!fs.existsSync(keyPath)) {
    throw new Error(`Service account key JSON not found at ${keyPath}`);
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const client = await auth.getClient();
  sheetsClient = google.sheets({ version: 'v4', auth: client });
  spreadsheetId = sheetId;
  sheetName = sheetNameOverride && String(sheetNameOverride).trim().length ? String(sheetNameOverride).trim() : null;

  // Resolve sheetName to a valid tab if necessary
  await resolveSheetTab();
  console.log('Sheets initialized. Using sheet tab:', sheetName);
  return true;
}

async function listSheetTitles() {
  await ensureInitialized();
  const meta = await sheetsClient.spreadsheets.get({ spreadsheetId });
  return (meta.data.sheets || []).map(s => s.properties && s.properties.title).filter(Boolean);
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
    const match = titles.find(t => t.toLowerCase() === lower);
    if (match) {
      sheetName = match;
      return;
    }
  }

  sheetName = titles[0];
}

async function readHeader(name) {
  await ensureInitialized();
  const range = safeRangeForRows(name, 1, 1);
  try {
    const resp = await sheetsClient.spreadsheets.values.get({ spreadsheetId, range });
    const vals = resp.data.values || [];
    if (!vals || vals.length === 0) throw new Error('Header row is empty');
    return vals[0].map(v => (typeof v === 'string' ? v.trim() : v));
  } catch (err) {
    // fallback: try reading full sheet and take first row
    try {
      const fallbackRange = quoteSheetNameIfNeeded(name);
      const fallback = await sheetsClient.spreadsheets.values.get({ spreadsheetId, range: fallbackRange });
      const all = fallback.data.values || [];
      if (!all || all.length === 0) throw new Error('Sheet exists but contains no rows');
      return all[0].map(v => (typeof v === 'string' ? v.trim() : v));
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

export async function getAllRows() {
  await ensureInitialized();
  if (!sheetName) await resolveSheetTab();

  // Use the sheet tab name (quoted if needed) to read the entire sheet
  const range = quoteSheetNameIfNeeded(sheetName); // <-- important: use full sheet name, not "1:"
  const resp = await sheetsClient.spreadsheets.values.get({ spreadsheetId, range });
  const vals = resp.data.values || [];
  if (vals.length === 0) return { headers: [], rows: [] };

  const headers = vals[0].map(h => (typeof h === 'string' ? h.trim() : h));
  const dataRows = vals.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, idx) => {
      const val = row[idx] === undefined ? '' : row[idx];
      obj[h] = h === 'history' ? parseHistory(val) : val;
    });
    return obj;
  });

  return { headers, rows: dataRows };
}

export async function getRowByTrackingId(trackingId) {
  await ensureInitialized();
  if (!sheetName) await resolveSheetTab();
  if (!trackingId) return null;

  // Read the whole sheet by sheet name (quoted if required)
  const range = quoteSheetNameIfNeeded(sheetName);
  const resp = await sheetsClient.spreadsheets.values.get({ spreadsheetId, range });
  const vals = resp.data.values || [];
  if (vals.length < 2) return null;

  const headers = vals[0].map(h => (typeof h === 'string' ? h.trim() : h));
  const trackingIdx = headers.findIndex(h => String(h).trim() === 'trackingId');
  if (trackingIdx === -1) throw new Error('trackingId column not found in headers');

  const rows = vals.slice(1);
  const needle = String(trackingId).trim().toUpperCase();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    // Normalize the cell value: toString, trim, remove non-breaking spaces
    const rawCell = row[trackingIdx] === undefined ? '' : String(row[trackingIdx]);
    const cell = rawCell.replace(/\u00A0/g, ' ').trim().toUpperCase();

    if (cell === needle) {
      const obj = {};
      headers.forEach((h, idx) => {
        const val = row[idx] === undefined ? '' : row[idx];
        obj[h] = h === 'history' ? parseHistory(val) : val;
      });
      return { rowIndex: i + 2, data: obj }; // actual sheet row index
    }
  }
  return null;
}

export async function createRow(rowData) {
  await ensureInitialized();
  if (!sheetName) await resolveSheetTab();
  const headers = await getHeaders();

  const payload = headers.map(h => {
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
  headers.forEach((h, idx) => { created[h] = h === 'history' ? parseHistory(payload[idx]) : payload[idx]; });
  return created;
}

export async function updateRow(trackingId, rowData) {
  await ensureInitialized();
  const found = await getRowByTrackingId(trackingId);
  if (!found) throw new Error('Tracking ID not found');

  const headers = await getHeaders();
  const payload = headers.map(h => {
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
  headers.forEach((h, idx) => { updated[h] = h === 'history' ? parseHistory(payload[idx]) : payload[idx]; });
  return updated;
}

export async function deleteRow(trackingId) {
  await ensureInitialized();
  const found = await getRowByTrackingId(trackingId);
  if (!found) throw new Error('Tracking ID not found');

  const meta = await sheetsClient.spreadsheets.get({ spreadsheetId });
  const sheetMeta = (meta.data.sheets || []).find(s => s.properties && s.properties.title === sheetName);
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
