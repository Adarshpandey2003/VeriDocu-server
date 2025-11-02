import nodemailer from 'nodemailer';

// Cache the transport to avoid creating new connections every time
let cachedTransport = null;
let lastTransportCheck = 0;
const TRANSPORT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Build candidate SMTP transport configs to try in order. This helps when
// providers accept either 587 (STARTTLS) or 465 (SSL) and the environment
// may not specify the correct secure/port combo.
function buildSmtpCandidates() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const configuredPort = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : undefined;
  const configuredSecure = process.env.SMTP_SECURE === 'true' ? true : (process.env.SMTP_SECURE === 'false' ? false : undefined);

  if (!host || !user) return [];

  const candidates = [];

  // If explicit port/secure provided, try that first
  if (configuredPort) {
    candidates.push({ 
      host, 
      port: configuredPort, 
      secure: !!configuredSecure, 
      auth: { user, pass },
      pool: true, // Use connection pooling for faster emails
      maxConnections: 5,
      maxMessages: 100
    });
  }

  // Add common combos: 587 STARTTLS (secure=false) then 465 SSL (secure=true)
  candidates.push({ 
    host, 
    port: 587, 
    secure: false, 
    auth: { user, pass },
    pool: true,
    maxConnections: 5,
    maxMessages: 100
  });
  candidates.push({ 
    host, 
    port: 465, 
    secure: true, 
    auth: { user, pass },
    pool: true,
    maxConnections: 5,
    maxMessages: 100
  });

  return candidates;
}

async function createWorkingTransport() {
  // Return cached transport if still valid
  const now = Date.now();
  if (cachedTransport && (now - lastTransportCheck) < TRANSPORT_CACHE_TTL) {
    return cachedTransport;
  }

  const candidates = buildSmtpCandidates();
  for (const cfg of candidates) {
    const t = nodemailer.createTransport(cfg);
    try {
      // verify() attempts to connect/auth — gives clearer error messages early
      await t.verify();
      cachedTransport = t;
      lastTransportCheck = now;
      return t;
    } catch (err) {
      console.warn('SMTP candidate failed to verify', { host: cfg.host, port: cfg.port, secure: cfg.secure, code: err && err.code });
      // try next candidate
    }
  }

  cachedTransport = null;
  return null;
}

export async function sendOtpEmail(toEmail, code, purpose = 'login') {
  const from = process.env.FROM_EMAIL || 'noreply@veriboard.com';

  // If no SMTP configured, skip sending in dev but return skipped
  if (!(process.env.SMTP_HOST && process.env.SMTP_USER)) {
    console.warn('⚠️  EMAIL NOT CONFIGURED - No mail transport available');
    console.warn('   To fix this, add to your .env file:');
    console.warn('   SMTP_HOST=smtp.gmail.com (or smtp.mail.yahoo.com)');
    console.warn('   SMTP_PORT=587 (or 465 for SSL)');
    console.warn('   SMTP_USER=your@email.com');
    console.warn('   SMTP_PASS=your-app-password');
    console.warn(`   OTP code for ${toEmail}: ${code} (expires in 10 minutes)`);
    return { skipped: true };
  }

  // Try to create a working transport by verifying the connection first.
  const transport = await createWorkingTransport();
  if (!transport) {
    const err = new Error('No working SMTP transport could be created (verify failed)');
    console.error('❌ EMAIL TRANSPORT FAILED');
    console.error('   Check your email credentials in .env file');
    console.error('   SMTP config:', process.env.SMTP_HOST ? `${process.env.SMTP_HOST}:${process.env.SMTP_PORT}` : 'not configured');
    console.error(`   OTP code for ${toEmail}: ${code} (use this to test)`);
    return { ok: false, error: err };
  }

  const subject = purpose === 'register' ? 'Your VeriBoard signup code' : 'Your VeriBoard login code';
  const text = `Your VeriBoard ${purpose} code is: ${code}\n\nThis code will expire in 10 minutes.`;
  const html = `<p>Your VeriBoard <strong>${purpose}</strong> code is:</p><h2>${code}</h2><p>This code will expire in 10 minutes.</p>`;

  try {
    const info = await transport.sendMail({ from, to: toEmail, subject, text, html });
    console.log('✅ OTP email sent successfully to', toEmail);
    return { ok: true, info };
  } catch (err) {
    console.error('❌ Failed to send OTP email to', toEmail);
    console.error('   Error:', err && err.code, err && err.message);
    console.error(`   OTP code for testing: ${code}`);
    return { ok: false, error: err };
  }
}

export default { sendOtpEmail };
