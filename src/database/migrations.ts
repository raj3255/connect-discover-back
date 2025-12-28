import { query } from '../config/database.js';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);

export async function runMigrations() {
  try {
    console.log('🔄 Running database migrations...');

    // =========================================================================
    // USERS TABLE
    // =========================================================================
    console.log('⏳ Creating users table...');
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

    // =========================================================================
    // LOCATIONS TABLE
    // =========================================================================
    console.log('⏳ Creating locations table...');
    await query(`
      CREATE TABLE IF NOT EXISTS locations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        latitude DECIMAL(10, 8) NOT NULL,
        longitude DECIMAL(11, 8) NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS idx_locations_user_id ON locations(user_id);
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS idx_locations_coords ON locations(latitude, longitude);
    `);
    console.log('✓ Locations table created');

    // =========================================================================
    // CONVERSATIONS TABLE
    // =========================================================================
    console.log('⏳ Creating conversations table...');
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
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS idx_conv_users ON conversations(user_1_id, user_2_id);
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS idx_conv_active ON conversations(is_active);
    `);
    console.log('✓ Conversations table created');

    // =========================================================================
    // MESSAGES TABLE
    // =========================================================================
    console.log('⏳ Creating messages table...');
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
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS idx_msg_conversation ON messages(conversation_id, created_at);
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS idx_msg_sender ON messages(sender_id);
    `);
    console.log('✓ Messages table created');

    // =========================================================================
    // ALBUMS TABLE
    // =========================================================================
    console.log('⏳ Creating albums table...');
    await query(`
      CREATE TABLE IF NOT EXISTS albums (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP
      );
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS idx_album_user ON albums(user_id, created_at);
    `);
    console.log('✓ Albums table created');

    // =========================================================================
    // ALBUM PHOTOS TABLE
    // =========================================================================
    console.log('⏳ Creating album_photos table...');
    await query(`
      CREATE TABLE IF NOT EXISTS album_photos (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        album_id UUID NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
        photo_url VARCHAR(500) NOT NULL,
        thumbnail_url VARCHAR(500),
        caption TEXT,
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP
      );
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS idx_album_photos_album ON album_photos(album_id);
    `);
    console.log('✓ Album photos table created');

    // =========================================================================
    // USER BLOCKS TABLE
    // =========================================================================
    console.log('⏳ Creating user_blocks table...');
    await query(`
      CREATE TABLE IF NOT EXISTS user_blocks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        blocked_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, blocked_user_id)
      );
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS idx_user_blocks_user ON user_blocks(user_id);
    `);
    console.log('✓ User blocks table created');

    // =========================================================================
    // USER REPORTS TABLE
    // =========================================================================
    console.log('⏳ Creating user_reports table...');
    await query(`
      CREATE TABLE IF NOT EXISTS user_reports (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reported_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reason VARCHAR(50) NOT NULL,
        description TEXT,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS idx_user_reports_status ON user_reports(status);
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS idx_user_reports_reporter ON user_reports(reporter_id);
    `);
    console.log('✓ User reports table created');

    // =========================================================================
    // USER SESSIONS TABLE
    // =========================================================================
    console.log('⏳ Creating user_sessions table...');
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
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS idx_session_user ON user_sessions(user_id);
    `);
    console.log('✓ User sessions table created');

    console.log('\n✅ All migrations completed successfully!\n');
  } catch (error) {
    console.error('❌ Migration error:', error);
    throw error;
  }
}

// Allow running migrations standalone
if (process.argv[1] === __filename) {
  runMigrations()
    .then(() => {
      console.log('✅ Migrations complete');
      process.exit(0);
    })
    .catch((err) => {
      console.error('❌ Migration failed:', err);
      process.exit(1);
    });
}