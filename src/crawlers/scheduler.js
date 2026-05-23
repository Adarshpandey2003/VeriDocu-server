// Cron scheduler for crawler sources. Loads enabled rows from `crawler_sources`,
// registers one cron job per row, and supports hot-reload after config changes.
import cron from 'node-cron';
import pool from '../config/database.js';
import { runSource } from './runner.js';

const logger = {
  info: (...args) => console.log('[INFO]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
};

const tasks = new Map(); // sourceId -> cron task

function stopAll() {
  for (const task of tasks.values()) {
    try { task.stop(); } catch (_) { /* ignore */ }
  }
  tasks.clear();
}

async function loadEnabledSources() {
  const result = await pool.query(
    'SELECT * FROM crawler_sources WHERE enabled = TRUE'
  );
  return result.rows;
}

function scheduleSource(source) {
  if (!cron.validate(source.schedule_cron)) {
    logger.warn(`[crawler] invalid cron "${source.schedule_cron}" for ${source.key}, skipping`);
    return;
  }
  const task = cron.schedule(source.schedule_cron, async () => {
    // Re-fetch the latest row so disabled/edited sources don't fire stale config.
    try {
      const fresh = await pool.query('SELECT * FROM crawler_sources WHERE id = $1 AND enabled = TRUE', [source.id]);
      if (fresh.rows.length === 0) return;
      await runSource(fresh.rows[0], { triggeredBy: 'cron' });
    } catch (err) {
      logger.error(`[crawler] scheduled run for ${source.key} failed: ${err.message}`);
    }
  });
  tasks.set(source.id, task);
}

export async function start() {
  try {
    stopAll();
    const sources = await loadEnabledSources();
    for (const source of sources) scheduleSource(source);
    logger.info(`[crawler] scheduler started with ${tasks.size} source(s)`);
  } catch (err) {
    logger.error(`[crawler] scheduler failed: ${err.message}`);
  }
}

export async function reload() {
  return start();
}
