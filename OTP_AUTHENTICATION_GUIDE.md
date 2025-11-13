# OTP Authentication Implementation Guide

## Overview
OTP (One-Time Password) email authentication has been implemented for both **registration** and **login** flows.

## What Changed

### 1. Environment Configuration
- **File**: `server/.env`
- **Change**: Set `ENABLE_OTP_ON_LOGIN=true` to enable OTP verification for login

### 2. Registration Flow (NEW)
Users now receive an OTP email when registering, and must verify before account creation.

#### Backend Changes
- **Endpoint**: `POST /api/auth/register`
- **Behavior**: 
  - Validates user data (name, email, password, accountType)
  - Checks if email already exists
  - Hashes password
  - Generates 6-digit OTP code
  - Stores OTP in `otp_codes` table with purpose='register'
  - Sends email via Resend with verification code
  - Returns `requiresVerification: true` instead of creating account immediately

#### New Verification Endpoint
- **Endpoint**: `POST /api/auth/verify-email`
- **Body**: 
  ```json
  {
    "email": "user@example.com",
    "code": "123456",
    "registrationData": {
      "name": "John Doe",
      "hashedPassword": "...",
      "accountType": "candidate",
      "companyName": "..." // optional, for company accounts
    }
  }
  ```
- **Behavior**:
  - Verifies OTP code from database
  - Creates user account in `users` table
  - Creates profile in `candidates` or `companies` table
  - Returns JWT token for immediate login
  - Deletes used OTP code

### 3. Login Flow (UPDATED)
When `ENABLE_OTP_ON_LOGIN=true`, users receive an OTP email after entering correct credentials.

#### Backend Changes
- **Endpoint**: `POST /api/auth/login`
- **Behavior**:
  - Validates email and password
  - If credentials correct AND OTP enabled:
    - Generates 6-digit OTP code
    - Stores OTP in `otp_codes` table with purpose='2fa'
    - Sends email via Resend
    - Returns `otpRequired: true` instead of JWT token

#### New Login Verification Endpoint
- **Endpoint**: `POST /api/auth/verify-login-otp`
- **Body**:
  ```json
  {
    "email": "user@example.com",
    "code": "123456"
  }
  ```
- **Behavior**:
  - Verifies OTP code from database
  - Returns JWT token for successful login
  - Deletes used OTP code

## Frontend Integration Required

### 1. Register Page Updates
```javascript
// Step 1: Submit registration form
const response = await authService.register({
  name, email, password, accountType, companyName
});

if (response.requiresVerification) {
  // Show OTP input form
  // Store email and registrationData for verification
  setShowOtpInput(true);
  setRegistrationData({
    email,
    name,
    hashedPassword: response.hashedPassword, // Backend should return this
    accountType,
    companyName
  });
}

// Step 2: Verify OTP
const verifyResponse = await authService.verifyEmail({
  email,
  code: otpCode,
  registrationData
});

if (verifyResponse.success) {
  // Store token and redirect to dashboard
  localStorage.setItem('token', verifyResponse.token);
  navigate('/dashboard');
}
```

### 2. Login Page Updates
```javascript
// Step 1: Submit login credentials
const response = await authService.login({ email, password });

if (response.otpRequired) {
  // Show OTP input form
  setShowOtpInput(true);
  setEmail(email);
}

// Step 2: Verify login OTP
const verifyResponse = await authService.verifyLoginOtp({
  email,
  code: otpCode
});

if (verifyResponse.success) {
  // Store token and redirect to dashboard
  localStorage.setItem('token', verifyResponse.token);
  navigate('/dashboard');
}
```

### 3. API Service Updates
```javascript
// In client/src/services/api.js

export const authService = {
  register: (data) => api.post('/auth/register', data),
  
  verifyEmail: (data) => api.post('/auth/verify-email', data),
  
  login: (data) => api.post('/auth/login', data),
  
  verifyLoginOtp: (data) => api.post('/auth/verify-login-otp', data),
  
  // ... other methods
};
```

## Email Templates

### Registration Email
- **Subject**: "Your VeriBoard Signup Code"
- **Purpose**: Verify email ownership before creating account
- **Content**: Professional HTML template with 6-digit code
- **Expiration**: 10 minutes

