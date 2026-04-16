import express from 'express';
import { createUpload } from '../utils/upload.js';
import pool from '../config/database.js';
import { protect } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { uploadToBucket, deleteFromBucket, signImageUrl, BUCKET_NAME } from '../utils/supabaseStorage.js';
import crypto from 'crypto';

const router = express.Router();

const upload = createUpload();

// All routes require auth
router.use(protect);

// ─── GET /api/feed  — paginated feed (newest first) ────────────────

router.get('/', async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 10, 30);
    const offset = (page - 1) * limit;

    const result = await pool.query(
      `SELECT
         p.id, p.content, p.image_url, p.likes_count, p.created_at, p.updated_at,
         p.user_id,
         u.name        AS author_name,
         u.account_type AS author_type,
         CASE
           WHEN u.account_type = 'candidate' THEN c.full_name
           ELSE u.name
         END AS author_display_name,
         CASE
           WHEN u.account_type = 'candidate' THEN c.title
           WHEN u.account_type = 'company'   THEN co.industry
           ELSE NULL
         END AS author_headline,
         CASE
           WHEN u.account_type = 'candidate' THEN c.avatar_url
           WHEN u.account_type = 'company'   THEN co.logo_url
           ELSE NULL
         END AS author_avatar_path,
         CASE
           WHEN u.account_type = 'company' THEN co.slug
           ELSE NULL
         END AS author_company_slug,
         EXISTS (
           SELECT 1 FROM social_post_likes l
           WHERE l.post_id = p.id AND l.user_id = $1
         ) AS liked_by_me
       FROM social_posts p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN candidates c  ON c.user_id  = u.id AND u.account_type = 'candidate'
       LEFT JOIN companies  co ON co.user_id = u.id AND u.account_type = 'company'
       ORDER BY p.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );

    const countResult = await pool.query('SELECT COUNT(*) FROM social_posts');
    const total = parseInt(countResult.rows[0].count);

    // Sign image URLs
    const posts = await Promise.all(
      result.rows.map(async (post) => {
        const signed = await signImageUrl(post.image_url);
        const avatarSigned = await signImageUrl(post.author_avatar_path);
        return {
          ...post,
          image_signed_url: signed,
          author_avatar_url: avatarSigned,
        };
      })
    );

    res.json({
      success: true,
      posts,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/feed  — create a post (with optional image) ─────────

router.post('/', upload.single('image'), async (req, res, next) => {
  try {
    const content = (req.body.content || '').trim();
    if (!content) return next(new AppError('Post content is required', 400));
    if (content.length > 500) return next(new AppError('Post content must be 500 characters or less', 400));

    let imagePath = null;

    if (req.file) {
      const ext = req.file.originalname.split('.').pop().toLowerCase();
      const uniqueName = `${crypto.randomUUID()}.${ext}`;
      const storagePath = `feed_images/${req.user.id}/${uniqueName}`;

      const { error } = await uploadToBucket(BUCKET_NAME, storagePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false,
      });

      if (error) {
        console.error('Feed image upload error:', error);
        return next(new AppError('Failed to upload image', 500));
      }

      imagePath = storagePath;
    }

    let result;
    try {
      result = await pool.query(
        `INSERT INTO social_posts (user_id, content, image_url, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())
         RETURNING *`,
        [req.user.id, content, imagePath]
      );
    } catch (dbError) {
      // Clean up orphaned image if DB insert fails
      if (imagePath) {
        await deleteFromBucket(BUCKET_NAME, imagePath).catch(() => {});
      }
      throw dbError;
    }

    const post = result.rows[0];
    const signed = await signImageUrl(post.image_url);

    res.status(201).json({
      success: true,
      post: { ...post, image_signed_url: signed, liked_by_me: false },
    });
  } catch (error) {
    next(error);
  }
});

// ─── DELETE /api/feed/:id  — delete own post ────────────────────────

router.delete('/:id', async (req, res, next) => {
  try {
    const postResult = await pool.query(
      'SELECT * FROM social_posts WHERE id = $1',
      [req.params.id]
    );

    if (postResult.rows.length === 0) return next(new AppError('Post not found', 404));

    const post = postResult.rows[0];

    // Only the author or an admin can delete
    if (post.user_id !== req.user.id && req.user.account_type !== 'admin') {
      return next(new AppError('Not authorized to delete this post', 403));
    }

    // Delete image from storage if exists
    if (post.image_url) {
      await deleteFromBucket(BUCKET_NAME, post.image_url);
    }

    await pool.query('DELETE FROM social_posts WHERE id = $1', [req.params.id]);

    res.json({ success: true, message: 'Post deleted' });
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/feed/:id/like  — toggle like ────────────────────────

router.post('/:id/like', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const postId = req.params.id;
    const userId = req.user.id;

    await client.query('BEGIN');

    // Try to insert a like; if it already exists, delete it instead
    const inserted = await client.query(
      `INSERT INTO social_post_likes (post_id, user_id, created_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (post_id, user_id) DO NOTHING
       RETURNING id`,
      [postId, userId]
    );

    let liked;
    if (inserted.rows.length > 0) {
      // New like was inserted
      await client.query(
        'UPDATE social_posts SET likes_count = likes_count + 1 WHERE id = $1',
        [postId]
      );
      liked = true;
    } else {
      // Already liked — remove the like
      await client.query(
        'DELETE FROM social_post_likes WHERE post_id = $1 AND user_id = $2',
        [postId, userId]
      );
      await client.query(
        'UPDATE social_posts SET likes_count = GREATEST(likes_count - 1, 0) WHERE id = $1',
        [postId]
      );
      liked = false;
    }

    const updated = await client.query('SELECT likes_count FROM social_posts WHERE id = $1', [postId]);
    await client.query('COMMIT');

    return res.json({ success: true, liked, likes_count: updated.rows[0]?.likes_count || 0 });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

export default router;
