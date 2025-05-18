const { Gpio } = require('pigpio');

const IR = new Gpio(23, {
  mode: Gpio.INPUT,
  pullUpDown: Gpio.PUD_DOWN,
  alert: true
});

IR.glitchFilter(10000);

IR.on('alert', (level, tick) => {
  console.log(`📡 IR 센서 상태: ${level === 1 ? '감지됨' : '없음'}`);
});
