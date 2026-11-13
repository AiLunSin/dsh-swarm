/**
 * Configuration: defaults, coercion, and validation with field-level errors.
 * Invalid configuration fails at apply() time instead of at the first tick.
 */
import { asBool, asEnum, asFloat, asInt, asString, parseTokenBudget, SwarmError } from './util.js'
import { TOPOLOGIES } from './state.js'

export const DEFAULT_CONFIG = Object.freeze({
  /** Empty means `<repo>/.dsh-swarm`; otherwise a shared base directory. */
  dataDir: '',
  /** Default swarm size when a call does not specify one. */
  members: 3,
  maxMembers: 8,
  topology: 'mesh',
  mode: 'swarm',
  budget: {
    tokens: 2_000_000,
    usd: 0,
    wallMs: 0,
    hardStop: true,
  },
  taskBudget: {
    tokens: 400_000,
  },
  memberBudget: {
    tokens: 800_000,
  },
  market: {
    minScore: 0.3,
    wipPerMember: 2,
    leaseMs: 120_000,
    bidWindowMs: 60_000,
    agingRounds: 5,
  },
  board: {
    maxEntryBytes: 8 * 1024,
    maxTotalBytes: 2 * 1024 * 1024,
    defaultTtlMs: 0,
    queryTokenBudget: 800,
  },
  pheromone: {
    halfLifeMs: 30 * 60_000,
    success: 0.3,
    warning: 0.5,
    heat: 0.1,
    diffuseAlpha: 0.05,
  },
  review: {
    reviewersPerPatch: 2,
    quorum: 2 / 3,
    timeoutMs: 10 * 60_000,
    requireEvidence: true,
  },
  convergence: {
    idleRounds: 3,
    maxRounds: 50,
    stallMs: 10 * 60_000,
  },
  orchestrator: {
    tickMs: 5_000,
    autoStart: true,
  },
  preflight: {
    enabled: true,
    minFreeMb: 256,
  },
  workspace: {
    enabled: true,
    /** Empty means `<repo>/.dsh-swarm/worktrees` (excluded from git status). */
    root: '',
    keep: true,
    maxConcurrent: 6,
    diskThresholdMb: 2048,
  },
  gate: {
    /** Extra commands run before and after a merge. Empty means "auto-detect". */
    commands: [],
    autoDetect: true,
    timeoutMs: 5 * 60_000,
  },
  merge: {
    strategy: 'merge',
  },
  dispatch: {
    /** Host subagent provider used to run one worker per task. */
    provider: 'spawn',
    timeoutMs: 30 * 60_000,
    /** Commit uncommitted child work before collecting the patch. */
    autoCommit: true,
    /** Let the tick loop dispatch ready tasks without an explicit tool call. */
    auto: false,
  },
  messages: {
    maxPerMinute: 120,
    maxPayloadBytes: 4096,
    defaultTtlMs: 5 * 60_000,
    maxInbox: 200,
  },
  prompt: {
    enabled: true,
  },
  http: {
    enabled: true,
    /** Empty disables write endpoints; reads stay loopback-only. */
    token: '',
  },
  logLevel: 'info',
})

/** @param {unknown} value @param {string} field */
function invalid(field, message) {
  return new SwarmError('CONFIG_INVALID', `invalid config field '${field}': ${message}`, { field })
}

/**
 * @param {unknown} raw
 * @returns {typeof DEFAULT_CONFIG}
 */
