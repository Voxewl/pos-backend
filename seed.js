const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  port: 5433,
  user: 'pos_user',
  password: 'pos_password',
  database: 'pos_system',
});

async function seedMenu() {
  try {
    // 1. Ensure printers exist
    const barPrinter = await pool.query(
      `INSERT INTO printers (name, ip_address, port) 
       VALUES ('Bar Printer', '127.0.0.1', 9200) 
       ON CONFLICT (ip_address) DO UPDATE SET name = EXCLUDED.name, port = EXCLUDED.port 
       RETURNING id`
    );

    const kitchenPrinter = await pool.query(
      `INSERT INTO printers (name, ip_address, port) 
       VALUES ('Kitchen Printer', '127.0.0.1', 9201) 
       ON CONFLICT (ip_address) DO UPDATE SET name = EXCLUDED.name, port = EXCLUDED.port 
       RETURNING id`
    );

    const barId = barPrinter.rows[0].id;
    const kitchenId = kitchenPrinter.rows[0].id;

    // 2. Clear old demo menu data for clean rebuild
    await pool.query('DELETE FROM menu_items');
    await pool.query('DELETE FROM categories');

    // 3. Create Categories mapped to printers
    const barCat = await pool.query(
      `INSERT INTO categories (name, printer_id) VALUES ('Beverages & Cocktails', $1) RETURNING id`,
      [barId]
    );

    const foodCat = await pool.query(
      `INSERT INTO categories (name, printer_id) VALUES ('Main Dishes', $1) RETURNING id`,
      [kitchenId]
    );

    const dessertCat = await pool.query(
      `INSERT INTO categories (name, printer_id) VALUES ('Desserts', $1) RETURNING id`,
      [kitchenId]
    );

    // 4. Create Sample Menu Items
    await pool.query(
      `INSERT INTO menu_items (name, price, category_id) VALUES 
       ('Margarita', 12.50, $1),
       ('Craft Beer', 7.00, $1),
       ('Cheeseburger', 15.00, $2),
       ('Ribeye Steak', 28.00, $2),
       ('Chocolate Cake', 8.50, $3)`,
      [barCat.rows[0].id, foodCat.rows[0].id, dessertCat.rows[0].id]
    );

    console.log("✅ Dynamic menu & categories successfully seeded!");

    // 5. Seed Restaurant Floor Tables
    await pool.query('DELETE FROM tables');

    await pool.query(`
      INSERT INTO tables (table_number, capacity, section, status) VALUES
      ('Table 1', 2, 'Main Dining', 'AVAILABLE'),
      ('Table 2', 4, 'Main Dining', 'AVAILABLE'),
      ('Table 3', 4, 'Main Dining', 'AVAILABLE'),
      ('Table 4', 6, 'Main Dining', 'AVAILABLE'),
      ('Patio 1', 4, 'Patio Zone', 'AVAILABLE'),
      ('Patio 2', 2, 'Patio Zone', 'AVAILABLE'),
      ('Bar Top 1', 1, 'Bar Zone', 'AVAILABLE'),
      ('Bar Top 2', 1, 'Bar Zone', 'AVAILABLE')
    `);

    console.log("✅ Restaurant floor tables seeded!");

  } catch (err) {
    console.error("❌ Seeding error:", err);
  } finally {
    await pool.end();
  }
}

seedMenu();