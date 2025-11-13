import { Resend } from 'resend';

// Initialize Resend with API key
const RESEND_API_KEY = process.env.RESEND_API_KEY;
let resend = null;
if (RESEND_API_KEY) {
  resend = new Resend(RESEND_API_KEY);
  console.log('✅ Resend initialized successfully');
} else {
  console.warn('⚠️  RESEND_API_KEY not found in environment variables');
}

export async function sendOtpEmail(toEmail, code, purpose = 'login') {
  const from = process.env.FROM_EMAIL || 'onboarding@resend.dev';
  const isDevMode = process.env.NODE_ENV === 'development';

  // Check if Resend is configured
  if (!RESEND_API_KEY || !resend) {
    console.warn('⚠️  RESEND NOT CONFIGURED - Email will not be sent');
    console.warn('   To fix this, add RESEND_API_KEY to your .env file');
    console.warn(`   🔐 OTP code for ${toEmail}: ${code} (expires in 10 minutes)`);
    return { skipped: true, code }; // Return code for testing in development
  }

  // Prepare email subject and content based on purpose
  const subject = purpose === 'register' ? 'Your VeriBoard Signup Code' : 
                  purpose === 'reset-password' ? 'Reset Your VeriBoard Password' :
                  purpose === '2fa' ? 'Your VeriBoard Login Code' :
                  'Your VeriBoard Verification Code';

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${subject}</title>
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4; }
        .container { max-width: 600px; margin: 20px auto; background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; color: white; }
        .header h1 { margin: 0; font-size: 28px; font-weight: 600; }
        .content { padding: 40px 30px; }
        .otp-box { background: #f8f9fa; border: 2px dashed #667eea; border-radius: 8px; padding: 20px; text-align: center; margin: 30px 0; }
        .otp-code { font-size: 36px; font-weight: bold; color: #667eea; letter-spacing: 8px; margin: 10px 0; font-family: 'Courier New', monospace; }
        .message { font-size: 16px; color: #555; margin: 20px 0; }
        .warning { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; border-radius: 4px; }
        .warning p { margin: 0; color: #856404; }
        .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 14px; color: #666; border-top: 1px solid #e0e0e0; }
        .footer a { color: #667eea; text-decoration: none; }
        @media only screen and (max-width: 600px) {
          .content { padding: 30px 20px; }
          .otp-code { font-size: 28px; letter-spacing: 6px; }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>🔐 VeriBoard</h1>
        </div>
        <div class="content">
          <p class="message">Hello,</p>
          <p class="message">
            ${purpose === 'register' ? 'Thank you for signing up with VeriBoard! Use the code below to complete your registration.' :
              purpose === 'reset-password' ? 'You requested to reset your VeriBoard password. Use the code below to proceed.' :
              purpose === '2fa' ? 'You are attempting to log in to VeriBoard. Use the code below to verify your identity.' :
              'Use the code below to verify your account.'}
          </p>
          
          <div class="otp-box">
            <p style="margin: 0 0 10px 0; font-size: 14px; color: #666;">Your verification code is:</p>
            <div class="otp-code">${code}</div>
            <p style="margin: 10px 0 0 0; font-size: 12px; color: #999;">This code will expire in 10 minutes</p>
          </div>

          <div class="warning">
            <p><strong>⚠️ Security Notice:</strong> Never share this code with anyone. VeriBoard staff will never ask for your verification code.</p>
          </div>

          <p class="message">
            If you didn't request this code, please ignore this email or contact support if you have concerns.
          </p>
        </div>
        <div class="footer">
          <p>© ${new Date().getFullYear()} VeriBoard. All rights reserved.</p>
          <p>Professional Verification Platform</p>
        </div>
      </div>
    </body>
    </html>
  `;

  const text = `
Your VeriBoard ${purpose} verification code is: ${code}

This code will expire in 10 minutes.

Security Notice: Never share this code with anyone. VeriBoard staff will never ask for your verification code.

If you didn't request this code, please ignore this email.

© ${new Date().getFullYear()} VeriBoard
Professional Verification Platform
  `.trim();

  const msg = {
    to: toEmail,
    from: {
      email: from,
      name: 'VeriBoard'
    },
    subject: subject,
    text: text,
    html: html,
  };

  try {
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log(`[RESEND] 📧 ATTEMPTING TO SEND EMAIL`);
    console.log(`[RESEND] To: ${toEmail}`);
    console.log(`[RESEND] From: VeriBoard <${from}>`);
    console.log(`[RESEND] Subject: ${subject}`);
    console.log(`[RESEND] Code: ${code}`);
    console.log(`[RESEND] Purpose: ${purpose}`);
    console.log('═══════════════════════════════════════════════════════════\n');
    
    const { data, error } = await resend.emails.send({
      from: `VeriBoard <${from}>`,
      to: [toEmail],
      subject: subject,
      html: html,
    });

    console.log('[RESEND] Resend API call completed. Checking result...\n');

    if (error) {
      console.error('\n❌❌❌ RESEND ERROR DETECTED ❌❌❌');
      console.error('Error Name:', error.name);
      console.error('Error Message:', error.message);
      console.error('Full Error:', JSON.stringify(error, null, 2));
      console.error('❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌\n');
      
      // In development, always log the OTP code
      if (isDevMode) {
        console.error('\n════════════════════════════════════════════════════════');
        console.error('   🔐 OTP CODE (Use this to test): ' + code);
        console.error('   📧 Recipient: ' + toEmail);
        console.error('   ⏰ Valid for: 10 minutes');
        console.error('════════════════════════════════════════════════════════\n');
      }
      
      return { ok: false, error, code };
    }

    console.log('\n✅✅✅ EMAIL SENT SUCCESSFULLY! ✅✅✅');
    console.log('✅ OTP email sent successfully via Resend to', toEmail);
    console.log('✅ Purpose:', purpose);
    console.log('✅ Message ID:', data.id);
    console.log('✅✅✅✅✅✅✅✅✅✅✅✅✅✅✅✅✅✅✅✅\n');
    return { ok: true, messageId: data.id };
  } catch (err) {
    console.error('❌ Exception sending OTP email via Resend to', toEmail);
    console.error('   Exception:', err.message);
    console.error('   Stack:', err.stack);
    console.error(`   🔐 OTP code for testing: ${code}`);
    return { ok: false, error: err, code };
  }
}

export default { sendOtpEmail };
