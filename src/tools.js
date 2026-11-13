/**
 * Model-facing `swarm_*` tools. Every tool returns canonical JSON (usable from
 * `run_code` / PTC) and renders a short human summary for the transcript.
 */
import { SwarmError, truncate } from './util.js'

/** @param {string} value */
function text(value) {
  return [{ type: 'text', text: String(value) }]
}

/** @param {unknown} error */
function toolError(error) {
  const candidate = /** @type {any} */ (error)
  if (candidate && typeof candidate === 'object') {
    candidate.info = {
      name: 'SwarmError',
      code: String(candidate.code ?? 'SWARM_ERROR'),
      reason: String(candidate.message ?? error),
    }
  }
  return error
}

/**
 * @param {import('./service.js').SwarmService} service
 * @param {{ runId?: string }} args
 */
function resolveRun(service, args) {
  if (args.runId) return args.runId
  const open = [...service.runs.values()].filter((run) =>
    ['created', 'running', 'paused', 'draining'].includes(run.state.status),
  )
  if (open.length === 1) return open[0].id
  if (open.length === 0) throw new SwarmError('NO_RUN', 'no open swarm run; call swarm_start first')
  const ids = open.map((run) => run.id).join(', ')
  throw new SwarmError('RUN_AMBIGUOUS', `multiple open swarms (${ids}); pass runId explicitly`)
}

/** @param {any} snapshot */
function summarizeStatus(snapshot) {
  const lines = [
    `swarm ${snapshot.swarmId}  status=${snapshot.status}  topology=${snapshot.topology}  round=${snapshot.round ?? 1}`,
    `goal: ${truncate(snapshot.goal, 160)}`,
    `members: ${snapshot.members.length}  tasks: ${snapshot.stats.tasks}  merged: ${snapshot.stats.merged}  active: ${snapshot.stats.active}`,
    `budget: ${snapshot.budget.run.tokens}/${snapshot.budget.limits.runTokens} tok, ${snapshot.budget.run.calls} calls, ${snapshot.budget.run.usd.toFixed(4)} usd`,
    `workspace: ${snapshot.workspace?.enabled ? 'worktree' : 'patch-only'}  gate=${(snapshot.gateCommands ?? []).join(', ') || 'none'}  autoDispatch=${snapshot.dispatch?.auto ? 'on' : 'off'}${snapshot.dispatch?.active ? ` active=${snapshot.dispatch.active}` : ''}`,
  ]
  if (snapshot.members.length) {
    lines.push('', 'members:')
    for (const member of snapshot.members.slice(0, 12)) {
      lines.push(
        `  ${member.name}  ${member.role}  ${member.status}  id=${member.id}  load=${member.load}  done=${member.stats.done}`,
      )
    }
  }
  if (snapshot.tasks.length) {
    lines.push('', 'tasks:')
    for (const task of snapshot.tasks.slice(0, 20)) {
      lines.push(`  ${task.id}  [${task.state}]  ${truncate(task.title, 80)}  assignee=${task.assignee ?? '-'}`)
    }
  }
  if (snapshot.convergedReason) lines.push('', `converged: ${snapshot.convergedReason}`)
  return lines.join('\n')
}

/** @param {any[]} tasks */
function summarizeTasks(tasks) {
  if (tasks.length === 0) return 'no tasks'
  const lines = [`tasks: ${tasks.length}`]
  for (const task of tasks) {
    lines.push(
      `${task.id}  [${task.state}]  ${truncate(task.title, 100)}  assignee=${task.assignee ?? '-'}  deps=${(task.deps ?? []).join(',') || '-'}  attempts=${task.attempts ?? 0}`,
    )
    for (const criterion of task.acceptance ?? []) lines.push(`   - acceptance: ${truncate(criterion, 120)}`)
    if (task.lease) lines.push(`   lease: member=${task.lease.memberId} fence=${task.lease.fence} expires=${new Date(task.lease.expiresAt).toISOString()}`)
    if (task.worktree) lines.push(`   worktree: ${task.worktree.path}  branch=${task.worktree.branch}`)
    if (task.gate) lines.push(`   gate: ${task.gate.passed ? 'passed' : 'failed'}  checks=${task.gate.checks?.length ?? 0}`)
    if (task.lastConflict) lines.push(`   conflict: ${(task.lastConflict.files ?? []).join(', ') || task.lastConflict.reason}`)
    if (task.mergeCommit) lines.push(`   merge: ${task.mergeCommit}`)
    if (task.patchId) lines.push(`   patch: ${task.patchId}`)
  }
  return lines.join('\n')
}

