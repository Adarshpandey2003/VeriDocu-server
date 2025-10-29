import express from 'express';
import storageUtils, { getProfilePictureSignedUrl } from '../utils/supabaseStorage.js';
import { supabase } from '../config/supabase.js';
import { AppError } from '../middleware/errorHandler.js';

const router = express.Router();

// @route   GET /profile/:path(*)
// @desc    Serve profile pictures and company logos publicly
// @access  Public
router.get('/profile/:path(*)', async (req, res, next) => {
  try {
    const imagePath = req.params.path;

    // Validate that the path is for profile pictures or company logos
    if (!imagePath.startsWith('profile_pic/') && !imagePath.startsWith('company_logo/')) {
      return next(new AppError('Invalid image path', 400));
    }

    // Try to stream the object from Supabase Storage and proxy it through the server
    try {
      const BUCKET = storageUtils.BUCKET_NAME;
      const { data, error } = await supabase.storage.from(BUCKET).download(imagePath);
      if (error) {
        console.error('Storage download error:', error);
        // As a fallback, attempt to generate a signed URL and redirect
        const signed = await getProfilePictureSignedUrl(imagePath, 3600);
        if (signed?.error || !signed?.data?.signedUrl) {
          return next(new AppError('Failed to retrieve image', 500));
        }
        return res.redirect(signed.data.signedUrl);
      }

      // `data` is a ReadableStream/Blob-like object. Convert to Buffer and send
      const arrayBuffer = await data.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Set content-type based on extension
      const ext = imagePath.split('.').pop().toLowerCase();
      const contentTypeMap = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        webp: 'image/webp',
      };
      const contentType = contentTypeMap[ext] || 'application/octet-stream';

      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.send(buffer);
    } catch (err) {
      console.error('Proxy error fetching image:', err);
      return next(new AppError('Failed to proxy image', 500));
    }
  } catch (error) {
    next(error);
  }
});

export default router;