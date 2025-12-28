import express from 'express';
import type { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../config/database.js';

const router = express.Router();

// Valid report reasons
const VALID_REASONS = [
  'inappropriate_content',
  'harassment',
  'fake_profile',
  'spam',
  'scam',
  'other'
];

// ============================================================================
// POST /api/reports - Report a user
// ============================================================================

router.post('/', async (req: Request, res: Response) => {
  try {
    const reporterId = req.userId;

    if (!reporterId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { reported_user_id, reason, description } = req.body;

    // Validation
    if (!reported_user_id) {
      return res.status(400).json({ error: 'reported_user_id is required' });
    }

    if (!reason) {
      return res.status(400).json({ error: 'reason is required' });
    }

    if (!VALID_REASONS.includes(reason)) {
      return res.status(400).json({
        error: `Invalid reason. Must be one of: ${VALID_REASONS.join(', ')}`,
      });
    }

    if (reporterId === reported_user_id) {
      return res.status(400).json({ error: 'Cannot report yourself' });
    }

    // Check if user exists
    const userCheck = await query(
      `SELECT id FROM users WHERE id = $1`,
      [reported_user_id]
    );

    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Create report
    const reportId = uuidv4();
    const result = await query(
      `INSERT INTO user_reports 
       (id, reporter_id, reported_user_id, reason, description, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
       RETURNING id, reporter_id, reported_user_id, reason, description, status, created_at, updated_at`,
      [reportId, reporterId, reported_user_id, reason, description || null, new Date(), new Date()]
    );

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    console.error('Report user error:', error);
    res.status(500).json({ error: 'Failed to submit report' });
  }
});

// ============================================================================
// GET /api/reports - Get user's reports
// ============================================================================

router.get('/', async (req: Request, res: Response) => {
  try {
    const reporterId = req.userId;

    if (!reporterId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { status, limit = '50', offset = '0' } = req.query;

    let reportQuery = `
      SELECT id, reporter_id, reported_user_id, reason, description, status, created_at, updated_at
      FROM user_reports
      WHERE reporter_id = $1
    `;
    const values: any[] = [reporterId];
    let paramIndex = 2;

    // Optional: filter by status
    if (status) {
      reportQuery += ` AND status = $${paramIndex}`;
      values.push(status);
      paramIndex++;
    }

    const limitNum = parseInt(limit as string);
    const offsetNum = parseInt(offset as string);

    // Get total count
    const countQuery = reportQuery.replace(/SELECT.*FROM/, 'SELECT COUNT(*) as count FROM');
    const countResult = await query(countQuery, values.slice(0, paramIndex - 1));
    const total = parseInt(countResult.rows[0].count);

    // Get paginated results
    reportQuery += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    values.push(limitNum, offsetNum);

    const result = await query(reportQuery, values);

    res.json({
      success: true,
      data: result.rows,
      total,
      limit: limitNum,
      offset: offsetNum,
    });
  } catch (error) {
    console.error('Get reports error:', error);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

// ============================================================================
// GET /api/reports/:id - Get single report
// ============================================================================

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const reporterId = req.userId;
    const { id } = req.params;

    if (!reporterId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const result = await query(
      `SELECT id, reporter_id, reported_user_id, reason, description, status, created_at, updated_at
       FROM user_reports
       WHERE id = $1 AND reporter_id = $2`,
      [id, reporterId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Report not found' });
    }

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    console.error('Get report error:', error);
    res.status(500).json({ error: 'Failed to fetch report' });
  }
});

// ============================================================================
// PUT /api/reports/:id - Update report status
// ============================================================================

router.put('/:id', async (req: Request, res: Response) => {
  try {
    const reporterId = req.userId;
    const { id } = req.params;
    const { status } = req.body;

    if (!reporterId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const validStatuses = ['pending', 'reviewed', 'resolved', 'dismissed'];

    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({
        error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
      });
    }

    // Verify report exists and belongs to user
    const reportCheck = await query(
      `SELECT id FROM user_reports WHERE id = $1 AND reporter_id = $2`,
      [id, reporterId]
    );

    if (reportCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Report not found' });
    }

    const result = await query(
      `UPDATE user_reports
       SET status = $1, updated_at = $2
       WHERE id = $3
       RETURNING id, reporter_id, reported_user_id, reason, description, status, created_at, updated_at`,
      [status, new Date(), id]
    );

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    console.error('Update report error:', error);
    res.status(500).json({ error: 'Failed to update report' });
  }
});

export default router;