/** @param {any} result */
function summarizeTally(result) {
  const tally = result.tally
  return [
    `review ${result.reviewId} recorded for patch ${tally ? '' : ''}${result.patchId ?? ''}`,
    `task state: ${result.taskState}`,
    `approvals ${tally.approvals}/${tally.needed}  rejections ${tally.rejections}  weak ${tally.weak}  pending ${tally.pending}`,
    tally.blocking.length ? `blocking comments: ${tally.blocking.length}` : '',
    result.weak ? 'warning: approval had no evidence and does not count toward quorum' : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * @param {import('./service.js').SwarmService} service
 */
export function createTools(service) {
  return [
    {
      name: 'swarm_start',
      description: [
        'Create and start a controlled agent swarm for one repository-level goal.',
        'Returns the swarm id, the initial member roster, and the budget snapshot.',
        'A swarm coordinates tasks, a shared blackboard, reviews, and budgets; it does not replace the host subagent runtime.',
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          goal: { type: 'string', description: 'One concrete, verifiable goal for this run.' },
          repo: { type: 'string', description: 'Absolute path of the target git repository (or a directory for patch-only mode).' },
          topology: { type: 'string', enum: ['mesh', 'pipeline', 'star', 'hierarchy'], description: 'Communication topology; mesh is the default.' },
          members: { type: 'integer', minimum: 1, maximum: 8, description: 'Total swarm size including the queen; single mode always uses 1.' },
          mode: { type: 'string', enum: ['swarm', 'single'], description: 'Use single for the cheaper baseline comparison.' },
          budget: {
            type: 'object',
            properties: {
              tokens: { type: 'integer', minimum: 1000, description: 'Hard token budget for the whole run.' },
              usd: { type: 'number', minimum: 0 },
              wallMs: { type: 'integer', minimum: 0, description: 'Wall-clock budget; 0 means unlimited.' },
            },
          },
          force: { type: 'boolean', description: 'Skip the repository preflight. Prefer fixing the reported issues.' },
          autoDispatch: {
            type: 'boolean',
            description: 'Let the tick loop dispatch ready tasks automatically; requires a bound parent Agent.',
          },
        },
        required: ['goal', 'repo'],
      },
      output: {
        schema: { type: 'object', description: 'Swarm snapshot: members, tasks, budget, convergence.' },
        render(_args, value) {
          return text(summarizeStatus(value))
        },
      },
      isConcurrencySafe() {
        return false
      },
      async execute(args, exec) {
        try {
          return await service.createRun(args, { agent: exec?.agent })
        } catch (error) {
          throw toolError(error)
        }
      },
    },
    {
      name: 'swarm_status',
      description: [
        'Return the current swarm snapshot: status, members, tasks, budget, and convergence.',
        'Omit runId when exactly one swarm is open. Pass detail=true to include the blackboard, reviews, and recent events.',
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', description: 'Swarm id; omit when only one run is open.' },
          detail: { type: 'boolean', description: 'Include board entries, reviews, pheromones, and the last 50 event types.' },
        },
      },
      output: {
        schema: { type: 'object', description: 'Swarm snapshot or a run list.' },
        render(_args, value) {
          if (Array.isArray(value.runs)) {
            if (value.runs.length === 0) return text('no swarm runs')
            return text(
              [
                `swarm runs: ${value.runs.length} (${value.active} active)`,
                ...value.runs.map((run) => `${run.swarmId}  ${run.status}  tasks=${run.tasks}  ${truncate(run.goal, 90)}`),
              ].join('\n'),
            )
          }
          return text(summarizeStatus(value))
        },
      },
      isConcurrencySafe() {
        return true
      },
      async execute(args) {
        try {
          if (args.runId) return await service.status(args.runId, args.detail === true)
          const open = [...service.runs.values()].filter((run) =>
            ['created', 'running', 'paused', 'draining'].includes(run.state.status),
          )
          if (open.length === 1) return await service.status(open[0].id, args.detail === true)
          if (open.length === 0 && service.runs.size === 1) {
            return await service.status([...service.runs.keys()][0], args.detail === true)
          }
          return await service.status(null, false)
        } catch (error) {
          throw toolError(error)
        }
      },
    },
    {
      name: 'swarm_task',
      description: [
        'Create, inspect, advertise, award, or cancel swarm tasks.',
        'A task requires a title and at least one machine-checkable acceptance criterion; dependencies must already exist.',
        'Actions: create | list | get | advertise | award | cancel.',
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['create', 'list', 'get', 'advertise', 'award', 'cancel'] },
          runId: { type: 'string' },
          taskId: { type: 'string' },
          title: { type: 'string' },
          acceptance: { type: 'array', items: { type: 'string' }, description: 'Verifiable acceptance criteria (commands, assertions).' },
          files: { type: 'array', items: { type: 'string' }, description: 'Files the task is expected to touch.' },
          symbols: { type: 'array', items: { type: 'string' } },
          deps: { type: 'array', items: { type: 'string' }, description: 'Task ids that must finish first.' },
          priority: { type: 'integer', minimum: 0, maximum: 100 },
          budgetTokens: { type: 'integer', minimum: 1 },
          tags: { type: 'array', items: { type: 'string' } },
          memberId: { type: 'string', description: 'For award: explicit assignee (requires reason).' },
          force: { type: 'boolean', description: 'For award: force assignment or reassignment.' },
          reason: { type: 'string' },
        },
        required: ['action'],
      },
      output: {
        schema: { type: 'object', description: 'Task, task list, or award result.' },
        render(args, value) {
          if (args.action === 'list') return text(summarizeTasks(value.tasks ?? []))
          if (args.action === 'get' || args.action === 'create' || args.action === 'advertise' || args.action === 'cancel') {
            return text(summarizeTasks(value.task ? [value.task] : [{ ...value }]))
          }
          if (args.action === 'award') return text(summarizeTasks([value]))
          return text(JSON.stringify(value, null, 2))
        },
      },
      isConcurrencySafe() {
        return false
      },
      async execute(args) {
        try {
          const runId = resolveRun(service, args)
          if (args.action === 'create') {
            return await service.createTask(runId, args)
          }
          if (args.action === 'list') {
            const snapshot = service.snapshot(runId, false)
            return { tasks: snapshot.tasks }
          }
          if (!args.taskId) throw toolError(new Error('taskId is required'))
          if (args.action === 'get') {
            const snapshot = service.snapshot(runId, true)
            const task = snapshot.tasks.find((item) => item.id === args.taskId)
            if (!task) throw toolError(new Error(`task ${args.taskId} not found`))
            return { task, reviews: snapshot.reviews.filter((review) => review.patchId === task.patchId) }
          }
          if (args.action === 'advertise') return { task: await service.advertiseTask(runId, args.taskId, args) }
          if (args.action === 'award') return await service.awardTask(runId, args.taskId, args)
          if (args.action === 'cancel') return { task: await service.cancelTask(runId, args.taskId, args) }
          throw toolError(new Error(`unknown action '${args.action}'`))
        } catch (error) {
          throw toolError(error)
        }
      },
    },
    {
      name: 'swarm_bid',
      description: [
        'Bid on an advertised swarm task. The server scores capability, idle capacity, historical success, starving age, and cost.',
        'One member may bid once per task. Use the member id returned by swarm_start.',
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string' },
          taskId: { type: 'string' },
          memberId: { type: 'string' },
          estimate: {
            type: 'object',
            properties: { tokens: { type: 'integer', minimum: 1 }, minutes: { type: 'integer', minimum: 1 } },
          },
          reason: { type: 'string', description: 'Why this member is a good fit.' },
        },
        required: ['taskId', 'memberId'],
      },
      output: {
        schema: { type: 'object', description: 'Bid acceptance and score components.' },
        render(_args, value) {
          if (value.accepted) {
            return text(`bid accepted: score=${value.score} (${Object.entries(value.components ?? {}).map(([key, item]) => `${key}=${Number(item).toFixed(2)}`).join(' ')})`)
          }
          return text(JSON.stringify(value, null, 2))
        },
      },
      isConcurrencySafe() {
        return false
      },
      async execute(args) {
        try {
          return await service.bid(resolveRun(service, args), args.taskId, args)
        } catch (error) {
          throw toolError(error)
        }
      },
    },
    {
      name: 'swarm_submit',
      description: [
        'Submit a task patch with its branch, changed files, and test evidence.',
        'The call must carry the member id and lease fence from the award. Reviewers are assigned automatically; the task moves to reviewing.',
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string' },
          taskId: { type: 'string' },
          memberId: { type: 'string' },
          fence: { type: 'integer', minimum: 1, description: 'Fencing token from the task lease.' },
          branch: { type: 'string', description: 'Branch to merge; optional when the task has an isolated worktree (the server reads its branch and commit).' },
          commit: { type: 'string', description: 'Commit SHA; optional when the worktree is collected automatically.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Changed files; optional in worktree mode.' },
          tests: {
            type: 'array',
            description: 'Test evidence: strings or {name, passed, output}.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                passed: { type: 'boolean' },
                output: { type: 'string' },
              },
            },
          },
          notes: { type: 'string', description: 'Implementation notes and known risks.' },
        },
        required: ['taskId', 'memberId', 'fence'],
      },
      output: {
        schema: { type: 'object', description: 'Patch id, task state, and reviewer assignment.' },
        render(_args, value) {
          return text(
            [
              `patch submitted: ${value.patchId}`,
              `task state: ${value.taskState}`,
              value.review
                ? `reviewers: ${value.review.reviewers.length ? value.review.reviewers.join(', ') : 'none (approved without review)'}`
                : '',
            ]
              .filter(Boolean)
              .join('\n'),
          )
        },
      },
      isConcurrencySafe() {
        return false
      },
      async execute(args) {
        try {
          return await service.submitPatch(resolveRun(service, args), args.taskId, args)
        } catch (error) {
          throw toolError(error)
        }
      },
    },
    {
      name: 'swarm_dispatch',
      description: [
        'Spawn a real subagent worker for an awarded task. The child works only in the task worktree and must commit its change.',
        'The server extends the lease, collects the commit and diff, and opens review automatically.',
        'Set wait=true to block until the child finishes and the patch is submitted; default starts it in the background.',
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string' },
          taskId: { type: 'string' },
          memberId: { type: 'string' },
          fence: { type: 'integer', minimum: 1, description: 'Fencing token from the task lease.' },
          wait: { type: 'boolean', description: 'Wait for the child to finish and submit before returning.' },
        },
        required: ['taskId', 'memberId', 'fence'],
      },
      output: {
        schema: { type: 'object', description: 'Dispatch start receipt or the submitted patch when wait=true.' },
        render(_args, value) {
          if (value?.patchId) {
            return text(
              `dispatch finished: patch=${value.patchId} task=${value.taskState} reviewers=${value.review?.reviewers?.join(', ') || 'none'}`,
            )
          }
          return text(`dispatch started: child=${value.childId} task=${value.taskId} status=${value.status}`)
        },
      },
      isConcurrencySafe() {
        return false
      },
      async execute(args, exec) {
        try {
          return await service.dispatchTask(resolveRun(service, args), args.taskId, {
            memberId: args.memberId,
            fence: args.fence,
            wait: args.wait === true,
            agent: exec?.agent,
            signal: exec?.signal,
          })
        } catch (error) {
          throw toolError(error)
        }
      },
    },
    {
      name: 'swarm_review',
      description: [
        'Cast a structured review vote on a submitted patch: approve, request_changes, or abstain.',
        'Only assigned non-author reviewers may vote. Approvals without evidence are recorded as weak and do not count toward quorum.',
        'Comments use kind blocking | nit | question.',
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string' },
          patchId: { type: 'string' },
          memberId: { type: 'string' },
          verdict: { type: 'string', enum: ['approve', 'request_changes', 'abstain'] },
          comments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['blocking', 'nit', 'question'] },
                body: { type: 'string' },
              },
              required: ['kind', 'body'],
            },
          },
          evidence: {
            type: 'array',
            items: { type: 'string' },
            description: 'Test names, command output, or file:line references supporting the verdict.',
          },
        },
        required: ['patchId', 'memberId', 'verdict'],
      },
      output: {
        schema: { type: 'object', description: 'Review id, tally, and resulting task state.' },
        render(_args, value) {
          return text(summarizeTally(value))
        },
      },
      isConcurrencySafe() {
        return false
      },
      async execute(args) {
        try {
          return await service.reviewPatch(resolveRun(service, args), args.patchId, args)
        } catch (error) {
          throw toolError(error)
        }
      },
    },
    {
      name: 'swarm_merge',
      description: [
        'Merge an approved patch into the integration branch after its gate passed.',
        'A patch whose task is not approved is rejected; a gate with passed=false is rejected even when every reviewer approved.',
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string' },
          patchId: { type: 'string' },
          mergeCommit: { type: 'string', description: 'Commit id of the merge on the integration branch.' },
          gate: {
            type: 'object',
            description: 'Gate evidence. Omit only for patch-only mode.',
            properties: {
              passed: { type: 'boolean' },
              checks: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    passed: { type: 'boolean' },
                    output: { type: 'string' },
                  },
                },
              },
            },
          },
        },
        required: ['patchId'],
      },
      output: {
        schema: { type: 'object', description: 'Merged task.' },
        render(_args, value) {
          return text(`merged: task=${value.id} state=${value.state}`)
        },
      },
      isConcurrencySafe() {
        return false
      },
      async execute(args) {
        try {
          return await service.mergePatch(resolveRun(service, args), args.patchId, args)
        } catch (error) {
          throw toolError(error)
        }
      },
    },
    {
      name: 'swarm_board',
      description: [
        'Read or write the shared hive blackboard and its pheromone field.',
        'Entries are typed (fact, decision, hypothesis, warstory, lock, artifact), carry confidence and TTL, and are secret-scrubbed on write.',
        'Operations: query | list | write | update | remove | deposit.',
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string' },
          op: { type: 'string', enum: ['query', 'list', 'write', 'update', 'remove', 'deposit'] },
          id: { type: 'string' },
          ids: { type: 'array', items: { type: 'string' } },
          kind: { type: 'string', enum: ['fact', 'decision', 'hypothesis', 'warstory', 'lock', 'artifact', 'success', 'warning', 'heat'] },
          topic: { type: 'string' },
          topics: { type: 'array', items: { type: 'string' } },
          kinds: { type: 'array', items: { type: 'string' } },
          content: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          ttlMs: { type: 'integer', minimum: 0 },
          expectedVersion: { type: 'integer', minimum: 1 },
          topK: { type: 'integer', minimum: 1, maximum: 200 },
          tokenBudget: { type: 'integer', minimum: 64 },
          includeExpired: { type: 'boolean' },
          delta: { type: 'number' },
          author: { type: 'string' },
        },
      },
      output: {
        schema: { type: 'object', description: 'Board entries, pheromones, or the written entry.' },
        render(_args, value) {
          if (value.entries) {
            const lines = [`board: ${value.entries.length}/${value.total ?? value.entries.length} entries${value.truncated ? ' (truncated)' : ''}`]
            for (const entry of value.entries) {
              lines.push(`[${entry.kind}] ${entry.topic} (v${entry.version}, conf=${entry.confidence}): ${truncate(entry.content, 180)}`)
            }
            if (value.pheromones?.length) {
              lines.push('', 'pheromones:')
              for (const item of value.pheromones.slice(0, 10)) lines.push(`  ${item.topic} ${item.kind} ${item.weight}`)
            }
            return text(lines.join('\n'))
          }
          return text(JSON.stringify(value, null, 2))
        },
      },
      isConcurrencySafe() {
        return true
      },
      async execute(args) {
        try {
          const runId = resolveRun(service, args)
          if (args.op === 'list' || !args.op) {
            return await service.board(runId, { ...args, op: 'query', includeExpired: true, topK: args.topK ?? 200 })
          }
          return await service.board(runId, args)
        } catch (error) {
          throw toolError(error)
        }
      },
    },
    {
      name: 'swarm_message',
      description: [
        'Send a point-to-point request/response or a topic broadcast to members of one swarm run.',
        'Messages are event-sourced, TTL-bounded, and rate-limited per sender; cross-run targets are rejected.',
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string' },
          from: { type: 'string', description: 'Sending member id.' },
          to: { type: 'string', description: 'Recipient member id (omit for a topic broadcast).' },
          topic: { type: 'string', description: 'Topic for broadcasts or an extra label for direct messages.' },
          kind: { type: 'string', enum: ['request', 'response', 'broadcast', 'event'] },
          content: { type: 'string', description: 'Plain-text payload.' },
          payload: { type: 'object', description: 'Structured payload; serialized as JSON.' },
          ttlMs: { type: 'integer', minimum: 0, description: 'Time to live; 0 means never expires.' },
          correlationId: { type: 'string', description: 'Request/response correlation id.' },
        },
        required: ['from'],
      },
      output: {
        schema: { type: 'object', description: 'Message id, target, and expiry.' },
        render(_args, value) {
          if (value.throttled) return text(`message throttled: ${value.reason}`)
          return text(`message sent: ${value.messageId} -> ${value.to} (${value.kind})`)
        },
      },
      isConcurrencySafe() {
        return false
      },
      async execute(args) {
        try {
          return await service.sendMessage(resolveRun(service, args), args)
        } catch (error) {
          throw toolError(error)
        }
      },
    },
    {
      name: 'swarm_inbox',
      description: [
        'Read pending messages for one member. Delivery is at-least-once with acknowledgement; consume=false peeks.',
        'Expired messages are skipped and recorded as swarm/message/expired.',
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string' },
          memberId: { type: 'string' },
          consume: { type: 'boolean', description: 'Acknowledge returned messages (default true).' },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
        required: ['memberId'],
      },
      output: {
        schema: { type: 'object', description: 'Pending messages for the member.' },
        render(_args, value) {
          if (value.messages.length === 0) return text(`inbox ${value.memberId}: empty`)
          return text(
            [
              `inbox ${value.memberId}: ${value.messages.length} message(s), ${value.pending} more`,
              ...value.messages.map(
                (message) => `${message.id}  ${message.kind}  ${message.from} -> ${message.to}  ${truncate(message.payload, 160)}`,
              ),
            ].join('\n'),
          )
        },
      },
      isConcurrencySafe() {
        return true
      },
      async execute(args) {
        try {
          return await service.inbox(resolveRun(service, args), args)
        } catch (error) {
          throw toolError(error)
        }
      },
    },
    {
      name: 'swarm_intervene',
      description: [
        'Human control over a swarm: pause, resume, drain, abort, steer, adjust budget, add/remove a member, or force convergence.',
        'Every intervention is recorded with actor and reason and cannot be deleted.',
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string' },
          action: {
            type: 'string',
            enum: [
              'pause',
              'resume',
              'start',
              'drain',
              'abort',
              'steer',
              'budget',
              'add_member',
              'remove_member',
              'converge',
            ],
          },
          reason: { type: 'string' },
          text: { type: 'string', description: 'For steer: the instruction to inject at the next tick boundary.' },
          tokens: { type: 'integer', description: 'For budget: tokens to add to the run limit.' },
          name: { type: 'string', description: 'For add_member: unique member name.' },
          role: { type: 'string', enum: ['worker', 'reviewer'], description: 'For add_member: default worker.' },
          model: { type: 'string', enum: ['fast', 'strong', 'inherit'], description: 'For add_member: model tier.' },
          memberId: { type: 'string', description: 'For remove_member: member to retire (queen excluded).' },
        },
        required: ['action'],
      },
      output: {
        schema: { type: 'object', description: 'Updated swarm snapshot.' },
        render(_args, value) {
          return text(`intervention applied: status=${value.status} members=${value.members?.length ?? '-'}`)
        },
      },
      isConcurrencySafe() {
        return false
      },
      async execute(args) {
        try {
          return await service.intervene(resolveRun(service, args), args)
        } catch (error) {
          throw toolError(error)
        }
      },
    },
  ]
}
