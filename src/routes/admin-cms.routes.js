import express from 'express';
import crypto from 'crypto';
import multer from 'multer';
import pool from '../config/database.js';
import { protect, authorize } from '../middleware/auth.js';
import { uploadToBucket, createSignedUrl, deleteFromBucket, BUCKET_NAME, FOLDERS } from '../utils/supabaseStorage.js';

const router = express.Router();

// Protect all admin CMS routes
router.use(protect);
router.use(authorize('admin'));

// Configure multer for document uploads (memory storage -> Supabase)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'image/jpeg',
      'image/png',
      'image/webp',
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, DOC, DOCX, JPG, PNG, WEBP files are allowed'));
    }
  },
});

// Helper: generate slug from title
function generateSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
}

// Helper: ensure slug uniqueness
async function uniqueSlug(base, excludeId = null) {
  let slug = base;
  let suffix = 2;
  while (true) {
    const check = excludeId
      ? await pool.query('SELECT id FROM cms_posts WHERE slug = $1 AND id != $2', [slug, excludeId])
      : await pool.query('SELECT id FROM cms_posts WHERE slug = $1', [slug]);
    if (check.rows.length === 0) return slug;
    slug = `${base}-${suffix}`;
    suffix++;
  }
}

// GET /api/admin/cms/posts — List all posts (drafts + published)
router.get('/posts', async (req, res) => {
  try {
    const { category, status, search, page = 1, limit = 20 } = req.query;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    let query = `
      SELECT id, slug, title, organization, category, status, is_featured,
             advertisement_no, total_vacancies, published_at, created_at, updated_at
      FROM cms_posts WHERE 1=1
    `;
    let countQuery = `SELECT COUNT(*) FROM cms_posts WHERE 1=1`;
    const params = [];
    const countParams = [];
    let pi = 1;
    let ci = 1;

    if (category && category !== 'all') {
      query += ` AND category = $${pi++}`;
      countQuery += ` AND category = $${ci++}`;
      params.push(category);
      countParams.push(category);
    }

    if (status && status !== 'all') {
      query += ` AND status = $${pi++}`;
      countQuery += ` AND status = $${ci++}`;
      params.push(status);
      countParams.push(status);
    }

    if (search && search.trim()) {
      query += ` AND (title ILIKE $${pi++} OR organization ILIKE $${pi++})`;
      countQuery += ` AND (title ILIKE $${ci++} OR organization ILIKE $${ci++})`;
      const term = `%${search.trim()}%`;
      params.push(term, term);
      countParams.push(term, term);
    }

    query += ` ORDER BY created_at DESC LIMIT $${pi++} OFFSET $${pi++}`;
    params.push(limitNum, offset);

    const [postsResult, countResult, aggResult] = await Promise.all([
      pool.query(query, params),
      pool.query(countQuery, countParams),
      pool.query(`SELECT
        COUNT(*) FILTER (WHERE status = 'published') AS published_count,
        COUNT(*) FILTER (WHERE status = 'draft')     AS draft_count,
        COUNT(*)                                     AS total_count
        FROM cms_posts`),
    ]);

    const total = parseInt(countResult.rows[0].count);
    const { published_count, draft_count, total_count } = aggResult.rows[0];

    res.json({
      success: true,
      posts: postsResult.rows,
      pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
      counts: {
        total: parseInt(total_count),
        published: parseInt(published_count),
        drafts: parseInt(draft_count),
      },
    });
  } catch (error) {
    console.error('Error fetching admin CMS posts:', error);
    res.status(500).json({ success: false, message: 'Error fetching posts' });
  }
});

