import express from 'express';
import { createUpload } from '../utils/upload.js';
import pool from '../config/database.js';
import { protect } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { uploadToBucket, deleteFromBucket, signImageUrl, BUCKET_NAME } from '../utils/supabaseStorage.js';
import crypto from 'crypto';

const router = express.Router();

const upload = createUpload();

router.use(protect);

// ─── Helpers ───────────────────────────────────────────────────────

function extractHashtags(content) {
  const matches = content.match(/#([a-zA-Z0-9_]+)/g);
  if (!matches) return [];
  return [...new Set(matches.map(m => m.slice(1).toLowerCase()))];
}

async function linkHashtags(client, postId, tags) {
  for (const tag of tags) {
    const result = await client.query(
      `INSERT INTO hashtags (tag) VALUES ($1)
       ON CONFLICT (tag) DO UPDATE SET tag = EXCLUDED.tag
       RETURNING id`,
      [tag]
    );
    await client.query(
      `INSERT INTO post_hashtags (post_id, hashtag_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [postId, result.rows[0].id]
    );
  }
}

const feedSelectColumns = `
  p.id, p.content, p.image_url, p.likes_count, p.comments_count, p.shares_count,
  p.created_at, p.updated_at, p.user_id,
  u.name AS author_name, u.account_type AS author_type,
  CASE WHEN u.account_type = 'candidate' THEN c.full_name ELSE u.name END AS author_display_name,
  CASE WHEN u.account_type = 'candidate' THEN c.title WHEN u.account_type = 'company' THEN co.industry ELSE NULL END AS author_headline,
  CASE WHEN u.account_type = 'candidate' THEN c.avatar_url WHEN u.account_type = 'company' THEN co.logo_url ELSE NULL END AS author_avatar_path,
  CASE WHEN u.account_type = 'company' THEN co.slug ELSE NULL END AS author_company_slug,
  EXISTS (SELECT 1 FROM social_post_likes l WHERE l.post_id = p.id AND l.user_id = $1) AS liked_by_me,
  EXISTS (SELECT 1 FROM social_bookmarks b WHERE b.post_id = p.id AND b.user_id = $1) AS bookmarked_by_me
`;

const feedJoins = `
  FROM social_posts p
  JOIN users u ON u.id = p.user_id
  LEFT JOIN candidates c ON c.user_id = u.id AND u.account_type = 'candidate'
  LEFT JOIN companies co ON co.user_id = u.id AND u.account_type = 'company'
`;

async function signPosts(rows) {
  return Promise.all(
    rows.map(async (post) => ({
      ...post,
      image_signed_url: await signImageUrl(post.image_url),
      author_avatar_url: await signImageUrl(post.author_avatar_path),
    }))
  );
}

// ════════════════════════════════════════════════════════════════════
// STATIC ROUTES (must come before /:id params)
// ════════════════════════════════════════════════════════════════════

// ─── GET /api/feed — paginated feed with sort/filter ───────────────

router.get('/', async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 10, 30);
    const offset = (page - 1) * limit;
    const sort = req.query.sort || 'latest';
    const filter = req.query.filter || '';
    const hashtag = (req.query.hashtag || '').trim().toLowerCase();

    let whereClause = '';
    let orderClause = '';
    let extraJoin = '';
    const params = [req.user.id];

    if (filter === 'mine') {
      whereClause = `WHERE p.user_id = $1`;
    } else if (sort === 'following') {
      extraJoin = `INNER JOIN user_connections uc ON uc.following_id = p.user_id AND uc.follower_id = $1`;
    }

    if (hashtag) {
      extraJoin += ` INNER JOIN post_hashtags ph ON ph.post_id = p.id
                     INNER JOIN hashtags h ON h.id = ph.hashtag_id AND h.tag = $${params.length + 1}`;
      params.push(hashtag);
    }

    if (sort === 'top') {
      orderClause = `ORDER BY (
        (p.likes_count * 2 + p.comments_count * 3 + p.shares_count)
        * (1.0 / (1 + EXTRACT(EPOCH FROM (NOW() - p.created_at)) / 86400))
      ) DESC`;
    } else {
      orderClause = 'ORDER BY p.created_at DESC';
    }

    const limitIdx = params.length + 1;
    const offsetIdx = params.length + 2;
    params.push(limit, offset);

    const result = await pool.query(
      `SELECT ${feedSelectColumns}
       ${feedJoins}
       ${extraJoin}
       ${whereClause}
       ${orderClause}
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    );

    const countParams = [];
    let countExtraJoin = '';
    let countWhere = '';

    if (filter === 'mine') {
      countParams.push(req.user.id);
      countWhere = `WHERE p.user_id = $${countParams.length}`;
    } else if (sort === 'following') {
      countParams.push(req.user.id);
      countExtraJoin = `INNER JOIN user_connections uc ON uc.following_id = p.user_id AND uc.follower_id = $${countParams.length}`;
    }

    if (hashtag) {
      countParams.push(hashtag);
      countExtraJoin += ` INNER JOIN post_hashtags ph ON ph.post_id = p.id
                          INNER JOIN hashtags h ON h.id = ph.hashtag_id AND h.tag = $${countParams.length}`;
    }

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM social_posts p ${countExtraJoin} ${countWhere}`,
      countParams
    );
    const total = parseInt(countResult.rows[0].count);

    const posts = await signPosts(result.rows);

    res.json({
      success: true,
      posts,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/feed — create post (with hashtag extraction) ────────

router.post('/', upload.single('image'), async (req, res, next) => {
  const client = await pool.connect();
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

    await client.query('BEGIN');

    let result;
    try {
      result = await client.query(
        `INSERT INTO social_posts (user_id, content, image_url, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())
         RETURNING *`,
        [req.user.id, content, imagePath]
      );
    } catch (dbError) {
      if (imagePath) {
        await deleteFromBucket(BUCKET_NAME, imagePath).catch(() => {});
      }
      throw dbError;
    }

    const post = result.rows[0];
    const tags = extractHashtags(content);
    if (tags.length > 0) {
      await linkHashtags(client, post.id, tags);
    }

    await client.query('COMMIT');

    const signed = await signImageUrl(post.image_url);

    res.status(201).json({
      success: true,
      post: { ...post, image_signed_url: signed, liked_by_me: false, bookmarked_by_me: false },
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

// ─── GET /api/feed/bookmarks — user's bookmarked posts ─────────────

router.get('/bookmarks', async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 10, 30);
    const offset = (page - 1) * limit;

    const result = await pool.query(
      `SELECT ${feedSelectColumns}
       ${feedJoins}
       INNER JOIN social_bookmarks sb ON sb.post_id = p.id AND sb.user_id = $1
       ORDER BY sb.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );

    const countResult = await pool.query(
      'SELECT COUNT(*) FROM social_bookmarks WHERE user_id = $1',
      [req.user.id]
    );
    const total = parseInt(countResult.rows[0].count);
    const posts = await signPosts(result.rows);

    res.json({
      success: true,
      posts,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/feed/connections — people the user follows ───────────

router.get('/connections', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const offset = parseInt(req.query.offset) || 0;

    const result = await pool.query(
      `SELECT u.id, u.account_type,
              COALESCE(c.full_name, u.name) AS display_name,
              COALESCE(c.title, co.industry) AS headline,
              COALESCE(c.avatar_url, co.logo_url) AS avatar_path,
              uc.created_at AS connected_since
       FROM user_connections uc
       JOIN users u ON u.id = uc.following_id
       LEFT JOIN candidates c ON c.user_id = u.id
       LEFT JOIN companies co ON co.user_id = u.id
       WHERE uc.follower_id = $1
       ORDER BY uc.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );

    const countResult = await pool.query(
      'SELECT COUNT(*) FROM user_connections WHERE follower_id = $1',
      [req.user.id]
    );

    const connections = await Promise.all(
      result.rows.map(async (r) => ({
        ...r,
        avatar_url: await signImageUrl(r.avatar_path),
      }))
    );

    res.json({
      success: true,
      connections,
      total: parseInt(countResult.rows[0].count),
    });
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/feed/followers — people who follow the user ──────────

router.get('/followers', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const offset = parseInt(req.query.offset) || 0;

    const result = await pool.query(
      `SELECT u.id, u.account_type,
              COALESCE(c.full_name, u.name) AS display_name,
              COALESCE(c.title, co.industry) AS headline,
              COALESCE(c.avatar_url, co.logo_url) AS avatar_path
       FROM user_connections uc
       JOIN users u ON u.id = uc.follower_id
       LEFT JOIN candidates c ON c.user_id = u.id
       LEFT JOIN companies co ON co.user_id = u.id
       WHERE uc.following_id = $1
       ORDER BY uc.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );

    const countResult = await pool.query(
      'SELECT COUNT(*) FROM user_connections WHERE following_id = $1',
      [req.user.id]
    );

    const followers = await Promise.all(
      result.rows.map(async (r) => ({
        ...r,
        avatar_url: await signImageUrl(r.avatar_path),
      }))
    );

    res.json({
      success: true,
      followers,
      total: parseInt(countResult.rows[0].count),
    });
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/feed/trending — top hashtags (last 7 days) ───────────

router.get('/trending', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT h.id, h.tag,
              COUNT(ph.post_id) AS recent_posts,
              h.post_count AS total_posts
       FROM hashtags h
       JOIN post_hashtags ph ON ph.hashtag_id = h.id
       JOIN social_posts p ON p.id = ph.post_id
       WHERE p.created_at > NOW() - INTERVAL '7 days'
       GROUP BY h.id, h.tag, h.post_count
       ORDER BY recent_posts DESC
       LIMIT 10`
    );

    res.json({ success: true, trending: result.rows });
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/feed/suggested — who to follow recommendations ───────

router.get('/suggested', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 5, 20);

    const result = await pool.query(
      `SELECT u.id, u.account_type,
              COALESCE(c.full_name, u.name) AS display_name,
              COALESCE(c.title, co.industry) AS headline,
              COALESCE(c.avatar_url, co.logo_url) AS avatar_path,
              COUNT(DISTINCT mutual.follower_id) AS mutual_count
       FROM users u
       LEFT JOIN candidates c ON c.user_id = u.id
       LEFT JOIN companies co ON co.user_id = u.id
       LEFT JOIN user_connections mutual ON mutual.following_id = u.id
         AND mutual.follower_id IN (
           SELECT following_id FROM user_connections WHERE follower_id = $1
         )
       WHERE u.id != $1
         AND u.id NOT IN (SELECT following_id FROM user_connections WHERE follower_id = $1)
       GROUP BY u.id, u.name, u.account_type, c.full_name, c.title, c.avatar_url, co.industry, co.logo_url
       ORDER BY mutual_count DESC, u.created_at DESC
       LIMIT $2`,
      [req.user.id, limit]
    );

    const suggested = await Promise.all(
      result.rows.map(async (r) => ({
        ...r,
        avatar_url: await signImageUrl(r.avatar_path),
      }))
    );

    res.json({ success: true, suggested });
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/feed/profile-stats — follower/following counts ───────

router.get('/profile-stats', async (req, res, next) => {
  try {
    const [followingResult, followersResult] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM user_connections WHERE follower_id = $1', [req.user.id]),
      pool.query('SELECT COUNT(*) FROM user_connections WHERE following_id = $1', [req.user.id]),
    ]);

    res.json({
      success: true,
      following: parseInt(followingResult.rows[0].count),
      followers: parseInt(followersResult.rows[0].count),
    });
  } catch (error) {
    next(error);
  }
});

// ─── DELETE /api/feed/comments/:commentId — delete own comment ─────

router.delete('/comments/:commentId', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const comment = await client.query(
      'SELECT * FROM social_post_comments WHERE id = $1 FOR UPDATE',
      [req.params.commentId]
    );
    if (comment.rows.length === 0) {
      await client.query('ROLLBACK');
      return next(new AppError('Comment not found', 404));
    }
    if (comment.rows[0].user_id !== req.user.id && req.user.account_type !== 'admin') {
      await client.query('ROLLBACK');
      return next(new AppError('Not authorized', 403));
    }

    await client.query('DELETE FROM social_post_comments WHERE id = $1', [req.params.commentId]);

    await client.query('COMMIT');

    res.json({ success: true, message: 'Comment deleted' });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

// ─── POST /api/feed/follow/:userId — follow a user ────────────────

router.post('/follow/:userId', async (req, res, next) => {
  try {
    const targetId = req.params.userId;
    if (targetId === req.user.id) return next(new AppError('Cannot follow yourself', 400));

    const userExists = await pool.query('SELECT id FROM users WHERE id = $1', [targetId]);
    if (userExists.rows.length === 0) return next(new AppError('User not found', 404));

    await pool.query(
      `INSERT INTO user_connections (follower_id, following_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [req.user.id, targetId]
    );

    res.json({ success: true, following: true });
  } catch (error) {
    next(error);
  }
});

// ─── DELETE /api/feed/follow/:userId — unfollow ────────────────────

router.delete('/follow/:userId', async (req, res, next) => {
  try {
    await pool.query(
      'DELETE FROM user_connections WHERE follower_id = $1 AND following_id = $2',
      [req.user.id, req.params.userId]
    );
    res.json({ success: true, following: false });
  } catch (error) {
    next(error);
  }
});

// ════════════════════════════════════════════════════════════════════
// DYNAMIC /:id ROUTES (after all static routes)
// ════════════════════════════════════════════════════════════════════

// ─── DELETE /api/feed/:id — delete own post ────────────────────────

router.delete('/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const postResult = await client.query('SELECT * FROM social_posts WHERE id = $1', [req.params.id]);
    if (postResult.rows.length === 0) return next(new AppError('Post not found', 404));

    const post = postResult.rows[0];
    if (post.user_id !== req.user.id && req.user.account_type !== 'admin') {
      return next(new AppError('Not authorized to delete this post', 403));
    }

    await client.query('BEGIN');
    await client.query('DELETE FROM social_posts WHERE id = $1', [req.params.id]);
    await client.query('COMMIT');

    if (post.image_url) {
      await deleteFromBucket(BUCKET_NAME, post.image_url).catch(() => {});
    }

    res.json({ success: true, message: 'Post deleted' });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

// ─── POST /api/feed/:id/like — toggle like ─────────────────────────

router.post('/:id/like', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const postId = req.params.id;
    const userId = req.user.id;

    await client.query('BEGIN');

    const inserted = await client.query(
      `INSERT INTO social_post_likes (post_id, user_id, created_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (post_id, user_id) DO NOTHING
       RETURNING id`,
      [postId, userId]
    );

    let liked;
    if (inserted.rows.length > 0) {
      await client.query('UPDATE social_posts SET likes_count = likes_count + 1 WHERE id = $1', [postId]);
      liked = true;
    } else {
      await client.query('DELETE FROM social_post_likes WHERE post_id = $1 AND user_id = $2', [postId, userId]);
      await client.query('UPDATE social_posts SET likes_count = GREATEST(likes_count - 1, 0) WHERE id = $1', [postId]);
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

// ─── POST /api/feed/:id/bookmark — toggle bookmark ────────────────

router.post('/:id/bookmark', async (req, res, next) => {
  try {
    const postId = req.params.id;
    const userId = req.user.id;

    const inserted = await pool.query(
      `INSERT INTO social_bookmarks (post_id, user_id) VALUES ($1, $2)
       ON CONFLICT (post_id, user_id) DO NOTHING RETURNING id`,
      [postId, userId]
    );

    let bookmarked;
    if (inserted.rows.length > 0) {
      bookmarked = true;
    } else {
      await pool.query('DELETE FROM social_bookmarks WHERE post_id = $1 AND user_id = $2', [postId, userId]);
      bookmarked = false;
    }

    res.json({ success: true, bookmarked });
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/feed/:id/comments — paginated comments ──────────────

router.get('/:id/comments', async (req, res, next) => {
  try {
    const postId = req.params.id;
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const offset = (page - 1) * limit;

    const result = await pool.query(
      `SELECT sc.id, sc.content, sc.created_at, sc.user_id,
              u.name AS author_name, u.account_type AS author_type,
              CASE WHEN u.account_type = 'candidate' THEN c.full_name ELSE u.name END AS author_display_name,
              CASE WHEN u.account_type = 'candidate' THEN c.avatar_url WHEN u.account_type = 'company' THEN co.logo_url ELSE NULL END AS author_avatar_path
       FROM social_post_comments sc
       JOIN users u ON u.id = sc.user_id
       LEFT JOIN candidates c ON c.user_id = u.id AND u.account_type = 'candidate'
       LEFT JOIN companies co ON co.user_id = u.id AND u.account_type = 'company'
       WHERE sc.post_id = $1
       ORDER BY sc.created_at ASC
       LIMIT $2 OFFSET $3`,
      [postId, limit, offset]
    );

    const countResult = await pool.query(
      'SELECT COUNT(*) FROM social_post_comments WHERE post_id = $1',
      [postId]
    );

    const comments = await Promise.all(
      result.rows.map(async (c) => ({
        ...c,
        author_avatar_url: await signImageUrl(c.author_avatar_path),
      }))
    );

    res.json({
      success: true,
      comments,
      total: parseInt(countResult.rows[0].count),
    });
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/feed/:id/comments — add comment ────────────────────

router.post('/:id/comments', async (req, res, next) => {
  try {
    const postId = req.params.id;
    const content = (req.body.content || '').trim();
    if (!content) return next(new AppError('Comment content is required', 400));
    if (content.length > 300) return next(new AppError('Comment must be 300 characters or less', 400));

    const result = await pool.query(
      `INSERT INTO social_post_comments (post_id, user_id, content)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [postId, req.user.id, content]
    );

    res.status(201).json({ success: true, comment: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/feed/:id/share — increment share count ─────────────

router.post('/:id/share', async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE social_posts SET shares_count = shares_count + 1 WHERE id = $1 RETURNING shares_count`,
      [req.params.id]
    );
    if (result.rows.length === 0) return next(new AppError('Post not found', 404));
    res.json({ success: true, shares_count: result.rows[0].shares_count });
  } catch (error) {
    next(error);
  }
});

export default router;
