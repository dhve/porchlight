import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIntro } from '../server/bulletin.js';
test('an incomplete empty checkup cannot become a reassuring bulletin introduction', () => {
  const text = buildIntro({post:{id:'post1'},report:{id:'report1',target:'example.com',grade:'?',score:null,assessment:{status:'incomplete'},findings:[]}});
  assert.match(text, /incomplete/i);
  assert.doesNotMatch(text, /good shape|nothing that needs fixing/);
});
