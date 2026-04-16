import { supabase } from '../config/supabase.js';
import NodeCache from 'node-cache';

// Helper utilities for uploading files and getting URLs from Supabase Storage
// Bucket name used by the app: 'VeriBoard_bucket' (create this bucket in Supabase console)
// Bucket contains folders: 'profile_pic' and 'resume'

const BUCKET_NAME = 'VeriBoard_bucket';

// In-memory cache for signed URLs.
// TTL 50 min (URLs are valid for 60 min) — leaves a 10-min buffer so clients never get an expired URL.
// checkperiod 120s — evict stale entries every 2 minutes to free memory.
const signedUrlCache = new NodeCache({ stdTTL: 3000, checkperiod: 120 });
const FOLDERS = {
  PROFILE_PIC: 'profile_pic',
  RESUME: 'resume',
  COMPANY_LOGO: 'company_logo',
  CMS_DOCS: 'cms_docs',
};

// Export bucket constants as named exports so other modules can import them directly
export { BUCKET_NAME, FOLDERS };

/**
 * Upload a Buffer/Stream/File to Supabase Storage
 * @param {string} bucket - bucket name (e.g., 'VeriBoard_bucket')
 * @param {string} path - destination path in the bucket (e.g., 'avatars/user-uuid.png')
 * @param {Buffer|Uint8Array|ReadableStream} file - file data
 * @param {object} options - optional: { contentType, upsert }
 * @returns {Promise<{error, data}>}
 */
export async function uploadToBucket(bucket, path, file, options = {}) {
  const { contentType = undefined, upsert = false } = options;

  try {
    const res = await supabase.storage.from(bucket).upload(path, file, {
      cacheControl: '3600',
      upsert,
      contentType,
    });

    // Invalidate any cached signed URL for this path
    if (!res.error) signedUrlCache.del(`${bucket}:${path}`);

    return res; // { data, error }
  } catch (err) {
    return { data: null, error: err };
  }
}

/**
 * Upload a profile picture to the profile_pic folder
 * @param {string} userId - user identifier
 * @param {Buffer|Uint8Array} fileBuffer - image file buffer
 * @param {string} fileName - original file name (for extension)
 * @param {object} options - optional: { upsert }
 * @returns {Promise<{error, data, path}>}
 */
export async function uploadProfilePicture(userId, fileBuffer, fileName, options = {}) {
  const { upsert = true } = options;
  const ext = fileName.split('.').pop().toLowerCase();
  const path = `${FOLDERS.PROFILE_PIC}/${userId}.${ext}`;

  const { data, error } = await uploadToBucket(BUCKET_NAME, path, fileBuffer, {
    contentType: `image/${ext}`,
    upsert,
  });

  return { data, error, path: error ? null : path };
}

/**
 * Upload a cover image to the profile_pic folder
 * @param {string} userId - user identifier
 * @param {Buffer|Uint8Array} fileBuffer - image file buffer
 * @param {string} fileName - original file name (for extension)
 * @param {object} options - optional: { upsert }
 * @returns {Promise<{error, data, path}>}
 */
export async function uploadCoverImage(userId, fileBuffer, fileName, options = {}) {
  const { upsert = true } = options;
  const ext = fileName.split('.').pop().toLowerCase();
  // Use a timestamp to ensure unique filenames and avoid conflicts with profile pictures
  const timestamp = Date.now();
  const path = `${FOLDERS.PROFILE_PIC}/${userId}_cover_${timestamp}.${ext}`;

  const { data, error } = await uploadToBucket(BUCKET_NAME, path, fileBuffer, {
    contentType: `image/${ext}`,
    upsert,
  });

  return { data, error, path: error ? null : path };
}

/**
 * Upload a company logo to the company_logo folder
 * @param {string} userId - user identifier (company user)
 * @param {Buffer|Uint8Array} fileBuffer - image file buffer
 * @param {string} fileName - original file name (for extension)
 * @param {object} options - optional: { upsert }
 * @returns {Promise<{error, data, path}>}
 */
