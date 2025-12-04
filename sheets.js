// sheets.js (replace existing with this file)
// ESM module — robust initialization: normalizes private_key newlines and accepts env or file input
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let sheetsClient = null;
let spreadsheetId = null;
let sheetName = null;

/* helpers (same as original) */
function colLetter(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function parseHistory(historyStr) {
  try {
    if (historyStr === undefined || historyStr === null || historyStr === '') return [];
    if (Array.isArray(historyStr)) return historyStr;
    if (typeof historyStr === 'object') return Array.isArray(historyStr) ? historyStr : [];

    if (typeof historyStr === 'string') {
      const trimmed = historyStr.trim();
      if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try {
          const parsed = JSON.parse(trimmed);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          try {
            const unescaped = trimmed.replace(/^"(.+)"$/, '$1').replace(/\\"/g, '"');
            const parsed2 = JSON.parse(unescaped);
            return Array.isArray(parsed2) ? parsed2 : [];
          } catch {
            return [];
          }
        }
      }
      return [{ date: '', location: '', message: trimmed }];
    }
    return [];
  } catch {
    return [];
  }
}

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

function quoteSheetNameIfNeeded(name) {
  if (!name) return name;
  const needsQuote = /[ \'\!\,\(\)\[\]\{\}\+\-\*\:\?\/\\]/.test(name);
  return needsQuote ? `'${name.replace(/'/g, "''")}'` : name;
}

function safeRangeForRows(name, fromRow = 1, toRow = null) {
  const quoted = quoteSheetNameIfNeeded(name);
  if (toRow !== null && toRow !== undefined) {
    return `${quoted}!${fromRow}:${toRow}`;
  }
  return `${quoted}!${fromRow}:`;
}

async function ensureInitialized() {
  if (!sheetsClient) throw new Error('Sheets client not initialized. Call initSheets() first.');
}

/**
 * initSheets(serviceAccountPathArg, sheetId, sheetNameOverride='')
 *
 * Behavior:
 *  - If environment variable SERVICE_ACCOUNT_JSON or SERVICE_ACCOUNT_KEY_JSON exists,
 *    it prefers that (accepts raw JSON or base64-encoded JSON).
 *  - Otherwise it uses serviceAccountPathArg or SERVICE_ACCOUNT_KEY_PATH.
 *  - It normalizes private_key by replacing literal "\\n" sequences with real newlines.
 *  - Writes a secure normalized temp file in the same dir and uses keyFile for GoogleAuth.
 */
export async function initSheets(serviceAccountPathArg, sheetId, sheetNameOverride = '') {
  // Prefer env-provided JSON (raw or base64)
  const envJson = process.env.SERVICE_ACCOUNT_JSON || process.env.SERVICE_ACCOUNT_KEY_JSON || '';
  let keyFilePathCandidate = serviceAccountPathArg || process.env.SERVICE_ACCOUNT_KEY_PATH || '';

  // If env JSON is present, decode/normalize and write to temp file
  if (envJson && envJson.trim()) {
    let raw = envJson.trim();

    // Heuristic: if it looks base64-like and not starting with '{', try decode
    if (!raw.startsWith('{') && /^[A-Za-z0-9+/=\s]+$/.test(raw)) {
      try {
        const decoded = Buffer.from(raw, 'base64').toString('utf8');
        if (decoded.trim().startsWith('{')) raw = decoded;
      } catch {
        // ignore decode errors; keep raw
      }
    }

    // Try parse JSON so we can normalize private_key
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }

    const dest = path.join(__dirname, 'service-account-from-env.json');

    if (parsed && parsed.private_key && typeof parsed.private_key === 'string') {
      parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
      fs.writeFileSync(dest, JSON.stringify(parsed), { encoding: 'utf8', mode: 0o600 });
      keyFilePathCandidate = dest;
    } else {
      // If not JSON or no private_key, write raw content (best-effort)
      fs.writeFileSync(dest, raw, { encoding: 'utf8', mode: 0o600 });
      keyFilePathCandidate = dest;
    }
  }

  // If no env JSON, but we have a file path, try to read and normalize it if needed
  if (keyFilePathCandidate && !path.isAbsolute(keyFilePathCandidate)) {
    keyFilePathCandidate = path.join(__dirname, keyFilePathCandidate);
  }

  if (!keyFilePathCandidate) {
    throw new Error('No service account key provided. Set SERVICE_ACCOUNT_KEY_PATH or SERVICE_ACCOUNT_JSON env var.');
  }

  // If the candidate exists as a file, read and normalize its private_key if needed
  let finalKeyPath = keyFilePathCandidate;
  if (fs.existsSync(keyFilePathCandidate)) {
    try {
      const rawFile = fs.readFileSync(keyFilePathCandidate, 'utf8');
      let parsedFile = null;
      try {
        parsedFile = JSON.parse(rawFile);
      } catch {
        parsedFile = null;
      }

      if (parsedFile && parsedFile.private_key && typeof parsedFile.private_key === 'string') {
        // If private_key contains literal backslash-n sequences, fix them
        if (parsedFile.private_key.includes('\\n')) {
          parsedFile.private_key = parsedFile.private_key.replace(/\\n/g, '\n');
          const normalizedDest = path.join(__dirname, 'service-account-normalized.json');
          fs.writeFileSync(normalizedDest, JSON.stringify(parsedFile), { encoding: 'utf8', mode: 0o600 });
          finalKeyPath = normalizedDest;
        } else {
          // no escaped sequences, use original file
          finalKeyPath = keyFilePathCandidate;
        }
      } else {
        // Not JSON or missing private_key — still use original path (may error later)
        finalKeyPath = keyFilePathCandidate;
      }
    } catch (e) {
      // can't read file — rethrow a clearer message
      throw new Error(`Failed to read service account key at ${keyFilePathCandidate}: ${e.message}`);
    }
  } else {
    // Candidate file doesn't exist: throw helpful message
    throw new Error(`Service account key JSON not found at ${keyFilePathCandidate}`);
  }

  // Initialize Google Auth using the normalized key file
  const auth = new google.auth.GoogleAuth({
    keyFile: finalKeyPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const client = await auth.getClient();
  sheetsClient = google.sheets({ version: 'v4', auth: client });
  spreadsheetId = sheetId;
  sheetName = sheetNameOverride && String(sheetNameOverride).trim().length ? String(sheetNameOverride).trim() : null;

  // Verify sheet tabs
  await resolveSheetTab();
  console.log('Sheets initialized. Using sheet tab:', sheetName);
  return true;
}

/* Remaining functions follow the same patterns as original file (read header, getAllRows, getRowByTrackingId, createRow, updateRow, deleteRow) */
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

  const range = quoteSheetNameIfNeeded(sheetName);
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
  headers.forEach((h, idx) => {
    created[h] = h === 'history' ? parseHistory(payload[idx]) : payload[idx];
  });
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
  headers.forEach((h, idx) => {
    updated[h] = h === 'history' ? parseHistory(payload[idx]) : payload[idx];
  });
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
