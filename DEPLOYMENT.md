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
SUPABASE_SERVICE_KEY=your_supabase_service_role_key
JWT_SECRET=your_jwt_secret_key
JWT_EXPIRES_IN=7d
CORS_ORIGIN=https://your-client-url.vercel.app
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100
```

**Important**: Get the `SUPABASE_SERVICE_KEY` from your Supabase project settings → API → service_role key. This key is required for server-side storage operations like file uploads.

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

### Supabase Storage (VeriBoard_bucket)

- Create a bucket in your Supabase project named `VeriBoard_bucket`.
- Create two folders inside the bucket:
  - `profile_pic/` - for storing user profile pictures
  - `resume/` - for storing user resume/CV files
- For server-side uploads (recommended), provide the `SUPABASE_SERVICE_KEY` env var (service role key). This key is required to perform storage uploads and to create signed URLs from the backend.
- If you want public URLs for uploaded files, mark the bucket public in Supabase or call `getPublicUrl` from the helper. For private buckets, use signed URLs.

Code notes:
- Server helper available at `server/src/utils/supabaseStorage.js` provides:
  - `uploadProfilePicture(userId, fileBuffer, fileName, {upsert})` - uploads to profile_pic/ folder
  - `uploadResume(userId, fileBuffer, fileName, {upsert})` - uploads to resume/ folder with timestamp
  - `uploadToBucket(bucket, path, fileBuffer, {contentType, upsert})` - generic upload function
  - `getPublicUrl(bucket, path)` - get public URL for public buckets
  - `createSignedUrl(bucket, path, expiresInSeconds)` - create temporary signed URL for private buckets
- The main Supabase client is in `server/src/config/supabase.js` and prefers `SUPABASE_SERVICE_KEY` when present.

Example usage:
```js
import { uploadProfilePicture, uploadResume } from './utils/supabaseStorage.js';

// Upload profile picture
const { data, error, url } = await uploadProfilePicture(userId, fileBuffer, 'avatar.jpg');

// Upload resume
const { data, error, url } = await uploadResume(userId, fileBuffer, 'resume.pdf');
```
