import { Resend } from 'resend';

// Test if Resend API key is valid
const RESEND_API_KEY = 're_5hACm1AC_LCxnoby5t7MDDDktLbftVDvj';

async function testResendApiKey() {
  console.log('\n🔍 Testing Resend API Key...\n');
  
  try {
    const resend = new Resend(RESEND_API_KEY);
    
    // Try to send a test email
    const { data, error } = await resend.emails.send({
      from: 'VeriBoard <noreply@veriboard.in>',
      to: ['adarshpandey.200304@gmail.com'], // Your verified email
      subject: 'Test - API Key Validation',
      html: '<p>This is a test to verify your Resend API key is working.</p>',
    });

    if (error) {
      console.error('❌ Resend API Error:');
      console.error('Error Name:', error.name);
      console.error('Error Message:', error.message);
      console.error('Status Code:', error.statusCode);
      console.error('Full Error:', JSON.stringify(error, null, 2));
      return false;
    }

    console.log('✅ Resend API key is VALID!');
    console.log('✅ Test email sent successfully!');
    console.log('Message ID:', data.id);
    console.log('\nCheck your inbox: adarshpandey.200304@gmail.com\n');
    return true;

  } catch (err) {
    console.error('❌ Exception testing Resend API:');
    console.error('Error:', err.message);
    console.error('Stack:', err.stack);
    return false;
  }
}

testResendApiKey();
