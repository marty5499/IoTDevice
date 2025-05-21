import {v4} from 'https://jspm.dev/uuid';
const uuidv4 = v4;
class IoTDevice {
  /**
   * @param {string} deviceId
   *   - brokerUrl: wss://your-broker:port
   *   - username?: string
   *   - password?: string
   */
  constructor(deviceId) {
    this.deviceId = deviceId;
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
        clientId: this.deviceId,
        username: this.username,
        password: this.password,
        reconnectPeriod: 1000,
      });

      this.client.on('connect', () => {
        const subscribeOptions = { qos: 0 };
        this.client.subscribe(`${this.deviceId}/+`, subscribeOptions, err => {
          if (err) return reject(err);
          this.client.subscribe(`${this.deviceId}/reply/+`, subscribeOptions, err2 => {
            if (err2) return reject(err2);
            this.client.on('message', (t, m) => this.handleMessage(t, m));
            resolve();
          });
        });
      });

      this.client.on('error', err => reject(err));
    });
  }

  disconnect() {
    if (!this.client) {
      console.log(`[${this.deviceId}] No client to disconnect.`);
      return Promise.resolve();
    }
    return new Promise(res => {
      this.client.end(true, () => {
        console.log(`[${this.deviceId}] Disconnected.`);
        this.client = null;
        res();
      });
    });
  }

  pub(topic, payload = {}, qos = 0) {
    const [targetId, action] = topic.split('.');
    if (!targetId || !action) {
      console.error('Invalid topic format. Use "targetDeviceId.action"');
      return;
    }
    const requestId = uuidv4();
    const msg = {
      requestId,
      from: this.deviceId,
      payload
    };
    const publishOptions = { qos };
    this.client.publish(`${targetId}/${action}`, JSON.stringify(msg), publishOptions);
  }

  pubSync(topic, payload = {}, timeout = 5000, qos = 0) {
    const [targetId, action] = topic.split('.');
    if (!targetId || !action) {
      return Promise.reject(new Error('Invalid topic format. Use "targetDeviceId.action"'));
    }
    const requestId = uuidv4();
    const msg = {
      requestId,
      from: this.deviceId,
      payload
    };
    const publishOptions = { qos };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingReqs.delete(requestId);
        reject(new Error('Request timeout'));
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
      console.error('Action 必須是非空字串');
      return;
    }
    if (typeof handler !== 'function') {
      console.error('Handler 必須是函式');
      return;
    }
    this.handlers.set(action, handler);
  }

  async handleMessage(topicString, message) {
    try {
      const parts = topicString.split('/');
      if (parts[0] !== this.deviceId) return;
      var jsonMsg = JSON.parse(message.toString());

      // 回覆訊息
      if (parts[1] === 'reply' && parts[2]) {
        const ctx = this.pendingReqs.get(jsonMsg.requestId);
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

      // 處理請求
      const action = parts[1];
      const handler = this.handlers.get(action);
      if (!jsonMsg.requestId || !jsonMsg.from) {
        jsonMsg = {
          payload: jsonMsg,
          requestId: 'unknown',
          from: 'unknown'
        }
      }
      let replyPayload;
      if (handler) {
        try {
          replyPayload = await handler(jsonMsg);
        } catch (err) {
          replyPayload = {
            error: err.message
          };
        }
      } else {
        replyPayload = {
          error: `No handler for action: ${action}`
        };
      }

      const replyMsg = {
        requestId: jsonMsg.requestId,
        from: this.deviceId,
        payload: replyPayload
      };
      this.client.publish(`${jsonMsg.from}/reply/${jsonMsg.requestId}`, JSON.stringify(replyMsg));
    } catch (err) {
      console.error(`[${this.deviceId}] 處理訊息時發生錯誤:`, err);
    }
  }
}

window.IoTDevice = IoTDevice;