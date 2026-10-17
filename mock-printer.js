const net = require('net');

function createMockPrinter(name, port) {
  const server = net.createServer((socket) => {
    console.log(`\n========================================`);
    console.log(`🖨️  [MOCK PRINTER: ${name}] Incoming connection from ${socket.remoteAddress}`);
    console.log(`========================================`);

    socket.on('data', (data) => {
      // Clean up ESC/POS control codes for clear terminal display
      const readableText = data
        .toString('utf8')
        .replace(/[\x00-\x1F\x7F-\x9F]/g, '') // Strip non-printable ESC/POS control bytes
        .trim();

      console.log(readableText);
    });

    socket.on('end', () => {
      console.log(`----------------------------------------`);
      console.log(`✅ [MOCK PRINTER: ${name}] Job finished & connection closed.\n`);
    });

    socket.on('error', (err) => {
      console.error(`❌ [MOCK PRINTER: ${name}] Error:`, err.message);
    });
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`🚀 Mock ${name} listening on 127.0.0.1:${port}`);
  });
}

// Start two simulated station printers on unused ports
createMockPrinter('Bar Printer', 9200);
createMockPrinter('Kitchen Printer', 9201);