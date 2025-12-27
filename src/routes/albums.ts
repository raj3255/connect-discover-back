import express from 'express';
import type { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../config/database.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

// ============================================================================
// GET ALBUMS - Get current user's albums
// ============================================================================
// QUERY: Get all albums for authenticated user
// Shows only user's own albums

router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;

    const result = await query(
      `SELECT id, user_id, photo_url, thumbnail_url, caption, is_public, 
              is_expiring, expiration_type, created_at, uploaded_at
       FROM albums
       WHERE user_id = $1 AND deleted_at IS NULL
       ORDER BY uploaded_at DESC`,
      [userId]
    );

    res.json({ albums: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Get albums error:', error);
    res.status(500).json({ error: 'Failed to get albums' });
  }
});

// ============================================================================
// GET ALBUM - Get specific album details
// ============================================================================
// QUERY: Get album if user owns it or it's shared with them
// Respects public/private visibility

router.get('/:albumId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { albumId } = req.params;
    const userId = req.userId;

    const result = await query(
      `SELECT id, user_id, photo_url, thumbnail_url, caption, is_public, 
              is_expiring, expiration_type, view_count, created_at
       FROM albums
       WHERE id = $1 AND deleted_at IS NULL`,
      [albumId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Album not found' });
    }

    const album = result.rows[0];
    const isOwner = album.user_id === userId;

    // Check if album is public or shared with user
    if (!isOwner && !album.is_public) {
      const sharedResult = await query(
        `SELECT id FROM albums 
         WHERE id = $1 AND shared_with @> $2::jsonb`,
        [albumId, JSON.stringify([{ userId }])]
      );

      if (sharedResult.rows.length === 0) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    // Increment view count
    if (!isOwner) {
      await query(
        `UPDATE albums SET view_count = view_count + 1 WHERE id = $1`,
        [albumId]
      );
    }

    res.json({ album });
  } catch (error) {
    console.error('Get album error:', error);
    res.status(500).json({ error: 'Failed to get album' });
  }
});

// ============================================================================
// UPLOAD ALBUM - Upload new photo to album
// ============================================================================
// QUERY: Insert new album photo with metadata
// Stores URL and optional caption

router.post('/upload', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    const { photoUrl, thumbnailUrl, caption, isPublic = false, isExpiring = false, expirationType = 'never' } = req.body;

    if (!photoUrl) {
      return res.status(400).json({ error: 'Photo URL required' });
    }

    const albumId = uuidv4();

    const result = await query(
      `INSERT INTO albums (id, user_id, photo_url, thumbnail_url, caption, is_public, is_expiring, expiration_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [albumId, userId, photoUrl, thumbnailUrl || null, caption || null, isPublic, isExpiring, expirationType]
    );

    res.status(201).json({ album: result.rows[0] });
  } catch (error) {
    console.error('Upload album error:', error);
    res.status(500).json({ error: 'Failed to upload photo' });
  }
});

// ============================================================================
// DELETE ALBUM - Delete photo from album
// ============================================================================
// QUERY: Only owner can delete their own photos
// Soft delete with timestamp

router.delete('/:albumId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { albumId } = req.params;
    const userId = req.userId;

    // Verify ownership
    const albumResult = await query(
      `SELECT user_id FROM albums WHERE id = $1`,
      [albumId]
    );

    if (albumResult.rows.length === 0) {
      return res.status(404).json({ error: 'Album not found' });
    }

    if (albumResult.rows[0].user_id !== userId) {
      return res.status(403).json({ error: 'Can only delete own photos' });
    }

    // Soft delete
    await query(
      `UPDATE albums SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [albumId]
    );

    res.json({ message: 'Photo deleted' });
  } catch (error) {
    console.error('Delete album error:', error);
    res.status(500).json({ error: 'Failed to delete photo' });
  }
});

// ============================================================================
// SHARE ALBUM - Share album with specific user
// ============================================================================
// QUERY: Add user to shared_with JSONB array
// Grants view access to album

router.post('/:albumId/share', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { albumId } = req.params;
    const userId = req.userId;
    const { recipientUserId, accessType = 'view' } = req.body;

    if (!recipientUserId) {
      return res.status(400).json({ error: 'Recipient user ID required' });
    }

    // Verify ownership
    const albumResult = await query(
      `SELECT user_id, shared_with FROM albums WHERE id = $1`,
      [albumId]
    );

    if (albumResult.rows.length === 0) {
      return res.status(404).json({ error: 'Album not found' });
    }

    if (albumResult.rows[0].user_id !== userId) {
      return res.status(403).json({ error: 'Can only share own albums' });
    }

    // Check if already shared
    const album = albumResult.rows[0];
    const sharedWith = album.shared_with || [];
    
    const alreadyShared = sharedWith.some((s: any) => s.userId === recipientUserId);
    if (alreadyShared) {
      return res.status(400).json({ error: 'Already shared with this user' });
    }

    // Add to shared_with
    const newSharedWith = [...sharedWith, { userId: recipientUserId, sharedAt: new Date(), accessType }];

    await query(
      `UPDATE albums SET shared_with = $1 WHERE id = $2`,
      [JSON.stringify(newSharedWith), albumId]
    );

    res.json({ message: 'Album shared successfully' });
  } catch (error) {
    console.error('Share album error:', error);
    res.status(500).json({ error: 'Failed to share album' });
  }
});

// ============================================================================
// UNSHARE ALBUM - Revoke access to album
// ============================================================================
// QUERY: Remove user from shared_with JSONB array
// User loses access immediately

router.post('/:albumId/unshare', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { albumId } = req.params;
    const userId = req.userId;
    const { recipientUserId } = req.body;

    if (!recipientUserId) {
      return res.status(400).json({ error: 'Recipient user ID required' });
    }

    // Verify ownership
    const albumResult = await query(
      `SELECT user_id, shared_with FROM albums WHERE id = $1`,
      [albumId]
    );

    if (albumResult.rows.length === 0) {
      return res.status(404).json({ error: 'Album not found' });
    }

    if (albumResult.rows[0].user_id !== userId) {
      return res.status(403).json({ error: 'Can only modify own albums' });
    }

    // Remove from shared_with
    const album = albumResult.rows[0];
    const sharedWith = album.shared_with || [];
    const newSharedWith = sharedWith.filter((s: any) => s.userId !== recipientUserId);

    await query(
      `UPDATE albums SET shared_with = $1 WHERE id = $2`,
      [JSON.stringify(newSharedWith), albumId]
    );

    res.json({ message: 'Access revoked' });
  } catch (error) {
    console.error('Unshare album error:', error);
    res.status(500).json({ error: 'Failed to revoke access' });
  }
});

// ============================================================================
// GET SHARED ALBUMS - Get albums shared with current user
// ============================================================================
// QUERY: Get all albums where user is in shared_with array
// Shows albums other users shared with you

router.get('/shared/with-me', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;

    const result = await query(
      `SELECT a.id, a.user_id, a.photo_url, a.thumbnail_url, a.caption, 
              a.created_at, u.name, u.avatar_url
       FROM albums a
       JOIN users u ON a.user_id = u.id
       WHERE a.shared_with @> $1::jsonb AND a.deleted_at IS NULL
       ORDER BY a.created_at DESC`,
      [JSON.stringify([{ userId }])]
    );

    res.json({ albums: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Get shared albums error:', error);
    res.status(500).json({ error: 'Failed to get shared albums' });
  }
});

export default router;