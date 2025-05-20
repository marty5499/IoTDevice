import IoTDevice from './IoTDevice.js';

const aaa = new IoTDevice('aaa');
const bbb = new IoTDevice('bbb');

await aaa.connect();
await bbb.connect();

bbb.proc('test', async (msg) => {
    console.log('[bbb] 收到請求:', msg);
    return { state: 'OK', echo: msg.payload };
});
var rtn = await aaa.pubSync('bbb.test', { hello: 'world' });
console.log('[aaa] 收到回覆:', rtn);