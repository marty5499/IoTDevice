require('dotenv').config();
const mqtt = require('mqtt');
const { v4: uuidv4 } = require('uuid');

class IoTDevice {
  /**
   * @param {string} deviceId
   */
  constructor(deviceId) {
    this.deviceId = deviceId;
    this.pendingReqs = new Map();
    this.handlers = new Map();
    // 讀取 .env
    this.brokerUrl = process.env['mqtt-server'] || process.env['BROKER_URL'];
    this.username = process.env['mqtt-username'] || process.env['BROKER_USERNAME'];
    this.password = process.env['mqtt-password'] || process.env['BROKER_PASSWORD'];
    this.client = null;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.client = mqtt.connect(this.brokerUrl, {
        username: this.username,
        password: this.password,
        clientId: this.deviceId,
        reconnectPeriod: 1000,
      });
      this.client.on('connect', () => {
        // 訂閱 {deviceId}/+ 和 {deviceId}/reply/+
        this.client.subscribe(`${this.deviceId}/+`, (err) => {
          if (err) return reject(err);
          this.client.subscribe(`${this.deviceId}/reply/+`, (err2) => {
            if (err2) return reject(err2);
            this.client.on('message', (topic, message) => this.handleMessage(topic, message));
            resolve();
          });
        });
      });
      this.client.on('error', (err) => {
        reject(err);
      });
    });
  }

  async disconnect() {
    if (this.client && this.client.connected) {
      console.log(`[${this.deviceId}] Disconnecting MQTT client (was connected)...`);
      await new Promise((resolve, reject) => {
        this.client.end(true, (err) => { // Force close
          if (err) {
            console.error(`[${this.deviceId}] Error during MQTT client disconnection:`, err);
            // Do not reject here if the goal is just to ensure it ends,
            // as errors on end() might not be critical for test teardown.
            // However, logging is good.
          }
          console.log(`[${this.deviceId}] MQTT client .end() callback executed.`);
          resolve(); // Resolve regardless of error to allow teardown to continue
        });
      });
      this.client = null; 
      console.log(`[${this.deviceId}] MQTT client instance nulled after disconnection.`);
    } else if (this.client) {
      console.log(`[${this.deviceId}] MQTT client existed but was not connected, attempting to end.`);
      await new Promise((resolve) => {
        this.client.end(true, () => {
            console.log(`[${this.deviceId}] MQTT client (not connected) .end() callback executed.`);
            resolve();
        });
      });
      this.client = null;
      console.log(`[${this.deviceId}] MQTT client instance (not connected) nulled.`);
    } else {
      console.log(`[${this.deviceId}] No MQTT client instance to disconnect.`);
    }
  }

  /**
   * 非同步發送
   * @param {string} topic - e.g., "targetDeviceId.action"
   * @param {any} payload
   */
  pub(topic, payload = {}) {
    const [targetId, action] = topic.split('.');
    if (!targetId || !action) {
      console.error('Invalid topic format for pub. Expected "targetDeviceId.action"');
      return;
    }
    const requestId = uuidv4();
    const msg = {
      requestId,
      from: this.deviceId,
      payload,
    };
    this.client.publish(`${targetId}/${action}`, JSON.stringify(msg));
  }

  /**
   * 同步發送，等待回覆
   * @param {string} topic - e.g., "targetDeviceId.action"
   * @param {any} payload
   * @param {number} timeout
   * @returns {Promise<any>}
   */
  pubSync(topic, payload = {}, timeout = 5000) {
    const [targetId, action] = topic.split('.');
    if (!targetId || !action) {
      return Promise.reject(new Error('Invalid topic format for pubSync. Expected "targetDeviceId.action"'));
    }
    const requestId = uuidv4();
    const msg = {
      requestId,
      from: this.deviceId,
      payload,
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingReqs.delete(requestId);
        reject(new Error('Request timeout'));
      }, timeout);
      this.pendingReqs.set(requestId, { resolve, reject, timer });
      this.client.publish(`${targetId}/${action}`, JSON.stringify(msg));
    });
  }

  /**
   * 註冊處理器 for a specific action
   * @param {string} action
   * @param {(msg: any) => any|Promise<any>} handler
   */
  proc(action, handler) {
    if (typeof action !== 'string' || !action) {
        console.error('Action must be a non-empty string');
        return;
    }
    if (typeof handler !== 'function') {
        console.error('Handler must be a function');
        return;
    }
    this.handlers.set(action, handler);
  }

  /**
   * 處理所有訊息
   * @param {string} topicString
   * @param {Buffer} message
   */
  async handleMessage(topicString, message) {
    try {
      const topicParts = topicString.split('/');
      const receivedDeviceId = topicParts[0];

      if (receivedDeviceId !== this.deviceId) {
        // Not for this device, though theoretically shouldn't happen with current subscriptions
        return;
      }

      const jsonMsg = JSON.parse(message.toString());

      if (topicParts[1] === 'reply' && topicParts[2]) {
        // 處理回覆 for pubSync
        const requestId = topicParts[2]; // requestId is part of the topic
        const ctx = this.pendingReqs.get(jsonMsg.requestId); // Ensure we use requestId from message body for map lookup
        if (ctx) {
          clearTimeout(ctx.timer);
          if (jsonMsg.payload && jsonMsg.payload.error) {
            ctx.reject(new Error(jsonMsg.payload.error));
          } else {
            ctx.resolve(jsonMsg.payload);
          }
          this.pendingReqs.delete(jsonMsg.requestId);
        }
      } else if (topicParts.length === 2 && topicParts[1] !== 'reply') {
        // 處理請求 for proc, topic is {deviceId}/{action}
        const action = topicParts[1];
        const handler = this.handlers.get(action);

        if (!jsonMsg.requestId || !jsonMsg.from) throw new Error('Invalid request format');

        if (handler) {
          let replyPayload;
          try {
            replyPayload = await handler(jsonMsg); // Pass the full message object
          } catch (err) {
            replyPayload = { error: err.message || 'Handler execution error' };
          }
          // 回覆
          const replyMsg = {
            requestId: jsonMsg.requestId,
            from: this.deviceId,
            payload: replyPayload,
          };
          if (this.client && this.client.connected) {
            this.client.publish(`${jsonMsg.from}/reply/${jsonMsg.requestId}`, JSON.stringify(replyMsg));
          } else {
            console.warn(`[${this.deviceId}] Client not available/connected. Cannot send reply for ${jsonMsg.requestId} to ${jsonMsg.from}.`);
          }
        } else {
          console.warn(`[${this.deviceId}] No handler for action: ${action} on topic ${topicString}`);
          // Optionally, send a default error reply if no handler is found
          const replyMsg = {
            requestId: jsonMsg.requestId,
            from: this.deviceId,
            payload: { error: `No handler for action: ${action}` },
          };
          if (this.client && this.client.connected) {
            this.client.publish(`${jsonMsg.from}/reply/${jsonMsg.requestId}`, JSON.stringify(replyMsg));
          } else {
            console.warn(`[${this.deviceId}] Client not available/connected. Cannot send error reply for ${jsonMsg.requestId} to ${jsonMsg.from}.`);
          }
        }
      } else {
        // 未知主題或不符合預期格式
        console.warn(`[${this.deviceId}] Received message on unhandled topic: ${topicString}`);
      }
    } catch (err) {
      console.error(`[${this.deviceId}] Error handling message on topic ${topicString}:`, err);
    }
  }
}

module.exports = IoTDevice;
