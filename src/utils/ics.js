// Minimal RFC 5545 ICS generator for interview confirmations.
// No external deps. Returns the .ics file content as a string.

function formatICSDate(date) {
  const d = new Date(date);
  return d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

function escapeText(str) {
  return String(str || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

export function generateICS({ uid, title, description, startsAt, endsAt, location, organizer, attendee }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//VeriBoard//Interview//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}@veriboard`,
    `DTSTAMP:${formatICSDate(new Date())}`,
    `DTSTART:${formatICSDate(startsAt)}`,
    `DTEND:${formatICSDate(endsAt)}`,
    `SUMMARY:${escapeText(title)}`,
    description ? `DESCRIPTION:${escapeText(description)}` : null,
    location ? `LOCATION:${escapeText(location)}` : null,
    organizer ? `ORGANIZER;CN=${escapeText(organizer.name || organizer.email)}:mailto:${organizer.email}` : null,
    attendee ? `ATTENDEE;CN=${escapeText(attendee.name || attendee.email)};RSVP=TRUE:mailto:${attendee.email}` : null,
    'STATUS:CONFIRMED',
    'SEQUENCE:0',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);

  return lines.join('\r\n');
}
