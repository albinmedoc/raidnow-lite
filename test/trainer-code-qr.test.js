import test from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';

import {
  createTrainerCodeQr,
  createTrainerCodeQrController,
  isValidTrainerCode
} from '../public/trainer-code-qr.js';
import { qrcode } from '../public/vendor/qrcode-generator/qrcode.mjs';

test('accepts exactly twelve ASCII digits', () => {
  assert.equal(isValidTrainerCode('123456789012'), true);
  for (const value of [
    '',
    '12345678901',
    '1234567890123',
    '1234 5678 9012',
    '１２３４５６７８９０１２',
    '12345678901a',
    null,
    undefined
  ]) {
    assert.equal(isValidTrainerCode(value), false, `expected ${String(value)} to be invalid`);
  }
});

test('passes the exact raw host code to the local QR generator', () => {
  const calls = [];
  const fakeQr = {
    addData(payload, mode) { calls.push(['addData', payload, mode]); },
    make() { calls.push(['make']); },
    createSvgTag(options) { calls.push(['createSvgTag', options]); return '<svg></svg>'; }
  };

  const result = createTrainerCodeQr('123456789012', {
    qrFactory(type, correction) {
      calls.push(['factory', type, correction]);
      return fakeQr;
    }
  });

  assert.equal(result.payload, '123456789012');
  assert.equal(result.grouped, '1234 5678 9012');
  assert.match(result.imageUrl, /^data:image\/svg\+xml/);
  assert.deepEqual(calls[1], ['addData', '123456789012', 'Numeric']);
  assert.equal(calls.some((call) => JSON.stringify(call).includes('1234 5678')), false);
});

test('invalid updates clear a previously generated QR and copy payload', () => {
  const controller = createTrainerCodeQrController({
    generate(value) {
      return isValidTrainerCode(value)
        ? { payload: value, grouped: '1234 5678 9012', imageUrl: 'data:image/svg+xml,test' }
        : null;
    }
  });

  assert.equal(controller.update('123456789012').payload, '123456789012');
  assert.equal(controller.current.payload, '123456789012');
  assert.equal(controller.update('1234 5678 9012'), null);
  assert.equal(controller.current, null);
});

test('invalid values never call the QR generator and return no image', () => {
  let calls = 0;
  const result = createTrainerCodeQr('1234 5678 9012', {
    qrFactory() { calls += 1; throw new Error('must not be called'); }
  });
  assert.equal(result, null);
  assert.equal(calls, 0);
});

test('an independent decoder reads the exact raw payload from a generated QR', () => {
  let generatedQr;
  const result = createTrainerCodeQr('123456789012', {
    qrFactory(type, correction) {
      generatedQr = qrcode(type, correction);
      return generatedQr;
    }
  });

  assert.equal(result.payload, '123456789012');
  const scale = 8;
  const quietModules = 4;
  const modules = generatedQr.getModuleCount();
  const width = (modules + quietModules * 2) * scale;
  const pixels = new Uint8ClampedArray(width * width * 4);
  pixels.fill(255);
  for (let row = 0; row < modules; row += 1) {
    for (let col = 0; col < modules; col += 1) {
      if (!generatedQr.isDark(row, col)) continue;
      for (let y = 0; y < scale; y += 1) {
        for (let x = 0; x < scale; x += 1) {
          const pixel = (((row + quietModules) * scale + y) * width + (col + quietModules) * scale + x) * 4;
          pixels[pixel] = 0;
          pixels[pixel + 1] = 0;
          pixels[pixel + 2] = 0;
        }
      }
    }
  }

  assert.equal(jsQR(pixels, width, width)?.data, '123456789012');
});
