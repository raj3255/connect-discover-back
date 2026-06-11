import express from 'express';
import type { Request, Response } from 'express';
import { query } from '../config/database.js';
import { getRedis, setRedis, deleteRedis } from '../config/redis.js';
import multer from 'multer';
import * as fs from 'fs';
import * as path from 'path';

const USER_CACHE_TTL = 60; // seconds
const userCacheKey = (id: string) => `user:profile:${id}`;

const router = express.Router();

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// ============================================================================
// GET /api/users/profile - Get current user profile
// ============================================================================

router.get('/profile', async (req: Request, res: Response) => {
  try {
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const result = await query(
      `SELECT id, email, name, age, gender, bio, interests, avatar_url, is_verified, is_active, created_at, updated_at
       FROM users WHERE id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// ============================================================================
// PUT /api/users/profile - Update current user profile
// ============================================================================

router.put('/profile', async (req: Request, res: Response) => {
  try {
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { name, age, gender, bio, interests } = req.body;

    // Validation
    if (name !== undefined && (!name || name.length < 2)) {
      return res.status(400).json({ error: 'Name must be at least 2 characters' });
    }

    if (age !== undefined && (age < 18 || age > 120)) {
      return res.status(400).json({ error: 'Age must be between 18 and 120' });
    }

    if (bio !== undefined && bio.length > 500) {
      return res.status(400).json({ error: 'Bio must be less than 500 characters' });
    }

    // Build dynamic update query
    const updates = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramIndex}`);
      values.push(name);
      paramIndex++;
    }

    if (age !== undefined) {
      updates.push(`age = $${paramIndex}`);
      values.push(age);
      paramIndex++;
    }

    if (gender !== undefined) {
      updates.push(`gender = $${paramIndex}`);
      values.push(gender);
      paramIndex++;
    }

    if (bio !== undefined) {
      updates.push(`bio = $${paramIndex}`);
      values.push(bio);
      paramIndex++;
    }

    // ✅ ADD INTERESTS FIELD
    if (interests !== undefined) {
      updates.push(`interests = $${paramIndex}`);
      values.push(interests);
      paramIndex++;
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push(`updated_at = $${paramIndex}`);
    values.push(new Date());
    paramIndex++;

    values.push(userId);

    const updateQuery = `
      UPDATE users 
      SET ${updates.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING id, email, name, age, gender, bio, interests, avatar_url, is_verified, is_active, created_at, updated_at
    `;

    const result = await query(updateQuery, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    await deleteRedis(userCacheKey(userId)).catch(() => {});

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ============================================================================
// POST /api/users/avatar - Upload avatar
// ============================================================================

router.post('/avatar', upload.single('avatar'), async (req: Request, res: Response) => {
  try {
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    // Create uploads directory if it doesn't exist (async, non-blocking)
    const uploadsDir = path.join(process.cwd(), 'uploads', 'avatars');
    await fs.promises.mkdir(uploadsDir, { recursive: true });

    // Save file with unique name
    const filename = `${userId}-${Date.now()}${path.extname(req.file.originalname)}`;
    const filepath = path.join(uploadsDir, filename);

    await fs.promises.writeFile(filepath, req.file.buffer);

    // ✅ Return relative path that matches the static file serving
    const avatar_url = `/uploads/avatars/${filename}`;

    // Update database - ✅ Include interests in RETURNING
    const result = await query(
      `UPDATE users 
       SET avatar_url = $1, updated_at = $2 
       WHERE id = $3
       RETURNING id, email, name, age, gender, bio, interests, avatar_url, is_verified, is_active`,
      [avatar_url, new Date(), userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    await deleteRedis(userCacheKey(userId)).catch(() => {});

    res.json({
      success: true,
      data: result.rows[0],
      avatar_url: avatar_url, // ✅ Also return avatar_url at root level for easier access
    });
  } catch (error) {
    console.error('Upload avatar error:', error);
    res.status(500).json({ error: 'Failed to upload avatar' });
  }
});

// ============================================================================
// GET /api/users/settings - Get current user's settings
// ============================================================================

const SETTING_FIELDS = [
  'push_notifications',
  'location_services',
  'dark_mode',
  'sound_effects',
  'show_online_status',
] as const;

router.get('/settings', async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Ensure a settings row exists (defaults), then return it.
    await query(
      `INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );

    const result = await query(
      `SELECT push_notifications, location_services, dark_mode, sound_effects, show_online_status, updated_at
       FROM user_settings WHERE user_id = $1`,
      [userId]
    );

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Get settings error:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// ============================================================================
// PUT /api/users/settings - Update current user's settings
// ============================================================================

router.put('/settings', async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Only accept known boolean fields.
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    for (const field of SETTING_FIELDS) {
      const val = req.body[field];
      if (val !== undefined) {
        if (typeof val !== 'boolean') {
          return res.status(400).json({ error: `${field} must be a boolean` });
        }
        updates.push(`${field} = $${paramIndex}`);
        values.push(val);
        paramIndex++;
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid settings to update' });
    }

    updates.push(`updated_at = $${paramIndex}`);
    values.push(new Date());
    paramIndex++;

    values.push(userId);

    // Upsert: ensure a row exists, then apply the update.
    await query(
      `INSERT INTO user_settings (user_id) VALUES ($${paramIndex}) ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );

    const result = await query(
      `UPDATE user_settings SET ${updates.join(', ')} WHERE user_id = $${paramIndex}
       RETURNING push_notifications, location_services, dark_mode, sound_effects, show_online_status, updated_at`,
      values
    );

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Update settings error:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// ============================================================================
// DELETE /api/users/account - Soft-delete the current user's account
// ============================================================================

router.delete('/account', async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Soft delete: mark deleted + deactivate, and release the email so it can
    // be reused for a fresh signup (email has a UNIQUE constraint).
    const result = await query(
      `UPDATE users
       SET deleted_at = $1,
           is_active = false,
           email = CONCAT('deleted_', id, '@deleted.local')
       WHERE id = $2 AND deleted_at IS NULL
       RETURNING id`,
      [new Date(), userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found or already deleted' });
    }

    res.json({ success: true, message: 'Account deleted' });
  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// ============================================================================
// GET /api/users/search - Search users
// NOTE: must be defined BEFORE the '/:id' route, otherwise '/search' is
// captured as an :id param and never reaches this handler.
// ============================================================================

router.get('/search', async (req: Request, res: Response) => {
  try {
    const { q, age, gender, limit = '20', offset = '0' } = req.query;

    let searchQuery = `
      SELECT id, email, name, age, gender, bio, interests, avatar_url, is_verified, is_active, created_at
      FROM users
      WHERE deleted_at IS NULL
    `;
    const values: any[] = [];
    let paramIndex = 1;

    if (q) {
      searchQuery += ` AND (name ILIKE $${paramIndex} OR email ILIKE $${paramIndex})`;
      values.push(`%${q}%`);
      paramIndex++;
    }

    if (age) {
      searchQuery += ` AND age = $${paramIndex}`;
      values.push(parseInt(age as string));
      paramIndex++;
    }

    if (gender) {
      searchQuery += ` AND gender = $${paramIndex}`;
      values.push(gender);
      paramIndex++;
    }

    // Clamp pagination to safe bounds to prevent unbounded/abusive queries.
    const limitNum = Math.min(Math.max(parseInt(limit as string) || 20, 1), 50);
    const offsetNum = Math.max(parseInt(offset as string) || 0, 0);

    // Get total count
    const countQuery = searchQuery.replace(/SELECT.*FROM/s, 'SELECT COUNT(*) as count FROM');
    const countResult = await query(countQuery, values);
    const total = parseInt(countResult.rows[0].count);

    // Get paginated results
    searchQuery += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    values.push(limitNum, offsetNum);

    const result = await query(searchQuery, values);

    res.json({
      success: true,
      data: result.rows,
      total,
      limit: limitNum,
      offset: offsetNum,
    });
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ error: 'Failed to search users' });
  }
});

// ============================================================================
// GET /api/users/:id - Get user by ID (cached in Redis, short TTL)
// ============================================================================

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const cached = await getRedis(userCacheKey(id)).catch(() => null);
    if (cached) {
      return res.json({ success: true, data: JSON.parse(cached) });
    }

    const result = await query(
      `SELECT id, email, name, age, gender, bio, interests, avatar_url, is_verified, is_active, created_at, updated_at
       FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    await setRedis(userCacheKey(id), JSON.stringify(result.rows[0]), USER_CACHE_TTL).catch(() => {});

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// ============================================================================
// GET /api/users/:id/online-status - Get user online status
// ============================================================================

router.get('/:id/online-status', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT is_active, updated_at FROM users WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    res.json({
      success: true,
      data: {
        status: user.is_active ? 'online' : 'offline',
        last_seen: user.updated_at,
      },
    });
  } catch (error) {
    console.error('Get online status error:', error);
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

// ============================================================================
// GET /api/users/:id/albums - Get user's albums
// ============================================================================

router.get('/:id/albums', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const requestingUserId = req.userId;

    const userCheck = await query(`SELECT id FROM users WHERE id = $1`, [id]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const isOwner = requestingUserId === id;

    // If viewing own profile, show all photos
    // If viewing someone else, only show public + shared-with-you
    const result = await query(
      `SELECT id, photo_url, thumbnail_url, caption, is_public, shared_with, uploaded_at
       FROM albums
       WHERE user_id = $1
         AND deleted_at IS NULL
         AND (
           $2 = true                          -- is owner
           OR is_public = true                -- public photo
           OR shared_with @> $3::jsonb        -- shared with requesting user
         )
       ORDER BY uploaded_at DESC`,
      [id, isOwner, JSON.stringify([{ userId: requestingUserId }])]
    );

    res.json({
      success: true,
      data: result.rows,
      albums: result.rows, // both keys for compatibility
    });
  } catch (error) {
    console.error('Get user albums error:', error);
    res.status(500).json({ error: 'Failed to fetch albums' });
  }
});

export default router;