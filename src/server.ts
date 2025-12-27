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

// Import Socket Manager
import initializeSocketServer from './socket/socketManager.js';

// Load environment variables
dotenv.config();

// Initialize Express and HTTP server
const app = express();
const server = http.createServer(app);

// ============================================================================
// MIDDLEWARE
// ============================================================================

app.use(helmet());
app.use(cors({ origin: config.CORS_ORIGIN as string[], credentials: true }));
app.use(morgan('combined'));
app.use('/api/', rateLimiter);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ============================================================================
// HEALTH CHECK ENDPOINTS
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
    await runMigrations();
    console.log('✅ Database migrations completed');

    // Initialize Socket.IO with all handlers
    console.log('📦 Initializing Socket.IO...');
    const io = initializeSocketServer(server, pool);
    console.log('✅ Socket.IO initialized with all handlers');

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
║     Socket:   Ready for connections                               ║
║                                                                    ║
║     Available Handlers:                                           ║
║     ✓ Chat (messaging)                                            ║
║     ✓ Status (online/idle/offline)                                ║
║     ✓ Location (GPS & nearby users)                               ║
║     ✓ Match (global mode matching)                                ║
║     ✓ Typing (indicators)                                         ║
║     ✓ Leaving (disconnect handling)                               ║
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
    // Close database connection
    await closePool();
    console.log('✅ PostgreSQL closed');

    // Close Redis connection
    await closeRedis();
    console.log('✅ Redis closed');

    // Close HTTP server
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