### Login Email (2FA)
- **Subject**: "Your VeriBoard Login Code"
- **Purpose**: Two-factor authentication for login
- **Content**: Professional HTML template with 6-digit code
- **Expiration**: 10 minutes

### Password Reset Email
- **Subject**: "Reset Your VeriBoard Password"
- **Purpose**: Verify identity before password reset
- **Content**: Professional HTML template with 6-digit code
- **Expiration**: 10 minutes

## Database Schema

### otp_codes Table
```sql
CREATE TABLE otp_codes (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  code VARCHAR(6) NOT NULL,
  purpose VARCHAR(50) NOT NULL, -- 'register', '2fa', 'reset-password'
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
```

## Testing

### 1. Test Registration Flow
```bash
# Step 1: Register
POST http://localhost:5000/api/auth/register
{
  "name": "Test User",
  "email": "test@example.com",
  "password": "password123",
  "accountType": "candidate"
}

# Expected: { requiresVerification: true, email: "test@example.com" }
# Check email for OTP code

# Step 2: Verify
POST http://localhost:5000/api/auth/verify-email
{
  "email": "test@example.com",
  "code": "123456",
  "registrationData": {
    "name": "Test User",
    "hashedPassword": "...",
    "accountType": "candidate"
  }
}

# Expected: { success: true, token: "...", user: {...} }
```

### 2. Test Login Flow
```bash
# Step 1: Login
POST http://localhost:5000/api/auth/login
{
  "email": "test@example.com",
  "password": "password123"
}

# Expected: { otpRequired: true, message: "OTP sent to email" }
# Check email for OTP code

# Step 2: Verify OTP
POST http://localhost:5000/api/auth/verify-login-otp
{
  "email": "test@example.com",
  "code": "123456"
}

# Expected: { success: true, token: "...", user: {...} }
```

## Configuration Options

### Enable/Disable OTP on Login
```env
# Enable OTP verification for login (two-factor authentication)
ENABLE_OTP_ON_LOGIN=true

# Disable OTP - login returns token immediately
ENABLE_OTP_ON_LOGIN=false
```

**Note**: Registration OTP is always enabled and cannot be disabled. This ensures email verification for all new accounts.

## Security Considerations

1. **OTP Expiration**: All OTP codes expire after 10 minutes
2. **Single Use**: OTP codes are deleted after successful verification
3. **Purpose Isolation**: Each OTP has a specific purpose (register, 2fa, reset-password)
4. **Rate Limiting**: Consider adding rate limits to prevent OTP spam
5. **Email Validation**: Only send OTPs to valid email addresses
6. **Secure Storage**: OTP codes are stored plain in database (consider hashing for production)

## Troubleshooting

### No Email Received
1. Check `RESEND_API_KEY` is set in `.env`
2. Check `FROM_EMAIL` is set to verified domain email
3. Check server logs for email sending errors
4. Verify domain is verified in Resend dashboard

### OTP Code Invalid
1. Check code hasn't expired (10 minutes)
2. Ensure correct purpose ('register', '2fa', 'reset-password')
3. Verify email matches exactly (case-sensitive)
4. Check code wasn't already used

### Server Not Starting
1. Ensure all dependencies installed: `npm install`
2. Check `.env` file exists with all required variables
3. Verify database connection working
4. Check logs for syntax errors

## Next Steps

### Frontend Implementation Needed:
1. ✅ Backend endpoints ready
2. ⏳ Update RegisterPage.jsx to handle OTP verification
3. ⏳ Update LoginPage.jsx to handle OTP verification
4. ⏳ Add OTP input component
5. ⏳ Update API service with new endpoints
6. ⏳ Add loading states and error handling
7. ⏳ Add "Resend OTP" functionality

### Optional Enhancements:
- Add rate limiting for OTP requests
- Implement "Resend OTP" endpoint
- Add cooldown period between OTP requests
- Hash OTP codes before storing in database
- Add SMS OTP as alternative to email
- Add remember device functionality

## Support

For issues or questions:
- Check server logs in terminal
- Verify `.env` configuration
- Test with provided test scripts
- Check Resend dashboard for email delivery status
