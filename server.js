import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import { 
  initSheets, 
  getHeaders, 
  getAllRows, 
  getRowByTrackingId, 
  createRow, 
  updateRow, 
  deleteRow 
} from './sheets.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',');

app.use(express.json());
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '24h' });
    return res.json({ token });
  }

  res.status(401).json({ error: 'Invalid credentials' });
});

/*
  GET /api/track
  - Ensures a consistent response shape: returns an object where `history` is always an array.
  - Adds logging to help debug mismatched formats.
*/
// Replace existing GET /api/track handler with this
app.get('/api/track', async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Tracking ID required' });

    const result = await getRowByTrackingId(id);
    if (!result) return res.status(404).json({ error: 'Tracking ID not found' });

    const raw = { ...result.data };

    // Map common header variants to canonical frontend keys
    const keyMap = {
      'trackingid': 'trackingId', 'tracking id': 'trackingId', 'id': 'trackingId',
      'status': 'status', 'state': 'status',
      'origin': 'origin', 'from': 'origin',
      'destination': 'destination', 'to': 'destination',
      'lastupdated': 'lastUpdated', 'last updated': 'lastUpdated', 'updated': 'lastUpdated',
      'estimateddelivery': 'estimatedDelivery', 'estimated delivery': 'estimatedDelivery', 'eta': 'estimatedDelivery',
      'history': 'history', 'events': 'history'
    };

    // Normalize keys
    const normalized = {};
    Object.keys(raw).forEach(k => {
      const lower = String(k).trim().toLowerCase();
      const mapped = keyMap[lower] || String(k).trim();
      normalized[mapped] = raw[k];
    });

    // Build canonical object with defaults
    const data = {
      trackingId: normalized.trackingId || '',
      status: normalized.status || '',
      origin: normalized.origin || '',
      destination: normalized.destination || '',
      lastUpdated: normalized.lastUpdated || '',
      estimatedDelivery: normalized.estimatedDelivery || '',
      ...normalized,
    };

    // Ensure history is an array
    if (data.history === undefined || data.history === null) data.history = [];
    else if (typeof data.history === 'string') {
      try { data.history = JSON.parse(data.history); }
      catch { data.history = []; }
    } else if (!Array.isArray(data.history)) {
      data.history = [];
    }

    // Ensure history items are objects
    data.history = data.history.map(h => (h && typeof h === 'object' ? h : {}));

    console.log('[GET /api/track] returning normalized for', id, 'historyLength=', data.history.length);
    return res.json(data);
  } catch (error) {
    console.error('Error in GET /api/track:', error);
    res.status(500).json({ error: error.message });
  }
});

/*
  POST /api/track
  - Accepts row payloads from Admin UI or other clients.
  - Normalizes incoming history to always be an array before passing to sheets.js
*/
app.post('/api/track', async (req, res) => {
  try {
    const rowData = req.body;

    if (!rowData || !rowData.trackingId) {
      return res.status(400).json({ error: 'trackingId is required' });
    }

    // Normalize incoming history so sheets.js always receives an array
    if (rowData.history === undefined || rowData.history === null) {
      rowData.history = [];
    } else if (typeof rowData.history === 'string') {
      try {
        const parsed = JSON.parse(rowData.history);
        rowData.history = Array.isArray(parsed) ? parsed : [];
      } catch {
        // fallback: attempt to treat the string as a single message entry
        rowData.history = [{ date: '', location: '', message: String(rowData.history) }];
      }
    } else if (!Array.isArray(rowData.history)) {
      rowData.history = [];
    }

    const existing = await getRowByTrackingId(rowData.trackingId);

    if (existing) {
      const updated = await updateRow(rowData.trackingId, rowData);
      console.log('[POST /api/track] updated', rowData.trackingId);
      return res.json({ created: false, data: updated });
    }

    const created = await createRow(rowData);
    console.log('[POST /api/track] created', rowData.trackingId);
    res.status(201).json({ created: true, data: created });
  } catch (error) {
    console.error('Error in POST /api/track:', error);
    res.status(500).json({ error: error.message });
  }
});

// Admin list endpoint (unchanged logic, kept for compatibility)
app.get('/api/admin/trackings', authenticateToken, async (req, res) => {
  try {
    // fetch headers (array)
    const headers = await getHeaders();

    // getAllRows() may return { headers, rows } or something else depending on implementation,
    // so normalize to ensure `rows` is always an array.
    const all = await getAllRows();

    let rows = [];

    if (all && Array.isArray(all.rows)) {
      rows = all.rows;
    } else if (Array.isArray(all)) {
      // in case getAllRows returned rows array directly
      rows = all;
    } else if (all && typeof all === 'object' && all.rows && Array.isArray(all.rows)) {
      rows = all.rows;
    } else {
      // last-resort: try to coerce any object values into an array
      if (all && typeof all === 'object') {
        const maybeRows = Object.values(all);
        // prefer arrays inside object values
        const foundArray = maybeRows.find(v => Array.isArray(v));
        if (foundArray) rows = foundArray;
        else rows = [];
      } else {
        rows = [];
      }
    }

    // ensure rows is an array of objects
    rows = rows.map(r => (r && typeof r === 'object' ? r : { trackingId: String(r) }));

    return res.json({ headers, rows });
  } catch (error) {
    console.error('Error in GET /api/admin/trackings:', error);
    return res.status(500).json({ error: error.message || 'Server error' });
  }
});

app.get('/api/admin/track/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const headers = await getHeaders();
    const result = await getRowByTrackingId(id);

    if (!result) {
      return res.status(404).json({ error: 'Tracking ID not found' });
    }

    res.json({ headers, row: result.data });
  } catch (error) {
    console.error('Error in GET /api/admin/track/:id:', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/admin/track/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    await deleteRow(id);
    res.json({ message: 'Tracking record deleted successfully' });
  } catch (error) {
    console.error('Error in DELETE /api/admin/track/:id:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

async function start() {
  try {
    const spreadsheetId = process.env.SPREADSHEET_ID;
    const serviceAccountPath = process.env.SERVICE_ACCOUNT_KEY_PATH;

    if (!spreadsheetId || !serviceAccountPath) {
      throw new Error('SPREADSHEET_ID and SERVICE_ACCOUNT_KEY_PATH must be set in .env');
    }

    await initSheets(serviceAccountPath, spreadsheetId);

    app.listen(PORT, () => {
      console.log(`Backend server running on http://localhost:${PORT}`);
      console.log('Google Sheets integration ready');
    });
  } catch (error) {
    console.error('Failed to start server:', error.message);
    process.exit(1);
  }
}

start();