export async function uploadCompanyLogo(userId, fileBuffer, fileName, options = {}) {
  const { upsert = true } = options;
  const ext = fileName.split('.').pop().toLowerCase();
  const path = `${FOLDERS.COMPANY_LOGO}/${userId}.${ext}`;

  const { data, error } = await uploadToBucket(BUCKET_NAME, path, fileBuffer, {
    contentType: `image/${ext}`,
    upsert,
  });

  return { data, error, path: error ? null : path };
}

/**
 * Resolve a storage path or URL into a usable signed URL.
 * Handles: null → null, full http(s) URLs → passthrough,
 * bucket-prefixed paths → extract, plain paths → sign directly.
 * @param {string|null} imagePath - storage path or URL
 * @param {number} expiresInSeconds - signed URL lifetime (default 3600)
 * @returns {Promise<string|null>}
 */
export async function signImageUrl(imagePath, expiresInSeconds = 3600) {
  if (!imagePath) return null;
  try {
    // Already a full URL — return as-is
    if (/^https?:\/\//i.test(imagePath)) return imagePath;

    // Extract relative path if it contains the bucket name
    let filePath = imagePath;
    const bucketSegment = `/${BUCKET_NAME}/`;
    const idx = imagePath.indexOf(bucketSegment);
    if (idx !== -1) {
      filePath = imagePath.slice(idx + bucketSegment.length);
    }

    const { data, error } = await createSignedUrl(BUCKET_NAME, filePath, expiresInSeconds);
    if (!error && data?.signedUrl) return data.signedUrl;
  } catch (_) {
    // fall through
  }
  return null;
}

/**
 * Get a public URL for an object in a public bucket
 * Note: bucket must be configured as public to use getPublicUrl
 */
export function getPublicUrl(bucket, path) {
  try {
    const { data } = supabase.storage.from(bucket).getPublicUrl(path);
    return data?.publicUrl || null;
  } catch (err) {
    return null;
  }
}

/**
 * Create a signed (temporary) URL for a private object in storage.
 * Results are cached in-memory for 50 minutes (URLs expire at 60 min).
 * @param {string} bucket
 * @param {string} path
 * @param {number} expiresInSeconds default 60 (1 minute)
 */
export async function createSignedUrl(bucket, path, expiresInSeconds = 60) {
  if (!path) return { data: null, error: 'No path provided' };

  // Only cache when the caller requests long-lived URLs (≥ 10 min)
  const useCache = expiresInSeconds >= 600;
  const cacheKey = `${bucket}:${path}`;

  if (useCache) {
    const cached = signedUrlCache.get(cacheKey);
    if (cached) return { data: cached, error: null };
  }

  try {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, expiresInSeconds);

    if (!error && data && useCache) {
      signedUrlCache.set(cacheKey, data);
    }

    return { data, error };
  } catch (err) {
    return { data: null, error: err };
  }
}

/**
 * Delete an object from a bucket
 * @param {string} bucket
 * @param {string} path
 */
export async function deleteFromBucket(bucket, path) {
  if (!bucket || !path) return { data: null, error: 'Missing bucket or path' };
  try {
    const res = await supabase.storage.from(bucket).remove([path]);

    // Invalidate cached signed URL
    signedUrlCache.del(`${bucket}:${path}`);

    return res; // { data, error }
  } catch (err) {
    return { data: null, error: err };
  }
}

/**
 * Get a signed URL for a profile picture
 * @param {string} path - the path of the file in storage
 * @param {number} expiresInSeconds - expiration time in seconds (default 3600 = 1 hour)
 * @returns {Promise<{signedUrl, error}>}
 */
export async function getProfilePictureSignedUrl(path, expiresInSeconds = 3600) {
  if (!path) return { signedUrl: null, error: 'No path provided' };
  return await createSignedUrl(BUCKET_NAME, path, expiresInSeconds);
}

export default {
  uploadToBucket,
  uploadProfilePicture,
  uploadCoverImage,
  uploadCompanyLogo,
  getPublicUrl,
  createSignedUrl,
  signImageUrl,
  getProfilePictureSignedUrl,
  deleteFromBucket,
  BUCKET_NAME,
  FOLDERS,
};
