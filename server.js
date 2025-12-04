// server.js
// ESM entry point (matches your sheets.js style)
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import path from 'path';
import {
  initSheets,
  getHeaders,
  getAllRows,
  getRowByTrackingId,
  createRow,
  updateRow,
  deleteRow,
} from './sheets.js';

dotenv.config();

const app = express();

// Render provides PORT via env; default to 5000 for local dev
const PORT = Number(process.env.PORT) || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// ALLOWED_ORIGINS may be comma-separated
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(express.json({ limit: '1mb' }));

app.use(
  cors({
    origin: (origin, callback) => {
      // allow non-browser requests (e.g. curl, server-to-server) with no origin
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  })
);

// Basic logger for Render logs
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Access token required' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
};

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '24h' });
    return res.json({ token });
  }

  res.status(401).json({ error: 'Invalid credentials' });
});

// GET /api/track?id=TRACKINGID
app.get('/api/track', async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Tracking ID required' });

    const result = await getRowByTrackingId(id);
    if (!result) return res.status(404).json({ error: 'Tracking ID not found' });

    // reuse normalization logic present in your original server; keep response shape stable
    const raw = { ...result.data };

    const keyMap = {
      trackingid: 'trackingId',
      'tracking id': 'trackingId',
      id: 'trackingId',
      status: 'status',
      state: 'status',
      origin: 'origin',
      from: 'origin',
      destination: 'destination',
      to: 'destination',
      lastupdated: 'lastUpdated',
      'last updated': 'lastUpdated',
      updated: 'lastUpdated',
      estimateddelivery: 'estimatedDelivery',
      'estimated delivery': 'estimatedDelivery',
      eta: 'estimatedDelivery',
      history: 'history',
      events: 'history',
    };

    const normalized = {};
    Object.keys(raw).forEach(k => {
      const lower = String(k).trim().toLowerCase();
      const mapped = keyMap[lower] || String(k).trim();
      normalized[mapped] = raw[k];
    });

    const data = {
      trackingId: normalized.trackingId || '',
      status: normalized.status || '',
      origin: normalized.origin || '',
      destination: normalized.destination || '',
      lastUpdated: normalized.lastUpdated || '',
      estimatedDelivery: normalized.estimatedDelivery || '',
      ...normalized,
    };

    if (data.history === undefined || data.history === null) data.history = [];
    else if (typeof data.history === 'string') {
      try { data.history = JSON.parse(data.history); }
      catch { data.history = []; }
    } else if (!Array.isArray(data.history)) {
      data.history = [];
    }

    data.history = data.history.map(h => (h && typeof h === 'object' ? h : {}));

    return res.json(data);
  } catch (error) {
    console.error('Error GET /api/track:', error);
    return res.status(500).json({ error: error.message || 'Server error' });
  }
});

app.post('/api/track', async (req, res) => {
  try {
    const rowData = req.body;
    if (!rowData || !rowData.trackingId) return res.status(400).json({ error: 'trackingId is required' });

    if (rowData.history === undefined || rowData.history === null) {
      rowData.history = [];
    } else if (typeof rowData.history === 'string') {
      try {
        const parsed = JSON.parse(rowData.history);
        rowData.history = Array.isArray(parsed) ? parsed : [];
      } catch {
        rowData.history = [{ date: '', location: '', message: String(rowData.history) }];
      }
    } else if (!Array.isArray(rowData.history)) {
      rowData.history = [];
    }

    const existing = await getRowByTrackingId(rowData.trackingId);

    if (existing) {
      const updated = await updateRow(rowData.trackingId, rowData);
      return res.json({ created: false, data: updated });
    }

    const created = await createRow(rowData);
    res.status(201).json({ created: true, data: created });
  } catch (error) {
    console.error('Error POST /api/track:', error);
    return res.status(500).json({ error: error.message || 'Server error' });
  }
});

// Admin endpoints
app.get('/api/admin/trackings', authenticateToken, async (req, res) => {
  try {
    const headers = await getHeaders();
    const all = await getAllRows();

    let rows = [];
    if (all && Array.isArray(all.rows)) rows = all.rows;
    else if (Array.isArray(all)) rows = all;
    else if (all && typeof all === 'object' && Array.isArray(all.rows)) rows = all.rows;
    else if (all && typeof all === 'object') {
      const maybeRows = Object.values(all);
      const foundArray = maybeRows.find(v => Array.isArray(v));
      rows = foundArray || [];
    } else rows = [];

    rows = rows.map(r => (r && typeof r === 'object' ? r : { trackingId: String(r) }));

    return res.json({ headers, rows });
  } catch (error) {
    console.error('Error GET /api/admin/trackings:', error);
    return res.status(500).json({ error: error.message || 'Server error' });
  }
});

app.get('/api/admin/track/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const headers = await getHeaders();
    const result = await getRowByTrackingId(id);
    if (!result) return res.status(404).json({ error: 'Tracking ID not found' });
    return res.json({ headers, row: result.data });
  } catch (error) {
    console.error('Error GET /api/admin/track/:id:', error);
    return res.status(500).json({ error: error.message || 'Server error' });
  }
});

app.delete('/api/admin/track/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    await deleteRow(id);
    return res.json({ message: 'Tracking record deleted successfully' });
  } catch (error) {
    console.error('Error DELETE /api/admin/track/:id:', error);
    return res.status(500).json({ error: error.message || 'Server error' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Root to show useful info in Render logs
app.get('/', (req, res) => {
  res.json({
    status: 'tracking-backend',
    env: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString(),
  });
});

async function start() {
  try {
    // Env var name expected: SERVICE_ACCOUNT_KEY_PATH
    // Accept common Render secret path: /etc/secrets/service-account.json
    const spreadsheetId = process.env.SPREADSHEET_ID;
    const serviceAccountPath =
      process.env.SERVICE_ACCOUNT_KEY_PATH ||
      process.env.SERVICE_ACCOUNT_KEY_path || // fallback to old name if present
      '/etc/secrets/service-account.json';

    if (!spreadsheetId || !serviceAccountPath) {
      throw new Error('SPREADSHEET_ID and SERVICE_ACCOUNT_KEY_PATH must be set in env');
    }

    await initSheets(serviceAccountPath, spreadsheetId, process.env.SHEET_NAME || '');

    app.listen(PORT, () => {
      console.log(`Backend server running on port ${PORT}`);
      console.log('Google Sheets integration ready');
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
