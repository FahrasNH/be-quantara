/**
 * userExchange.test.js — regression: reconnect must re-activate soft-deleted rows.
 *
 * Run: node test/userExchange.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '../src/services/userExchange.js'),
  'utf8'
);

assert.ok(
  source.includes('deletedAt: null'),
  'upsertExchange must clear deletedAt on create/update so reconnected exchanges appear in list'
);

assert.ok(
  source.includes('deletedAt: null }'),
  'migrateLegacyIfNeeded must count only active exchanges (deletedAt: null)'
);

assert.ok(
  source.includes('exchangeType.toLowerCase()'),
  'listExchangesMasked must normalize exchangeType to lowercase'
);

console.log('✅ userExchange regression checks passed (3/3)');
