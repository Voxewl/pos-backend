const { Queue, Worker } = require('bullmq');
const { buildReceiptBuffer, sendToPrinter } = require('./printer');

const connection = {
  host: '127.0.0.1',
  port: 6379,
};

// Create a unified queue for print jobs
const printQueue = new Queue('printQueue', { connection });

// Process jobs sequentially
const printWorker = new Worker(
  'printQueue',
  async (job) => {
    const { printerIp, printerPort, orderData } = job.data;
    console.log(`[QUEUE] Processing print job for Table ${orderData.tableNumber} -> Station: ${orderData.stationName} (${printerIp})`);

    const buffer = buildReceiptBuffer(orderData);
    await sendToPrinter(printerIp, printerPort || 9100, buffer);
    console.log(`[QUEUE] Successfully printed ticket on ${printerIp}`);
  },
  { connection, concurrency: 5 } // Can handle up to 5 parallel workers for different printers
);

printWorker.on('failed', (job, err) => {
  console.error(`[QUEUE ERROR] Job ${job.id} failed for IP ${job.data.printerIp}:`, err.message);
});

module.exports = { printQueue };