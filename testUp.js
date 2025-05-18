const { Gpio } = require('pigpio');

const IR = new Gpio(23, {
  mode: Gpio.INPUT,
  pullUpDown: Gpio.PUD_UP,
  alert: true
});

IR.glitchFilter(10000);

IR.on('alert', (level, tick) => {
  console.log(`📡 IR 센서 상태: ${level === 0 ? '감지됨' : '없음'}`);
});
