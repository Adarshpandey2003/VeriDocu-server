# VeriBoard Server

Node.js backend API for VeriBoard - Professional Verification Platform

## Features

- 🔒 JWT Authentication
- 🛡️ Security with Helmet
- 📊 PostgreSQL Database
- ✉️ Email Notifications (Postmark)
- 📝 Audit Logging
- 🔐 GDPR Compliant
- ⚡ Rate Limiting

## Getting Started

### Prerequisites

- Node.js 18+
- PostgreSQL 14+
- npm or yarn

### Installation

1. Install dependencies:
```bash
npm install
```

2. Copy environment file:
```bash
copy .env.example .env
```

3. Update `.env` with your database credentials and other configuration

4. Create database:
```bash
createdb veriboard
```

5. Run migrations:
```bash
npm run db:migrate
```

6. (Optional) Seed database:
```bash
npm run db:seed
```

7. Start development server:
```bash
npm run dev
```

The API will be available at `http://localhost:5000`

## Available Scripts

- `npm run dev` - Start development server with nodemon
- `npm start` - Start production server
- `npm run db:migrate` - Run database migrations
- `npm run db:seed` - Seed database with sample data

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login user
- `GET /api/auth/me` - Get current user (protected)

### Companies
- `GET /api/companies` - List companies
- `GET /api/companies/:slug` - Get company by slug
- `POST /api/companies` - Create company (protected)
- `PUT /api/companies/:id` - Update company (protected)

### Candidates
- `GET /api/candidates/:id` - Get candidate profile
- `PUT /api/candidates/:id` - Update candidate (protected)

### Jobs
- `GET /api/jobs` - List jobs
- `GET /api/jobs/:id` - Get job details
- `POST /api/jobs` - Create job (protected)

### Verifications (Admin)
- `GET /api/verifications/pending` - Get pending verifications
- `POST /api/verifications/:id/approve` - Approve verification
- `POST /api/verifications/:id/reject` - Reject verification

### Consent
- `GET /api/consent/requests` - Get consent requests (protected)
- `POST /api/consent/request/:candidateId` - Request consent
- `POST /api/consent/:id/grant` - Grant consent
- `POST /api/consent/:id/revoke` - Revoke consent

### Search
- `GET /api/search/candidates` - Search candidates
- `GET /api/search/companies` - Search companies

## Database Schema

See `database/schema.sql` for the complete database schema.

## Security

- All endpoints use HTTPS in production
- JWT tokens for authentication
- Rate limiting on all API routes
- Helmet for security headers
- Input validation with express-validator
- CORS configuration
- SQL injection protection with parameterized queries

## License

Proprietary - All rights reserved
