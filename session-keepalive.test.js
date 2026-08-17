import test from 'node:test'
import assert from 'node:assert/strict'
import SessionKeepalivePlugin from './session-keepalive.js'

test('SessionKeepalivePlugin', async (t) => {
  await t.test('skips when enabled: false', async () => {
    const plugin = await SessionKeepalivePlugin({}, { enabled: false })
    assert.deepEqual(plugin, {})
  })

  await t.test('eligibility rules', async () => {
    let mockGetCalled = false
    const ctx = {
      client: {
        session: {
          get: async () => {
            mockGetCalled = true
            return {
              data: {
                agent: 'expensive-agent',
                model: { providerID: 'anthropic' }
              }
            }
          }
        }
      }
    }

    const plugin = await SessionKeepalivePlugin(ctx, { agents: ['expensive-agent'] })
    await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_123' } } })
    
    assert.equal(mockGetCalled, true)
    await plugin.dispose()
  })

  await t.test('ineligible agent', async () => {
    let mockGetCalled = false
    const ctx = {
      client: {
        session: {
          get: async () => {
            mockGetCalled = true
            return {
              data: {
                agent: 'cheap-agent',
                model: { providerID: 'anthropic' }
              }
            }
          }
        }
      }
    }

    const plugin = await SessionKeepalivePlugin(ctx, { agents: ['expensive-agent'] })
    await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_123' } } })
    
    assert.equal(mockGetCalled, true)
    
    // the plugin shouldn't have set a timer because the agent wasn't expensive-agent
    // we can test this indirectly by checking tool.execute.before which checks if pinging
    await plugin['tool.execute.before']({ sessionID: 'ses_123' }) // shouldn't throw
    await plugin.dispose()
  })

  const delay = (ms) => new Promise(r => setTimeout(r, ms))

  await t.test('timer logic and pinging', async () => {
    let promptCalled = 0
    const ctx = {
      client: {
        session: {
          get: async () => ({
            data: { agent: 'a', model: { providerID: 'anthropic' } }
          }),
          prompt: async () => {
            promptCalled++
            return {}
          }
        }
      }
    }

    const plugin = await SessionKeepalivePlugin(ctx, { windowMs: 100, intervalMs: 20 })
    
    // session idle triggers arming
    await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_timer' } } })
    
    // wait for interval
    await delay(30)
    assert.ok(promptCalled >= 1)

    // real user turn disarms
    await plugin.event({ 
      event: { 
        type: 'message.updated', 
        properties: { info: { sessionID: 'ses_timer', role: 'user' } } 
      } 
    })
    
    const countAfterDisarm = promptCalled
    await delay(30)
    assert.equal(promptCalled, countAfterDisarm) // no new ping
    
    await plugin.dispose()
  })

  await t.test('tool.execute.before throws if pinging', async () => {
    let promptCalled = 0
    let promptPromiseResolve
    const promptPromise = new Promise(r => promptPromiseResolve = r)
    
    const ctx = {
      client: {
        session: {
          get: async () => ({
            data: { agent: 'a', model: { providerID: 'anthropic' } }
          }),
          prompt: async () => {
            promptCalled++
            return promptPromise // hang the prompt so pinging stays true
          }
        }
      }
    }

    const plugin = await SessionKeepalivePlugin(ctx, { windowMs: 100, intervalMs: 10 })
    await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_block' } } })
    
    await delay(20) // wait for ping to start
    assert.equal(promptCalled, 1) // ping should be running
    
    await assert.rejects(
      plugin['tool.execute.before']({ sessionID: 'ses_block' }),
      /tools are disabled during a keepalive ping/
    )

    promptPromiseResolve({})
    await delay(10) // wait for prompt promise to flush and pinging to become false
    
    // Now pinging is done, should not throw
    await plugin['tool.execute.before']({ sessionID: 'ses_block' })
    
    await plugin.dispose()
  })

  await t.test('ignores child sessions unless includeChildSessions is true', async () => {
    const ctx = {
      client: {
        session: {
          get: async () => ({
            data: { parentID: 'ses_parent', model: { providerID: 'anthropic' } }
          })
        }
      }
    }

    // Default: false
    const plugin1 = await SessionKeepalivePlugin(ctx)
    await plugin1.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_child' } } })
    // shouldn't block, wasn't armed
    await plugin1['tool.execute.before']({ sessionID: 'ses_child' }) 
    await plugin1.dispose()

    // With includeChildSessions: true
    const plugin2 = await SessionKeepalivePlugin(ctx, { includeChildSessions: true, windowMs: 100, intervalMs: 10 })
    await plugin2.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_child2' } } })
    // It is armed, disarming via dispose:
    await plugin2.dispose()
  })

  await t.test('session.deleted disarms the timer', async () => {
    let promptCalled = 0
    const ctx = {
      client: {
        session: {
          get: async () => ({ data: { model: { providerID: 'anthropic' } } }),
          prompt: async () => {
            promptCalled++
            return {}
          }
        }
      }
    }

    const plugin = await SessionKeepalivePlugin(ctx, { windowMs: 100, intervalMs: 20 })
    await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_del' } } })
    
    // Fire deletion
    await plugin.event({ event: { type: 'session.deleted', properties: { sessionID: 'ses_del' } } })
    
    await delay(30) // wait to see if it pings
    assert.equal(promptCalled, 0)
    
    await plugin.dispose()
  })
})
