import IoTDevice from './IoTDevice.js';

const aaa = new IoTDevice('aaa');
const bbb = new IoTDevice('bbb');

await aaa.connect();
await bbb.connect();

aaa.proc('test', async (msg) => {
    console.log('[aaa] 收到回覆:', msg.payload.payload);
    await aaa.disconnect();
    await bbb.disconnect();
});

bbb.proc('test', async (msg) => {
    msg.payload = { rtn: 'OKOK' };
    bbb.pub('aaa.test', msg);
});

aaa.pub('bbb.test', { hello: 'world' });