import assert from 'node:assert/strict'
import test from 'node:test'

test('the client half registers a sidebar entry and a main page', async () => {
  let definition
  globalThis.window = {
    __ModuleLoader__: {
      load(value) {
        definition = value
      },
    },
  }
  try {
    await import(`../client.js?test=${Date.now()}`)
    assert.equal(definition.id, 'dsh-swarm')
    const React = {
      createElement() {},
      useState() {},
      useEffect() {},
      useCallback(fn) {
        return fn
      },
    }
    const module = definition.factory((name) => {
      assert.equal(name, 'react')
      return React
    })
    assert.deepEqual(module.inject, ['slots', 'locale'])

    const slots = []
    const registrations = []
    const ctx = {
      effect(fn) {
        fn()
      },
      locale: {
        register(namespace, dictionary) {
          registrations.push({ namespace, dictionary })
        },
        bind() {
          return (key) => key
        },
        subscribe() {
          return () => {}
        },
      },
      slots: {
        inject(_name, callback) {
          callback()
        },
        register(options, component) {
          slots.push({ options, component })
          return () => {}
        },
      },
    }
    module.apply(ctx)

    assert.equal(registrations[0].namespace, 'dshSwarm')
    assert.ok(registrations[0].dictionary.zh.navLabel)
    assert.deepEqual(
      slots.map((entry) => [entry.options.name, entry.options.id ?? entry.options.key]),
      [
        ['sidebar.panellist', 'swarm'],
        ['main', 'swarm'],
      ],
    )
    assert.equal(typeof slots[1].component, 'function')
  } finally {
    delete globalThis.window
  }
})