export function resolveConfig(raw) {
  const input = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {}
  const budget = section(input, 'budget')
  const taskBudget = section(input, 'taskBudget')
  const memberBudget = section(input, 'memberBudget')
  const market = section(input, 'market')
  const board = section(input, 'board')
  const pheromone = section(input, 'pheromone')
  const review = section(input, 'review')
  const convergence = section(input, 'convergence')
  const orchestrator = section(input, 'orchestrator')
  const preflight = section(input, 'preflight')
  const workspace = section(input, 'workspace')
  const gate = section(input, 'gate')
  const merge = section(input, 'merge')
  const dispatch = section(input, 'dispatch')
  const messages = section(input, 'messages')
  const prompt = section(input, 'prompt')
  const http = section(input, 'http')

  const maxMembers = asInt(input.maxMembers, DEFAULT_CONFIG.maxMembers, 1, 32)
  const members = asInt(input.members, DEFAULT_CONFIG.members, 1, maxMembers)
  const topology = asEnum(input.topology, TOPOLOGIES, DEFAULT_CONFIG.topology)
  const mode = asEnum(input.mode, /** @type {const} */ (['swarm', 'single']), DEFAULT_CONFIG.mode)
  if (members > maxMembers) throw invalid('members', `must be <= maxMembers (${maxMembers})`)

  const quorum = asFloat(review.quorum, DEFAULT_CONFIG.review.quorum, 0.5, 1)
  if (quorum > 1) throw invalid('review.quorum', 'must be between 0.5 and 1')
  const reviewers = asInt(review.reviewersPerPatch, DEFAULT_CONFIG.review.reviewersPerPatch, 1, 7)

  const config = {
    dataDir: asString(input.dataDir, ''),
    members,
    maxMembers,
    topology,
    mode,
    budget: {
      tokens: parseTokenBudget(budget.tokens, DEFAULT_CONFIG.budget.tokens),
      usd: asFloat(budget.usd, DEFAULT_CONFIG.budget.usd, 0, Number.MAX_SAFE_INTEGER),
      wallMs: asInt(budget.wallMs, DEFAULT_CONFIG.budget.wallMs, 0, 30 * 24 * 3600_000),
      hardStop: asBool(budget.hardStop, DEFAULT_CONFIG.budget.hardStop),
    },
    taskBudget: {
      tokens: parseTokenBudget(taskBudget.tokens, DEFAULT_CONFIG.taskBudget.tokens),
    },
    memberBudget: {
      tokens: parseTokenBudget(memberBudget.tokens, DEFAULT_CONFIG.memberBudget.tokens),
    },
    market: {
      minScore: asFloat(market.minScore, DEFAULT_CONFIG.market.minScore, 0, 1),
      wipPerMember: asInt(market.wipPerMember, DEFAULT_CONFIG.market.wipPerMember, 1, 8),
      leaseMs: asInt(market.leaseMs, DEFAULT_CONFIG.market.leaseMs, 5_000, 24 * 3600_000),
      bidWindowMs: asInt(market.bidWindowMs, DEFAULT_CONFIG.market.bidWindowMs, 1_000, 3600_000),
      agingRounds: asInt(market.agingRounds, DEFAULT_CONFIG.market.agingRounds, 1, 100),
    },
    board: {
      maxEntryBytes: asInt(board.maxEntryBytes, DEFAULT_CONFIG.board.maxEntryBytes, 256, 1024 * 1024),
      maxTotalBytes: asInt(board.maxTotalBytes, DEFAULT_CONFIG.board.maxTotalBytes, 1024, 64 * 1024 * 1024),
      defaultTtlMs: asInt(board.defaultTtlMs, DEFAULT_CONFIG.board.defaultTtlMs, 0, 30 * 24 * 3600_000),
      queryTokenBudget: asInt(board.queryTokenBudget, DEFAULT_CONFIG.board.queryTokenBudget, 64, 32_000),
    },
    pheromone: {
      halfLifeMs: asInt(pheromone.halfLifeMs, DEFAULT_CONFIG.pheromone.halfLifeMs, 5 * 60_000, 240 * 60_000),
      success: asFloat(pheromone.success, DEFAULT_CONFIG.pheromone.success, 0, 10),
      warning: asFloat(pheromone.warning, DEFAULT_CONFIG.pheromone.warning, 0, 10),
      heat: asFloat(pheromone.heat, DEFAULT_CONFIG.pheromone.heat, 0, 10),
      diffuseAlpha: asFloat(pheromone.diffuseAlpha, DEFAULT_CONFIG.pheromone.diffuseAlpha, 0, 0.5),
    },
    review: {
      reviewersPerPatch: reviewers,
      quorum,
      timeoutMs: asInt(review.timeoutMs, DEFAULT_CONFIG.review.timeoutMs, 10_000, 24 * 3600_000),
      requireEvidence: asBool(review.requireEvidence, DEFAULT_CONFIG.review.requireEvidence),
    },
    convergence: {
      idleRounds: asInt(convergence.idleRounds, DEFAULT_CONFIG.convergence.idleRounds, 1, 100),
      maxRounds: asInt(convergence.maxRounds, DEFAULT_CONFIG.convergence.maxRounds, 1, 10_000),
      stallMs: asInt(convergence.stallMs, DEFAULT_CONFIG.convergence.stallMs, 60_000, 24 * 3600_000),
    },
    orchestrator: {
      tickMs: asInt(orchestrator.tickMs, DEFAULT_CONFIG.orchestrator.tickMs, 500, 60_000),
      autoStart: asBool(orchestrator.autoStart, DEFAULT_CONFIG.orchestrator.autoStart),
    },
    preflight: {
      enabled: asBool(preflight.enabled, DEFAULT_CONFIG.preflight.enabled),
      minFreeMb: asInt(preflight.minFreeMb, DEFAULT_CONFIG.preflight.minFreeMb, 0, 1_000_000),
    },
    workspace: {
      enabled: asBool(workspace.enabled, DEFAULT_CONFIG.workspace.enabled),
      root: asString(workspace.root, ''),
      keep: asBool(workspace.keep, DEFAULT_CONFIG.workspace.keep),
      maxConcurrent: asInt(workspace.maxConcurrent, DEFAULT_CONFIG.workspace.maxConcurrent, 1, 32),
      diskThresholdMb: asInt(workspace.diskThresholdMb, DEFAULT_CONFIG.workspace.diskThresholdMb, 0, 1_000_000),
    },
    gate: {
      commands: normalizeCommands(gate.commands),
      autoDetect: asBool(gate.autoDetect, DEFAULT_CONFIG.gate.autoDetect),
      timeoutMs: asInt(gate.timeoutMs, DEFAULT_CONFIG.gate.timeoutMs, 1_000, 3_600_000),
    },
    merge: {
      strategy: asEnum(merge.strategy, /** @type {const} */ (['merge']), 'merge'),
    },
    dispatch: {
      provider: asString(dispatch.provider, 'spawn'),
      timeoutMs: asInt(dispatch.timeoutMs, DEFAULT_CONFIG.dispatch.timeoutMs, 30_000, 4 * 3600_000),
      autoCommit: asBool(dispatch.autoCommit, DEFAULT_CONFIG.dispatch.autoCommit),
      auto: asBool(dispatch.auto, DEFAULT_CONFIG.dispatch.auto),
    },
    messages: {
      maxPerMinute: asInt(messages.maxPerMinute, DEFAULT_CONFIG.messages.maxPerMinute, 1, 10_000),
      maxPayloadBytes: asInt(messages.maxPayloadBytes, DEFAULT_CONFIG.messages.maxPayloadBytes, 64, 1024 * 1024),
      defaultTtlMs: asInt(messages.defaultTtlMs, DEFAULT_CONFIG.messages.defaultTtlMs, 1_000, 24 * 3600_000),
      maxInbox: asInt(messages.maxInbox, DEFAULT_CONFIG.messages.maxInbox, 1, 10_000),
    },
    prompt: {
      enabled: asBool(prompt.enabled, DEFAULT_CONFIG.prompt.enabled),
    },
    http: {
      enabled: asBool(http.enabled, DEFAULT_CONFIG.http.enabled),
      token: asString(http.token, ''),
    },
    logLevel: asEnum(input.logLevel, /** @type {const} */ (['debug', 'info', 'warn', 'error']), 'info'),
  }
  return config
}

