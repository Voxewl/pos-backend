const net = require('net');
const ReceiptPrinterEncoder = require('@point-of-sale/receipt-printer-encoder');

/**
 * Encodes text into thermal receipt format (ESC/POS)
 */
function buildReceiptBuffer(orderData) {
  const encoder = new ReceiptPrinterEncoder();

  let builder = encoder
    .initialize()
    .align('center')
    .size('double-height', 'double-width')
    .text(`STATION: ${orderData.stationName.toUpperCase()}\n`)
    .size('normal', 'normal')
    .text(`Table: ${orderData.tableNumber} | Order #${orderData.orderId}\n`)
    .text(`Time: ${new Date(orderData.createdAt).toLocaleTimeString()}\n`)
    .line('-'.repeat(32))
    .align('left');

  // Add line items
  orderData.items.forEach((item) => {
    builder
      .size('bold', 'bold')
      .text(`${item.quantity}x ${item.item_name}\n`)
      .size('normal', 'normal');

    if (item.notes) {
      builder.text(`   * NOTE: ${item.notes}\n`);
    }
  });

  // Line cut & print command
  return builder
    .line('-'.repeat(32))
    .newline()
    .cut('full')
    .encode();
}

/**
 * Connects directly to thermal printer IP via TCP port 9100 and sends binary buffer
 */
function sendToPrinter(ipAddress, port = 9100, buffer) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();

    // 5-second timeout for printer response
    client.setTimeout(5000);

    client.connect(port, ipAddress, () => {
      client.write(Buffer.from(buffer), () => {
        client.end();
        resolve(true);
      });
    });

    client.on('error', (err) => {
      client.destroy();
      reject(new Error(`Failed to connect to printer at ${ipAddress}:${port} - ${err.message}`));
    });

    client.on('timeout', () => {
      client.destroy();
      reject(new Error(`Printer connection timed out at ${ipAddress}:${port}`));
    });
  });
}

module.exports = { buildReceiptBuffer, sendToPrinter };