import {v4} from 'https://jspm.dev/uuid';
const uuidv4 = v4;
class IoTDevice {
  /**
   * @param {string} logicalDeviceId - The logical ID for the device, used for topic subscriptions.
   *   - brokerUrl: wss://your-broker:port
   *   - username?: string
   *   - password?: string
   */
  constructor(logicalDeviceId) {
    this.deviceId = logicalDeviceId; // This is the logical ID
    this.mqttClientId = `client-${uuidv4().substring(0, 8)}`; // Unique ID for MQTT connection
    this.brokerUrl = 'wss://mqtt-edu.webduino.io/mqtt';
    this.username = 'hsh2025';
    this.password = 'hsh2025';
    this.client = null;
    this.pendingReqs = new Map();
    this.handlers = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.client = mqtt.connect(this.brokerUrl, {
        clientId: this.mqttClientId, // Use unique mqttClientId for connection
        username: this.username,
        password: this.password,
        reconnectPeriod: 1000,
      });

      this.client.on('connect', () => {
        const subscribeOptions = { qos: 0 };
        // Subscribe using the logical deviceId for application topics
        this.client.subscribe(`${this.deviceId}/+`, subscribeOptions, err => {
          if (err) return reject(err);
          this.client.subscribe(`${this.deviceId}/reply/+`, subscribeOptions, err2 => {
            if (err2) return reject(err2);
            this.client.on('message', (t, m) => this.handleMessage(t, m));
            console.log(`[${this.deviceId} / ${this.mqttClientId}] Connected and subscribed to ${this.deviceId}/+ and ${this.deviceId}/reply/+`);
            resolve();
          });
        });
      });

      this.client.on('error', err => {
        console.error(`[${this.deviceId} / ${this.mqttClientId}] Connection error:`, err);
        reject(err);
      });
    });
  }

  disconnect() {
    if (!this.client) {
      console.log(`[${this.deviceId} / ${this.mqttClientId}] No client to disconnect.`);
      return Promise.resolve();
    }
    return new Promise(res => {
      this.client.end(true, () => {
        console.log(`[${this.deviceId} / ${this.mqttClientId}] Disconnected.`);
        this.client = null;
        res();
      });
    });
  }

  subscribe(topic, qos = 0) {
    return new Promise((resolve, reject) => {
      if (!this.client || !this.client.connected) {
        return reject(new Error(`[${this.deviceId} / ${this.mqttClientId}] Client not connected`));
      }
      
      const subscribeOptions = { qos };
      this.client.subscribe(topic, subscribeOptions, err => {
        if (err) return reject(err);
        console.log(`[${this.deviceId} / ${this.mqttClientId}] Successfully subscribed to topic: ${topic}`);
        resolve();
      });
    });
  }

  pub(topic, payload = {}, qos = 0) {
    const [targetId, action] = topic.split('.');
    if (!targetId || !action) {
      console.error(`[${this.deviceId} / ${this.mqttClientId}] Invalid topic format for pub. Use "targetDeviceId.action"`);
      return;
    }
    const requestId = uuidv4();
    const msg = {
      requestId,
      from: this.deviceId, // 'from' should be the logical deviceId
      payload
    };
    const publishOptions = { qos };
    this.client.publish(`${targetId}/${action}`, JSON.stringify(msg), publishOptions);
    // console.log(`[${this.deviceId} / ${this.mqttClientId}] PUB: ${targetId}/${action}`, msg);
  }

  pubSync(topic, payload = {}, timeout = 5000, qos = 0) {
    const [targetId, action] = topic.split('.');
    if (!targetId || !action) {
      return Promise.reject(new Error(`[${this.deviceId} / ${this.mqttClientId}] Invalid topic format for pubSync. Use "targetDeviceId.action"`));
    }
    const requestId = uuidv4();
    const msg = {
      requestId,
      from: this.deviceId, // 'from' should be the logical deviceId
      payload
    };
    const publishOptions = { qos };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingReqs.delete(requestId);
        reject(new Error(`[${this.deviceId} / ${this.mqttClientId}] Request timeout for ${requestId}`));
      }, timeout);
      this.pendingReqs.set(requestId, {
        resolve,
        reject,
        timer
      });
      this.client.publish(`${targetId}/${action}`, JSON.stringify(msg), publishOptions);
    });
  }

  proc(action, handler) {
    if (typeof action !== 'string' || !action) {
      console.error(`[${this.deviceId} / ${this.mqttClientId}] Action must be a non-empty string`);
      return;
    }
    if (typeof handler !== 'function') {
      console.error(`[${this.deviceId} / ${this.mqttClientId}] Handler must be a function`);
      return;
    }
    this.handlers.set(action, handler);
    // console.log(`[${this.deviceId} / ${this.mqttClientId}] PROC registered for action: ${action}`);
  }

  async handleMessage(topicString, message) {
    // console.log(`[${this.deviceId} / ${this.mqttClientId}] MSG received on topic: ${topicString}`, message.toString());
    try {
      const parts = topicString.split('/');
      // Messages are filtered by the MQTT broker based on subscriptions.
      // This check ensures we're processing for the correct logical deviceId.
      if (parts[0] !== this.deviceId) {
        // This case should ideally not happen if subscriptions are set up correctly
        // (i.e., client only subscribed to topics starting with its logical deviceId).
        // However, if other subscriptions were manually added, this might be relevant.
        // console.warn(`[${this.deviceId} / ${this.mqttClientId}] Message on topic ${topicString} not for this logical device. Ignoring.`);
        return;
      }

      var jsonMsg = JSON.parse(message.toString());

      // Reply message for pubSync
      if (parts[1] === 'reply' && parts[2]) { // topic: {logicalDeviceId}/reply/{requestId}
        const ctx = this.pendingReqs.get(jsonMsg.requestId); // requestId from message body
        if (ctx) {
          clearTimeout(ctx.timer);
          if (jsonMsg.payload?.error) {
            ctx.reject(new Error(jsonMsg.payload.error));
          } else {
            ctx.resolve(jsonMsg.payload);
          }
          this.pendingReqs.delete(jsonMsg.requestId);
        }
        return;
      }

      // Request message for proc
      // topic: {logicalDeviceId}/{action}
      const action = parts[1];
      const handler = this.handlers.get(action);
      
      if (!jsonMsg.requestId || !jsonMsg.from) {
         // If it's a simple pub without full IoTDevice message structure, wrap it.
         // This might happen if a non-IoTDevice client publishes to this topic.
        jsonMsg = {
          payload: jsonMsg, // The original message becomes the payload
          requestId: 'unknown-' + uuidv4().substring(0,8),
          from: 'unknown-sender'
        };
      }

      let replyPayload;
      if (handler) {
        try {
          replyPayload = await handler(jsonMsg); // Pass the full message
        } catch (err) {
          replyPayload = {
            error: err.message || 'Handler execution error'
          };
        }
      } else {
        // console.warn(`[${this.deviceId} / ${this.mqttClientId}] No handler for action: ${action} on topic ${topicString}`);
        replyPayload = {
          error: `No handler for action: ${action}`
        };
      }

      // Send reply for proc
      // Reply topic: {originalSenderLogicalId}/reply/{originalRequestId}
      const replyMsg = {
        requestId: jsonMsg.requestId,
        from: this.deviceId, // This is our logicalId
        payload: replyPayload
      };
      if (this.client && this.client.connected && jsonMsg.from !== 'unknown-sender') {
        this.client.publish(`${jsonMsg.from}/reply/${jsonMsg.requestId}`, JSON.stringify(replyMsg));
      }
    } catch (err) {
      console.error(`[${this.deviceId} / ${this.mqttClientId}] Error handling message on topic ${topicString}:`, err, message.toString());
    }
  }
}

window.IoTDevice = IoTDevice;