// POST /api/admin/cms/posts — Create new post
router.post('/posts', async (req, res) => {
  try {
    const {
      title, organization, category, status = 'draft', is_featured = false,
      brief_info, important_dates, application_fee, age_limit,
      vacancy_details, eligibility, how_to_apply, important_links,
      advertisement_no, total_vacancies, meta_title, meta_description,
    } = req.body;

    if (!title || !organization || !category) {
      return res.status(400).json({ success: false, message: 'Title, organization, and category are required' });
    }

    const slug = await uniqueSlug(generateSlug(title));
    const published_at = status === 'published' ? new Date().toISOString() : null;

    const result = await pool.query(
      `INSERT INTO cms_posts
        (slug, title, organization, category, status, is_featured,
         brief_info, important_dates, application_fee, age_limit,
         vacancy_details, eligibility, how_to_apply, important_links,
         advertisement_no, total_vacancies, meta_title, meta_description,
         published_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING *`,
      [
        slug, title, organization, category, status, is_featured,
        brief_info || null,
        JSON.stringify(important_dates || {}),
        JSON.stringify(application_fee || {}),
        JSON.stringify(age_limit || {}),
        JSON.stringify(vacancy_details || []),
        eligibility || null,
        how_to_apply || null,
        JSON.stringify(important_links || []),
        advertisement_no || null,
        total_vacancies || null,
        meta_title || null,
        meta_description || null,
        published_at,
        req.user.id,
      ]
    );

    res.status(201).json({ success: true, post: result.rows[0] });
  } catch (error) {
    console.error('Error creating CMS post:', error);
    res.status(500).json({ success: false, message: 'Error creating post' });
  }
});

// GET /api/admin/cms/posts/:id — Single post by UUID for editing
router.get('/posts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM cms_posts WHERE id = $1', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }

    res.json({ success: true, post: result.rows[0] });
  } catch (error) {
    console.error('Error fetching CMS post:', error);
    res.status(500).json({ success: false, message: 'Error fetching post' });
  }
});

// PUT /api/admin/cms/posts/:id — Update post
router.put('/posts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      title, organization, category, status, is_featured,
      brief_info, important_dates, application_fee, age_limit,
      vacancy_details, eligibility, how_to_apply, important_links,
      advertisement_no, total_vacancies, meta_title, meta_description,
    } = req.body;

    // Check post exists
    const existing = await pool.query('SELECT * FROM cms_posts WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }

    const old = existing.rows[0];

    // Regenerate slug if title changed
    let slug = old.slug;
    if (title && title !== old.title) {
      slug = await uniqueSlug(generateSlug(title), id);
    }

    // Set published_at on first publish
    let published_at = old.published_at;
    if (status === 'published' && old.status !== 'published') {
      published_at = new Date().toISOString();
    }

    const result = await pool.query(
      `UPDATE cms_posts SET
        slug=$1, title=$2, organization=$3, category=$4, status=$5, is_featured=$6,
        brief_info=$7, important_dates=$8, application_fee=$9, age_limit=$10,
        vacancy_details=$11, eligibility=$12, how_to_apply=$13, important_links=$14,
        advertisement_no=$15, total_vacancies=$16, meta_title=$17, meta_description=$18,
        published_at=$19
       WHERE id=$20 RETURNING *`,
      [
        slug,
        title ?? old.title,
        organization ?? old.organization,
        category ?? old.category,
        status ?? old.status,
        is_featured ?? old.is_featured,
        brief_info ?? old.brief_info,
        JSON.stringify(important_dates ?? old.important_dates),
        JSON.stringify(application_fee ?? old.application_fee),
        JSON.stringify(age_limit ?? old.age_limit),
        JSON.stringify(vacancy_details ?? old.vacancy_details),
        eligibility ?? old.eligibility,
        how_to_apply ?? old.how_to_apply,
        JSON.stringify(important_links ?? old.important_links),
        advertisement_no ?? old.advertisement_no,
        total_vacancies ?? old.total_vacancies,
        meta_title ?? old.meta_title,
        meta_description ?? old.meta_description,
        published_at,
        id,
      ]
    );

    res.json({ success: true, post: result.rows[0] });
  } catch (error) {
    console.error('Error updating CMS post:', error);
    res.status(500).json({ success: false, message: 'Error updating post' });
  }
});

