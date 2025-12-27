import express from 'express';
import type { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../config/database.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

// Report reason types
type ReportReason = 'harassment' | 'inappropriate_content' | 'fake_profile' | 'spam' | 'underage' | 'violence' | 'other';

// ============================================================================
// SUBMIT REPORT - Report a user or message
// ============================================================================
// QUERY: Insert report into reports table
// Creates record for admin review

router.post('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    const { reportedUserId, conversationId, messageId, reason, description } = req.body;

    // Must report either a user or message
    if (!reportedUserId && !messageId) {
      return res.status(400).json({ error: 'Must report either a user or message' });
    }

    // Validate reason
    const validReasons = ['harassment', 'inappropriate_content', 'fake_profile', 'spam', 'underage', 'violence', 'other'];
    if (!validReasons.includes(reason)) {
      return res.status(400).json({ error: 'Invalid report reason' });
    }

    // Check if already reported recently (prevent spam)
    if (reportedUserId) {
      const recentReport = await query(
        `SELECT id FROM reports 
         WHERE reporter_id = $1 AND reported_user_id = $2 AND created_at > NOW() - INTERVAL '24 hours'`,
        [userId, reportedUserId]
      );

      if (recentReport.rows.length > 0) {
        return res.status(400).json({ error: 'Already reported this user recently' });
      }
    }

    // Create report
    const reportId = uuidv4();
    const result = await query(
      `INSERT INTO reports (id, reporter_id, reported_user_id, conversation_id, message_id, reason, description, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')
       RETURNING *`,
      [reportId, userId, reportedUserId || null, conversationId || null, messageId || null, reason, description || null]
    );

    res.status(201).json({ report: result.rows[0] });
  } catch (error) {
    console.error('Submit report error:', error);
    res.status(500).json({ error: 'Failed to submit report' });
  }
});

// ============================================================================
// GET MY REPORTS - Get reports submitted by current user
// ============================================================================
// QUERY: Get all reports filed by user
// Shows what user has reported

router.get('/my-reports', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;

    const result = await query(
      `SELECT r.id, r.reported_user_id, r.reason, r.description, r.status, r.created_at,
              u.name as reported_user_name, u.avatar_url
       FROM reports r
       LEFT JOIN users u ON r.reported_user_id = u.id
       WHERE r.reporter_id = $1
       ORDER BY r.created_at DESC`,
      [userId]
    );

    res.json({ reports: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Get my reports error:', error);
    res.status(500).json({ error: 'Failed to get reports' });
  }
});

// ============================================================================
// GET REPORT DETAILS - Get specific report
// ============================================================================
// QUERY: Get full report details with all related data
// Only reporter can view their report

router.get('/:reportId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { reportId } = req.params;
    const userId = req.userId;

    const result = await query(
      `SELECT r.*, 
              reporter.name as reporter_name, reporter.email as reporter_email,
              reported.name as reported_user_name, reported.email as reported_user_email,
              m.text as message_text, m.created_at as message_created_at
       FROM reports r
       LEFT JOIN users reporter ON r.reporter_id = reporter.id
       LEFT JOIN users reported ON r.reported_user_id = reported.id
       LEFT JOIN messages m ON r.message_id = m.id
       WHERE r.id = $1`,
      [reportId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Report not found' });
    }

    const report = result.rows[0];

    // Only reporter can view their report (or admin, but we don't have admin check here yet)
    if (report.reporter_id !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json({ report });
  } catch (error) {
    console.error('Get report details error:', error);
    res.status(500).json({ error: 'Failed to get report' });
  }
});

// ============================================================================
// UPDATE REPORT (ADMIN ONLY) - Update report status
// ============================================================================
// QUERY: Update report status and add admin notes
// Called by admin to resolve reports

router.put('/:reportId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { reportId } = req.params;
    const { status, adminNotes, action } = req.body;

    // TODO: Add admin role check here
    // if (!isAdmin) return res.status(403).json({ error: 'Admin only' });

    const validStatuses = ['open', 'investigating', 'resolved', 'dismissed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    // Get report
    const reportResult = await query(
      `SELECT reported_user_id FROM reports WHERE id = $1`,
      [reportId]
    );

    if (reportResult.rows.length === 0) {
      return res.status(404).json({ error: 'Report not found' });
    }

    // Update report
    const result = await query(
      `UPDATE reports 
       SET status = $1, admin_notes = $2, resolved_at = CASE WHEN $1 IN ('resolved', 'dismissed') THEN NOW() ELSE NULL END
       WHERE id = $3
       RETURNING *`,
      [status, adminNotes || null, reportId]
    );

    // If action is to ban user
    if (action === 'ban' && reportResult.rows[0].reported_user_id) {
      await query(
        `UPDATE users SET banned = true, banned_at = NOW() WHERE id = $1`,
        [reportResult.rows[0].reported_user_id]
      );
    }

    res.json({ report: result.rows[0] });
  } catch (error) {
    console.error('Update report error:', error);
    res.status(500).json({ error: 'Failed to update report' });
  }
});

// ============================================================================
// GET ALL REPORTS (ADMIN ONLY) - Get all reports for moderation
// ============================================================================
// QUERY: Get all open reports for admin review
// Sorted by newest first

router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    // TODO: Add admin role check here
    // if (!isAdmin) return res.status(403).json({ error: 'Admin only' });

    const { status = 'open', page = 1, limit = 50 } = req.query;

    const pageNum = parseInt(page as string) || 1;
    const limitNum = parseInt(limit as string) || 50;
    const offset = (pageNum - 1) * limitNum;

    let whereClause = '';
    const params: any[] = [];

    if (status && status !== 'all') {
      whereClause = 'WHERE status = $1';
      params.push(status);
      params.push(limitNum);
      params.push(offset);
    } else {
      params.push(limitNum);
      params.push(offset);
    }

    const result = await query(
      `SELECT r.*, 
              reporter.name as reporter_name, reporter.email as reporter_email,
              reported.name as reported_user_name, reported.email as reported_user_email
       FROM reports r
       LEFT JOIN users reporter ON r.reporter_id = reporter.id
       LEFT JOIN users reported ON r.reported_user_id = reported.id
       ${whereClause}
       ORDER BY r.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ reports: result.rows, count: result.rows.length, page: pageNum });
  } catch (error) {
    console.error('Get all reports error:', error);
    res.status(500).json({ error: 'Failed to get reports' });
  }
});

export default router;