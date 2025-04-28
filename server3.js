const { Gpio } = require('pigpio');
const servo = new Gpio(18, { mode: Gpio.OUTPUT });

console.log('서보를 0도 위치로 이동');
servo.servoWrite(500);

setTimeout(() => {
    console.log('서보를 180도 위치로 이동');
    servo.servoWrite(2500);
}, 2000);

setTimeout(() => {
    console.log('서보를 90도 위치로 이동');
    servo.servoWrite(1500);
}, 4000);

setTimeout(() => {
    console.log('테스트 완료');
    process.exit(0);
}, 6000);