/** @param {unknown} value @returns {string[]} */
function normalizeCommands(value) {
  if (!Array.isArray(value)) return []
  /** @type {string[]} */
  const commands = []
  for (const item of value) {
    const command = typeof item === 'string' ? item.trim() : ''
    if (!command) continue
    if (command.length > 500) throw invalid('gate.commands', 'a command must be <= 500 characters')
    commands.push(command)
  }
  if (commands.length > 20) throw invalid('gate.commands', 'at most 20 gate commands are allowed')
  return commands
}

/** @param {Record<string, unknown>} input @param {string} key */
function section(input, key) {  const value = input[key]
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {}
}

/** JSON Schema fragment for docs and settings UI. @returns {Record<string, unknown>} */
export function configSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      dataDir: { type: 'string', default: '', description: 'Shared data directory; empty means <repo>/.dsh-swarm.' },
      members: { type: 'integer', minimum: 1, maximum: 32, default: 3 },
      maxMembers: { type: 'integer', minimum: 1, maximum: 32, default: 8 },
      topology: { type: 'string', enum: [...TOPOLOGIES], default: 'mesh' },
      mode: { type: 'string', enum: ['swarm', 'single'], default: 'swarm' },
      budget: {
        type: 'object',
        properties: {
          tokens: { type: 'integer', default: 2_000_000 },
          usd: { type: 'number', default: 0 },
          wallMs: { type: 'integer', default: 0 },
          hardStop: { type: 'boolean', default: true },
        },
      },
      taskBudget: { type: 'object', properties: { tokens: { type: 'integer', default: 400_000 } } },
      memberBudget: { type: 'object', properties: { tokens: { type: 'integer', default: 800_000 } } },
      review: {
        type: 'object',
        properties: {
          reviewersPerPatch: { type: 'integer', minimum: 1, maximum: 7, default: 2 },
          quorum: { type: 'number', minimum: 0.5, maximum: 1, default: 0.667 },
          timeoutMs: { type: 'integer', default: 600_000 },
          requireEvidence: { type: 'boolean', default: true },
        },
      },
      workspace: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean', default: true },
          root: { type: 'string', default: '' },
          keep: { type: 'boolean', default: true },
          maxConcurrent: { type: 'integer', minimum: 1, maximum: 32, default: 6 },
          diskThresholdMb: { type: 'integer', minimum: 0, default: 2048 },
        },
      },
      gate: {
        type: 'object',
        properties: {
          commands: { type: 'array', items: { type: 'string' }, default: [] },
          autoDetect: { type: 'boolean', default: true },
          timeoutMs: { type: 'integer', minimum: 1000, default: 300_000 },
        },
      },
      dispatch: {
        type: 'object',
        properties: {
          provider: { type: 'string', default: 'spawn' },
          timeoutMs: { type: 'integer', minimum: 30000, default: 1_800_000 },
          autoCommit: { type: 'boolean', default: true },
          auto: { type: 'boolean', default: false },
        },
      },
      prompt: { type: 'object', properties: { enabled: { type: 'boolean', default: true } } },
      http: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean', default: true },
          token: { type: 'string', default: '' },
        },
      },
    },
  }
}
