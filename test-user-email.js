import { Resend } from 'resend';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'onboarding@resend.dev';

console.log('\n🧪 Testing Resend with Different Email Addresses...\n');

if (!RESEND_API_KEY) {
  console.error('❌ ERROR: RESEND_API_KEY not found');
  process.exit(1);
}

const resend = new Resend(RESEND_API_KEY);

// Test sending to a different email (simulate password reset)
const testEmail = 'user@example.com'; // Change this to the email you're testing with

async function testPasswordResetEmail() {
  console.log(`📧 Attempting to send password reset OTP to: ${testEmail}`);
  console.log(`   From: VeriBoard <${FROM_EMAIL}>`);
  console.log(`   Purpose: reset-password\n`);

  try {
    const { data, error } = await resend.emails.send({
      from: `VeriBoard <${FROM_EMAIL}>`,
      to: [testEmail],
      subject: 'Reset Your VeriBoard Password',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2>🔐 Password Reset Request</h2>
          <p>Your verification code is: <strong style="font-size: 24px; color: #667eea;">123456</strong></p>
          <p>This code will expire in 10 minutes.</p>
        </div>
      `,
    });

    if (error) {
      console.error('❌ FAILED TO SEND!');
      console.error('Error Name:', error.name);
      console.error('Error Message:', error.message);
      console.error('\nFull Error:', JSON.stringify(error, null, 2));
      
      if (error.message && (error.message.includes('onboarding') || error.message.includes('not verified'))) {
        console.error('\n⚠️  RESEND LIMITATION DETECTED:');
        console.error('   The onboarding@resend.dev domain can only send to:');
        console.error('   - Email addresses verified in YOUR Resend account');
        console.error('   - The email used to sign up for Resend');
        console.error('\n✅ SOLUTIONS:');
        console.error('   1. Add your domain in Resend: https://resend.com/domains');
        console.error('   2. Verify DNS records');
        console.error('   3. Update .env FROM_EMAIL to: noreply@yourdomain.com');
        console.error('\n   OR for testing: Use adarshpandey.200304@gmail.com (your verified email)');
      }
      process.exit(1);
    }

    console.log('✅ EMAIL SENT SUCCESSFULLY!');
    console.log('Message ID:', data.id);
    console.log(`\n📬 Check inbox: ${testEmail}\n`);
  } catch (err) {
    console.error('❌ EXCEPTION:', err.message);
    console.error('Stack:', err.stack);
    process.exit(1);
  }
}

testPasswordResetEmail();