// DELETE /api/admin/cms/posts/:id — Delete post (also cleans up uploaded docs)
router.delete('/posts/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Get post to clean up documents from storage
    const postResult = await pool.query('SELECT documents FROM cms_posts WHERE id = $1', [id]);
    if (postResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }

    const documents = postResult.rows[0].documents || [];

    // Delete all uploaded docs from Supabase Storage
    for (const doc of documents) {
      if (doc.path) {
        await deleteFromBucket(BUCKET_NAME, doc.path).catch(() => {});
      }
    }

    await pool.query('DELETE FROM cms_posts WHERE id = $1', [id]);

    res.json({ success: true, message: 'Post deleted' });
  } catch (error) {
    console.error('Error deleting CMS post:', error);
    res.status(500).json({ success: false, message: 'Error deleting post' });
  }
});

// ===== DOCUMENT UPLOAD ENDPOINTS =====

// POST /api/admin/cms/posts/:id/documents — Upload document(s) to a post
router.post('/posts/:id/documents', upload.array('documents', 5), async (req, res) => {
  try {
    const { id } = req.params;

    // Verify post exists
    const postResult = await pool.query('SELECT documents FROM cms_posts WHERE id = $1', [id]);
    if (postResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: 'No files uploaded' });
    }

    const existingDocs = postResult.rows[0].documents || [];
    const newDocs = [];

    for (const file of req.files) {
      const docId = crypto.randomUUID();
      const ext = file.originalname.split('.').pop().toLowerCase();
      const storagePath = `${FOLDERS.CMS_DOCS}/${id}/${docId}.${ext}`;

      const { error } = await uploadToBucket(BUCKET_NAME, storagePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });

      if (error) {
        console.error('Supabase upload error:', error);
        continue;
      }

      newDocs.push({
        id: docId,
        name: file.originalname,
        path: storagePath,
        size: file.size,
        type: file.mimetype,
        uploaded_at: new Date().toISOString(),
      });
    }

    if (newDocs.length === 0) {
      return res.status(500).json({ success: false, message: 'Failed to upload documents' });
    }

    const allDocs = [...existingDocs, ...newDocs];

    await pool.query('UPDATE cms_posts SET documents = $1 WHERE id = $2', [JSON.stringify(allDocs), id]);

    res.json({ success: true, documents: allDocs });
  } catch (error) {
    console.error('Error uploading CMS documents:', error);
    res.status(500).json({ success: false, message: 'Error uploading documents' });
  }
});

// DELETE /api/admin/cms/posts/:id/documents/:docId — Remove a single document
router.delete('/posts/:id/documents/:docId', async (req, res) => {
  try {
    const { id, docId } = req.params;

    const postResult = await pool.query('SELECT documents FROM cms_posts WHERE id = $1', [id]);
    if (postResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }

    const documents = postResult.rows[0].documents || [];
    const doc = documents.find(d => d.id === docId);

    if (!doc) {
      return res.status(404).json({ success: false, message: 'Document not found' });
    }

    // Delete from Supabase Storage
    await deleteFromBucket(BUCKET_NAME, doc.path).catch(() => {});

    // Remove from JSONB array
    const updatedDocs = documents.filter(d => d.id !== docId);
    await pool.query('UPDATE cms_posts SET documents = $1 WHERE id = $2', [JSON.stringify(updatedDocs), id]);

    res.json({ success: true, documents: updatedDocs });
  } catch (error) {
    console.error('Error deleting CMS document:', error);
    res.status(500).json({ success: false, message: 'Error deleting document' });
  }
});

// GET /api/admin/cms/posts/:id/documents/:docId/url — Get signed URL for a document
router.get('/posts/:id/documents/:docId/url', async (req, res) => {
  try {
    const { id, docId } = req.params;

    const postResult = await pool.query('SELECT documents FROM cms_posts WHERE id = $1', [id]);
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
    console.error('Error generating document URL:', error);
    res.status(500).json({ success: false, message: 'Error generating URL' });
  }
});

export default router;
