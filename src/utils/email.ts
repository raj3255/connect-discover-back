import axios from 'axios';
import { config } from '../config/env.js';

const SENDGRID_URL = 'https://api.sendgrid.com/v3/mail/send';

interface SendEmailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Sends an email via the SendGrid REST API.
 *
 * If SENDGRID_API_KEY is not configured, the email is logged to the console
 * instead (development fallback) so flows like verification / password reset
 * remain testable locally without a mail provider.
 */
export async function sendEmail({ to, subject, text, html }: SendEmailOptions): Promise<void> {
  if (!config.SENDGRID_API_KEY) {
    console.warn(
      `[email] SENDGRID_API_KEY not set — email NOT sent. Logging instead.\n` +
        `  To: ${to}\n  Subject: ${subject}\n  Body: ${text}`
    );
    return;
  }

  try {
    await axios.post(
      SENDGRID_URL,
      {
        personalizations: [{ to: [{ email: to }] }],
        from: { email: config.SENDGRID_FROM_EMAIL },
        subject,
        content: [
          { type: 'text/plain', value: text },
          ...(html ? [{ type: 'text/html', value: html }] : []),
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${config.SENDGRID_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (error: any) {
    // Surface the SendGrid error body for easier debugging, then rethrow so
    // callers can decide how to respond.
    const detail = error?.response?.data ?? error?.message ?? error;
    console.error('[email] SendGrid send failed:', detail);
    throw new Error('Failed to send email');
  }
}

export async function sendVerificationEmail(to: string, code: string): Promise<void> {
  await sendEmail({
    to,
    subject: 'Verify your Connect & Discover account',
    text: `Welcome to Connect & Discover!\n\nYour verification code is: ${code}\n\nThis code expires in 10 minutes.`,
    html:
      `<p>Welcome to <strong>Connect &amp; Discover</strong>!</p>` +
      `<p>Your verification code is:</p>` +
      `<p style="font-size:24px;font-weight:bold;letter-spacing:3px;">${code}</p>` +
      `<p>This code expires in 10 minutes.</p>`,
  });
}

export async function sendPasswordResetEmail(to: string, code: string): Promise<void> {
  await sendEmail({
    to,
    subject: 'Reset your Connect & Discover password',
    text: `You requested a password reset.\n\nYour reset code is: ${code}\n\nThis code expires in 30 minutes. If you didn't request this, you can ignore this email.`,
    html:
      `<p>You requested a password reset.</p>` +
      `<p>Your reset code is:</p>` +
      `<p style="font-size:24px;font-weight:bold;letter-spacing:3px;">${code}</p>` +
      `<p>This code expires in 30 minutes. If you didn't request this, you can ignore this email.</p>`,
  });
}
