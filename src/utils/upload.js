import multer from 'multer';
import path from 'path';

/**
 * Create a multer instance with memory storage.
 * @param {object} options
 * @param {number}  [options.maxSize=5*1024*1024]  — max file size in bytes
 * @param {'images'|'documents'|'all'|string[]} [options.allow='images']
 *   - 'images'    → image/* mimetypes
 *   - 'documents' → PDF, DOC, DOCX, JPG, PNG, WEBP
 *   - 'all'       → any mimetype
 *   - string[]    → explicit list of allowed extensions (e.g., ['jpeg','jpg','png','pdf'])
 * @returns {multer.Multer}
 */
export function createUpload({ maxSize = 5 * 1024 * 1024, allow = 'images' } = {}) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxSize },
    fileFilter: (_req, file, cb) => {
      if (allow === 'all') return cb(null, true);

      if (allow === 'images') {
        if (file.mimetype.startsWith('image/')) return cb(null, true);
        return cb(new Error('Only image files are allowed'), false);
      }

      if (allow === 'documents') {
        const allowed = [
          'application/pdf',
          'application/msword',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'image/jpeg',
          'image/png',
          'image/webp',
        ];
        if (allowed.includes(file.mimetype)) return cb(null, true);
        return cb(new Error('Only PDF, DOC, DOCX, JPG, PNG, WEBP files are allowed'), false);
      }

      // Array of allowed extensions
      if (Array.isArray(allow)) {
        const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
        const allowedSet = new Set(allow.map(a => a.toLowerCase()));
        if (allowedSet.has(ext)) return cb(null, true);
        return cb(new Error(`Only ${allow.join(', ')} files are allowed`), false);
      }

      cb(null, true);
    },
  });
}
