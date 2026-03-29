/**
 * Shared test setup: mocks external dependencies so unit/integration
 * tests never touch the real database or email provider.
 */
import { vi } from 'vitest';

// ── Database mock ──────────────────────────────────────────────────────────────
export const mockQuery = vi.fn();
export const mockConnect = vi.fn();
export const mockRelease = vi.fn();
export const mockClientQuery = vi.fn();

vi.mock('../config/database.js', () => ({
  default: {
    query: mockQuery,
    connect: mockConnect,
  },
}));

// Mock pool.connect() to return a transaction client
mockConnect.mockResolvedValue({
  query: mockClientQuery,
  release: mockRelease,
});

// ── Mailer mock ────────────────────────────────────────────────────────────────
export const mockSendOtpEmail = vi.fn().mockResolvedValue({ ok: true, messageId: 'test-id' });

vi.mock('../utils/mailer.js', () => ({
  sendOtpEmail: mockSendOtpEmail,
}));

// ── Passport mock ──────────────────────────────────────────────────────────────
vi.mock('../config/passport.js', () => ({
  default: {
    initialize: () => (_req, _res, next) => next(),
    authenticate: () => (_req, _res, next) => next(),
  },
}));

// ── Supabase mock ──────────────────────────────────────────────────────────────
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    storage: {
      from: () => ({
        upload: vi.fn().mockResolvedValue({ data: {}, error: null }),
        getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: 'https://test.example/file' } }),
        createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'https://test.example/signed' }, error: null }),
        remove: vi.fn().mockResolvedValue({ data: {}, error: null }),
      }),
    },
  }),
}));
