import { Resend } from 'resend';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL;

console.log('\n🧪 Testing Resend with Yahoo Email Address\n');
console.log('API Key:', RESEND_API_KEY ? `${RESEND_API_KEY.substring(0, 10)}...` : '❌ NOT SET');
console.log('From Email:', FROM_EMAIL);
console.log('\n📧 Sending password reset OTP to Yahoo email...\n');

if (!RESEND_API_KEY) {
  console.error('❌ ERROR: RESEND_API_KEY not found in .env file');
  process.exit(1);
}

const resend = new Resend(RESEND_API_KEY);

// Test with the actual Yahoo email from your database
const testEmail = 'adarsh123pandey@yahoo.com';
const testCode = '729596'; // The code from your database

async function testYahooEmail() {
  console.log(`📬 Attempting to send to: ${testEmail}`);
  console.log(`🔐 OTP Code: ${testCode}`);
  console.log(`📤 From: VeriBoard <${FROM_EMAIL}>`);
  console.log('');
  
  try {
    const { data, error } = await resend.emails.send({
      from: `VeriBoard <${FROM_EMAIL}>`,
      to: [testEmail],
      subject: 'Reset Your VeriBoard Password',
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <style>
              body { font-family: Arial, sans-serif; padding: 20px; background: #f4f4f4; }
              .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; }
              .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; text-align: center; border-radius: 8px; margin-bottom: 20px; }
              .code { font-size: 32px; font-weight: bold; color: #667eea; text-align: center; padding: 20px; background: #f0f0f0; border-radius: 8px; letter-spacing: 8px; margin: 20px 0; font-family: monospace; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <h1>🔐 Reset Your Password</h1>
              </div>
              <p>You requested to reset your VeriBoard password.</p>
              <p><strong>Your verification code is:</strong></p>
              <div class="code">${testCode}</div>
              <p>This code will expire in 10 minutes.</p>
              <p style="color: #999; font-size: 12px; margin-top: 30px;">
                If you didn't request this, please ignore this email.
              </p>
            </div>
          </body>
        </html>
      `,
    });

    if (error) {
      console.error('\n❌ FAILED TO SEND EMAIL!');
      console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.error('Error Name:', error.name);
      console.error('Error Message:', error.message);
      console.error('\nFull Error Object:');
      console.error(JSON.stringify(error, null, 2));
      console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      
      if (error.message) {
        if (error.message.includes('not verified') || error.message.includes('not authorized')) {
          console.error('⚠️  DOMAIN NOT VERIFIED or RECIPIENT NOT ALLOWED');
          console.error('   Check Resend dashboard: https://resend.com/domains');
          console.error('   Make sure veriboard.in is verified and active\n');
        }
        
        if (error.message.includes('rate limit') || error.message.includes('quota')) {
          console.error('⚠️  RATE LIMIT or QUOTA EXCEEDED');
          console.error('   Check your Resend usage limits\n');
        }
      }
      
      console.error('💡 Possible issues:');
      console.error('   1. Domain veriboard.in not fully verified in Resend');
      console.error('   2. Yahoo email blocking/filtering');
      console.error('   3. Resend API key restrictions');
      console.error('   4. Free tier limitations\n');
      
      process.exit(1);
    }

    console.log('✅ EMAIL SENT SUCCESSFULLY!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Message ID:', data.id);
    console.log('To:', testEmail);
    console.log('From:', FROM_EMAIL);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('📬 Check your Yahoo inbox: adarsh123pandey@yahoo.com\n');
    console.log('Note: Yahoo may filter emails. Check:');
    console.log('  - Inbox');
    console.log('  - Spam/Junk folder');
    console.log('  - Bulk mail folder\n');
  } catch (err) {
    console.error('❌ EXCEPTION:', err.message);
    console.error('Stack:', err.stack);
    process.exit(1);
  }
}

testYahooEmail();
