import { query } from '../config/database.js';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);


export async function runMigrations() {
  try {
    console.log('Running database migrations...');

    await query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        phone VARCHAR(20),
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(100) NOT NULL,
        age INT NOT NULL,
        bio TEXT,
        gender VARCHAR(20),
        interests TEXT,
        avatar_url VARCHAR(500),
        is_verified BOOLEAN DEFAULT false,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP
      );
    `);
    console.log('✓ Users table created');

    await query(`
      CREATE TABLE IF NOT EXISTS locations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        latitude DECIMAL(10, 8) NOT NULL,
        longitude DECIMAL(11, 8) NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_locations_user_id ON locations(user_id);
      CREATE INDEX IF NOT EXISTS idx_locations_coords ON locations(latitude, longitude);
    `);
    console.log('✓ Locations table created');

    await query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_1_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_2_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        chat_mode VARCHAR(20) NOT NULL,
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ended_at TIMESTAMP,
        last_message_at TIMESTAMP,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_conv_users ON conversations(user_1_id, user_2_id);
      CREATE INDEX IF NOT EXISTS idx_conv_active ON conversations(is_active);
    `);
    console.log('✓ Conversations table created');

    await query(`
      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        text TEXT,
        media_urls TEXT[],
        message_type VARCHAR(20) DEFAULT 'text',
        is_read BOOLEAN DEFAULT false,
        read_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_msg_conversation ON messages(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_msg_sender ON messages(sender_id);
    `);
    console.log('✓ Messages table created');

    await query(`
      CREATE TABLE IF NOT EXISTS albums (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        photo_url VARCHAR(500) NOT NULL,
        thumbnail_url VARCHAR(500),
        caption TEXT,
        is_public BOOLEAN DEFAULT false,
        is_expiring BOOLEAN DEFAULT false,
        expiration_type VARCHAR(20) DEFAULT 'never',
        shared_with JSONB DEFAULT '[]'::jsonb,
        view_count INT DEFAULT 0,
        last_viewed_by JSONB DEFAULT '[]'::jsonb,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_album_user ON albums(user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_album_public ON albums(user_id, is_public);
    `);
    console.log('✓ Albums table created');

    await query(`
      CREATE TABLE IF NOT EXISTS blocked_users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        blocker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        blocked_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reason TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(blocker_id, blocked_id)
      );
      CREATE INDEX IF NOT EXISTS idx_blocked_blocker ON blocked_users(blocker_id);
    `);
    console.log('✓ Blocked users table created');

    await query(`
      CREATE TABLE IF NOT EXISTS reports (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reported_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
        message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
        reason VARCHAR(50) NOT NULL,
        description TEXT,
        status VARCHAR(20) DEFAULT 'open',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
    `);
    console.log('✓ Reports table created');

    await query(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        refresh_token VARCHAR(500) NOT NULL,
        device_info VARCHAR(255),
        ip_address INET,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_session_user ON user_sessions(user_id);
    `);
    console.log('✓ User sessions table created');

    console.log('✓ All migrations completed successfully!');
  } catch (error) {
    console.error('Migration error:', error);
    throw error;
  }
}

if (process.argv[1] === __filename) {
  runMigrations()
    .then(() => {
      console.log('Migrations complete');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}