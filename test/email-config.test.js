const cfg = require('../src/config/env');
const { isEmailConfigured } = require('../src/modules/auth/services/EmailService');

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    return true;
  } catch (err) {
    console.error(`✗ ${name}:`, err.message);
    return false;
  }
}

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// Save originals
const orig = {
  EMAIL_HOST: process.env.EMAIL_HOST,
  EMAIL_USER: process.env.EMAIL_USER,
  EMAIL_PASS: process.env.EMAIL_PASS,
};

function setEmailEnv(host, user, pass) {
  process.env.EMAIL_HOST = host ?? '';
  process.env.EMAIL_USER = user ?? '';
  process.env.EMAIL_PASS = pass ?? '';
  delete require.cache[require.resolve('../src/config/env')];
  delete require.cache[require.resolve('../src/modules/auth/services/EmailService')];
}

if (test('isEmailConfigured false when EMAIL_* empty', () => {
  setEmailEnv('', '', '');
  const { isEmailConfigured: check } = require('../src/modules/auth/services/EmailService');
  assert(check() === false);
})) passed++; else failed++;

if (test('isEmailConfigured true when all EMAIL_* set', () => {
  setEmailEnv('smtp.gmail.com', 'user@example.com', 'secret');
  const { isEmailConfigured: check } = require('../src/modules/auth/services/EmailService');
  assert(check() === true);
})) passed++; else failed++;

// Restore env
process.env.EMAIL_HOST = orig.EMAIL_HOST;
process.env.EMAIL_USER = orig.EMAIL_USER;
process.env.EMAIL_PASS = orig.EMAIL_PASS;
delete require.cache[require.resolve('../src/config/env')];
delete require.cache[require.resolve('../src/modules/auth/services/EmailService')];

console.log(`\nemail-config.test.js — ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
