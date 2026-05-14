// Shared AI service — single point of integration with OpenAI.
// Used by resume generation, cover letter generation, AI screening, interview questions.

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4o-mini';

export async function callOpenAI({ system, user, model = DEFAULT_MODEL, maxTokens = 2048, temperature = 0.3, json = false, timeoutMs = 60000 }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not configured');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body = {
      model,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: user },
      ],
      max_tokens: maxTokens,
      temperature,
    };
    if (json) body.response_format = { type: 'json_object' };

    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const err = new Error(errBody?.error?.message || `OpenAI request failed: ${res.status}`);
      err.statusCode = res.status;
      err.openaiError = errBody;
      throw err;
    }

    const data = await res.json();
    let content = data.choices?.[0]?.message?.content ?? '';
    content = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    return content;
  } finally {
    clearTimeout(timer);
  }
}

export async function callOpenAIJson(opts) {
  const raw = await callOpenAI({ ...opts, json: true });
  try {
    return JSON.parse(raw);
  } catch {
    // Try to extract JSON from the response if model wrapped it
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch {}
    }
    throw new Error('AI returned invalid JSON');
  }
}

// ── Resume Screening ────────────────────────────────────────────────────
export async function screenResume({ resumeText, jobTitle, jobDescription, requiredSkills = [] }) {
  const system = `You are an expert technical recruiter and resume screener. Your job is to assess how well a candidate's resume matches a job posting. Be objective, fair, and concise. Output ONLY valid JSON.`;

  const user = `Evaluate this candidate's resume against the job posting.

JOB TITLE: ${jobTitle}
${requiredSkills.length > 0 ? `REQUIRED SKILLS: ${requiredSkills.join(', ')}` : ''}

JOB DESCRIPTION:
${jobDescription || '(No description provided)'}

CANDIDATE RESUME / PROFILE:
${resumeText}

Return a JSON object with this exact shape:
{
  "score": <integer 0-100, fit score>,
  "summary": "<one short sentence summary>",
  "strengths": ["<bullet>", "<bullet>", "<bullet>"],
  "concerns": ["<bullet>", "<bullet>"]
}

Scoring guide:
- 85-100: Excellent match. Has core required skills + relevant experience.
- 70-84: Strong match. Most requirements met.
- 50-69: Partial match. Some relevant skills but notable gaps.
- 30-49: Weak match. Limited overlap.
- 0-29: Poor match.

Provide 2-4 strengths and 1-3 concerns. Keep bullets to <12 words each.`;

  const result = await callOpenAIJson({
    system,
    user,
    maxTokens: 800,
    temperature: 0.2,
  });

  const score = Math.max(0, Math.min(100, parseInt(result.score, 10) || 0));
  return {
    score,
    summary: String(result.summary || '').slice(0, 500),
    strengths: Array.isArray(result.strengths) ? result.strengths.slice(0, 5).map(String) : [],
    concerns: Array.isArray(result.concerns) ? result.concerns.slice(0, 5).map(String) : [],
  };
}

// ── Interview Question Generator ────────────────────────────────────────
export async function generateInterviewQuestions({ resumeText, jobTitle, jobDescription }) {
  const system = `You are an expert hiring manager. Generate insightful interview questions tailored to a specific candidate and role. Output ONLY valid JSON.`;

  const user = `Generate interview questions for this candidate applying to "${jobTitle}".

JOB DESCRIPTION:
${jobDescription || '(No description provided)'}

CANDIDATE RESUME / PROFILE:
${resumeText}

Return a JSON object with this exact shape:
{
  "technical": ["<question>", "<question>", "<question>", "<question>", "<question>"],
  "behavioral": ["<question>", "<question>", "<question>", "<question>"],
  "situational": ["<question>", "<question>", "<question>"]
}

Guidelines:
- Technical: probe role-specific skills referenced in the resume.
- Behavioral: STAR-format, draw from candidate's past experience.
- Situational: hypothetical scenarios relevant to the role.
- Tailor every question to THIS candidate's background. Avoid generic textbook questions.`;

  const result = await callOpenAIJson({
    system,
    user,
    maxTokens: 1200,
    temperature: 0.5,
  });

  return {
    technical:   Array.isArray(result.technical)   ? result.technical.slice(0, 8).map(String)   : [],
    behavioral:  Array.isArray(result.behavioral)  ? result.behavioral.slice(0, 8).map(String)  : [],
    situational: Array.isArray(result.situational) ? result.situational.slice(0, 8).map(String) : [],
  };
}
