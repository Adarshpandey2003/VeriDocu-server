import express from 'express';
import multer from 'multer';
import { createRequire } from 'module';
import * as cheerio from 'cheerio';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse/lib/pdf-parse.js');
import { body, param, validationResult } from 'express-validator';
import { protect } from '../middleware/auth.js';
import pool from '../config/database.js';
import { AppError } from '../middleware/errorHandler.js';
import { uploadToBucket, BUCKET_NAME } from '../utils/supabaseStorage.js';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

// ── Parse PDF → extract text ───────────────────────────────────────────────
router.post('/parse-pdf', protect, upload.single('resume'), async (req, res, next) => {
  try {
    if (!req.file) return next(new AppError('No PDF file uploaded', 400));
    if (req.file.mimetype !== 'application/pdf') {
      return next(new AppError('Only PDF files are accepted', 400));
    }
    const parsed = await pdfParse(req.file.buffer);
    res.json({ text: parsed.text.trim() });
  } catch (err) {
    next(err);
  }
});

// ── Parse LinkedIn public profile ──────────────────────────────────────────
router.post(
  '/parse-linkedin',
  protect,
  [body('url').notEmpty().withMessage('LinkedIn URL required')],
  validate,
  async (req, res, next) => {
    try {
      // Normalise URL – add https:// if missing
      let rawUrl = req.body.url.trim();
      if (!/^https?:\/\//i.test(rawUrl)) rawUrl = 'https://' + rawUrl;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);

      let response;
      try {
        response = await fetch(rawUrl, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
            Accept: 'text/html,application/xhtml+xml',
          },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        return res.status(200).json({
          partial: true,
          blocked: true,
          message:
            'LinkedIn blocked the request. Please paste your profile summary text in the text area below.',
        });
      }

      const html = await response.text();
      const $ = cheerio.load(html);

      const name =
        $('h1').first().text().trim() ||
        $('[class*="top-card__title"]').first().text().trim();
      const title =
        $('[class*="top-card__subline-item"]').first().text().trim() ||
        $('[class*="headline"]').first().text().trim();
      const location = $('[class*="top-card__flavor--bullet"]').first().text().trim();

      // Grab a best-effort body text slice for AI processing
      const bodyText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 6000);

      res.json({ name, title, location, bodyText, partial: true });
    } catch (err) {
      if (err.name === 'AbortError') {
        return res.status(200).json({
          partial: true,
          blocked: true,
          message: 'LinkedIn request timed out. Please paste your profile text instead.',
        });
      }
      next(err);
    }
  }
);

