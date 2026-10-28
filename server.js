const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { printQueue } = require('./queue');

const app = express();
app.use(cors());
app.use(express.json());

const db = new Pool({
  host: 'localhost',
  port: 5433,
  user: 'pos_user',
  password: 'pos_password',
  database: 'pos_system',
});

// --- WAITER LOGIN ---
app.post('/api/login', async (req, res) => {
  const { pin } = req.body;
  try {
    const result = await db.query('SELECT id, name FROM waiters WHERE pin = $1', [pin]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid PIN' });
    }
    res.json({ success: true, waiter: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- SUBMIT / UPDATE ORDER (Saves to DB & Queues Print Jobs) ---
app.post('/api/orders', async (req, res) => {
  const { table_number, guest_count, items, waiter_name } = req.body;

  if (!table_number || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Invalid order data. Table number and items required.' });
  }

  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // 1. Check if an ACTIVE order already exists for this table
    let orderRes = await client.query(
      "SELECT id FROM orders WHERE table_number = $1 AND status IN ('ACTIVE', 'PENDING')",
      [table_number]
    );

    let orderId;
    let createdAt;

    if (orderRes.rows.length > 0) {
      orderId = orderRes.rows[0].id;
      createdAt = new Date();
    } else {
      // Create new persistent order marked as 'ACTIVE' with waiter_name
      const newOrder = await client.query(
        "INSERT INTO orders (table_number, status, waiter_name, guest_count) VALUES ($1, 'ACTIVE', $2, $3) RETURNING id, created_at",
        [table_number, waiter_name || 'Staff', guest_count || 1]
      );
      orderId = newOrder.rows[0].id;
      createdAt = newOrder.rows[0].created_at;
    }

    // 2. Set Table Status to OCCUPIED
    await client.query(
      "UPDATE tables SET status = 'OCCUPIED' WHERE table_number = $1",
      [table_number]
    );

    // 3. Insert line items & gather target printer info
    const stationGroups = {};

    for (const item of items) {
      await client.query(
        'INSERT INTO order_items (order_id, item_id, item_name, quantity, notes, status) VALUES ($1, $2, $3, $4, $5, $6)',
        [orderId, item.item_id || null, item.item_name, item.quantity, item.notes || '', 'PENDING']
      );

      const printerRes = await client.query(
        `SELECT p.id as printer_id, p.name as printer_name, p.ip_address, p.port 
         FROM menu_items mi
         JOIN categories c ON mi.category_id = c.id
         JOIN printers p ON c.printer_id = p.id
         WHERE mi.id = $1`,
        [item.item_id]
      );

      let printer = printerRes.rows[0];
      const targetIp = printer ? printer.ip_address : '127.0.0.1'; 
      const stationName = printer ? printer.printer_name : 'Default Station';

      if (!stationGroups[targetIp]) {
        stationGroups[targetIp] = {
          printerIp: targetIp,
          printerPort: printer ? printer.port : 9100,
          stationName: stationName,
          items: [],
        };
      }

      stationGroups[targetIp].items.push(item);
    }

    await client.query('COMMIT');

    // 4. Queue print jobs for local thermal printers
    for (const ip in stationGroups) {
      const group = stationGroups[ip];
      await printQueue.add('printJob', {
        printerIp: group.printerIp,
        printerPort: group.printerPort,
        orderData: {
          orderId,
          tableNumber: table_number,
          guestCount: guest_count || 1,
          stationName: group.stationName,
          createdAt,
          items: group.items,
        },
      });
    }

    res.status(201).json({
      message: 'Order created and print jobs queued successfully!',
      orderId,
      stationsNotified: Object.keys(stationGroups).length,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Order processing error:', error);
    res.status(500).json({ error: 'Failed to process order' });
  } finally {
    client.release();
  }
});

// --- FETCH ACTIVE ORDERS ---
app.get('/api/orders/active', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        o.id AS order_id,
        o.table_number,
        COALESCE(o.waiter_name, 'Staff') AS waiter_name,
        COALESCE(o.guest_count, 1) AS guest_count,
        o.created_at,
        COALESCE(SUM(oi.quantity * mi.price), 0) AS total_amount,
        COUNT(DISTINCT oi.id) AS item_count
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      LEFT JOIN menu_items mi ON oi.item_id = mi.id
      WHERE o.status IN ('ACTIVE', 'PENDING')
      GROUP BY o.id, o.table_number, o.waiter_name, o.guest_count, o.created_at
      ORDER BY o.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- CASHIER CHECKOUT & TABLE CLOSE ---
app.post('/api/orders/checkout', async (req, res) => {
  const { order_id, payment_method, total_amount, status } = req.body;
  try {
    const orderRes = await db.query(
      "UPDATE orders SET status = $1, payment_method = $2, total_amount = $3 WHERE id = $4 RETURNING table_number",
      [status || 'CLOSED', payment_method, total_amount, order_id]
    );

    if (orderRes.rows.length > 0) {
      const tableNumber = orderRes.rows[0].table_number;
      await db.query("UPDATE tables SET status = 'AVAILABLE' WHERE table_number = $1", [tableNumber]);
    }

    res.json({ success: true, message: 'Table closed successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- WAITER PERFORMANCE REPORT ---
app.get('/api/reports/waiters', async (req, res) => {
  try {
    const query = `
      SELECT 
        o.waiter_name,
        COUNT(CASE WHEN o.status IN ('ACTIVE', 'PENDING') THEN 1 END) AS active_tables,
        COUNT(CASE WHEN o.status = 'CLOSED' THEN 1 END) AS tables_closed_today,
        COALESCE(SUM(CASE WHEN o.status = 'CLOSED' THEN o.total_amount ELSE 0 END), 0) AS total_sales
      FROM orders o
      WHERE DATE(o.created_at) = CURRENT_DATE
      GROUP BY o.waiter_name;
    `;
    const result = await db.query(query);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- MENU & CATEGORY ROUTES ---
app.get('/api/menu', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        mi.id AS item_id,
        mi.id,
        mi.name AS item_name,
        mi.name,
        mi.price,
        mi.category_id,
        c.name AS category_name,
        p.name AS printer_name
      FROM menu_items mi
      LEFT JOIN categories c ON mi.category_id = c.id
      LEFT JOIN printers p ON c.printer_id = p.id
      ORDER BY mi.id ASC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/menu', async (req, res) => {
  try {
    const itemName = req.body.item_name || req.body.name;
    const price = req.body.price;
    const categoryId = req.body.category_id || req.body.categoryId;

    if (!itemName || !price || !categoryId) {
      return res.status(400).json({ error: 'Missing required fields: item_name, price, or category_id' });
    }

    const query = `
      INSERT INTO menu_items (name, price, category_id)
      VALUES ($1, $2, $3)
      RETURNING *;
    `;

    const values = [itemName, price, categoryId];
    const result = await db.query(query, values);

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create menu item', details: err.message });
  }
});

app.delete('/api/menu/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await db.query('DELETE FROM menu_items WHERE id = $1', [id]);
    res.json({ message: 'Menu item deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete menu item' });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT c.*, p.name as printer_name 
      FROM categories c 
      LEFT JOIN printers p ON c.printer_id = p.id 
      ORDER BY c.name ASC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

app.post('/api/categories', async (req, res) => {
  const { name, printer_id } = req.body;
  try {
    const result = await db.query(
      'INSERT INTO categories (name, printer_id) VALUES ($1, $2) RETURNING *',
      [name, printer_id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create category' });
  }
});

app.delete('/api/categories/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await db.query('DELETE FROM menu_items WHERE category_id = $1', [id]);
    await db.query('DELETE FROM categories WHERE id = $1', [id]);
    res.json({ message: 'Category and associated items deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete category' });
  }
});

// --- PRINTER ROUTES ---
app.get('/api/printers', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM printers ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch printers' });
  }
});

app.post('/api/printers', async (req, res) => {
  const { name, ip_address, port } = req.body;
  try {
    const result = await db.query(
      'INSERT INTO printers (name, ip_address, port) VALUES ($1, $2, $3) RETURNING *',
      [name, ip_address, port || 9100]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create printer' });
  }
});

app.delete('/api/printers/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await db.query('DELETE FROM printers WHERE id = $1', [id]);
    res.json({ message: 'Printer deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete printer' });
  }
});

app.post('/api/printers/test', async (req, res) => {
  const { ip_address, port, name } = req.body;
  try {
    await printQueue.add('printJob', {
      printerIp: ip_address,
      printerPort: port || 9100,
      orderData: {
        orderId: 0,
        tableNumber: 'TEST',
        guestCount: 1,
        stationName: name || 'TEST PRINTER',
        createdAt: new Date(),
        items: [{ item_name: 'Printer Connection Test OK', quantity: 1, notes: 'ESC/POS Verified' }],
      },
    });
    res.json({ message: `Test print job queued for ${name} (${ip_address}:${port || 9100})` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to queue test print job', details: err.message });
  }
});

// --- AJUSTES / CONFIGURATION ROUTES ---
app.get('/api/ajustes', async (req, res) => {
  try {
    const result = await db.query('SELECT clave, valor FROM ajustes');
    const settings = {};
    result.rows.forEach(row => {
      settings[row.clave] = row.valor;
    });
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ajustes', async (req, res) => {
  const settings = req.body;
  try {
    for (const [clave, valor] of Object.entries(settings)) {
      await db.query(
        'INSERT INTO ajustes (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor',
        [clave, String(valor)]
      );
    }
    res.json({ success: true, message: 'Ajustes guardados correctamente' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- TABLE MANAGEMENT ROUTES ---
app.get('/api/tables', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM tables ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch tables' });
  }
});

app.put('/api/tables/:table_number/status', async (req, res) => {
  const { table_number } = req.params;
  const { status } = req.body;
  try {
    await db.query('UPDATE tables SET status = $1 WHERE table_number = $2', [status, table_number]);
    res.json({ message: 'Table status updated successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update table status' });
  }
});

app.get('/api/orders/table/:table_number/items', async (req, res) => {
  const { table_number } = req.params;
  try {
    const result = await db.query(`
      SELECT 
        oi.id,
        oi.item_id,
        oi.item_name,
        oi.quantity,
        oi.notes,
        COALESCE(mi.price, 0) AS price
      FROM orders o
      JOIN order_items oi ON o.id = oi.order_id
      LEFT JOIN menu_items mi ON oi.item_id = mi.id
      WHERE LOWER(o.table_number) = LOWER($1) AND o.status IN ('ACTIVE', 'PENDING')
      ORDER BY oi.id ASC
    `, [table_number]);

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- KDS STATION-FILTERED ORDERS ENDPOINT ---
app.get('/api/kds/orders', async (req, res) => {
  const { station } = req.query;

  try {
    let query = `
      SELECT 
        o.id AS order_id,
        o.table_number,
        COALESCE(o.waiter_name, 'Staff') AS waiter_name,
        o.created_at,
        oi.id AS item_id,
        oi.item_name,
        oi.quantity,
        oi.notes,
        COALESCE(c.name, 'General') AS category_name,
        COALESCE(p.name, 'Unassigned') AS station_name
      FROM orders o
      JOIN order_items oi ON o.id = oi.order_id
      LEFT JOIN menu_items mi ON oi.item_id = mi.id
      LEFT JOIN categories c ON mi.category_id = c.id
      LEFT JOIN printers p ON c.printer_id = p.id
      WHERE o.status IN ('ACTIVE', 'PENDING')
        AND oi.status = 'PENDING'
    `;

    const params = [];

    if (station && station.trim() !== '' && station.trim() !== 'All Stations') {
      params.push(`%${station.trim()}%`);
      query += ` AND LOWER(p.name) LIKE LOWER($${params.length})`;
    }

    query += ` ORDER BY o.created_at ASC, oi.id ASC`;

    const result = await db.query(query, params);

    const ordersMap = {};
    result.rows.forEach(row => {
      if (!ordersMap[row.order_id]) {
        ordersMap[row.order_id] = {
          order_id: row.order_id,
          table_number: row.table_number,
          waiter_name: row.waiter_name,
          created_at: row.created_at,
          items: [],
        };
      }
      ordersMap[row.order_id].items.push({
        item_id: row.item_id,
        item_name: row.item_name,
        quantity: row.quantity,
        notes: row.notes,
        category: row.category_name,
        station: row.station_name,
      });
    });

    res.json(Object.values(ordersMap));
  } catch (err) {
    console.error('Error fetching KDS orders:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- KDS MARK ALL ITEMS IN TICKET AS READY ---
app.put('/api/kds/orders/:id/complete-items', async (req, res) => {
  const { id } = req.params;

  try {
    await db.query(
      "UPDATE order_items SET status = 'READY' WHERE order_id = $1",
      [id]
    );
    res.json({ success: true, message: `All items for Order #${id} marked as READY` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- START SERVER ---
const PORT = 3000;
const HOST = '0.0.0.0'; // Binds to all network interfaces

app.listen(PORT, HOST, () => {
  console.log(`🚀 POS Backend Server running on http://${HOST}:${PORT}`);
});