import { Resend } from 'resend';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'onboarding@resend.dev';

console.log('\n🧪 Testing Resend Configuration...\n');
console.log('API Key:', RESEND_API_KEY ? `${RESEND_API_KEY.substring(0, 10)}...` : '❌ NOT SET');
console.log('From Email:', FROM_EMAIL);
console.log('\n📧 Sending test email...\n');

if (!RESEND_API_KEY) {
  console.error('❌ ERROR: RESEND_API_KEY not found in .env file');
  process.exit(1);
}

const resend = new Resend(RESEND_API_KEY);

async function testEmail() {
  try {
    const { data, error } = await resend.emails.send({
      from: `VeriBoard Test <${FROM_EMAIL}>`,
      to: ['adarshpandey.200304@gmail.com'], // Change to your test email
      subject: 'Resend Test - OTP Email',
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <style>
              body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
              .container { max-width: 600px; margin: 0 auto; padding: 20px; }
              .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
              .otp-box { background: #f0f0f0; padding: 20px; margin: 30px 0; text-align: center; border-radius: 8px; }
              .otp-code { font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #667eea; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <h1>🧪 Resend Test Email</h1>
              </div>
              <div style="padding: 30px; background: white;">
                <p>This is a test email from VeriBoard using Resend!</p>
                <div class="otp-box">
                  <p style="margin: 0; font-size: 14px; color: #666;">Test OTP Code:</p>
                  <div class="otp-code">123456</div>
                </div>
                <p>If you received this email, Resend is configured correctly! ✅</p>
              </div>
            </div>
          </body>
        </html>
      `,
    });

    if (error) {
      console.error('❌ TEST EMAIL FAILED!');
      console.error('Error:', error);
      process.exit(1);
    }

    console.log('✅ TEST EMAIL SENT SUCCESSFULLY!');
    console.log('Message ID:', data.id);
    console.log('\n📬 Check your inbox: adarshpandey.200304@gmail.com\n');
  } catch (err) {
    console.error('❌ EXCEPTION:', err.message);
    process.exit(1);
  }
}

testEmail();
