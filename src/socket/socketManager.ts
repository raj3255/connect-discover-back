// src/socket/socketManager.ts
import { Server as HTTPServer } from 'http';
import { Server, Socket } from 'socket.io';
import { Pool } from 'pg';
import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import type { CustomSocket } from '../types/customSocket.js';

// Import handlers
import { chatHandler } from './handlers/chatHandler.js';
import { typingHandler } from './handlers/typingHandler.js';
import { statusHandler } from './handlers/statusHandler.js';
import { locationHandler } from './handlers/locationHandler.js';
import { matchHandler } from './handlers/matchHandler.js';
import { leavingHandler } from './handlers/leavingHandler.js';
import { setupWebRTCHandlers } from './handlers/webrtcHandler.js'; // ✅ ADD THIS
import { localMatchHandler } from './handlers/localMatchHandler.js';

export function initializeSocketServer(httpServer: HTTPServer, dbPool: Pool): Server {
  const io = new Server(httpServer, {
    cors: {
      origin: config.CORS_ORIGIN as string[],
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling'],
  });

  console.log('🔌 Socket.IO server initializing...');

  // ============================================================================
  // AUTHENTICATION MIDDLEWARE
  // ============================================================================
  io.use(async (socket: Socket, next) => {
    try {
      const token =
        socket.handshake.auth.token ||
        socket.handshake.headers.authorization?.split(' ')[1];

      if (!token) {
        return next(new Error('Authentication token required'));
      }

      // Verify JWT
      const decoded = jwt.verify(token, config.JWT_SECRET as string) as {
        userId: string;
      };

      const customSocket = socket as CustomSocket;
      customSocket.userId = decoded.userId;

      console.log(`✅ Socket authenticated: User ${decoded.userId}`);
      next();
    } catch (error) {
      console.error('Socket authentication error:', error);
      next(new Error('Authentication failed'));
    }
  });

  // ============================================================================
  // CONNECTION HANDLER
  // ============================================================================
  io.on('connection', (socket: Socket) => {
    const customSocket = socket as CustomSocket;
    const userId = customSocket.userId;

    console.log(`🔌 New socket connection: ${socket.id} (User: ${userId})`);

    // Join user-specific room (for targeted events)
    socket.join(`user:${userId}`);

    // ============================================================================
    // SETUP ALL HANDLERS
    // ============================================================================
    try {
      chatHandler(io, customSocket, dbPool);
      typingHandler(io, customSocket, dbPool);
      statusHandler(io, customSocket, dbPool);
      locationHandler(io, customSocket, dbPool);
      matchHandler(io, customSocket);
      localMatchHandler(io, customSocket);
      leavingHandler(io, customSocket);
      setupWebRTCHandlers(io, customSocket, userId); // ✅ ADD THIS LINE

      console.log(`✅ All handlers initialized for user ${userId}`);
    } catch (error) {
      console.error(`Error initializing handlers for user ${userId}:`, error);
    }

    // ============================================================================
    // DISCONNECT HANDLER
    // ============================================================================
    socket.on('disconnect', (reason) => {
      console.log(`🔌 Socket disconnected: ${socket.id} (User: ${userId}) - Reason: ${reason}`);
      
      // Handlers already have their own disconnect logic
      // This is just for logging
    });

    // ============================================================================
    // ERROR HANDLER
    // ============================================================================
    socket.on('error', (error) => {
      console.error(`Socket error for user ${userId}:`, error);
      socket.emit('error', {
        message: 'An error occurred',
        details: error instanceof Error ? error.message : String(error)
      });
    });

    // ============================================================================
    // CONNECTION SUCCESS CONFIRMATION
    // ============================================================================
    socket.emit('connection:success', {
      message: 'Connected successfully',
      userId,
      socketId: socket.id,
      timestamp: new Date()
    });
  });

  console.log('✅ Socket.IO server initialized');
  return io;
}

export default initializeSocketServer;