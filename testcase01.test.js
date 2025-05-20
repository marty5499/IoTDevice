import IoTDevice from './IoTDevice.js';

// Jest tests for IoTDevice
describe('IoTDevice Communication Tests', () => {
  let a;
  let b;
  const TIMEOUT_MS = 5000; // General timeout for async operations in tests
  const SHORT_TIMEOUT_MS = 100;

  beforeAll(async () => {
    a = new IoTDevice('a');
    b = new IoTDevice('b');
    console.log('[TEST SETUP] Connecting devices a and b...');
    await Promise.all([a.connect(), b.connect()]);
    console.log('[TEST SETUP] Devices connected.');

    console.log('[TEST SETUP] Registering handlers on device b...');
    await b.proc('proc1', async (msg) => {
      console.log('  [b/proc1] Test handler received request:', msg.payload);
      await new Promise(r => setTimeout(r, 50)); // Simulate async work
      return { status: 'processed by b/proc1', originalPayload: msg.payload };
    });
    await b.proc('testAction', (msg) => {
      console.log('  [b/testAction] Test handler received request:', msg.payload);
      return { status: 'processed by b/testAction', originalPayload: msg.payload };
    });
    console.log('[TEST SETUP] Handlers registered on device b.');
  }, TIMEOUT_MS + 2000); // Give more time for beforeAll

  afterAll(async () => {
    console.log('[TEST TEARDOWN] Disconnecting devices...');
    await Promise.all([a.disconnect(), b.disconnect()]);
    console.log('[TEST TEARDOWN] Devices disconnected.');
  }, TIMEOUT_MS);

  test('Device a should send a sync request to b.proc1 and receive a successful reply', async () => {
    const payload = { message: 'Sync request to proc1' };
    console.log(`  [a] Sending to b.proc1: ${JSON.stringify(payload)}`);
    const reply = await a.pubSync('b.proc1', payload, TIMEOUT_MS);
    console.log('  [a] Received reply from b.proc1:', reply);
    expect(reply).toBeDefined();
    expect(reply.status).toBe('processed by b/proc1');
    expect(reply.originalPayload).toEqual(payload);
  }, TIMEOUT_MS);

  test('Device a should send a sync request to b.testAction and receive a successful reply', async () => {
    const payload = { data: 'Sync request to testAction' };
    console.log(`  [a] Sending to b.testAction: ${JSON.stringify(payload)}`);
    const reply = await a.pubSync('b.testAction', payload, TIMEOUT_MS);
    console.log('  [a] Received reply from b.testAction:', reply);
    expect(reply).toBeDefined();
    expect(reply.status).toBe('processed by b/testAction');
    expect(reply.originalPayload).toEqual(payload);
  }, TIMEOUT_MS);

  test('Device a should receive an error reply when sending a sync request to a non-existent action on b', async () => {
    const payload = { data: 'Request to nonExistentAction' };
    console.log(`  [a] Sending to b.nonExistentAction: ${JSON.stringify(payload)}`);
    await expect(a.pubSync('b.nonExistentAction', payload, TIMEOUT_MS))
      .rejects
      .toThrow('No handler for action: nonExistentAction');
    console.log('  [a] Correctly received rejection for nonExistentAction.');
  }, TIMEOUT_MS);

  test('Device a pubSync should timeout if b takes too long to respond', async () => {
    const slowAction = 'proc1_slow_for_timeout_test';
    await b.proc(slowAction, async (msg) => {
      console.log(`  [b/${slowAction}] Test handler received, will delay...`, msg.payload);
      await new Promise(r => setTimeout(r, SHORT_TIMEOUT_MS + 100)); // Delay longer than pubSync timeout
      return { status: `processed by ${slowAction}` };
    });
    const payload = { message: 'Testing pubSync timeout' };
    console.log(`  [a] Sending to b.${slowAction} with ${SHORT_TIMEOUT_MS}ms timeout: ${JSON.stringify(payload)}`);
    await expect(a.pubSync('b.' + slowAction, payload, SHORT_TIMEOUT_MS))
      .rejects
      .toThrow('Request timeout');
    console.log('  [a] Correctly received timeout error.');
     b.handlers.delete(slowAction); // Clean up the slow handler
  }, TIMEOUT_MS);

  test('Device a should send an async message (pub) to b.proc1 and b should process it', async () => {
    const payload = { info: 'Async message to proc1' };
    let asyncMessageProcessed = false;
    let timeoutId; // Store timeout ID

    const ackPromise = new Promise(resolve => {
      b.proc('proc1_async_ack', async (msg) => {
        console.log('  [b/proc1_async_ack] Test handler received async message:', msg.payload);
        if (msg.payload && msg.payload.info === payload.info) {
          asyncMessageProcessed = true;
        }
        resolve(); // Resolve the promise when message is processed
        return { status: 'async processed' };
      });
    });

    console.log(`  [a] Sending async message to b.proc1_async_ack: ${JSON.stringify(payload)}`);
    a.pub('b.proc1_async_ack', payload);

    try {
      await Promise.race([
          ackPromise,
          new Promise((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error('Timeout waiting for async message processing')), TIMEOUT_MS);
          })
      ]);
    } finally {
      clearTimeout(timeoutId); // Clear the timeout
    }
    
    expect(asyncMessageProcessed).toBe(true);
    console.log('  [b] Confirmed async message was processed.');
    b.handlers.delete('proc1_async_ack'); // Clean up test handler
  }, TIMEOUT_MS + 500);
}); 