import express from 'express';
import type { Request, Response } from 'express';
import bcryptjs from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../config/database.js';
import { setRedis, getRedis, deleteRedis } from '../config/redis.js';
import { generateTokens } from '../middleware/auth.js';
import { authMiddleware } from '../middleware/auth.js';
import { validate, schemas } from '../utils/validators.js';

const router = express.Router();

// ============================================================================
// REGISTER - Create new user account
// ============================================================================

router.post('/register', async (req: Request, res: Response) => {
  try {
    const { error, value } = validate(schemas.register, req.body);

    if (error) {
      const messages = error.details.map((d) => d.message);
      return res.status(400).json({ error: 'Validation failed', details: messages });
    }

    const { email, password, name, age, gender } = value;

    // Check if user already exists
    const existingUser = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    // Hash password
    const salt = await bcryptjs.genSalt(10);
    const passwordHash = await bcryptjs.hash(password, salt);

    // Create user
    const userId = uuidv4();
    await query(
      `INSERT INTO users (id, email, password_hash, name, age, gender, is_verified, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, false, true)`,
      [userId, email, passwordHash, name, age, gender]
    );

    // Generate verification code
    const verificationCode = Math.random().toString().slice(2, 8);
    await setRedis(`verify:${email}`, verificationCode, 600); // 10 minutes

    // TODO: Send verification email via SendGrid
    console.log(`[DEV] Verification code for ${email}: ${verificationCode}`);

    res.status(201).json({
      message: 'User created successfully. Please verify your email.',
      userId,
      email,
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ============================================================================
// VERIFY EMAIL - Activate account with verification code
// ============================================================================

router.post('/verify-email', async (req: Request, res: Response) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ error: 'Email and code required' });
    }

    // Get stored verification code
    const storedCode = await getRedis(`verify:${email}`);

    if (!storedCode || storedCode !== code) {
      return res.status(400).json({ error: 'Invalid or expired verification code' });
    }

    // Update user as verified
    const result = await query('UPDATE users SET is_verified = true WHERE email = $1 RETURNING id, email, name', [
      email,
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Delete verification code from Redis
    await deleteRedis(`verify:${email}`);

    res.json({ message: 'Email verified successfully' });
  } catch (error) {
    console.error('Verify email error:', error);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// ============================================================================
// LOGIN - Authenticate user and return JWT tokens
// ============================================================================

// In your src/routes/auth.ts - UPDATE the LOGIN endpoint only

router.post('/login', async (req: Request, res: Response) => {
  try {
    const { error, value } = validate(schemas.login, req.body);

    if (error) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    const { email, password } = value;

    // Find user
    const result = await query(
      `SELECT id, email, name, password_hash, is_verified, is_active, age, gender FROM users WHERE email = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];

    // Check if user is active
    if (!user.is_active) {
      return res.status(403).json({ error: 'Account is inactive' });
    }

    // Verify password
    const passwordMatch = await bcryptjs.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate tokens
    const { accessToken, refreshToken } = generateTokens(user.id, user.email);

    // Store refresh token in database
    const sessionId = uuidv4();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    await query(
      `INSERT INTO user_sessions (id, user_id, refresh_token, expires_at, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [sessionId, user.id, refreshToken, expiresAt]
    );

    // Store user in Redis for quick access
    await setRedis(`user:${user.id}`, JSON.stringify(user), 3600); // 1 hour

    // UPDATED RESPONSE FORMAT - matches frontend expectations
    res.json({
      success: true,
      message: 'Login successful',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        age: user.age,
        gender: user.gender,
        is_verified: user.is_verified,
      },
      token: accessToken,  // Single token for socket auth
      tokens: {            // Keep both formats for flexibility
        accessToken,
        refreshToken,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

router.get('/me', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId; // Set by authMiddleware
    
    const result = await query(
      `SELECT id, email, name, age, gender, is_verified, is_active FROM users WHERE id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    res.json({
      success: true,
      user,
      data: user
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});
// ============================================================================
// REFRESH TOKEN - Get new access token using refresh token
// ============================================================================

router.post('/refresh', async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token required' });
    }

    // Verify refresh token exists in database
    const result = await query(`SELECT user_id FROM user_sessions WHERE refresh_token = $1 AND expires_at > NOW()`, [
      refreshToken,
    ]);

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const userId = result.rows[0].user_id;

    // Get user details
    const userResult = await query('SELECT id, email FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    // Generate new tokens
    const { accessToken, refreshToken: newRefreshToken } = generateTokens(user.id, user.email);

    // Update refresh token in database
    await query('UPDATE user_sessions SET refresh_token = $1 WHERE refresh_token = $2', [
      newRefreshToken,
      refreshToken,
    ]);

    res.json({
      message: 'Token refreshed successfully',
      tokens: {
        accessToken,
        refreshToken: newRefreshToken,
      },
    });
  } catch (error) {
    console.error('Refresh token error:', error);
    res.status(500).json({ error: 'Token refresh failed' });
  }
});

// ============================================================================
// FORGOT PASSWORD - Send password reset code
// ============================================================================

router.post('/forgot-password', async (req: Request, res: Response) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }

    // Check if user exists
    const result = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      // Don't reveal if email exists for security
      return res.json({ success: true, message: 'If email exists, reset code has been sent' });
    }

    // Generate reset code
    const resetCode = Math.random().toString().slice(2, 8);
    
    try {
      await setRedis(`reset:${email}`, resetCode, 1800); // 30 minutes
      console.log(`[DEV] Password reset code for ${email}: ${resetCode}`);
    } catch (redisError) {
      console.error('Redis error saving reset code:', redisError);
      return res.status(500).json({ error: 'Failed to generate reset code' });
    }

    res.json({ success: true, message: 'If email exists, reset code has been sent' });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// ============================================================================
// RESET PASSWORD - Reset password with code
// ============================================================================

router.post('/reset-password', async (req: Request, res: Response) => {
  try {
    const { email, code, newPassword } = req.body;

    if (!email || !code || !newPassword) {
      return res.status(400).json({ error: 'Email, code, and new password required' });
    }

    // Validate new password
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Verify reset code
    let storedCode: string | null = null;
    try {
      storedCode = await getRedis(`reset:${email}`);
    } catch (redisError) {
      console.error('Redis error retrieving reset code:', redisError);
      return res.status(500).json({ error: 'Failed to verify reset code' });
    }

    if (!storedCode || storedCode !== code) {
      return res.status(400).json({ error: 'Invalid or expired reset code' });
    }

    // Hash new password
    const salt = await bcryptjs.genSalt(10);
    const passwordHash = await bcryptjs.hash(newPassword, salt);

    // Update password
    const result = await query('UPDATE users SET password_hash = $1 WHERE email = $2 RETURNING id', [
      passwordHash,
      email,
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Delete reset code from Redis
    try {
      await deleteRedis(`reset:${email}`);
    } catch (redisError) {
      console.error('Redis error deleting reset code:', redisError);
      // Don't fail the request, code is already used
    }

    // Invalidate all user sessions
    await query('DELETE FROM user_sessions WHERE user_id = $1', [result.rows[0].id]);

    res.json({ success: true, message: 'Password reset successfully. Please login with your new password.' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Password reset failed' });
  }
});

// ============================================================================
// LOGOUT - Invalidate refresh token
// ============================================================================

router.post('/logout', async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token required' });
    }

    // Delete refresh token from database
    await query('DELETE FROM user_sessions WHERE refresh_token = $1', [refreshToken]);

    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// ============================================================================
// RESEND VERIFICATION CODE
// ============================================================================

router.post('/resend-verification', async (req: Request, res: Response) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }

    // Check if user exists and is not verified
    const result = await query('SELECT id, is_verified FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (result.rows[0].is_verified) {
      return res.status(400).json({ error: 'Email already verified' });
    }

    // Generate new verification code
    const verificationCode = Math.random().toString().slice(2, 8);
    await setRedis(`verify:${email}`, verificationCode, 600); // 10 minutes

    // TODO: Send verification email via SendGrid
    console.log(`[DEV] Verification code for ${email}: ${verificationCode}`);

    res.json({ message: 'Verification code sent to email' });
  } catch (error) {
    console.error('Resend verification error:', error);
    res.status(500).json({ error: 'Failed to send verification code' });
  }
});

export default router;