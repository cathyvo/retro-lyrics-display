// v2 Step 4: send one test message from the PC to the Uno over USB.
// Run with:  npm run serial-test
// Close the Arduino Serial Monitor first (only one program can use COM3 at a time).

import { SerialPort } from 'serialport';

const PORT_PATH = 'COM3'; // your Uno's port (bottom-right of the Arduino IDE)

const port = new SerialPort({ path: PORT_PATH, baudRate: 9600 });

port.on('open', () => {
  console.log(`Connected to the Uno on ${PORT_PATH}`);

  // Opening the port restarts the Uno, so give it 2 seconds to boot.
  setTimeout(() => {
    // Format: "top row|bottom row" + a new line at the end
    port.write('hello|from JavaScript\n', (err) => {
      if (err) return console.error('Write failed:', err.message);
      console.log('Sent!');
      port.drain(() => port.close()); // wait until it's fully sent, then let go of COM3
    });
  }, 2000);
});

port.on('error', (err) => {
  console.error('Serial error:', err.message);
  if (err.message.includes('Access denied')) {
    console.error('-> Close the Arduino Serial Monitor (or any program using the port) and try again.');
  }
});