// ── Generate LaTeX via Sarvam AI ───────────────────────────────────────────
router.post(
  '/generate',
  protect,
  [
    body('resumeData').notEmpty().withMessage('Resume data is required'),
    body('targetRole').trim().notEmpty().withMessage('Target role is required'),
    body('jobDescription').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { resumeData, targetRole } = req.body;
      const resumeStr =
        typeof resumeData === 'string'
          ? resumeData
          : JSON.stringify(resumeData, null, 2);

      const { jobDescription } = req.body;

      const systemPrompt = `You are a world-class resume writer and LaTeX expert. Produce a COMPLETE, COMPILABLE LaTeX resume document.

OUTPUT FORMAT — ABSOLUTE RULES:
- Output RAW LaTeX only. Zero markdown, zero explanation, zero code fences.
- First line MUST be: \\documentclass[letterpaper,11pt]{article}
- Last line MUST be: \\end{document}
- Every special character in user data MUST be escaped: & → \\&, % → \\%, $ → \\$, # → \\#, _ → \\_, ^ → \\^{}, ~ → \\textasciitilde{}

REQUIRED PACKAGE BLOCK — use EXACTLY these lines, NO others, NO fontawesome, NO icons, NO extra fonts:
\\usepackage[top=0.65in,bottom=0.65in,left=0.75in,right=0.75in]{geometry}
\\usepackage[T1]{fontenc}
\\usepackage[utf8]{inputenc}
\\usepackage{enumitem}
\\usepackage{titlesec}
\\usepackage{hyperref}
\\usepackage{xcolor}
\\hypersetup{hidelinks}
\\setlength{\\parindent}{0pt}
\\setlength{\\parskip}{0pt}

FORBIDDEN PACKAGES (will cause compile errors): fontawesome, fontawesome5, fontspec, xunicode, xltxtra, lualatex packages, marvosym, pifont, wasysym, MnSymbol, any icon packages.

SECTION FORMATTING:
\\titleformat{\\section}{\\large\\bfseries\\uppercase}{}{0em}{}[\\titlerule\\vspace{2pt}]
\\titlespacing*{\\section}{0pt}{8pt}{4pt}

LIST FORMATTING:
\\setlist[itemize]{leftmargin=1.2em,noitemsep,topsep=1pt,parsep=0pt,partopsep=0pt}
Use \\textbullet{} as the list label.

HEADER:
- Centered: {\\LARGE\\bfseries Full Name}\\\\[4pt]
- Second line: email \\textbar{} phone \\textbar{} location \\textbar{} LinkedIn URL \\textbar{} GitHub URL
- Use \\href{mailto:email}{email} and \\href{URL}{display text} for links

EXPERIENCE/EDUCATION ENTRIES — use this exact pattern:
{\\bfseries Job Title} \\hfill {\\bfseries Start – End}\\\\
{\\itshape Company Name, Location}
\\begin{itemize}
  \\item Achievement bullet...
\\end{itemize}

CONTENT RULES:
1. Tailor every bullet and the summary aggressively to the target role${jobDescription ? ' and the exact job description provided' : ''}.
2. Quantify achievements wherever possible: numbers, percentages, impact.
3. Use strong action verbs (Led, Engineered, Reduced, Delivered, Automated…).
4. Skills section: group into logical sub-categories on one or two lines.
5. Aim for 1 page; 2 pages max only if there is substantial content.
6. Do NOT invent facts. Only use what is provided.`;

      const userPrompt = `TARGET ROLE: ${targetRole}
${jobDescription ? `\nJOB DESCRIPTION:\n${jobDescription}\n` : ''}
RESUME DATA:
${resumeStr}

Generate the complete LaTeX resume now.`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);

      let aiResponse;
      try {
        aiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            max_tokens: 4096,
            temperature: 0.3,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!aiResponse.ok) {
        const errBody = await aiResponse.json().catch(() => ({}));
        console.error('Sarvam AI error:', errBody);
        return next(new AppError('AI generation failed. Check SARVAM_API_KEY and try again.', 502));
      }

      const aiResult = await aiResponse.json();
      let latex = aiResult.choices?.[0]?.message?.content ?? '';

      // Strip chain-of-thought <think> blocks emitted by reasoning models (e.g. sarvam-m)
      latex = latex.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

      // Strip any accidental markdown fences
      latex = latex
        .replace(/^```(?:latex|tex)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

      if (!latex.includes('\\documentclass')) {
        return next(new AppError('AI returned invalid LaTeX. Please try again.', 502));
      }

      res.json({ latex });
    } catch (err) {
      if (err.name === 'AbortError') {
        return next(new AppError('AI request timed out. Please try again.', 408));
      }
      next(err);
    }
  }
);

// ── Sanitise LaTeX: strip packages that may not be on the compiler ─────────
function sanitizeLatex(latex) {
  const allowed = new Set([
    'geometry', 'fontenc', 'inputenc', 'enumitem', 'titlesec',
    'hyperref', 'xcolor', 'parskip', 'setspace', 'microtype',
    'graphicx', 'amsmath', 'amssymb', 'url', 'calc', 'fancyhdr',
    'lastpage', 'etoolbox', 'ragged2e', 'array', 'tabularx',
    'booktabs', 'multirow', 'longtable', 'changepage', 'paracol',
    'lmodern', 'helvet', 'times', 'palatino', 'avant', 'courier',
    'mathptmx', 'inconsolata', 'charter', 'tgpagella',
  ]);

  // Comment out any \usepackage{...} line whose packages aren't all in the allowed set
  latex = latex.replace(
    /^([ \t]*\\usepackage(?:\[[^\]]*\])?\{([^}]+)\}.*)/gm,
    (line, _full, pkgStr) => {
      const pkgs = pkgStr.split(',').map((p) => p.trim().replace(/\s.*$/, ''));
      return pkgs.every((p) => allowed.has(p)) ? line : `% stripped (unavailable): ${line}`;
    }
  );

  // Strip markdown fences if the model forgot
  latex = latex.replace(/^```(?:latex|tex)?\s*/im, '').replace(/\s*```$/im, '').trim();

  return latex;
}

// ── Compile LaTeX → PDF (YtoTech primary, latexonline.cc fallback) ─────────
router.post(
  '/compile',
  protect,
  [body('latex').notEmpty().withMessage('LaTeX code required')],
  validate,
  async (req, res, next) => {
    try {
      const clean = sanitizeLatex(req.body.latex);

      // ── Primary: latex.ytotech.com ────────────────────────────────────────
      let pdfBuffer = null;
      let lastError = null;

      try {
        const ctrl1 = new AbortController();
        const t1 = setTimeout(() => ctrl1.abort(), 50000);
        let r1;
        try {
          r1 = await fetch('https://latex.ytotech.com/builds/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              compiler: 'pdflatex',
              resources: [{ main: true, content: clean }],
            }),
            signal: ctrl1.signal,
          });
        } finally {
          clearTimeout(t1);
        }
        if (r1.ok) {
          const buf = Buffer.from(await r1.arrayBuffer());
          // YtoTech returns PDF directly
          if (buf[0] === 0x25 && buf[1] === 0x50) { // %P = PDF magic bytes
            pdfBuffer = buf;
          } else {
            // Might be JSON error body
            lastError = 'YtoTech returned non-PDF data';
          }
        } else {
          const errBody = await r1.json().catch(() => ({}));
          lastError = errBody?.logs || errBody?.message || `YtoTech status ${r1.status}`;
          console.error('YtoTech compile error:', lastError);
        }
      } catch (e1) {
        lastError = e1.message;
        console.error('YtoTech fetch failed:', e1.message);
      }

      // ── Fallback: latexonline.cc ──────────────────────────────────────────
      if (!pdfBuffer) {
        try {
          const fd = new FormData();
          fd.append('file', new Blob([clean], { type: 'text/plain' }), 'resume.tex');
          const ctrl2 = new AbortController();
          const t2 = setTimeout(() => ctrl2.abort(), 40000);
          let r2;
          try {
            r2 = await fetch('https://latexonline.cc/compile?command=pdflatex', {
              method: 'POST',
              body: fd,
              signal: ctrl2.signal,
            });
          } finally {
            clearTimeout(t2);
          }
          if (r2.ok) {
            pdfBuffer = Buffer.from(await r2.arrayBuffer());
          } else {
            lastError = `latexonline.cc status ${r2.status}`;
          }
        } catch (e2) {
          lastError = e2.message;
          console.error('latexonline.cc fallback failed:', e2.message);
        }
      }

      if (!pdfBuffer) {
        console.error('Both compilers failed. Last error:', lastError);
        return next(new AppError(
          'PDF compilation failed on both services. Download the .tex file and paste it into Overleaf (overleaf.com) to get your PDF instantly.',
          422
        ));
      }

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="resume.pdf"');
      res.send(pdfBuffer);
    } catch (err) {
      next(err);
    }
  }
);

// ── Save resume ────────────────────────────────────────────────────────────
router.post(
  '/save',
  protect,
  [
    body('title').trim().notEmpty().withMessage('Title is required'),
    body('targetRole').trim().notEmpty().withMessage('Target role is required'),
    body('sourceType').isIn(['pdf', 'linkedin', 'manual']).withMessage('Invalid source type'),
    body('latexCode').notEmpty().withMessage('LaTeX code is required'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { title, targetRole, sourceType, rawData, latexCode } = req.body;

      const result = await pool.query(
        `INSERT INTO resumes (user_id, title, target_role, source_type, raw_data, latex_code)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, title, target_role, source_type, created_at`,
        [
          req.user.id,
          title,
          targetRole,
          sourceType,
          rawData ? JSON.stringify(rawData) : null,
          latexCode,
        ]
      );

      res.status(201).json(result.rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

// ── List resumes ───────────────────────────────────────────────────────────
router.get('/', protect, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, title, target_role, source_type, created_at
       FROM resumes
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// ── Get single resume ──────────────────────────────────────────────────────
router.get(
  '/:id',
  protect,
  [param('id').isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT * FROM resumes WHERE id = $1 AND user_id = $2`,
        [req.params.id, req.user.id]
      );
      if (!result.rows[0]) return next(new AppError('Resume not found', 404));
      res.json(result.rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

// ── Delete resume ──────────────────────────────────────────────────────────
router.delete(
  '/:id',
  protect,
  [param('id').isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const row = await pool.query(
        `SELECT user_id, tex_path FROM resumes WHERE id = $1`,
        [req.params.id]
      );
      if (!row.rows[0]) return next(new AppError('Resume not found', 404));
      if (row.rows[0].user_id !== req.user.id)
        return next(new AppError('Forbidden', 403));

      if (row.rows[0].tex_path) {
        const { supabase } = await import('../config/supabase.js');
        await supabase.storage.from(BUCKET_NAME).remove([row.rows[0].tex_path]);
      }

      await pool.query(`DELETE FROM resumes WHERE id = $1`, [req.params.id]);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);

// ── Generate Cover Letter via Sarvam AI ───────────────────────────────────
router.post(
  '/generate-cover-letter',
  protect,
  [
    body('resumeData').notEmpty().withMessage('Resume data is required'),
    body('targetRole').trim().notEmpty().withMessage('Target role is required'),
    body('jobDescription').optional().trim(),
    body('companyName').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { resumeData, targetRole, jobDescription, companyName } = req.body;
      const resumeStr =
        typeof resumeData === 'string'
          ? resumeData
          : JSON.stringify(resumeData, null, 2);

      const systemPrompt = `You are an expert career coach and professional writer. Write a compelling, personalised cover letter.

OUTPUT FORMAT — ABSOLUTE RULES:
- Output PLAIN TEXT only. No markdown, no headers, no bullet points, no HTML.
- Structure: opening paragraph, 2-3 body paragraphs, closing paragraph, sign-off.
- Length: 300–450 words.
- Tone: professional, confident, enthusiastic — never generic or robotic.

CONTENT RULES:
1. Address it to "Hiring Manager" unless a name is provided.
2. Opening: mention the role and company by name; hook with a specific achievement or skill.
3. Body: connect 2-3 key experiences from the resume directly to the job requirements.
${jobDescription ? '4. Mirror language and keywords from the job description naturally.' : ''}
5. Closing: express enthusiasm, request an interview, and provide contact info.
6. Do NOT invent qualifications or experiences. Only use what is in the resume data.
7. Keep every sentence purposeful — cut filler phrases like "I am writing to apply".`;

      const userPrompt = `CANDIDATE NAME: ${typeof resumeData === 'object' ? (resumeData.personal?.name || 'the candidate') : 'the candidate'}
TARGET ROLE: ${targetRole}
${companyName ? `COMPANY: ${companyName}` : ''}
${jobDescription ? `\nJOB DESCRIPTION:\n${jobDescription}\n` : ''}
RESUME DATA:
${resumeStr}

Write the cover letter now.`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);

      let aiResponse;
      try {
        aiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            max_tokens: 1024,
            temperature: 0.5,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!aiResponse.ok) {
        return next(new AppError('AI generation failed. Please try again.', 502));
      }

      const aiResult = await aiResponse.json();
      let coverLetter = aiResult.choices?.[0]?.message?.content ?? '';

      // Strip chain-of-thought <think> blocks emitted by reasoning models
      coverLetter = coverLetter.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

      if (!coverLetter) {
        return next(new AppError('AI returned empty response. Please try again.', 502));
      }

      res.json({ coverLetter });
    } catch (err) {
      if (err.name === 'AbortError') {
        return next(new AppError('AI request timed out. Please try again.', 408));
      }
      next(err);
    }
  }
);

export default router;
