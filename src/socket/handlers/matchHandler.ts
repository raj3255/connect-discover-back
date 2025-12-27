import { Server as SocketServer, Socket } from 'socket.io';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../../config/database.js';
import { setRedis, getRedis, deleteRedis, addToSet, removeFromSet, getSet } from '../../config/redis.js';
import { CustomSocket } from '../../types/customSocket';
export const matchHandler = (io: SocketServer, socket: CustomSocket, db: Pool) => {
  const userId = socket.userId;
  let currentMatchId: string | null = null;
  let searchInterval: NodeJS.Timeout | null = null;

  // ============================================================================
  // START SEARCHING - User enters match queue
  // ============================================================================
  // Adds user to Redis queue and starts matching loop

  socket.on('match:start_searching', async (preferences) => {
    try {
      const { mode = 'text', ageRange = [18, 80], genderPreference = 'any' } = preferences;

      // Get user info
      const userResult = await query(
        `SELECT id, name, age, avatar_url FROM users WHERE id = $1`,
        [userId]
      );

      if (userResult.rows.length === 0) {
        socket.emit('error', { message: 'User not found' });
        return;
      }

      const user = userResult.rows[0];

      // Add to match queue in Redis
      const queueData = {
        id: userId,
        name: user.name,
        age: user.age,
        avatar: user.avatar_url,
        preferences: { mode, ageRange, genderPreference },
        joinedAt: Date.now()
      };

      await setRedis(`match_queue:${userId}`, JSON.stringify(queueData), 3600);
      await addToSet('match_queue_users', userId);

      socket.emit('match:searching');

      // Start matching loop
      if (searchInterval) clearInterval(searchInterval);
      searchInterval = setInterval(async () => {
        await findMatch(user, preferences);
      }, 2000);

      console.log(`User ${userId} started searching for match`);
    } catch (error) {
      console.error('Start searching error:', error);
      socket.emit('error', { message: 'Failed to start searching' });
    }
  });

  // ============================================================================
  // FIND MATCH - Match users in queue
  // ============================================================================

  const findMatch = async (user: any, preferences: any) => {
    try {
      // Get all users in queue
      const queueUserIds = await getSet('match_queue_users');
      if (queueUserIds.length < 2) return; // Need at least 2 users

      // Get blocked users
      const blockedResult = await query(
        `SELECT blocked_id FROM blocked_users WHERE blocker_id = $1
         UNION
         SELECT blocker_id FROM blocked_users WHERE blocked_id = $1`,
        [userId]
      );

      const blockedSet = new Set(
        blockedResult.rows.map((r: any) => r.blocked_id || r.blocker_id)
      );

      // Find compatible match
      for (const candidateId of queueUserIds) {
        if (candidateId === userId) continue;
        if (blockedSet.has(candidateId)) continue;

        const candidateStr = await getRedis(`match_queue:${candidateId}`);
        if (!candidateStr) continue;

        const candidate = JSON.parse(candidateStr);

        // Check mutual compatibility
        if (!isCompatible(user, preferences, candidate)) continue;
        if (!isCompatible(candidate, candidate.preferences, user)) continue;

        // Found a match!
        const matchId = `match_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Store pending match
        const matchData = {
          user1: userId,
          user2: candidateId,
          mode: preferences.mode,
          createdAt: Date.now(),
          user1_accepted: false,
          user2_accepted: false
        };

        await setRedis(`pending_match:${matchId}`, JSON.stringify(matchData), 30); // 30 second timeout

        // Remove from queue
        await removeFromSet('match_queue_users', userId);
        await removeFromSet('match_queue_users', candidateId);
        await deleteRedis(`match_queue:${userId}`);
        await deleteRedis(`match_queue:${candidateId}`);

        currentMatchId = matchId;

        if (searchInterval) {
          clearInterval(searchInterval);
          searchInterval = null;
        }

        // Notify both users
        socket.emit('match:found', {
          matchId,
          user: {
            id: candidateId,
            name: candidate.name,
            age: candidate.age,
            avatar: candidate.avatar
          }
        });

        io.to(`user:${candidateId}`).emit('match:found', {
          matchId,
          user: {
            id: userId,
            name: user.name,
            age: user.age,
            avatar: user.avatar_url
          }
        });

        return;
      }
    } catch (error) {
      console.error('Find match error:', error);
    }
  };

  // ============================================================================
  // CHECK COMPATIBILITY
  // ============================================================================

  const isCompatible = (user: any, preferences: any, candidate: any) => {
    // Check age range
    if (
      candidate.age < preferences.ageRange[0] ||
      candidate.age > preferences.ageRange[1]
    ) {
      return false;
    }

    // Check gender preference
    if (
      preferences.genderPreference !== 'any' &&
      candidate.gender !== preferences.genderPreference
    ) {
      return false;
    }

    // Check mode preference
    if (preferences.mode !== candidate.preferences.mode) {
      return false;
    }

    return true;
  };

  // ============================================================================
  // ACCEPT MATCH - User accepts match
  // ============================================================================

  socket.on('match:accept', async (matchId: string) => {
    try {
      const matchStr = await getRedis(`pending_match:${matchId}`);
      if (!matchStr) {
        socket.emit('error', { message: 'Match expired' });
        return;
      }

      const match = JSON.parse(matchStr);
      const otherUserId = match.user1 === userId ? match.user2 : match.user1;

      // Mark as accepted
      match[`${userId === match.user1 ? 'user1' : 'user2'}_accepted`] = true;

      // Check if both accepted
      if (match.user1_accepted && match.user2_accepted) {
        // Create session
        const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Create conversation in DB
        const convResult = await query(
          `INSERT INTO conversations (user_1_id, user_2_id, chat_mode, is_active)
           VALUES ($1, $2, $3, true)
           RETURNING id`,
          [match.user1, match.user2, 'global']
        );

        const conversationId = convResult.rows[0].id;

        const sessionData = {
          id: sessionId,
          conversationId,
          participants: [match.user1, match.user2],
          mode: match.mode,
          startedAt: new Date()
        };

        await setRedis(`active_session:${sessionId}`, JSON.stringify(sessionData), 3600);
        await deleteRedis(`pending_match:${matchId}`);

        currentMatchId = null;

        socket.emit('match:accepted', sessionData);
        io.to(`user:${otherUserId}`).emit('match:accepted', sessionData);

        // Join session room
        socket.join(`session:${sessionId}`);
        io.sockets.sockets.get(
          Array.from(io.sockets.adapter.rooms.get(`user:${otherUserId}`) || [])[0] || ''
        )?.join(`session:${sessionId}`);
      } else {
        // Wait for partner
        await setRedis(`pending_match:${matchId}`, JSON.stringify(match), 30);
      }
    } catch (error) {
      console.error('Accept match error:', error);
      socket.emit('error', { message: 'Failed to accept match' });
    }
  });

  // ============================================================================
  // SKIP / END SESSION
  // ============================================================================

  socket.on('match:skip', async () => {
    if (currentMatchId) {
      await deleteRedis(`pending_match:${currentMatchId}`);
    }
    currentMatchId = null;
  });

  // ============================================================================
  // STOP SEARCHING
  // ============================================================================

  socket.on('match:stop_searching', async () => {
    if (searchInterval) {
      clearInterval(searchInterval);
      searchInterval = null;
    }
    await deleteRedis(`match_queue:${userId}`);
    await removeFromSet('match_queue_users', userId);
  });

  // ============================================================================
  // CLEANUP
  // ============================================================================

  socket.on('disconnect', async () => {
    if (searchInterval) {
      clearInterval(searchInterval);
    }
    await deleteRedis(`match_queue:${userId}`);
    await removeFromSet('match_queue_users', userId);
  });
};

export default matchHandler;