# Resend Email Setup Guide

## Current Status

✅ **Resend is configured and working**
- API Key: `re_5hACm1AC_...` 
- Test emails successfully sent to: `adarshpandey.200304@gmail.com`

⚠️ **Current Limitation**
- Using `onboarding@resend.dev` (Resend's testing domain)
- Can ONLY send emails to YOUR verified email addresses
- Real users won't receive password reset emails

## Why Password Reset Emails Aren't Working

The `onboarding@resend.dev` domain is a **sandbox domain** provided by Resend for testing. It has these restrictions:

- ✅ Can send to email addresses you've verified in Resend
- ❌ Cannot send to random user email addresses
- ❌ Cannot be used in production

**This is why:**
- Test email worked (sent to your Gmail)
- User password resets fail (sent to their emails)

## Solution: Add Your Own Domain

### Step 1: Choose Your Domain

You need a domain name (e.g., `veriboard.com`, `yourdomain.com`) to send emails from `noreply@yourdomain.com`

### Step 2: Add Domain in Resend

1. Go to: https://resend.com/domains
2. Click **"Add Domain"**
3. Enter your domain name (without www)
4. Click **"Add"**

### Step 3: Verify DNS Records

Resend will provide you with DNS records to add. You'll need to add these to your domain registrar (GoDaddy, Namecheap, Cloudflare, etc.):

**Example DNS Records:**
```
Type: TXT
Name: @ (or root)
Value: resend-verification=abc123xyz...

Type: MX
Name: @
Value: feedback-smtp.resend.com
Priority: 10

Type: TXT  
Name: @
Value: v=spf1 include:spf.resend.com ~all

Type: TXT
Name: resend._domainkey
Value: p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC...
```

### Step 4: Wait for Verification

- DNS propagation takes 5-60 minutes
- Resend will auto-verify once DNS is updated
- Check status in Resend dashboard

### Step 5: Update .env File

Once your domain is verified in Resend:

```bash
# Change FROM_EMAIL from:
FROM_EMAIL=onboarding@resend.dev

# To your verified domain:
FROM_EMAIL=noreply@veriboard.com  # or your domain
```

### Step 6: Restart Server

```bash
npm run dev
```

Now emails will be sent to ANY user email address! 🎉

## Alternative: Testing Without a Domain

If you don't have a domain yet, you can still test:

### Option 1: Check Server Console for OTP Codes

When password reset fails to send email, the OTP code is logged to the console:

```bash
cd d:\VeriDocu\server
npm run dev

# Then test password reset - watch console for:
════════════════════════════════════════════════════════
   🔐 OTP CODE (Use this to test): 123456
   📧 Recipient: user@example.com
   ⏰ Valid for: 10 minutes
════════════════════════════════════════════════════════
```

### Option 2: Test with Your Verified Email

Only test password reset using: `adarshpandey.200304@gmail.com`

This email is verified in your Resend account, so emails will be delivered.

## Resend Pricing (as of 2025)

- **Free Tier**: 100 emails/day, 3,000/month
- **Pro Tier**: $20/month for 50,000 emails/month
- No sender verification fees
- Unlimited verified domains

## Common Errors

### Error: "Email is not authorized to send from this domain"

**Cause:** Trying to send to an unverified email using `onboarding@resend.dev`

**Fix:** 
1. Add your own domain (see steps above), OR
2. Check server console for OTP code during testing

### Error: "Domain not verified"

**Cause:** DNS records not added or not propagated yet

**Fix:**
1. Double-check DNS records in your domain registrar
2. Wait 30-60 minutes for DNS propagation
3. Use DNS checker: https://dnschecker.org

## Testing Checklist

- [ ] Resend API key added to `.env`
- [ ] Test email sent successfully (`node test-resend.js`)
- [ ] Domain added in Resend dashboard (or using onboarding domain for now)
- [ ] DNS records added and verified (if using custom domain)
- [ ] `FROM_EMAIL` updated in `.env`
- [ ] Server restarted (`npm run dev`)
- [ ] Password reset tested with real user email
- [ ] OTP email received in user's inbox (or check console)

## Need Help?

- Resend Docs: https://resend.com/docs
- Resend Support: support@resend.com
- DNS Help: https://resend.com/docs/dashboard/domains/dns-records

## Summary

**Current Setup (Testing Only):**
- ✅ Resend API configured
- ✅ Works for YOUR email
- ⚠️ Won't work for real users
- 💡 Check server console for OTP codes

**Production Setup (Required for Real Users):**
- 🎯 Add your domain in Resend
- 🔧 Verify DNS records
- ✉️ Update `FROM_EMAIL` to `noreply@yourdomain.com`
- 🚀 Deploy and send to ANY email address!
