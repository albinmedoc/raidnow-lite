import { qrcode } from './vendor/qrcode-generator/qrcode.mjs';

const TRAINER_CODE_PATTERN = /^[0-9]{12}$/;

export function isValidTrainerCode(value) {
  return typeof value === 'string' && TRAINER_CODE_PATTERN.test(value);
}

export function createTrainerCodeQr(value, { qrFactory = qrcode } = {}) {
  if (!isValidTrainerCode(value)) return null;

  const qr = qrFactory(0, 'M');
  qr.addData(value, 'Numeric');
  qr.make();
  const svg = qr.createSvgTag({
    cellSize: 8,
    margin: 32,
    scalable: true,
    alt: `QR-kod för trainer code ${value}`,
    title: 'Trainer code QR-kod'
  });

  return {
    payload: value,
    grouped: value.replace(/(.{4})(?=.)/g, '$1 '),
    imageUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  };
}

export function createTrainerCodeQrController({ generate = createTrainerCodeQr } = {}) {
  let current = null;
  return {
    update(value) {
      current = generate(value);
      return current;
    },
    clear() {
      current = null;
      return current;
    },
    get current() {
      return current;
    }
  };
}
