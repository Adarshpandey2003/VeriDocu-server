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
          <h1>VeriBoard</h1>
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
            <p><strong>Security Notice:</strong> Never share this code with anyone. VeriBoard staff will never ask for your verification code.</p>
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

  try {
    console.log(`[RESEND] Sending ${purpose} email to ${toEmail}`);

    const { data, error } = await resend.emails.send({
      from: `VeriBoard <${from}>`,
      to: [toEmail],
      subject: subject,
      html: html,
      text: text,
      headers: {
        'List-Unsubscribe': `<mailto:${from}>`,
      },
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

// ── Generic HTML email sender (reused by HR templates) ─────────────────
async function sendBrandedEmail({ to, subject, heading, bodyHtml, ctaText, ctaUrl, footerNote, attachments }) {
  const from = process.env.FROM_EMAIL || 'onboarding@resend.dev';

  if (!RESEND_API_KEY || !resend) {
    console.warn('⚠️  RESEND NOT CONFIGURED - Email will not be sent to', to);
    console.warn(`   Subject: ${subject}`);
    if (ctaUrl) console.warn(`   CTA URL: ${ctaUrl}`);
    return { skipped: true };
  }

  const html = `
    <!DOCTYPE html>
    <html><head><meta charset="utf-8"><title>${subject}</title>
    <style>
      body{font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;line-height:1.6;color:#333;margin:0;padding:0;background:#f4f4f4;}
      .container{max-width:600px;margin:20px auto;background:white;border-radius:10px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,0.1);}
      .header{background:linear-gradient(135deg,#2563eb 0%,#7c3aed 100%);padding:30px;text-align:center;color:white;}
      .header h1{margin:0;font-size:26px;font-weight:600;}
      .content{padding:36px 30px;}
      .content h2{margin:0 0 16px 0;color:#1f2937;font-size:22px;}
      .content p{font-size:15px;color:#4b5563;margin:12px 0;}
      .cta-btn{display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#2563eb 0%,#7c3aed 100%);color:white !important;text-decoration:none;border-radius:8px;font-weight:600;margin:20px 0;}
      .footer{background:#f8f9fa;padding:18px;text-align:center;font-size:13px;color:#6b7280;border-top:1px solid #e5e7eb;}
      .footer-note{font-size:12px;color:#9ca3af;margin-top:8px;}
    </style></head>
    <body>
      <div class="container">
        <div class="header"><h1>VeriBoard</h1></div>
        <div class="content">
          <h2>${heading}</h2>
          ${bodyHtml}
          ${ctaText && ctaUrl ? `<div style="text-align:center;"><a href="${ctaUrl}" class="cta-btn">${ctaText}</a></div>` : ''}
          ${footerNote ? `<p class="footer-note">${footerNote}</p>` : ''}
        </div>
        <div class="footer">
          <p>© ${new Date().getFullYear()} VeriBoard · Professional Verification Platform</p>
        </div>
      </div>
    </body></html>
  `;

  try {
    const payload = {
      from: `VeriBoard <${from}>`,
      to: [to],
      subject,
      html,
    };
    if (attachments) payload.attachments = attachments;

    const { data, error } = await resend.emails.send(payload);
    if (error) {
      console.error('[MAILER] Resend error:', error.message);
      return { ok: false, error };
    }
    return { ok: true, messageId: data.id };
  } catch (err) {
    console.error('[MAILER] Exception:', err.message);
    return { ok: false, error: err };
  }
}

// ── Job collaborator invite ─────────────────────────────────────────────
export async function sendCollaboratorInvite({ to, inviterName, companyName, jobTitle, role, magicLink }) {
  const roleLabel = { co_owner: 'Co-Owner', recruiter: 'Recruiter', reviewer: 'Reviewer' }[role] || role;
  return sendBrandedEmail({
    to,
    subject: `${inviterName} invited you to help hire on VeriBoard`,
    heading: `You've been invited to collaborate`,
    bodyHtml: `
      <p><strong>${inviterName}</strong> from <strong>${companyName}</strong> has invited you to join the hiring team for:</p>
      <p style="font-size:18px;font-weight:600;color:#111827;background:#f3f4f6;padding:14px;border-radius:8px;margin:16px 0;">${jobTitle}</p>
      <p>Your role: <strong>${roleLabel}</strong></p>
      <p>Click the button below to accept and start reviewing candidates.</p>
    `,
    ctaText: 'Accept Invitation',
    ctaUrl: magicLink,
    footerNote: 'This invitation link expires in 14 days.',
  });
}

// ── Interview invite to candidate ───────────────────────────────────────
export async function sendInterviewInvite({ to, candidateName, companyName, jobTitle, magicLink, slotCount }) {
  return sendBrandedEmail({
    to,
    subject: `Interview invitation for ${jobTitle} at ${companyName}`,
    heading: `You're invited to interview`,
    bodyHtml: `
      <p>Hi ${candidateName || 'there'},</p>
      <p>Good news — <strong>${companyName}</strong> would like to interview you for the <strong>${jobTitle}</strong> role.</p>
      <p>They've proposed ${slotCount || 'multiple'} time slot${slotCount === 1 ? '' : 's'}. Pick the one that works best for you using the button below.</p>
    `,
    ctaText: 'Choose a Time',
    ctaUrl: magicLink,
    footerNote: 'If you can\'t make any of these times, reply to the recruiter directly.',
  });
}

// ── Interview confirmation (both parties) ──────────────────────────────
export async function sendInterviewConfirmation({ to, recipientName, jobTitle, companyName, scheduledAt, mode, meetingLink, location, icsContent }) {
  const dateStr = new Date(scheduledAt).toLocaleString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
  const modeLabel = { video: 'Video Call', phone: 'Phone Call', in_person: 'In-Person' }[mode] || mode;
  const detailsLine = mode === 'video' && meetingLink
    ? `<p>Meeting link: <a href="${meetingLink}">${meetingLink}</a></p>`
    : mode === 'in_person' && location
      ? `<p>Location: ${location}</p>`
      : '';

  const attachments = icsContent ? [{
    filename: 'interview.ics',
    content: Buffer.from(icsContent).toString('base64'),
  }] : undefined;

  return sendBrandedEmail({
    to,
    subject: `Interview confirmed: ${jobTitle} at ${companyName}`,
    heading: `Your interview is confirmed`,
    bodyHtml: `
      <p>Hi ${recipientName || 'there'},</p>
      <p>Your interview for <strong>${jobTitle}</strong> at <strong>${companyName}</strong> is confirmed.</p>
      <p style="background:#f3f4f6;padding:14px;border-radius:8px;margin:16px 0;">
        <strong>${dateStr}</strong><br>
        Mode: ${modeLabel}
      </p>
      ${detailsLine}
      <p>An ICS calendar attachment is included with this email.</p>
    `,
    attachments,
  });
}

// ── Bulk onboarding invite (new candidate) ──────────────────────────────
export async function sendBulkOnboardInvite({ to, candidateName, companyName, position, signupLink }) {
  return sendBrandedEmail({
    to,
    subject: `${companyName} added you to VeriBoard as a verified employee`,
    heading: `Welcome to VeriBoard`,
    bodyHtml: `
      <p>Hi ${candidateName || 'there'},</p>
      <p><strong>${companyName}</strong> has added you to VeriBoard with a verified work-history record:</p>
      <p style="font-size:16px;font-weight:600;color:#111827;background:#f3f4f6;padding:14px;border-radius:8px;margin:16px 0;">${position} · ${companyName}</p>
      <p>Claim your account to:</p>
      <ul style="color:#4b5563;font-size:15px;">
        <li>Show your verified work history to future employers</li>
        <li>Build a professional profile</li>
        <li>Apply to jobs with a verified badge</li>
      </ul>
    `,
    ctaText: 'Claim Your Account',
    ctaUrl: signupLink,
    footerNote: 'Your work history is already saved and verified by ' + companyName + '.',
  });
}

// ── Application status update (rejection / shortlist) ──────────────────
export async function sendApplicationStatusEmail({ to, candidateName, companyName, jobTitle, status, customMessage }) {
  const messages = {
    rejected: {
      heading: 'Update on your application',
      body: `<p>Hi ${candidateName || 'there'},</p>
        <p>Thank you for your interest in the <strong>${jobTitle}</strong> role at <strong>${companyName}</strong>.</p>
        <p>After careful consideration, we've decided to move forward with other candidates whose background more closely matches our current needs.</p>
        <p>We genuinely appreciate the time you invested and wish you the best in your search.</p>`,
    },
    shortlisted: {
      heading: 'Good news — you\'re shortlisted!',
      body: `<p>Hi ${candidateName || 'there'},</p>
        <p>Great news! Your application for <strong>${jobTitle}</strong> at <strong>${companyName}</strong> has been shortlisted.</p>
        <p>The hiring team will be in touch shortly with next steps.</p>`,
    },
    reviewing: {
      heading: 'Your application is being reviewed',
      body: `<p>Hi ${candidateName || 'there'},</p>
        <p>The team at <strong>${companyName}</strong> is now reviewing your application for <strong>${jobTitle}</strong>.</p>
        <p>You'll hear from them soon.</p>`,
    },
  };
  const template = messages[status] || { heading: 'Application update', body: `<p>Your application for ${jobTitle} has been updated.</p>` };
  return sendBrandedEmail({
    to,
    subject: `${template.heading} — ${jobTitle}`,
    heading: template.heading,
    bodyHtml: template.body + (customMessage ? `<p><em>${customMessage}</em></p>` : ''),
  });
}

export default { sendOtpEmail, sendCollaboratorInvite, sendInterviewInvite, sendInterviewConfirmation, sendBulkOnboardInvite, sendApplicationStatusEmail };
