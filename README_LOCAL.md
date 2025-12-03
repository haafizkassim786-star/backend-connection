# TKS Tracking System - Local Development Setup

## Overview
This is a complete Google Sheets-based tracking system with a Node.js/Express backend and React frontend.

## Prerequisites
- **Node.js** 16+ and npm
- **Google Cloud Project** with Sheets API enabled
- **Google Service Account** JSON key file
- **Google Sheets** spreadsheet with proper headers

## Backend Setup

### 1. Install Dependencies
```bash
cd backend
npm install
```

### 2. Create Google Service Account
- Go to [Google Cloud Console](https://console.cloud.google.com/)
- Create a new project or select an existing one
- Enable the Google Sheets API
- Create a Service Account with Editor role
- Generate and download the JSON key file
- Place the JSON file in the `backend/` folder as `service-account.json`

### 3. Create Google Sheets
- Create a new Google Sheet or use an existing one
- Add the following headers in the first row:
  ```
  trackingId | status | origin | destination | lastUpdated | estimatedDelivery | history
  ```
- Share the sheet with the service account email (found in the JSON key file)
- Copy the Spreadsheet ID from the URL

### 4. Configure Environment Variables
```bash
cp .env.example .env
```

Update `.env` with:
```
PORT=5000
SPREADSHEET_ID=your_google_sheet_id_here
SERVICE_ACCOUNT_KEY_PATH=./service-account.json
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin123
JWT_SECRET=your_random_secret_key_here
ALLOWED_ORIGINS=http://localhost:3000
```

### 5. Start Backend Server
```bash
npm start
```

The server will run on `http://localhost:5000`

## Frontend Setup

### 1. Install Dependencies
```bash
cd frontend
npm install
```

### 2. Configure Environment Variables
```bash
cp .env.example .env
```

Update `.env` with:
```
REACT_APP_API_BASE=http://localhost:5000
REACT_APP_EMAILJS_SERVICE_ID=your_service_id_here
REACT_APP_EMAILJS_TEMPLATE_ID=your_template_id_here
REACT_APP_EMAILJS_PUBLIC_KEY=your_public_key_here
```

### 3. Start Frontend Development Server
```bash
npm start
```

The frontend will open at `http://localhost:3000`

## API Endpoints

### Public Endpoints

**Get Tracking by ID**
```bash
GET /api/track?id=TKS12345678
```

**Create/Update Tracking**
```bash
POST /api/track
Content-Type: application/json

{
  "trackingId": "TKS12345678",
  "status": "In Transit",
  "origin": "Singapore",
  "destination": "India",
  "lastUpdated": "2025-02-01 13:20",
  "estimatedDelivery": "2025-02-05",
  "history": "[{\"date\":\"2025-02-01\",\"location\":\"Singapore Hub\",\"message\":\"Shipment Received\",\"completed\":true}]"
}
```

### Admin Endpoints (Protected)

**Admin Login**
```bash
POST /api/admin/login
Content-Type: application/json

{
  "username": "admin",
  "password": "admin123"
}

Response:
{
  "token": "eyJhbGciOiJIUzI1NiIs..."
}
```

**Get All Trackings**
```bash
GET /api/admin/trackings
Authorization: Bearer <token>
```

**Get Single Tracking**
```bash
GET /api/admin/track/TKS12345678
Authorization: Bearer <token>
```

**Delete Tracking**
```bash
DELETE /api/admin/track/TKS12345678
Authorization: Bearer <token>
```

## Frontend Usage

### Public Tracking
Navigate to `/tracking` and enter a tracking ID to view shipment status and history.

### Admin Dashboard
1. Navigate to `/admin/login`
2. Login with credentials from `.env`
3. Access `/admin/dashboard` to:
   - View all tracking records
   - Create new records
   - Edit existing records
   - Delete records

## Sample cURL Tests

### Test Public Tracking
```bash
curl "http://localhost:5000/api/track?id=TKS12345678"
```

### Test Admin Login
```bash
curl -X POST http://localhost:5000/api/admin/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'
```

### Test Protected Endpoint
```bash
curl "http://localhost:5000/api/admin/trackings" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

### Create New Tracking
```bash
curl -X POST http://localhost:5000/api/track \
  -H "Content-Type: application/json" \
  -d '{
    "trackingId": "TKS99999999",
    "status": "Processing",
    "origin": "Singapore",
    "destination": "Thailand",
    "lastUpdated": "2025-02-02 10:00",
    "estimatedDelivery": "2025-02-08",
    "history": "[]"
  }'
```

## Troubleshooting

### Backend Won't Start
- Check `.env` file exists and has correct values
- Verify `service-account.json` is in the correct location
- Ensure Google Sheets API is enabled
- Check Node.js version: `node --version` (should be 16+)

### Cannot Connect to Google Sheets
- Verify the Spreadsheet ID is correct
- Ensure service account email is added to the sheet with Editor access
- Check headers are in the first row with exact names

### Frontend Can't Connect to Backend
- Verify backend is running: `curl http://localhost:5000/health`
- Check `REACT_APP_API_BASE` in `.env` is correct
- Ensure CORS is not blocking requests
- Check browser console for detailed error messages

### Admin Login Fails
- Verify credentials in `.env` match what you're entering
- Check token expiration (24 hours default)
- Clear browser cache/localStorage if needed

## Production Deployment

Before deploying:
1. Change `JWT_SECRET` to a strong random value
2. Update `ALLOWED_ORIGINS` for your production domain
3. Use environment variables or secrets management for sensitive data
4. Set `NODE_ENV=production`
5. Enable HTTPS
6. Implement rate limiting and input validation

## Notes

- History field must be valid JSON when stored
- All dates should be in consistent format (e.g., `YYYY-MM-DD HH:mm`)
- Tracking IDs must match format `TKS` followed by 8 digits
- Admin tokens expire after 24 hours (configurable in `server.js`)
