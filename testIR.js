const { Gpio } = require('pigpio');

// IR 센서 핀
const IR = new Gpio(23, {
  mode: Gpio.INPUT,
  alert: true
});

IR.glitchFilter(10000); // 10ms 이상 신호만 감지

IR.on('alert', (level, tick) => {
  console.log(`IR 센서 상태: ${level === 1 ? 'ON(감지)' : 'OFF(미감지)'}`);
});