// src/routes/albums.ts
import express from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../config/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { uploadMiddleware } from '../middleware/upload.js';

const router = express.Router();

// ============================================================================
// GET MY ALBUMS
// ============================================================================
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    const result = await query(
      `SELECT id, user_id, photo_url, thumbnail_url, caption, is_public,
              shared_with, view_count, created_at, uploaded_at
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
// UPLOAD PHOTO — multipart/form-data with file
// ============================================================================
router.post(
  '/upload',
  authMiddleware,
  uploadMiddleware.single('photo'),
  async (req: Request, res: Response) => {
    try {
      const userId = req.userId;
      if (!req.file) return res.status(400).json({ error: 'No photo file provided' });

      const { caption, isPublic = 'false' } = req.body;
      const photoUrl = `/uploads/albums/${req.file.filename}`;
      const albumId = uuidv4();

      const result = await query(
        `INSERT INTO albums (id, user_id, photo_url, thumbnail_url, caption, is_public, shared_with)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         RETURNING *`,
        [albumId, userId, photoUrl, photoUrl, caption || null, isPublic === 'true', JSON.stringify([])]
      );

      res.status(201).json({ album: result.rows[0], success: true });
    } catch (error) {
      console.error('Upload photo error:', error);
      res.status(500).json({ error: 'Failed to upload photo' });
    }
  }
);

// ============================================================================
// ⚠️  STATIC ROUTES — must be defined BEFORE /:albumId
// ============================================================================

// SHARE ALL MY PHOTOS WITH USER (bulk share)
router.post('/share-all', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    const { recipientUserId } = req.body;
    if (!recipientUserId) return res.status(400).json({ error: 'recipientUserId required' });

    // Single bulk update: append the recipient to every album that doesn't
    // already include them (avoids the previous N+1 query-per-album loop).
    const recipientEntry = JSON.stringify([{ userId: recipientUserId, sharedAt: new Date() }]);
    const recipientMatch = JSON.stringify([{ userId: recipientUserId }]);

    const result = await query(
      `UPDATE albums
       SET shared_with = shared_with || $2::jsonb
       WHERE user_id = $1 AND deleted_at IS NULL
         AND NOT (shared_with @> $3::jsonb)`,
      [userId, recipientEntry, recipientMatch]
    );

    res.json({ success: true, message: 'All photos shared', count: result.rowCount });
  } catch (error) {
    console.error('Share all error:', error);
    res.status(500).json({ error: 'Failed to share album' });
  }
});

// UNSHARE ALL FROM USER (bulk revoke)
router.post('/unshare-all', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    const { recipientUserId } = req.body;
    if (!recipientUserId) return res.status(400).json({ error: 'recipientUserId required' });

    // Single bulk update: filter the recipient out of shared_with for every
    // album that currently includes them (replaces the prior N+1 loop).
    const recipientMatch = JSON.stringify([{ userId: recipientUserId }]);

    const result = await query(
      `UPDATE albums
       SET shared_with = COALESCE(
             (SELECT jsonb_agg(elem)
              FROM jsonb_array_elements(shared_with) elem
              WHERE elem->>'userId' <> $2),
             '[]'::jsonb)
       WHERE user_id = $1 AND deleted_at IS NULL
         AND shared_with @> $3::jsonb`,
      [userId, recipientUserId, recipientMatch]
    );

    res.json({ success: true, message: 'Access revoked for all photos', count: result.rowCount });
  } catch (error) {
    console.error('Unshare all error:', error);
    res.status(500).json({ error: 'Failed to revoke access' });
  }
});

// GET ALBUMS SHARED WITH ME
router.get('/shared/with-me', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;

    const result = await query(
      `SELECT a.id, a.user_id, a.photo_url, a.thumbnail_url, a.caption,
              a.shared_with, a.created_at, u.name, u.avatar_url
       FROM albums a
       JOIN users u ON a.user_id = u.id
       WHERE a.shared_with @> $1::jsonb AND a.deleted_at IS NULL
       ORDER BY a.created_at DESC`,
      [JSON.stringify([{ userId }])]
    );

    const byOwner: Record<string, any> = {};
    for (const row of result.rows) {
      if (!byOwner[row.user_id]) {
        byOwner[row.user_id] = {
          ownerId: row.user_id,
          ownerName: row.name,
          ownerAvatar: row.avatar_url,
          photos: [],
        };
      }
      byOwner[row.user_id].photos.push(row);
    }

    res.json({ sharedAlbums: Object.values(byOwner), count: result.rows.length });
  } catch (error) {
    console.error('Get shared albums error:', error);
    res.status(500).json({ error: 'Failed to get shared albums' });
  }
});

// GET WHO I'VE SHARED WITH (for AlbumSharing page)
router.get('/sharing/recipients', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;

    const result = await query(
      `SELECT shared_with FROM albums WHERE user_id = $1 AND deleted_at IS NULL`,
      [userId]
    );

    const recipientMap: Record<string, { userId: string; sharedAt: string }> = {};
    for (const row of result.rows) {
      const sharedWith: any[] = row.shared_with || [];
      for (const entry of sharedWith) {
        if (!recipientMap[entry.userId]) recipientMap[entry.userId] = entry;
      }
    }

    const recipientIds = Object.keys(recipientMap);
    if (recipientIds.length === 0) return res.json({ recipients: [] });

    const usersResult = await query(
      `SELECT id, name, avatar_url FROM users WHERE id = ANY($1::uuid[])`,
      [recipientIds]
    );

    const recipients = usersResult.rows.map((u) => ({
      ...u,
      sharedAt: recipientMap[u.id]?.sharedAt,
    }));

    res.json({ recipients });
  } catch (error) {
    console.error('Get recipients error:', error);
    res.status(500).json({ error: 'Failed to get recipients' });
  }
});

// ============================================================================
// PARAMETERIZED ROUTES — must be AFTER all static routes above
// ============================================================================

// GET SPECIFIC ALBUM — owner or shared user
router.get('/:albumId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { albumId } = req.params;
    const userId = req.userId;

    const result = await query(
      `SELECT id, user_id, photo_url, thumbnail_url, caption, is_public,
              shared_with, view_count, created_at
       FROM albums WHERE id = $1 AND deleted_at IS NULL`,
      [albumId]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });

    const album = result.rows[0];
    const isOwner = album.user_id === userId;
    const sharedWith: any[] = album.shared_with || [];
    const hasAccess = isOwner || album.is_public || sharedWith.some((s) => s.userId === userId);

    if (!hasAccess) return res.status(403).json({ error: 'Access denied' });

    if (!isOwner) {
      await query(`UPDATE albums SET view_count = view_count + 1 WHERE id = $1`, [albumId]);
    }

    res.json({ album, isOwner });
  } catch (error) {
    console.error('Get album error:', error);
    res.status(500).json({ error: 'Failed to get album' });
  }
});

// DELETE PHOTO
router.delete('/:albumId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { albumId } = req.params;
    const userId = req.userId;

    const albumResult = await query(
      `SELECT user_id, photo_url FROM albums WHERE id = $1 AND deleted_at IS NULL`,
      [albumId]
    );

    if (albumResult.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    if (albumResult.rows[0].user_id !== userId) return res.status(403).json({ error: 'Forbidden' });

    const photoUrl: string = albumResult.rows[0].photo_url;
    const filePath = path.join(process.cwd(), photoUrl);
    // Async unlink; ignore "file not found" so a missing file doesn't fail the delete.
    await fs.promises.unlink(filePath).catch((err: any) => {
      if (err?.code !== 'ENOENT') throw err;
    });

    await query(`UPDATE albums SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1`, [albumId]);
    res.json({ success: true, message: 'Photo deleted' });
  } catch (error) {
    console.error('Delete album error:', error);
    res.status(500).json({ error: 'Failed to delete photo' });
  }
});

// SHARE ALBUM WITH USER
router.post('/:albumId/share', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { albumId } = req.params;
    const userId = req.userId;
    const { recipientUserId } = req.body;

    if (!recipientUserId) return res.status(400).json({ error: 'recipientUserId required' });

    const albumResult = await query(
      `SELECT user_id, shared_with FROM albums WHERE id = $1 AND deleted_at IS NULL`,
      [albumId]
    );

    if (albumResult.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    if (albumResult.rows[0].user_id !== userId) return res.status(403).json({ error: 'Forbidden' });

    const sharedWith: any[] = albumResult.rows[0].shared_with || [];
    if (sharedWith.some((s) => s.userId === recipientUserId)) {
      return res.status(400).json({ error: 'Already shared with this user' });
    }

    const updated = [...sharedWith, { userId: recipientUserId, sharedAt: new Date() }];
    await query(`UPDATE albums SET shared_with = $1::jsonb WHERE id = $2`, [
      JSON.stringify(updated), albumId,
    ]);

    res.json({ success: true, message: 'Album shared' });
  } catch (error) {
    console.error('Share album error:', error);
    res.status(500).json({ error: 'Failed to share album' });
  }
});

// UNSHARE ALBUM — revoke access
router.post('/:albumId/unshare', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { albumId } = req.params;
    const userId = req.userId;
    const { recipientUserId } = req.body;

    if (!recipientUserId) return res.status(400).json({ error: 'recipientUserId required' });

    const albumResult = await query(
      `SELECT user_id, shared_with FROM albums WHERE id = $1 AND deleted_at IS NULL`,
      [albumId]
    );

    if (albumResult.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    if (albumResult.rows[0].user_id !== userId) return res.status(403).json({ error: 'Forbidden' });

    const sharedWith: any[] = albumResult.rows[0].shared_with || [];
    const updated = sharedWith.filter((s) => s.userId !== recipientUserId);

    await query(`UPDATE albums SET shared_with = $1::jsonb WHERE id = $2`, [
      JSON.stringify(updated), albumId,
    ]);

    res.json({ success: true, message: 'Access revoked' });
  } catch (error) {
    console.error('Unshare album error:', error);
    res.status(500).json({ error: 'Failed to revoke access' });
  }
});

export default router;