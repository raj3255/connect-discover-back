import express from 'express';
import type { Request, Response } from 'express';
import { query } from '../config/database.js';
import multer from 'multer';
import * as fs from 'fs';
import * as path from 'path';

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

    // Create uploads directory if it doesn't exist
    const uploadsDir = path.join(process.cwd(), 'uploads', 'avatars');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    // Save file with unique name
    const filename = `${userId}-${Date.now()}${path.extname(req.file.originalname)}`;
    const filepath = path.join(uploadsDir, filename);

    fs.writeFileSync(filepath, req.file.buffer);

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

    console.log('✅ Avatar uploaded:', avatar_url); // Debug log

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
// GET /api/users/:id - Get user by ID
// ============================================================================

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT id, email, name, age, gender, bio, interests, avatar_url, is_verified, is_active, created_at, updated_at
       FROM users WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

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
// GET /api/users/search - Search users
// ============================================================================

router.get('/search', async (req: Request, res: Response) => {
  try {
    const { q, age, gender, limit = '20', offset = '0' } = req.query;

    let searchQuery = `
      SELECT id, email, name, age, gender, bio, interests, avatar_url, is_verified, is_active, created_at
      FROM users 
      WHERE 1=1
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

    const limitNum = parseInt(limit as string);
    const offsetNum = parseInt(offset as string);

    // Get total count
    const countQuery = searchQuery.replace(/SELECT.*FROM/, 'SELECT COUNT(*) as count FROM');
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

    // Check if user exists
    const userCheck = await query(
      `SELECT id FROM users WHERE id = $1`,
      [id]
    );

    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get albums with photo count
    const result = await query(
      `SELECT id, name, created_at, updated_at,
              (SELECT COUNT(*) FROM album_photos WHERE album_id = albums.id) as photo_count
       FROM albums 
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [id]
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error('Get albums error:', error);
    res.status(500).json({ error: 'Failed to fetch albums' });
  }
});

export default router;