import express from 'express';
import pool from '../config/database.js';
import { createSignedUrl, BUCKET_NAME } from '../utils/supabaseStorage.js';

const router = express.Router();

// GET /api/cms/posts — List published posts with filters + pagination
router.get('/posts', async (req, res) => {
  try {
    const {
      category,
      search,
      page = 1,
      limit = 20,
    } = req.query;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    let query = `
      SELECT id, slug, title, organization, category, is_featured,
             brief_info, important_dates, total_vacancies,
             advertisement_no, published_at, created_at
      FROM cms_posts
      WHERE status = 'published'
    `;

    let countQuery = `SELECT COUNT(*) FROM cms_posts WHERE status = 'published'`;
    const params = [];
    const countParams = [];
    let paramIndex = 1;
    let countParamIndex = 1;

    if (category && category !== 'all') {
      query += ` AND category = $${paramIndex}`;
      countQuery += ` AND category = $${countParamIndex}`;
      params.push(category);
      countParams.push(category);
      paramIndex++;
      countParamIndex++;
    }

    if (search && search.trim()) {
      query += ` AND to_tsvector('english', coalesce(title, '') || ' ' || coalesce(organization, '')) @@ plainto_tsquery('english', $${paramIndex})`;
      countQuery += ` AND to_tsvector('english', coalesce(title, '') || ' ' || coalesce(organization, '')) @@ plainto_tsquery('english', $${countParamIndex})`;
      params.push(search.trim());
      countParams.push(search.trim());
      paramIndex++;
      countParamIndex++;
    }

    query += ` ORDER BY is_featured DESC, published_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limitNum, offset);

    const [postsResult, countResult] = await Promise.all([
      pool.query(query, params),
      pool.query(countQuery, countParams),
    ]);

    const total = parseInt(countResult.rows[0].count);

    res.json({
      success: true,
      posts: postsResult.rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error('Error fetching CMS posts:', error);
    res.status(500).json({ success: false, message: 'Error fetching posts' });
  }
});

// GET /api/cms/posts/:slug — Single published post by slug
router.get('/posts/:slug', async (req, res) => {
  try {
    const { slug } = req.params;

    const result = await pool.query(
      `SELECT * FROM cms_posts WHERE slug = $1 AND status = 'published'`,
      [slug]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }

    res.json({ success: true, post: result.rows[0] });
  } catch (error) {
    console.error('Error fetching CMS post:', error);
    res.status(500).json({ success: false, message: 'Error fetching post' });
  }
});

// GET /api/cms/posts/:slug/documents/:docId/url — Public signed URL for a document
router.get('/posts/:slug/documents/:docId/url', async (req, res) => {
  try {
    const { slug, docId } = req.params;

    const postResult = await pool.query(
      `SELECT documents FROM cms_posts WHERE slug = $1 AND status = 'published'`,
      [slug]
    );

    if (postResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }

    const documents = postResult.rows[0].documents || [];
    const doc = documents.find(d => d.id === docId);

    if (!doc) {
      return res.status(404).json({ success: false, message: 'Document not found' });
    }

    const { data, error } = await createSignedUrl(BUCKET_NAME, doc.path, 3600);
    if (error) {
      return res.status(500).json({ success: false, message: 'Failed to generate URL' });
    }

    res.json({ success: true, url: data.signedUrl, name: doc.name, type: doc.type });
  } catch (error) {
    console.error('Error generating public document URL:', error);
    res.status(500).json({ success: false, message: 'Error generating URL' });
  }
});

export default router;
