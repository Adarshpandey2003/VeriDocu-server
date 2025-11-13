import { Resend } from 'resend';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL;

console.log('\n🎉 Testing Resend with Verified Domain: veriboard.in\n');
console.log('API Key:', RESEND_API_KEY ? `${RESEND_API_KEY.substring(0, 10)}...` : '❌ NOT SET');
console.log('From Email:', FROM_EMAIL);
console.log('\n📧 Sending test email to a different user email...\n');

if (!RESEND_API_KEY) {
  console.error('❌ ERROR: RESEND_API_KEY not found in .env file');
  process.exit(1);
}

const resend = new Resend(RESEND_API_KEY);

// Test with a different email (not your Gmail)
const testEmails = [
  'test@example.com',
  'user@test.com',
  'adarshpandey.200304@gmail.com' // Your verified email as backup
];

async function testEmail(toEmail) {
  console.log(`\n📬 Sending to: ${toEmail}`);
  
  try {
    const { data, error } = await resend.emails.send({
      from: `VeriBoard <${FROM_EMAIL}>`,
      to: [toEmail],
      subject: 'Test Email - Verified Domain',
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <style>
              body { font-family: Arial, sans-serif; padding: 20px; background: #f4f4f4; }
              .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; }
              .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; text-align: center; border-radius: 8px; margin-bottom: 20px; }
              .code { font-size: 32px; font-weight: bold; color: #667eea; text-align: center; padding: 20px; background: #f0f0f0; border-radius: 8px; letter-spacing: 8px; margin: 20px 0; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <h1>✅ Verified Domain Test</h1>
              </div>
              <p><strong>Success!</strong> This email was sent from your verified domain:</p>
              <p style="text-align: center; font-size: 18px; color: #667eea;"><strong>noreply@veriboard.in</strong></p>
              <div class="code">123456</div>
              <p>Your verified domain is now active! You can send emails to ANY user. 🎉</p>
              <p style="color: #666; font-size: 14px; margin-top: 30px;">Test performed at: ${new Date().toLocaleString()}</p>
            </div>
          </body>
        </html>
      `,
    });

    if (error) {
      console.error(`   ❌ FAILED for ${toEmail}`);
      console.error('   Error:', error.message);
      if (error.message.includes('not verified') || error.message.includes('not authorized')) {
        console.error('\n   ⚠️  DOMAIN NOT VERIFIED YET');
        console.error('   Make sure DNS records are added and verified in Resend dashboard');
        console.error('   Check status: https://resend.com/domains\n');
      }
      return false;
    }

    console.log(`   ✅ SUCCESS! Message ID: ${data.id}`);
    return true;
  } catch (err) {
    console.error(`   ❌ EXCEPTION for ${toEmail}:`, err.message);
    return false;
  }
}

async function runTests() {
  console.log('═══════════════════════════════════════════════════════\n');
  
  // Test with your verified Gmail first
  const success1 = await testEmail('adarshpandey.200304@gmail.com');
  
  if (success1) {
    console.log('\n🎉 VERIFIED DOMAIN IS WORKING!');
    console.log('You can now send emails to ANY user email address!\n');
    console.log('═══════════════════════════════════════════════════════\n');
  } else {
    console.log('\n⚠️  Domain verification may still be pending');
    console.log('Check DNS status in Resend dashboard\n');
  }
}

runTests();
