import express from 'express';
import { validate as isUuid } from 'uuid';
import type { Request, Response } from 'express';
import { query } from '../config/database.js';
import { setRedis, getRedis } from '../config/redis.js';
import { authMiddleware } from '../middleware/auth.js';
import { calculateDistance } from '../utils/distance.js';
import { searchCities, getCityCoordinates } from '../utils/geocoding.js';

const router = express.Router();

// ============================================================================
// UPDATE LOCATION - Store user's current GPS location
// ============================================================================
// QUERY 1: Insert or update user location
// This stores latitude and longitude in the locations table
// Also caches in Redis for quick access

router.post('/update', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    const { latitude, longitude } = req.body;

    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({ error: 'Latitude and longitude required' });
    }

    // Validate coordinates
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return res.status(400).json({ error: 'Invalid coordinates' });
    }

    // Check if location record exists
    const existingResult = await query(
      'SELECT id FROM locations WHERE user_id = $1',
      [userId]
    );

    if (existingResult.rows.length > 0) {
      // Update existing location
      await query(
        `UPDATE locations SET latitude = $1, longitude = $2, updated_at = CURRENT_TIMESTAMP 
         WHERE user_id = $3`,
        [latitude, longitude, userId]
      );
    } else {
      // Insert new location
      await query(
        `INSERT INTO locations (user_id, latitude, longitude, updated_at) 
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
        [userId, latitude, longitude]
      );
    }

    // Cache in Redis for 30 minutes (fast access)
    await setRedis(
      `location:${userId}`,
      JSON.stringify({ latitude, longitude, updated_at: new Date() }),
      1800
    );

    res.json({
      message: 'Location updated successfully',
      location: { latitude, longitude },
    });
  } catch (error) {
    console.error('Update location error:', error);
    res.status(500).json({ error: 'Failed to update location' });
  }
});

// ============================================================================
// GET NEARBY USERS - Find users within specified radius
// ============================================================================
// QUERY 2: Distance calculation using Haversine formula
// This finds all users within X km of your location
// Uses the calculateDistance utility function

router.get('/nearby', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    const { radius = 5, limit = 20 } = req.query;

    const radiusNum = parseInt(radius as string) || 5;
    const limitNum = parseInt(limit as string) || 20;

    if (radiusNum < 1 || radiusNum > 100) {
      return res.status(400).json({ error: 'Radius must be between 1 and 100 km' });
    }

    // Get current user's location
    const userLocResult = await query(
      'SELECT latitude, longitude FROM locations WHERE user_id = $1',
      [userId]
    );

    if (userLocResult.rows.length === 0) {
      return res.status(400).json({ error: 'Please share your location first' });
    }

    const { latitude: userLat, longitude: userLng } = userLocResult.rows[0];

    // Get all users with locations (excluding blocked users)
    const result = await query(
      `SELECT u.id, u.name, u.age, u.avatar_url, u.bio, u.interests,
              l.latitude, l.longitude, l.updated_at
       FROM users u
       JOIN locations l ON u.id = l.user_id
       WHERE u.id != $1 
       AND u.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM blocked_users 
         WHERE (blocker_id = $1 AND blocked_id = u.id) 
         OR (blocker_id = u.id AND blocked_id = $1)
       )
       LIMIT 100`,
      [userId]
    );

    // Calculate distances and filter by radius
    const nearbyUsers = result.rows
      .map((user) => {
        const distance = calculateDistance(
          userLat,
          userLng,
          user.latitude,
          user.longitude
        );
        return { ...user, distance: Math.round(distance * 100) / 100 };
      })
      .filter((user) => user.distance <= radiusNum)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limitNum);

    res.json({
      nearbyUsers,
      count: nearbyUsers.length,
      userLocation: { latitude: userLat, longitude: userLng },
    });
  } catch (error) {
    console.error('Get nearby users error:', error);
    res.status(500).json({ error: 'Failed to get nearby users' });
  }
});

// ============================================================================
// SEARCH CITIES - Autocomplete city names (via Nominatim)
// ============================================================================
// QUERY 3: External API call to Nominatim
// Searches for cities matching user input
// Results are cached in Redis

router.get('/search-cities', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { q } = req.query;

    if (!q || (q as string).length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters' });
    }

    const cities = await searchCities(q as string);

    res.json({
      suggestions: cities,
      count: cities.length,
    });
  } catch (error) {
    console.error('Search cities error:', error);
    res.status(500).json({ error: 'Failed to search cities' });
  }
});

// ============================================================================
// SEARCH USERS BY CITY - Find users in a specific city
// ============================================================================
// QUERY 4: Get city coordinates + find nearby users in that city
// Converts city name to coordinates, then finds users

router.get('/search-by-city', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { city, radius = 25, limit = 20 } = req.query;
    const userId = req.userId;

    if (!city || (city as string).length < 2) {
      return res.status(400).json({ error: 'City name required' });
    }

    const radiusNum = parseInt(radius as string) || 25;
    const limitNum = parseInt(limit as string) || 20;

    // Get city coordinates via Nominatim API
    const cityCoords = await getCityCoordinates(city as string);

    if (!cityCoords) {
      return res.status(404).json({ error: 'City not found' });
    }

    const { lat: cityLat, lng: cityLng } = cityCoords;

    // Get all users with locations
    const result = await query(
      `SELECT u.id, u.name, u.age, u.avatar_url, u.bio, u.interests,
              l.latitude, l.longitude
       FROM users u
       JOIN locations l ON u.id = l.user_id
       WHERE u.id != $1 
       AND u.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM blocked_users 
         WHERE (blocker_id = $1 AND blocked_id = u.id) 
         OR (blocker_id = u.id AND blocked_id = $1)
       )
       LIMIT 200`,
      [userId]
    );

    // Calculate distances from city center
    const usersInCity = result.rows
      .map((user) => {
        const distance = calculateDistance(
          cityLat,
          cityLng,
          user.latitude,
          user.longitude
        );
        return { ...user, distanceFromCity: Math.round(distance * 100) / 100 };
      })
      .filter((user) => user.distanceFromCity <= radiusNum)
      .sort((a, b) => a.distanceFromCity - b.distanceFromCity)
      .slice(0, limitNum);

    res.json({
      city: cityCoords.displayName,
      usersFound: usersInCity,
      count: usersInCity.length,
      cityCoordinates: { latitude: cityLat, longitude: cityLng },
    });
  } catch (error) {
    console.error('Search by city error:', error);
    res.status(500).json({ error: 'Failed to search city' });
  }
});

// ============================================================================
// GET USER LOCATION - Get another user's location
// ============================================================================
// QUERY 5: Get specific user's location (only if you're nearby or matched)

router.get('/:userId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.userId;

    if (!isUuid(userId)) {
      return res.status(400).json({ error: 'Invalid user id format' });
    }

    const convResult = await query(
      `SELECT id FROM conversations 
       WHERE ((user_1_id = $1 AND user_2_id = $2)
           OR (user_1_id = $2 AND user_2_id = $1))
       AND is_active = true`,
      [currentUserId, userId]
    );

    if (convResult.rows.length === 0) {
      return res.status(403).json({ error: 'Not authorized to view this location' });
    }

    // Get user location
    const result = await query(
      `SELECT latitude, longitude, updated_at FROM locations WHERE user_id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User location not found' });
    }

    res.json({
      location: result.rows[0],
    });
  } catch (error) {
    console.error('Get user location error:', error);
    res.status(500).json({ error: 'Failed to get location' });
  }
});

export default router;