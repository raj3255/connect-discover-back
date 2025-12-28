import { config } from './config/env.js';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import http from 'http';
import { query as dbQuery, closePool, pool } from './config/database.js';
import { connectRedis, closeRedis } from './config/redis.js';
import { authMiddleware } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';
import { rateLimiter } from './middleware/rateLimiter.js';
import { runMigrations } from './database/migrations.js';

// Import routes
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import locationRoutes from './routes/location.js';
import conversationRoutes from './routes/conversations.js';
import messageRoutes from './routes/messages.js';
import albumRoutes from './routes/albums.js';
import blockRoutes from './routes/blocks.js';
import reportRoutes from './routes/reports.js';

// Load environment variables
dotenv.config();

// Initialize Express and HTTP server
const app = express();
const server = http.createServer(app);

// ============================================================================
// MIDDLEWARE
// ============================================================================

// ✅ Configure Helmet to allow serving images from same origin
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }, // Allow cross-origin resource loading
  contentSecurityPolicy: false, // Disable CSP for development (or configure it properly)
}));

app.use(cors({ origin: config.CORS_ORIGIN as string[], credentials: true }));
app.use(morgan('combined'));
app.use('/api/', rateLimiter);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ============================================================================
// STATIC FILES - MOVED BEFORE ROUTES
// ============================================================================
// ✅ Serve static files with proper headers
app.use('/uploads', express.static('uploads', {
  setHeaders: (res) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  }
}));

// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: config.NODE_ENV,
  });
});

app.get('/api/test', (req: Request, res: Response) => {
  res.json({ message: 'Backend is running!' });
});

// ============================================================================
// API ROUTES
// ============================================================================

app.use('/api/auth', authRoutes);
app.use('/api/users', authMiddleware, userRoutes);
app.use('/api/location', authMiddleware, locationRoutes);
app.use('/api/conversations', authMiddleware, conversationRoutes);
app.use('/api/messages', authMiddleware, messageRoutes);
app.use('/api/albums', authMiddleware, albumRoutes);
app.use('/api/blocks', authMiddleware, blockRoutes);
app.use('/api/reports', authMiddleware, reportRoutes);

// ============================================================================
// ERROR HANDLING
// ============================================================================

app.use(errorHandler);

app.use((req: Request, res: Response) => {
  res.status(404).json({ error: 'Route not found' });
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

async function startServer() {
  try {
    console.log('\n🔄 Starting server initialization...\n');

    // Connect to PostgreSQL
    console.log('📦 Connecting to PostgreSQL...');
    const result = await dbQuery('SELECT NOW()');
    console.log('✅ PostgreSQL connected:', result.rows[0]);

    // Connect to Redis
    console.log('📦 Connecting to Redis...');
    await connectRedis();
    console.log('✅ Redis connected');

    // Run migrations
    console.log('📦 Running database migrations...');
    try {
      await runMigrations();
      console.log('✅ Database migrations completed');
    } catch (migrationError) {
      console.error('⚠️  Migration error:', migrationError);
      console.log('⏩ Continuing without migrations...');
    }

    // Initialize Socket.IO with timeout
    console.log('📦 Initializing Socket.IO...');
    try {
      const socketTimeout = new Promise((resolve, reject) => {
        setTimeout(() => {
          reject(new Error('Socket.IO initialization timeout'));
        }, 10000); // 10 second timeout
      });

      const socketInit = (async () => {
        try {
          const { initializeSocketServer } = await import('./socket/socketManager.js');
          const io = initializeSocketServer(server, pool);
          console.log('✅ Socket.IO initialized');
          return io;
        } catch (err) {
          console.warn('⚠️  Socket.IO init error (continuing):', err);
          return null;
        }
      })();

      await Promise.race([socketInit, socketTimeout]);
    } catch (socketError) {
      console.warn('⚠️  Socket.IO disabled:', socketError);
      // Continue without Socket.IO
    }

    // Start HTTP server
    server.listen(config.PORT, () => {
      console.log(`
╔════════════════════════════════════════════════════════════════════╗
║                                                                    ║
║     🚀 Connect & Discover Backend Started                         ║
║                                                                    ║
║     Server:   http://localhost:${config.PORT}                           ║
║     Env:      ${config.NODE_ENV}                                     ║
║     Database: PostgreSQL (${config.DB_HOST}:${config.DB_PORT})                     ║
║     Cache:    Redis (${config.REDIS_HOST}:${config.REDIS_PORT})                     ║
║                                                                    ║
║     Available Routes:                                             ║
║     ✓ Auth (register, login, verify)                              ║
║     ✓ Users (profile, search, avatar)                             ║
║     ✓ Conversations (messaging)                                   ║
║     ✓ Messages (chat history)                                     ║
║     ✓ Albums (photo management)                                   ║
║     ✓ Blocks (block users)                                        ║
║     ✓ Reports (report users)                                      ║
║     ✓ Location (GPS & nearby)                                     ║
║                                                                    ║
╚════════════════════════════════════════════════════════════════════╝
      `);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

process.on('SIGINT', async () => {
  console.log('\n\n🛑 Shutting down...');
  try {
    await closePool();
    console.log('✅ PostgreSQL closed');

    await closeRedis();
    console.log('✅ Redis closed');

    server.close();
    console.log('✅ HTTP server closed');

    console.log('✅ Server shutdown complete\n');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error during shutdown:', error);
    process.exit(1);
  }
});

// ============================================================================
// START SERVER
// ============================================================================

startServer();