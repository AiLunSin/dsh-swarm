import assert from 'node:assert/strict'
import test from 'node:test'
import { toCsv } from '../src/export.js'

test('toCsv renders a header and one line per row', () => {
  assert.equal(toCsv([{ id: 1, title: 'first' }]), 'id,title\n1,first')
})
