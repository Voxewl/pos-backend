const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  port: 5433,
  user: 'pos_user',
  password: 'pos_password',
  database: 'pos_system',
});

const createTables = async () => {
  const queryText = `
    -- 1. Waiters Table
    CREATE TABLE IF NOT EXISTS waiters (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE,
      pin VARCHAR(10) NOT NULL
    );

    -- 2. Printers Table
    CREATE TABLE IF NOT EXISTS printers (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      ip_address VARCHAR(45) NOT NULL UNIQUE,
      port INT DEFAULT 9100,
      is_active BOOLEAN DEFAULT true
    );

    -- 3. Categories Table
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      printer_id INT REFERENCES printers(id) ON DELETE SET NULL
    );

    -- 4. Menu Items Table
    CREATE TABLE IF NOT EXISTS menu_items (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      price NUMERIC(10, 2) NOT NULL,
      category_id INT REFERENCES categories(id) ON DELETE CASCADE
    );

    -- 5. Tables Table
    CREATE TABLE IF NOT EXISTS tables (
      id SERIAL PRIMARY KEY,
      table_number VARCHAR(50) UNIQUE NOT NULL,
      capacity INT DEFAULT 4,
      section VARCHAR(50) DEFAULT 'Main Dining',
      status VARCHAR(20) DEFAULT 'AVAILABLE',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- 6. Orders Table
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      table_number VARCHAR(20) NOT NULL,
      waiter_name VARCHAR(100) DEFAULT 'Staff',
      guest_count INT DEFAULT 1,
      status VARCHAR(50) DEFAULT 'ACTIVE',
      total_amount NUMERIC(10, 2) DEFAULT 0.00,
      payment_method VARCHAR(20),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- 7. Order Items Table
    CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY,
      order_id INT REFERENCES orders(id) ON DELETE CASCADE,
      item_id INT REFERENCES menu_items(id) ON DELETE SET NULL,
      item_name VARCHAR(100) NOT NULL,
      quantity INT NOT NULL,
      notes VARCHAR(255)
    );

    -- --- MIGRATIONS (Patches existing 'orders' table if missing columns) ---
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS waiter_name VARCHAR(100) DEFAULT 'Staff';
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS guest_count INT DEFAULT 1;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS total_amount NUMERIC(10, 2) DEFAULT 0.00;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20);
  `;

  try {
    // Run schema creation & column patches
    await pool.query(queryText);
    console.log("Database tables and column migrations applied successfully.");

    // Seed default waiter accounts for testing
    await pool.query(`
      INSERT INTO waiters (name, pin) 
      VALUES ('Alex', '1234'), ('Maria', '5678')
      ON CONFLICT (name) DO NOTHING;
    `);
    console.log("Default waiters seeded (Alex: 1234, Maria: 5678).");

  } catch (err) {
    console.error("Error setting up database tables:", err);
  } finally {
    await pool.end();
  }
};

createTables();