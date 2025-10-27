import express from 'express';
import { protect } from '../middleware/auth.js';
import pool from '../config/database.js';

const router = express.Router();

// @route   GET /api/notifications
// @desc    Get current user's notifications
// @access  Private
router.get('/', protect, async (req, res) => {
  try {
    const { limit = 20, offset = 0, unreadOnly = false } = req.query;

    // Validate query parameters
    const limitNum = Math.min(parseInt(limit) || 20, 100); // Max 100 items
    const offsetNum = Math.max(parseInt(offset) || 0, 0);

    let query = `
      SELECT id, type, title, message, link, is_read, created_at
      FROM notifications 
      WHERE user_id = $1
    `;
    const params = [req.user.id];

    if (unreadOnly === 'true') {
      query += ` AND is_read = false`;
    }

    query += ` ORDER BY created_at DESC LIMIT $2 OFFSET $3`;
    params.push(limitNum, offsetNum);

    const result = await pool.query(query, params);

    // Get unread count
    const unreadCountResult = await pool.query(
      'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false',
      [req.user.id]
    );

    res.json({
      success: true,
      notifications: result.rows,
      unreadCount: parseInt(unreadCountResult.rows[0].count),
      pagination: {
        limit: limitNum,
        offset: offsetNum,
        hasMore: result.rows.length === limitNum
      }
    });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch notifications' });
  }
});

// @route   PUT /api/notifications/:id/read
// @desc    Mark notification as read
// @access  Private
router.put('/:id/read', protect, async (req, res) => {
  try {
    const { id } = req.params;

    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      return res.status(400).json({ success: false, message: 'Invalid notification ID format' });
    }

    const result = await pool.query(
      `UPDATE notifications 
       SET is_read = true, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $1 AND user_id = $2
       RETURNING id, type, title, message, link, is_read, created_at`,
      [id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Notification not found or access denied' });
    }

    res.json({
      success: true,
      notification: result.rows[0]
    });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({ success: false, message: 'Failed to update notification' });
  }
});

// @route   PUT /api/notifications/mark-all-read
// @desc    Mark all notifications as read
// @access  Private
router.put('/mark-all-read', protect, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE notifications 
       SET is_read = true, updated_at = CURRENT_TIMESTAMP 
       WHERE user_id = $1 AND is_read = false`,
      [req.user.id]
    );

    res.json({
      success: true,
      message: 'All notifications marked as read',
      updatedCount: result.rowCount
    });
  } catch (error) {
    console.error('Error marking all notifications as read:', error);
    res.status(500).json({ success: false, message: 'Failed to update notifications' });
  }
});

// @route   POST /api/notifications
// @desc    Create a new notification (internal use)
// @access  Private (Admin/Company)
router.post('/', protect, async (req, res) => {
  try {
    const { userId, type, title, message, link } = req.body;

    // Validate required fields
    if (!userId || !type || !title || !message) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required fields: userId, type, title, message' 
      });
    }

    // Validate notification type
    const validTypes = ['application', 'verification', 'interview', 'system', 'job', 'profile'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid notification type' 
      });
    }

    const result = await pool.query(
      `INSERT INTO notifications (user_id, type, title, message, link, is_read)
       VALUES ($1, $2, $3, $4, $5, false)
       RETURNING id, type, title, message, link, is_read, created_at`,
      [userId, type, title, message, link || null]
    );

    res.status(201).json({
      success: true,
      notification: result.rows[0]
    });
  } catch (error) {
    console.error('Error creating notification:', error);
    res.status(500).json({ success: false, message: 'Failed to create notification' });
  }
});

// @route   DELETE /api/notifications/:id
// @desc    Delete a notification
// @access  Private
router.delete('/:id', protect, async (req, res) => {
  try {
    const { id } = req.params;

    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      return res.status(400).json({ success: false, message: 'Invalid notification ID format' });
    }

    const result = await pool.query(
      'DELETE FROM notifications WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Notification not found or access denied' });
    }

    res.json({
      success: true,
      message: 'Notification deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting notification:', error);
    res.status(500).json({ success: false, message: 'Failed to delete notification' });
  }
});

export default router;
