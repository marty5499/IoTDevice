### 1. 目的

針對 Node.js 環境中，以 MQTT 為通訊協定，設計一套可複用的 IoT 類別（`IoTDevice`）。其物件能夠：

* 自動從 `.env` 讀取 MQTT Broker 連線參數。
* 以唯一識別碼 `deviceId` 連線並訂閱 `{deviceId}/+` 主題。
* 支援非同步發布（`pub`）與同步請求回覆模式（`pubSync`）。
* 提供多重訂閱處理器註冊（`proc`）介面，依不同子主題 action 執行不同邏輯。
* 統一錯誤與逾時管理。

---

### 2. 系統概述

* **Broker**：透過 `.env` 設定的 MQTT 伺服器。
* **Device**：每個 `IoTDevice` 實例代表一個網路終端。
* **通訊架構**：混合 Request–Reply 與 Publish–Subscribe。

```
+---------+           MQTT Broker          +---------+
| DeviceA | <----------------------------> | DeviceB |
+---------+                                +---------+
```

---

### 3. 架構圖

```
┌────────────────────────────────────────────────┐
│                    IoTDevice                   │
│                                                │
│  • properties:                                 │
│      – client      : mqtt.Client               │
│      – deviceId    : string                    │
│      – pendingReqs : Map<requestId, Context>   │
│      – handlers    : Map<action, handler>      │
│                                                │
│  • methods:                                    │
│      – constructor(deviceId: string)           │
│      – connect()                               │
│      – disconnect()                            │
│      – pub(topic: string, payload?): void      │
│      – pubSync(topic: string, payload?, timeout?): Promise<any> │
│      – proc(action: string, handler): Promise<void> │
│      – handleMessage(topic: string, message: Buffer): void │
└────────────────────────────────────────────────┘
```

---

### 4. 類別設計

| 成員          | 型別                                     | 說明                            |                     |
| ----------- | -------------------------------------- | ----------------------------- | ------------------- |
| client      | mqtt.Client                            | MQTT 客戶端實例                    |                     |
| deviceId    | string                                 | 設備唯一識別碼                       |                     |
| pendingReqs | Map\<string, {resolve, reject, timer}> | 同步請求上下文（含 callback 與逾時 timer） |                     |
| handlers    | Map\<string, (msg: any) ⇒ any          | Promise<any>>                 | 子主題 action 對應的處理器函式 |

**建構子**：

```js
new IoTDevice(deviceId: string)
```

* 從 `.env` 讀取 `BROKER_URL`，建立並連線。
* 自動訂閱：`{deviceId}/+`，監聽所有子主題。

---

### 5. MQTT 通訊協定

* **Request Topic**：`{targetDeviceId}/{action}`
* **Reply Topic**：`{requesterDeviceId}/reply/{requestId}`

**訊息格式**（JSON）：

```json
{
  "requestId": "uuid-v4",
  "from": "deviceId",
  "payload": { ... }
}
```

---

### 6. 同步 vs 非同步流程

1. **非同步 (`pub`)**

   * 參數 `topic`: 可包含 target 與 action，如 `"b.proc1"` 表示發送至 `b/proc1`。
   * 產生 `requestId`。
   * 組裝訊息後發佈至對應 MQTT 主題。
   * 不等待回覆。

2. **同步 (`pubSync`)**

   * 參數 `topic`: 如 `"b.test"`。
   * 產生 `requestId`，並於 `pendingReqs` 註冊 `resolve`/`reject`。
   * 發佈至 `{target}/{action}`。
   * 在 `timeout` 內，收到對應 `{deviceId}/reply/{requestId}` 時，`resolve(payload)`；逾時則 `reject`。

---

### 7. 錯誤與逾時處理

* 使用 `setTimeout` 控制同步請求逾時。
* `handleMessage`：

  1. 若 `topic` 為 `{deviceId}/reply/{requestId}`，觸發對應 `pendingReqs`。
  2. 若 `topic` 為 `{deviceId}/{action}`，則調用 `handlers.get(action)`；若無對應 handler，記錄警告。

---

### 8. 使用範例

```js
const a = new IoTDevice('a');
await a.connect();
const b = new IoTDevice('b');
await b.connect();

// b 註冊多種 proc 處理器\await b.proc('proc1', async (msg) => {
  // 處理 b/proc1 接收的 msg.payload...
  return 'process by proc1';
});

await b.proc('test', (msg) => {
  // 處理 b/test 接收的 msg.payload...
  return 'process by test';
});

// a 同步請求不同 action
const rtn1 = await a.pubSync('b.proc1', { msg: 'Hello' });
console.log(rtn1); // 'process by proc1'

const rtn2 = await a.pubSync('b.test', 'Hello');
console.log(rtn2); // 'process by test'
```
