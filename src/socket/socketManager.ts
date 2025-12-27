// src/socket/socketManager.ts
import { Server as SocketServer } from 'socket.io';
import { Server as HttpServer } from 'http';
import { Pool } from 'pg';
import jwt from 'jsonwebtoken';
import { query } from '../config/database.js';
import { CustomSocket } from '../types/customSocket';

// Import all handlers
import chatHandler from './handlers/chatHandler.js';
import statusHandler from './handlers/statusHandler.js';
import locationHandler from './handlers/locationHandler.js';
import matchHandler from './handlers/matchHandler.js';
import typingHandler from './handlers/typingHandler.js';
import leavingHandler from './handlers/leavingHandler.js';

/**
 * Initialize Socket.IO server with all event handlers
 */
export const initializeSocketServer = (
  httpServer: HttpServer,
  db: Pool
): SocketServer => {
  const io = new SocketServer(httpServer, {
    cors: {
      // origin: process.env.CLIENT_URL || 'http://localhost:5173',
      origin: [
      "http://localhost:5173",
      "http://localhost:5500",
      "http://127.0.0.1:5500",
      "http://localhost:8080",

    ],
      methods: ['GET', 'POST'],
      credentials: true
    },
    pingTimeout: 60000,
    pingInterval: 25000
  });
console.log("🔥 Socket.IO server initialized");

  // ==========================================================================
  // AUTHENTICATION MIDDLEWARE
  // ============================================================================
  io.use(async (socket, next) => {
    try {
      // Get token from auth header or handshake
      const token =
        socket.handshake.auth.token ||
        socket.handshake.headers.authorization?.replace('Bearer ', '');

      if (!token) {
        return next(new Error('Authentication required'));
      }

      // Verify JWT token
      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as {
        userId: string;
      };

      // Check if user exists and is not banned
      const userResult = await query(
        'SELECT id,is_active FROM users WHERE id = $1',
        [decoded.userId]
      );

      if (userResult.rows.length === 0) {
        return next(new Error('User not found'));
      }

      if (!userResult.rows[0].is_active) {
        return next(new Error('User is banned'));
      }

      // Attach userId to socket
      (socket as CustomSocket).userId = decoded.userId;

      next();
    } catch (error) {
      console.error('Auth middleware error:', error);
      next(new Error('Authentication failed'));
    }
  });

  // ============================================================================
  // CONNECTION HANDLER
  // ============================================================================
  io.on('connection', (socket) => {
    const customSocket = socket as CustomSocket;
    console.log(`User ${customSocket.userId} connected with socket ID ${socket.id}`);

    socket.on('disconnect', () => {
    console.log(`User ${customSocket.userId} disconnected`);
  });

    try {
      // Join user's personal room for direct messages
      socket.join(`user:${customSocket.userId}`);

      // Initialize all event handlers
      chatHandler(io, customSocket, db);
      statusHandler(io, customSocket, db);
      locationHandler(io, customSocket, db);
      matchHandler(io, customSocket, db);
      typingHandler(io, customSocket, db);
      leavingHandler(io, customSocket);

      // Emit connection success
      socket.emit('connection:success', {
        message: 'Connected to server',
        socketId: socket.id
      });

    } catch (error) {
      console.error('Connection handler error:', error);
      socket.disconnect(true);
    }
  });
  return io;
};

/**
 * Broadcast message to a conversation room
 */
export const broadcastToConversation = (
  io: SocketServer,
  conversationId: string,
  event: string,
  data: any,
  excludeUserId?: string
): void => {
  const room = io.to(`conversation:${conversationId}`);
  room.emit(event, { ...data, excludeUserId });
};

/**
 * Send message to specific user
 */
export const sendToUser = (
  io: SocketServer,
  userId: string,
  event: string,
  data: any
): void => {
  io.to(`user:${userId}`).emit(event, data);
};

/**
 * Get connected sockets count
 */
export const getConnectedSocketsCount = (io: SocketServer): number => {
  return io.engine.clientsCount;
};

export default initializeSocketServer;