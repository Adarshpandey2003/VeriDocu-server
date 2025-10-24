# VeriDocu Server

Backend API for VeriDocu - Professional Verification Platform

## Deployment to Vercel

### Prerequisites
- Node.js 18+
- PostgreSQL database (recommended: Supabase)
- Vercel account

### Environment Variables

Set these in Vercel Dashboard (Project Settings → Environment Variables):

```
NODE_ENV=production
DATABASE_URL=your_postgresql_connection_string
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_KEY=your_supabase_service_key
JWT_SECRET=your_jwt_secret_key
JWT_EXPIRES_IN=7d
CORS_ORIGIN=https://your-client-url.vercel.app
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100
```

### Deploy

1. Push to GitHub:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/Adarshpandey2003/VeriDocu-server.git
   git push -u origin main
   ```

2. Import to Vercel:
   - Go to vercel.com
   - Click "New Project"
   - Import repository
   - Add environment variables
   - Deploy

### API Endpoints

- `GET /health` - Health check
- `POST /api/auth/login` - User login
- `POST /api/auth/register` - User registration
- `GET /api/jobs` - Get all jobs
- And more...

### Local Development

```bash
npm install
npm run dev
```

Server runs on http://localhost:5000
